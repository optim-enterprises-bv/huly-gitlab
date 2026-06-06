import { randomBytes, createHash } from 'node:crypto'
import { Router as createRouter } from 'express'
import type { Request, Response, Router } from 'express'
import { ObjectId } from 'mongodb'
import type { Collection } from 'mongodb'
import type { Config } from '../config'
import type { Store } from '../state/store'
import type { Logger } from '../logging'
import type { OAuthStateDoc } from '../state/oauth-state'
import { putCredential } from '../state/credentials'
import { validateGitLabBaseUrl } from '../util/url-validation'
import { signHmac, verifyHmac } from '../util/secret-rotation'
import type { SecretConfig } from '../util/secret-rotation'

/** Admin OAuth state rows carry no `kind` field (or kind != 'user'). */
interface AdminOAuthStateDoc extends OAuthStateDoc {
  kind?: string
}

export interface OAuthRouterDeps {
  config: Config
  store: Store
  logger: Logger
  secrets?: SecretConfig
}

export function createOAuthRouter (deps: OAuthRouterDeps): Router {
  const { config, store, logger } = deps
  const secrets: SecretConfig = deps.secrets ?? { primary: config.ServerSecret, previous: config.ServerSecretPrevious }
  const router = createRouter()

  // GET /oauth/start?workspaceUuid=...&hulyProjectRef=...&gitlabBaseUrl=...
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  router.get('/start', async (req: Request, res: Response) => {
    const { workspaceUuid, hulyProjectRef, gitlabBaseUrl } = req.query

    if (typeof workspaceUuid !== 'string' || workspaceUuid === '') {
      res.status(400).json({ error: 'invalid_request', message: 'Missing workspaceUuid' })
      return
    }
    if (typeof hulyProjectRef !== 'string' || hulyProjectRef === '') {
      res.status(400).json({ error: 'invalid_request', message: 'Missing hulyProjectRef' })
      return
    }
    const rawBaseUrl = typeof gitlabBaseUrl === 'string' && gitlabBaseUrl !== ''
      ? gitlabBaseUrl
      : config.GitLabBaseUrl

    try {
      validateGitLabBaseUrl(rawBaseUrl)
    } catch (err) {
      res.status(400).json({ error: 'invalid gitlabBaseUrl', reason: err instanceof Error ? err.message : String(err) })
      return
    }

    const nonce = randomBytes(16).toString('base64url')
    const codeVerifier = randomBytes(32).toString('base64url')
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')

    const epoch = Date.now()
    const statePayload = `${workspaceUuid}|${hulyProjectRef}|${nonce}|${epoch}`
    const state = signHmac(statePayload, secrets)

    const expiresAt = new Date(epoch + 10 * 60 * 1000)

    try {
      await store.oauthStates().insertOne({
        _id: new ObjectId(),
        state,
        statePayload,
        nonce,
        codeVerifier,
        workspaceUuid,
        hulyProjectRef,
        gitlabBaseUrl: rawBaseUrl,
        expiresAt
      })
    } catch (err) {
      logger.error('oauth: failed to persist state', { err: err instanceof Error ? err.message : String(err) })
      res.status(500).json({ error: 'server_error', message: 'Failed to initiate OAuth flow' })
      return
    }

    const authorizeUrl = new URL(`${rawBaseUrl}/oauth/authorize`)
    authorizeUrl.searchParams.set('client_id', config.GitLabClientId)
    authorizeUrl.searchParams.set('redirect_uri', config.OAuthRedirectUri)
    authorizeUrl.searchParams.set('response_type', 'code')
    authorizeUrl.searchParams.set('state', state)
    authorizeUrl.searchParams.set('scope', 'api')
    authorizeUrl.searchParams.set('code_challenge', codeChallenge)
    authorizeUrl.searchParams.set('code_challenge_method', 'S256')

    res.redirect(302, authorizeUrl.toString())
  })

  // GET /oauth/callback?code=...&state=...
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  router.get('/callback', async (req: Request, res: Response) => {
    const { code, state } = req.query

    if (typeof state !== 'string' || state === '') {
      res.status(400).json({ error: 'invalid_request', message: 'Missing state' })
      return
    }
    if (typeof code !== 'string' || code === '') {
      res.status(400).json({ error: 'invalid_request', message: 'Missing code' })
      return
    }

    const adminStates = store.oauthStates() as unknown as Collection<AdminOAuthStateDoc>
    const stateDoc = await adminStates.findOne({ state, kind: { $ne: 'user' } } as unknown as Partial<AdminOAuthStateDoc>)
    if (stateDoc === null) {
      res.status(404).json({ error: 'not_found', message: 'Unknown or already-used state' })
      return
    }

    // Dual-verify HMAC against primary OR previous secret (grace-period rotation).
    if (verifyHmac(stateDoc.statePayload, state, secrets) === null) {
      await store.oauthStates().deleteOne({ state })
      res.status(401).json({ error: 'invalid_state', message: 'State HMAC verification failed' })
      return
    }

    if (stateDoc.expiresAt.getTime() < Date.now()) {
      res.status(410).json({ error: 'expired', message: 'OAuth state has expired' })
      return
    }

    // Delete the state doc immediately to prevent replay
    await store.oauthStates().deleteOne({ state })

    const { workspaceUuid, hulyProjectRef, gitlabBaseUrl, codeVerifier } = stateDoc

    // Defense-in-depth: validate stored base URL (state row could be stale/tampered)
    try {
      validateGitLabBaseUrl(gitlabBaseUrl)
    } catch (err) {
      res.status(400).json({ error: 'invalid gitlabBaseUrl', reason: err instanceof Error ? err.message : String(err) })
      return
    }

    // Exchange code for tokens
    const tokenUrl = `${gitlabBaseUrl}/oauth/token`
    let tokenResponse: globalThis.Response
    let tokenData: Record<string, unknown>
    try {
      const tokenParams: Record<string, string> = {
        grant_type: 'authorization_code',
        client_id: config.GitLabClientId,
        client_secret: config.GitLabClientSecret,
        code,
        redirect_uri: config.OAuthRedirectUri
      }
      if (typeof codeVerifier === 'string' && codeVerifier !== '') {
        tokenParams.code_verifier = codeVerifier
      }
      tokenResponse = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(tokenParams).toString()
      })
      tokenData = await tokenResponse.json() as Record<string, unknown>
    } catch (err) {
      logger.error('oauth: token exchange network error', { err: err instanceof Error ? err.message : String(err) })
      res.status(400).json({ error: 'token_exchange_failed', message: 'Failed to contact GitLab' })
      return
    }

    if (!tokenResponse.ok) {
      logger.error('oauth: token exchange failed', { status: tokenResponse.status, body: tokenData })
      res.status(400).json({ error: 'token_exchange_failed', message: 'GitLab rejected the authorization code' })
      return
    }

    const accessToken = tokenData.access_token
    const refreshToken = tokenData.refresh_token
    const expiresIn = typeof tokenData.expires_in === 'number' ? tokenData.expires_in : 7200

    if (typeof accessToken !== 'string') {
      logger.error('oauth: token response missing access_token', { body: tokenData })
      res.status(400).json({ error: 'token_exchange_failed', message: 'No access token in response' })
      return
    }

    const expiresAt = new Date(Date.now() + expiresIn * 1000)
    const encryptionKey = Buffer.from(config.CredentialEncryptionKey, 'base64')

    const credentialRef = await putCredential(store.credentials(), encryptionKey, {
      kind: 'oauth',
      plaintext: accessToken,
      refreshTokenPlaintext: typeof refreshToken === 'string' ? refreshToken : undefined,
      expiresAt,
      gitlabBaseUrl,
      workspaceUuid
    })

    logger.info('oauth: credential stored', { credentialRef, workspaceUuid, hulyProjectRef })

    const acceptHeader = req.headers.accept ?? ''
    if (acceptHeader.includes('application/json')) {
      res.status(200).json({ credentialRef, workspaceUuid, hulyProjectRef })
    } else {
      res.status(200).send(
        '<!DOCTYPE html><html><head><title>Connected</title></head><body>' +
        '<h1>GitLab connected successfully</h1>' +
        '<p>You can close this window.</p>' +
        '</body></html>'
      )
    }
  })

  return router
}
