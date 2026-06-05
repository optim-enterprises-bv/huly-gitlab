import { Router as createRouter } from 'express'
import type { Request, Response, Router } from 'express'
import type { Store } from '../state/store'
import type { Logger } from '../logging'
import type { Config } from '../config'
import { getCredential } from '../state/credentials'
import { requireBearer } from '../http/auth-middleware'
import { createAccessTokenRouter } from './access-token'

export { OAuthRefresher } from './refresh'
export type { OAuthRefresherDeps } from './refresh'

export interface CredentialSummary {
  credentialRef: string
  kind: string
  createdAt: Date
  expiresAt?: Date
  workspaceUuid?: string
  gitlabBaseUrl?: string
}

export interface ResolvedCredential {
  kind: string
  token: string
  expiresAt?: Date
  gitlabBaseUrl?: string
}

export interface CredentialResolverDeps {
  store: Store
  encryptionKey: Buffer
}

export class CredentialResolver {
  private readonly store: Store
  private readonly encryptionKey: Buffer

  constructor (deps: CredentialResolverDeps) {
    this.store = deps.store
    this.encryptionKey = deps.encryptionKey
  }

  async resolve (credentialRef: string): Promise<ResolvedCredential | null> {
    const result = await getCredential(this.store.credentials(), this.encryptionKey, credentialRef)
    if (result === null) return null
    return {
      kind: result.kind,
      token: result.plaintext,
      expiresAt: result.expiresAt,
      gitlabBaseUrl: undefined
    }
  }

  async list (filter?: { workspaceUuid?: string }): Promise<CredentialSummary[]> {
    const query: Record<string, unknown> = {}
    if (filter?.workspaceUuid !== undefined) {
      query.workspaceUuid = filter.workspaceUuid
    }
    const docs = await this.store.credentials().find(query, {
      projection: {
        _id: 1,
        kind: 1,
        createdAt: 1,
        expiresAt: 1,
        workspaceUuid: 1,
        gitlabBaseUrl: 1
        // Intentionally excludes ciphertext, iv, tag, refreshToken* fields
      }
    }).toArray()

    return docs.map(doc => {
      const summary: CredentialSummary = {
        credentialRef: doc._id.toHexString(),
        kind: doc.kind,
        createdAt: doc.createdAt
      }
      if (doc.expiresAt !== undefined) summary.expiresAt = doc.expiresAt
      if (doc.workspaceUuid !== undefined) summary.workspaceUuid = doc.workspaceUuid
      if (doc.gitlabBaseUrl !== undefined) summary.gitlabBaseUrl = doc.gitlabBaseUrl
      return summary
    })
  }
}

export interface CredentialsRouterDeps {
  config: Config
  store: Store
  logger: Logger
}

export function createCredentialsRouter (deps: CredentialsRouterDeps): Router {
  const { config, store, logger } = deps
  const router = createRouter()
  const auth = requireBearer(config.ServerSecret)

  // Mount access-token sub-router at /access-token
  router.use('/access-token', createAccessTokenRouter(config, store, logger))

  // GET /api/v1/credentials — admin list view
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  router.get('/', auth, async (req: Request, res: Response) => {
    const workspaceUuid = typeof req.query.workspaceUuid === 'string' ? req.query.workspaceUuid : undefined
    const encryptionKey = Buffer.from(config.CredentialEncryptionKey, 'base64')
    const resolver = new CredentialResolver({ store, encryptionKey })
    const list = await resolver.list({ workspaceUuid })
    res.status(200).json(list)
  })

  return router
}
