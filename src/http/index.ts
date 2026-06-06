import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import bodyParser from 'body-parser'
import path from 'node:path'
import type { Config } from '../config'
import type { Store } from '../state/store'
import type { SyncEngine } from '../sync/engine'
import type { Logger } from '../logging'
import type { CredentialResolver } from '../auth'
import type { BindingLifecycleService } from '../sync/binding-lifecycle'
import type { BindingLoader } from '../sync/binding-loader'
import { createHealthRouter } from './health'
import { createWebhookRouter } from './webhook'
import { createBindingRouter } from './binding'
import { createOAuthRouter } from './oauth'
import { createUserOAuthRouter } from './user-oauth'
import { createUserSessionRouter } from './user-session'
import { createCredentialsRouter } from '../auth'

export interface AppDependencies {
  config: Config
  store: Store
  syncEngine: SyncEngine
  logger: Logger
  credentialResolver?: CredentialResolver
  bindingLifecycle?: BindingLifecycleService
  bindingLoader?: BindingLoader
}

export function createApp (deps: AppDependencies): express.Express {
  const { config, store, syncEngine, logger } = deps
  const app = express()

  // B7: configure trust-proxy when running behind a reverse proxy so `req.ip`
  // and `X-Forwarded-*` headers reflect the real client. Unset → default false.
  if (config.TrustProxy !== undefined) {
    app.set('trust proxy', config.TrustProxy)
  }

  // Parse encryption key once
  const encryptionKey = Buffer.from(config.CredentialEncryptionKey, 'base64')

  // Security headers — must come before any route mount.
  app.use(helmet())

  // CORS: locked down to the explicit allow-list from CORS_ALLOWED_ORIGINS.
  // Empty list disables CORS (no Access-Control-Allow-Origin emitted).
  const allowedOrigins = config.CorsAllowedOrigins
  if (allowedOrigins.length > 0) {
    app.use(cors({ origin: allowedOrigins, credentials: false }))
  } else {
    app.use(cors({ origin: false, credentials: false }))
  }

  app.use(bodyParser.json({ limit: '5mb' }))

  // Request logger middleware
  app.use((req, _res, next) => {
    logger.debug('http: incoming request', { method: req.method, path: req.path })
    next()
  })

  // Health route
  app.use(createHealthRouter(store, logger))

  // Webhook route
  app.use(createWebhookRouter(store, syncEngine, encryptionKey, logger))

  // Binding admin routes
  app.use(createBindingRouter(
    store,
    encryptionKey,
    config.ServerSecret,
    logger,
    deps.bindingLifecycle,
    config.PublicBaseUrl,
    deps.bindingLoader
  ))

  // Shared secret-rotation config for HMAC dual-verify across cookie + state surfaces.
  const secrets = { primary: config.ServerSecret, previous: config.ServerSecretPrevious }

  // OAuth routes
  app.use('/oauth', createOAuthRouter({ config, store, logger, secrets }))

  // Per-user OAuth routes (Phase 4 — cookie-auth + rate-limit + GitLab user lookup).
  app.use('/user/oauth', createUserOAuthRouter({ config, store, logger, secrets }))

  // B5: cookie-mint endpoint (bearer-protected). Platform integration point.
  app.use('/user', createUserSessionRouter({ config, logger }))

  // Credentials admin routes (access-token + list)
  app.use('/api/v1/credentials', createCredentialsRouter({ config, store, logger }))

  // User UI static files with CSP headers (Bug-6)
  app.use('/user/ui', express.static(path.join(__dirname, '..', 'public', 'user-ui'), {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) {
        res.setHeader(
          'Content-Security-Policy',
          "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'"
        )
      }
    }
  }))

  // Error handler middleware — log full err with stack; never leak details to clients.
  app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const errObj = err instanceof Error
      ? { message: err.message, stack: err.stack }
      : { message: String(err) }
    logger.error('http: unhandled error', { path: req.path, ...errObj })
    res.status(500).json({ error: 'Internal server error' })
  })

  return app
}
