/**
 * B5: `/user/session` — integration point for the Huly platform to mint
 * the HMAC `huly-user` cookie that gates the per-user OAuth flow.
 *
 * Without this endpoint, the entire `/user/oauth/*` flow was unreachable
 * because no other code path called `signCookie`. Operators with their own
 * identity proxy may bypass this endpoint and mint their own cookies using
 * the same `signCookie(serverSecret, …)` helper.
 *
 * Auth model: bearer-protected with the same `ServerSecret` used by
 * `/api/v1/credentials` and `/bindings`. Body: `{ workspaceUuid,
 * hulyPersonUuid, ttlSeconds? }`. Default ttl: 3600 seconds (1 hour).
 *
 * Sets the cookie with `Path=/user`, `HttpOnly`, `SameSite=Strict` and
 * `Secure` when `PublicBaseUrl` is HTTPS.
 */

import { Router as createRouter } from 'express'
import type { Request, Response, Router } from 'express'
import type { Config } from '../config'
import type { Logger } from '../logging'
import { requireBearer } from './auth-middleware'
import { signCookie } from './cookie-auth'

const DEFAULT_TTL_SECONDS = 3600
const MAX_TTL_SECONDS = 24 * 3600

export interface UserSessionRouterDeps {
  config: Config
  logger: Logger
}

export function createUserSessionRouter (deps: UserSessionRouterDeps): Router {
  const { config, logger } = deps
  const router = createRouter()
  const auth = requireBearer(config.ServerSecret)
  const isHttps = config.PublicBaseUrl.startsWith('https://')

  router.post('/session', auth, (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown> | undefined
    const workspaceUuid = body?.workspaceUuid
    const hulyPersonUuid = body?.hulyPersonUuid
    const ttlSeconds = body?.ttlSeconds

    if (typeof workspaceUuid !== 'string' || workspaceUuid === '') {
      res.status(400).json({ error: 'invalid_request', message: 'Missing workspaceUuid' })
      return
    }
    if (typeof hulyPersonUuid !== 'string' || hulyPersonUuid === '') {
      res.status(400).json({ error: 'invalid_request', message: 'Missing hulyPersonUuid' })
      return
    }

    let ttl = DEFAULT_TTL_SECONDS
    if (typeof ttlSeconds === 'number' && Number.isFinite(ttlSeconds) && ttlSeconds > 0) {
      ttl = Math.min(Math.floor(ttlSeconds), MAX_TTL_SECONDS)
    }

    const expiresAt = Date.now() + ttl * 1000
    const cookie = signCookie(
      { workspaceUuid, hulyPersonUuid, expiresAt },
      config.ServerSecret
    )

    const attrs = ['Path=/user', 'HttpOnly', 'SameSite=Strict']
    if (isHttps) attrs.push('Secure')
    attrs.push(`Max-Age=${ttl}`)

    res.setHeader('Set-Cookie', `huly-user=${cookie}; ${attrs.join('; ')}`)
    logger.info('user-session: cookie minted', { workspaceUuid, hulyPersonUuid, ttl })
    res.status(200).json({ ok: true, expiresAt })
  })

  return router
}
