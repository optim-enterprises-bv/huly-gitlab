import type { SyncMergeRequest } from '../adapter/types'
import { BiDirectionalCache } from './bi-directional-cache'

/**
 * Minimal GitLab client surface used by MRCache.
 * Decoupled from the full GitLabClient so tests can pass a tiny fake.
 */
export interface MRGitLabClient {
  listMergeRequests: (projectId: number | string) => Promise<SyncMergeRequest[]>
}

/**
 * Per-binding cache of GitLab merge requests keyed by iid.
 *
 * getMR: iid → SyncMergeRequest (primes from GitLab on first call)
 * invalidate: clears the whole cache or a single entry
 */
export class MRCache {
  private readonly byIid: BiDirectionalCache<number, SyncMergeRequest>
  private primed = false

  constructor (private readonly gitlabProjectId: number | string) {
    // Primer is never used via BiDirectionalCache.get() — we manage priming manually
    // so that we can pass the client at call time.
    this.byIid = new BiDirectionalCache({ loadAll: async () => [] })
  }

  /**
   * Look up a merge request by iid. Primes from GitLab on first call.
   */
  async getMR (
    client: MRGitLabClient,
    iid: number
  ): Promise<SyncMergeRequest | undefined> {
    await this.prime(client)
    return await this.byIid.get(iid)
  }

  /**
   * Evict a single iid from the cache, or clear everything when called with no argument.
   */
  invalidate (iid?: number): void {
    if (iid === undefined) {
      this.byIid.invalidate()
      this.primed = false
    } else {
      this.byIid.invalidate(iid)
    }
  }

  /**
   * Test helper: seed cache without hitting any backing store.
   */
  primeSync (mrs: readonly SyncMergeRequest[]): void {
    this.byIid.primeSync(mrs.map(mr => ({ key: mr.iid, value: mr })))
    this.primed = true
  }

  private async prime (client: MRGitLabClient): Promise<void> {
    if (this.primed) return
    const mrs = await client.listMergeRequests(this.gitlabProjectId)
    this.byIid.primeSync(mrs.map(mr => ({ key: mr.iid, value: mr })))
    this.primed = true
  }
}
