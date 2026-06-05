import { Router as createRouter } from 'express'
import type { Request, Response, Router } from 'express'
import type { Config } from '../config'
import type { Store } from '../state/store'
import type { Logger } from '../logging'
import { putCredential } from '../state/credentials'
import { requireBearer } from '../http/auth-middleware'
import { validateGitLabBaseUrl } from '../util/url-validation'

interface AccessTokenBody {
  gitlabBaseUrl: string
  token: string
  scope: 'group' | 'project'
  resourceId: string | number
}

export function createAccessTokenRouter (
  config: Config,
  store: Store,
  logger: Logger
): Router {
  const router = createRouter()
  const auth = requireBearer(config.ServerSecret)
  const encryptionKey = Buffer.from(config.CredentialEncryptionKey, 'base64')

  // POST /api/v1/credentials/access-token
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  router.post('/', auth, async (req: Request, res: Response) => {
    const body = req.body as Partial<AccessTokenBody>

    if (typeof body.token !== 'string' || body.token === '') {
      res.status(400).json({ error: 'invalid_request', message: 'Missing token' })
      return
    }
    if (typeof body.gitlabBaseUrl !== 'string' || body.gitlabBaseUrl === '') {
      res.status(400).json({ error: 'invalid_request', message: 'Missing gitlabBaseUrl' })
      return
    }
    if (body.scope !== 'group' && body.scope !== 'project') {
      res.status(400).json({ error: 'invalid_request', message: 'scope must be group or project' })
      return
    }

    const gitlabBaseUrl = body.gitlabBaseUrl
    const token = body.token

    // Validate the base URL before making any outbound request
    try {
      validateGitLabBaseUrl(gitlabBaseUrl)
    } catch (err) {
      res.status(400).json({ error: 'invalid gitlabBaseUrl', reason: err instanceof Error ? err.message : String(err) })
      return
    }

    // Validate token against GitLab
    let validateResponse: globalThis.Response
    try {
      validateResponse = await fetch(`${gitlabBaseUrl}/api/v4/user`, {
        headers: { 'PRIVATE-TOKEN': token }
      })
    } catch (err) {
      logger.error('access-token: validation network error', { err: err instanceof Error ? err.message : String(err) })
      res.status(502).json({ error: 'upstream_error', message: 'Failed to reach GitLab' })
      return
    }

    if (validateResponse.status === 401) {
      logger.warn('access-token: token rejected by GitLab', { gitlabBaseUrl })
      res.status(400).json({ error: 'invalid_token', message: 'GitLab rejected the token' })
      return
    }

    if (!validateResponse.ok) {
      logger.error('access-token: GitLab returned unexpected status', { status: validateResponse.status })
      res.status(502).json({ error: 'upstream_error', message: `GitLab returned ${validateResponse.status}` })
      return
    }

    const credentialRef = await putCredential(store.credentials(), encryptionKey, {
      kind: 'access_token',
      plaintext: token,
      gitlabBaseUrl
    })

    logger.info('access-token: credential stored', { credentialRef, gitlabBaseUrl })
    res.status(201).json({ credentialRef })
  })

  return router
}
