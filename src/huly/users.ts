import type { PersonUuid, WorkspaceUuid } from '@hcengineering/core'
import type { AccountClient } from '@hcengineering/account-client'

/**
 * Social key formats (frozen contract):
 *   - OAuth-authenticated GitLab user: `gitlab:{oauth_subject}` (immutable sub claim)
 *   - Email-matched (no OAuth):        `email:{lowercased_email}`
 */
const SOCIAL_KEY_GITLAB = (id: string): string => `gitlab:${id}`
const SOCIAL_KEY_EMAIL = (email: string): string => `email:${email.toLowerCase()}`

export interface SyncUser {
  gitlabId: string
  email?: string
  name?: string
  username?: string
}

/**
 * Minimal store interface used by UserIdentity for guest stub persistence.
 * The real Store passes its idmap collection wrappers; tests pass jest stubs.
 */
export interface IdMapStore {
  getIdMap: (workspaceUuid: string, gitlabKind: string, gitlabId: string) => Promise<string | undefined>
  putIdMap: (workspaceUuid: string, gitlabKind: string, gitlabId: string, hulyRef: string) => Promise<void>
}

interface CacheEntry {
  value: PersonUuid | undefined
  expiresAt: number
}

export class UserIdentity {
  private readonly cache = new Map<string, CacheEntry>()

  constructor (
    private readonly accountClient: AccountClient,
    private readonly store: IdMapStore,
    private readonly workspaceUuid: WorkspaceUuid,
    private readonly ttlMs: number = 5 * 60 * 1000
  ) {}

  async mapByEmail (email: string): Promise<PersonUuid | undefined> {
    const key = SOCIAL_KEY_EMAIL(email)
    return await this.lookupCached(key)
  }

  async mapByGitlabUser (user: SyncUser): Promise<PersonUuid | undefined> {
    const gitlabKey = SOCIAL_KEY_GITLAB(user.gitlabId)
    const byGitlab = await this.lookupCached(gitlabKey)
    if (byGitlab !== undefined) {
      return byGitlab
    }

    if (user.email !== undefined) {
      return await this.mapByEmail(user.email)
    }

    return undefined
  }

  /**
   * Returns an existing stub PersonUuid from idmap, or records a new stub mapping.
   * Deduplicates by gitlabId (R9 dedup): if a mapping already exists, returns it unchanged.
   */
  async ensureStubGuest (user: SyncUser): Promise<string> {
    const existing = await this.store.getIdMap(this.workspaceUuid, 'user', user.gitlabId)
    if (existing !== undefined) {
      return existing
    }

    // Stub ref: a deterministic placeholder referencing the gitlab user
    const stubRef = `stub:gitlab:${user.gitlabId}`
    await this.store.putIdMap(this.workspaceUuid, 'user', user.gitlabId, stubRef)
    return stubRef
  }

  invalidate (key?: string): void {
    if (key !== undefined) {
      this.cache.delete(key)
    } else {
      this.cache.clear()
    }
  }

  private async lookupCached (socialKey: string): Promise<PersonUuid | undefined> {
    const now = Date.now()
    const cached = this.cache.get(socialKey)
    if (cached !== undefined && now < cached.expiresAt) {
      return cached.value
    }

    const value = await this.accountClient.findPersonBySocialKey(socialKey)
    this.cache.set(socialKey, { value, expiresAt: now + this.ttlMs })
    return value
  }
}
