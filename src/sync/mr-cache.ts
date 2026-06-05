import type { SyncMergeRequest } from '../adapter/types'

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
  private readonly byIid = new Map<number, SyncMergeRequest>()
  private primed = false

  constructor (private readonly gitlabProjectId: number | string) {}

  /**
   * Look up a merge request by iid. Primes from GitLab on first call.
   */
  async getMR (
    client: MRGitLabClient,
    iid: number
  ): Promise<SyncMergeRequest | undefined> {
    await this.prime(client)
    return this.byIid.get(iid)
  }

  /**
   * Evict a single iid from the cache, or clear everything when called with no argument.
   */
  invalidate (iid?: number): void {
    if (iid === undefined) {
      this.byIid.clear()
      this.primed = false
    } else {
      this.byIid.delete(iid)
    }
  }

  /**
   * Test helper: seed cache without hitting any backing store.
   */
  primeSync (mrs: readonly SyncMergeRequest[]): void {
    for (const mr of mrs) {
      this.byIid.set(mr.iid, mr)
    }
    this.primed = true
  }

  private async prime (client: MRGitLabClient): Promise<void> {
    if (this.primed) return
    const mrs = await client.listMergeRequests(this.gitlabProjectId)
    for (const mr of mrs) {
      this.byIid.set(mr.iid, mr)
    }
    this.primed = true
  }
}
