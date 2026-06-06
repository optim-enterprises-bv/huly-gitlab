/**
 * Per-user OAuth router. Phase 4 — companion to the Phase 1 admin oauth router.
 *
 * Routes (mounted under `/user/oauth`):
 *   GET    /start       — cookie-protected; redirects to GitLab /oauth/authorize with PKCE.
 *   GET    /callback    — NOT cookie-protected; identity is taken from the oauth-state row (SCG-3).
 *   GET    /status      — cookie-protected; returns {linked, gitlabBaseUrl, username?, expiresAt?} (SCG-2).
 *   DELETE /credential  — cookie-protected; removes the stored UserCredentialDoc for the requesting user.
 *
 * SCG-3 (callback identity source): the callback MUST NOT re-verify the huly-user cookie. By callback
 * time the user may have lost their cookie (different browser, cleared cookies, etc). The persisted
 * oauth-state row is the authoritative identity carrier for the in-flight OAuth flow.
 *
 * SCG-2 (username capture): immediately after token exchange the callback hits GET /api/v4/user with
 * the freshly-issued bearer token and persists the GitLab username alongside the encrypted token. The
 * /status response surfaces the username field.
 *
 * Bug-6 (bearer transport): bearer tokens are NEVER accepted in the query string. Cookie-auth is the
 * only credential carried on protected routes here. Status/delete are cookie-protected, not
 * bearer-protected, to avoid any code path that could be tempted to read a bearer from the URL.
 */

import { createHmac, randomBytes, createHash } from 'node:crypto'
import { Router as createRouter } from 'express'
import type { Request, Response, Router } from 'express'
import { ObjectId } from 'mongodb'
import type { Collection } from 'mongodb'
import type { WorkspaceUuid, PersonUuid } from '@hcengineering/core'
import type { Config } from '../config'
import type { Store } from '../state/store'
import type { Logger } from '../logging'
import {
  putUserCredential,
  getUserCredential,
  deleteUserCredential
} from '../state/user-credentials'
import { validateGitLabBaseUrl } from '../util/url-validation'
import { requireHulyCookie } from './cookie-auth'
import type { HulyUserAuthRequest } from './cookie-auth'
import { rateLimit } from './rate-limit'

/**
 * Per-user OAuth state document. Wider than the Phase 1 admin OAuthStateDoc — it carries
 * `hulyPersonUuid` and an optional `returnTo`. Persisted into the same `oauth_state` collection
 * with `kind: 'user'` for ergonomic isolation from Phase 1 admin rows (`kind` absent or 'binding').
 */
interface UserOAuthStateDoc {
  _id: ObjectId
  kind: 'user'
  state: string
  nonce: string
  codeVerifier: string
  workspaceUuid: string
  hulyPersonUuid: string
  gitlabBaseUrl: string
  returnTo?: string
  expiresAt: Date
}

export interface UserOAuthRouterDeps {
  config: Config
  store: Store
  logger: Logger
}

function signState (secret: string, workspaceUuid: string, hulyPersonUuid: string, nonce: string, epoch: number): string {
  return createHmac('sha256', secret)
    .update(`user|${workspaceUuid}|${hulyPersonUuid}|${nonce}|${epoch}`)
    .digest('hex')
}

/**
 * B9: returnTo path allowlist. Even when the URL is same-origin we restrict
 * the pathname to known UI entrypoints so an attacker cannot redirect to an
 * arbitrary path that might host an open-redirect or template-injection
 * surface inside the same origin.
 */
const RETURN_TO_ALLOWED_PATHS = ['/user/ui', '/user/ui/']

function isSafeReturnTo (raw: string | undefined, publicBaseUrl: string): string | undefined {
  if (raw === undefined || raw === '') return undefined
  try {
    const url = new URL(raw, publicBaseUrl)
    const base = new URL(publicBaseUrl)
    if (url.origin !== base.origin) return undefined
    const pathOk = RETURN_TO_ALLOWED_PATHS.some(
      (p) => url.pathname === p || url.pathname.startsWith(p)
    )
    if (!pathOk) return undefined
    return url.toString()
  } catch {
    return undefined
  }
}

export function createUserOAuthRouter (deps: UserOAuthRouterDeps): Router {
  const { config, store, logger } = deps
  const router = createRouter()

  const cookieAuth = requireHulyCookie(config.ServerSecret)
  const startRateLimit = rateLimit({ capacity: 10, refillPerSecond: 10 / 60 })

  // GET /start?gitlabBaseUrl=...&returnTo=...
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  router.get('/start', startRateLimit, cookieAuth, async (req: HulyUserAuthRequest, res: Response) => {
    const identity = req.hulyUser
    if (identity === undefined) {
      res.status(401).json({ error: 'huly-user cookie required' })
      return
    }

    const { gitlabBaseUrl, returnTo } = req.query
    if (typeof gitlabBaseUrl !== 'string' || gitlabBaseUrl === '') {
      res.status(400).json({ error: 'invalid_request', message: 'Missing gitlabBaseUrl' })
      return
    }

    try {
      validateGitLabBaseUrl(gitlabBaseUrl)
    } catch (err) {
      res.status(400).json({ error: 'invalid gitlabBaseUrl', reason: err instanceof Error ? err.message : String(err) })
      return
    }

    const safeReturnTo = isSafeReturnTo(typeof returnTo === 'string' ? returnTo : undefined, config.PublicBaseUrl)

    const nonce = randomBytes(16).toString('base64url')
    const codeVerifier = randomBytes(32).toString('base64url')
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')

    const epoch = Date.now()
    const state = signState(config.ServerSecret, identity.workspaceUuid, identity.hulyPersonUuid, nonce, epoch)
    const expiresAt = new Date(epoch + 10 * 60 * 1000)

    const userOAuthStates = store.oauthStates() as unknown as Collection<UserOAuthStateDoc>
    const stateDoc: UserOAuthStateDoc = {
      _id: new ObjectId(),
      kind: 'user',
      state,
      nonce,
      codeVerifier,
      workspaceUuid: identity.workspaceUuid,
      hulyPersonUuid: identity.hulyPersonUuid,
      gitlabBaseUrl,
      expiresAt
    }
    if (safeReturnTo !== undefined) {
      stateDoc.returnTo = safeReturnTo
    }

    try {
      await userOAuthStates.insertOne(stateDoc)
    } catch (err) {
      logger.error('user-oauth: failed to persist state', { err: err instanceof Error ? err.message : String(err) })
      res.status(500).json({ error: 'server_error', message: 'Failed to initiate OAuth flow' })
      return
    }

    const callbackUri = `${config.PublicBaseUrl}/user/oauth/callback`
    const authorizeUrl = new URL(`${gitlabBaseUrl}/oauth/authorize`)
    authorizeUrl.searchParams.set('client_id', config.GitLabClientId)
    authorizeUrl.searchParams.set('redirect_uri', callbackUri)
    authorizeUrl.searchParams.set('response_type', 'code')
    authorizeUrl.searchParams.set('state', state)
    authorizeUrl.searchParams.set('scope', 'api')
    authorizeUrl.searchParams.set('code_challenge', codeChallenge)
    authorizeUrl.searchParams.set('code_challenge_method', 'S256')

    res.redirect(302, authorizeUrl.toString())
  })

  // GET /callback?code=...&state=...
  // SCG-3: identity comes from the oauth-state row, NOT from a re-verified cookie.
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  router.get('/callback', async (req: Request, res: Response) => {
    const { code, state } = req.query

    if (typeof state !== 'string' || state === '') {
      res.status(401).json({ error: 'invalid_state', message: 'Missing state' })
      return
    }
    if (typeof code !== 'string' || code === '') {
      res.status(400).json({ error: 'invalid_request', message: 'Missing code' })
      return
    }

    const userOAuthStates = store.oauthStates() as unknown as Collection<UserOAuthStateDoc>
    const filter: Partial<UserOAuthStateDoc> = { state, kind: 'user' }
    const stateDoc = await userOAuthStates.findOne(filter)
    if (stateDoc === null) {
      res.status(401).json({ error: 'invalid_state', message: 'Unknown or already-used state' })
      return
    }
    if (stateDoc.expiresAt.getTime() < Date.now()) {
      await userOAuthStates.deleteOne({ _id: stateDoc._id })
      res.status(410).json({ error: 'expired', message: 'OAuth state has expired' })
      return
    }

    // Delete the state doc immediately to prevent replay.
    await userOAuthStates.deleteOne({ _id: stateDoc._id })

    const { workspaceUuid, hulyPersonUuid, gitlabBaseUrl, codeVerifier, returnTo } = stateDoc

    // Defense-in-depth: validate stored base URL.
    try {
      validateGitLabBaseUrl(gitlabBaseUrl)
    } catch (err) {
      res.status(400).json({ error: 'invalid gitlabBaseUrl', reason: err instanceof Error ? err.message : String(err) })
      return
    }

    // Exchange code for tokens.
    const callbackUri = `${config.PublicBaseUrl}/user/oauth/callback`
    const tokenUrl = `${gitlabBaseUrl}/oauth/token`
    let tokenResponse: globalThis.Response
    let tokenData: Record<string, unknown>
    try {
      const tokenParams: Record<string, string> = {
        grant_type: 'authorization_code',
        client_id: config.GitLabClientId,
        client_secret: config.GitLabClientSecret,
        code,
        redirect_uri: callbackUri,
        code_verifier: codeVerifier
      }
      tokenResponse = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(tokenParams).toString()
      })
      tokenData = await tokenResponse.json() as Record<string, unknown>
    } catch (err) {
      logger.error('user-oauth: token exchange network error', { err: err instanceof Error ? err.message : String(err) })
      res.status(400).json({ error: 'token_exchange_failed', message: 'Failed to contact GitLab' })
      return
    }

    if (!tokenResponse.ok) {
      logger.error('user-oauth: token exchange failed', { status: tokenResponse.status })
      res.status(400).json({ error: 'token_exchange_failed', message: 'GitLab rejected the authorization code' })
      return
    }

    const accessToken = tokenData.access_token
    const refreshToken = tokenData.refresh_token
    const expiresIn = typeof tokenData.expires_in === 'number' ? tokenData.expires_in : 7200

    if (typeof accessToken !== 'string' || accessToken === '') {
      logger.error('user-oauth: token response missing access_token')
      res.status(400).json({ error: 'token_exchange_failed', message: 'No access token in response' })
      return
    }

    // SCG-2: fetch the GitLab username so the /status response can surface it.
    let username: string
    try {
      const userResponse = await fetch(`${gitlabBaseUrl}/api/v4/user`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}` }
      })
      if (!userResponse.ok) {
        logger.error('user-oauth: user lookup failed', { status: userResponse.status })
        res.status(400).json({ error: 'user_lookup_failed', message: 'Failed to look up GitLab user' })
        return
      }
      const userData = await userResponse.json() as Record<string, unknown>
      if (typeof userData.username !== 'string' || userData.username === '') {
        logger.error('user-oauth: user response missing username')
        res.status(400).json({ error: 'user_lookup_failed', message: 'GitLab user response missing username' })
        return
      }
      username = userData.username
    } catch (err) {
      logger.error('user-oauth: user lookup network error', { err: err instanceof Error ? err.message : String(err) })
      res.status(400).json({ error: 'user_lookup_failed', message: 'Failed to contact GitLab' })
      return
    }

    const expiresAt = new Date(Date.now() + expiresIn * 1000)
    const encryptionKey = Buffer.from(config.CredentialEncryptionKey, 'base64')

    try {
      await putUserCredential(store.userCredentials(), encryptionKey, {
        workspaceUuid: workspaceUuid as WorkspaceUuid,
        hulyPersonUuid: hulyPersonUuid as PersonUuid,
        gitlabBaseUrl,
        username,
        accessToken,
        refreshToken: typeof refreshToken === 'string' ? refreshToken : undefined,
        expiresAt
      })
    } catch (err) {
      logger.error('user-oauth: failed to persist credential', { err: err instanceof Error ? err.message : String(err) })
      res.status(500).json({ error: 'server_error', message: 'Failed to persist credential' })
      return
    }

    logger.info('user-oauth: credential stored', { workspaceUuid, hulyPersonUuid, gitlabBaseUrl, username })

    if (returnTo !== undefined && returnTo !== '') {
      res.redirect(302, returnTo)
      return
    }

    const acceptHeader = req.headers.accept ?? ''
    if (acceptHeader.includes('application/json')) {
      res.status(200).json({ linked: true, gitlabBaseUrl, username, expiresAt: expiresAt.toISOString() })
    } else {
      // B10: lock down the inline success HTML with strict CSP + nosniff.
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'none'; style-src 'self' 'unsafe-inline'"
      )
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.status(200).send(
        '<!DOCTYPE html><html><head><title>Connected</title></head><body>' +
        '<h1>GitLab connected successfully</h1>' +
        `<p>Linked as <strong>${escapeHtml(username)}</strong> on <code>${escapeHtml(gitlabBaseUrl)}</code>.</p>` +
        '<p>You can close this window.</p>' +
        '</body></html>'
      )
    }
  })

  // GET /status?gitlabBaseUrl=...
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  router.get('/status', cookieAuth, async (req: HulyUserAuthRequest, res: Response) => {
    const identity = req.hulyUser
    if (identity === undefined) {
      res.status(401).json({ error: 'huly-user cookie required' })
      return
    }

    const { gitlabBaseUrl } = req.query
    if (typeof gitlabBaseUrl !== 'string' || gitlabBaseUrl === '') {
      res.status(400).json({ error: 'invalid_request', message: 'Missing gitlabBaseUrl' })
      return
    }

    try {
      validateGitLabBaseUrl(gitlabBaseUrl)
    } catch (err) {
      res.status(400).json({ error: 'invalid gitlabBaseUrl', reason: err instanceof Error ? err.message : String(err) })
      return
    }

    const encryptionKey = Buffer.from(config.CredentialEncryptionKey, 'base64')
    const credential = await getUserCredential(
      store.userCredentials(),
      encryptionKey,
      identity.workspaceUuid as WorkspaceUuid,
      identity.hulyPersonUuid as PersonUuid,
      gitlabBaseUrl
    )

    if (credential === null) {
      res.status(200).json({ linked: false, gitlabBaseUrl })
      return
    }

    res.status(200).json({
      linked: true,
      gitlabBaseUrl: credential.gitlabBaseUrl,
      username: credential.username,
      expiresAt: credential.expiresAt !== null ? credential.expiresAt.toISOString() : null
    })
  })

  // DELETE /credential — body: { gitlabBaseUrl }
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  router.delete('/credential', cookieAuth, async (req: HulyUserAuthRequest, res: Response) => {
    const identity = req.hulyUser
    if (identity === undefined) {
      res.status(401).json({ error: 'huly-user cookie required' })
      return
    }

    const body = req.body as Record<string, unknown> | undefined
    const gitlabBaseUrl = body?.gitlabBaseUrl
    if (typeof gitlabBaseUrl !== 'string' || gitlabBaseUrl === '') {
      res.status(400).json({ error: 'invalid_request', message: 'Missing gitlabBaseUrl' })
      return
    }

    try {
      validateGitLabBaseUrl(gitlabBaseUrl)
    } catch (err) {
      res.status(400).json({ error: 'invalid gitlabBaseUrl', reason: err instanceof Error ? err.message : String(err) })
      return
    }

    const deleted = await deleteUserCredential(
      store.userCredentials(),
      identity.workspaceUuid as WorkspaceUuid,
      identity.hulyPersonUuid as PersonUuid,
      gitlabBaseUrl
    )

    res.status(200).json({ deleted })
  })

  return router
}

function escapeHtml (raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
