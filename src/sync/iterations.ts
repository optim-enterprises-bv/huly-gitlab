import type { GitLabClient } from '../adapter/gitlab-client'
import type { SyncIteration } from '../adapter/types'

export interface IterationCacheEntry {
  byId: Map<string, SyncIteration>
  byTitle: Map<string, SyncIteration>
  cachedAt: number
}

/**
 * In-memory cache for GitLab iterations, keyed by `${gitlabBaseUrl}:${topGroupId}`.
 *
 * Iterations are EE-only group-level objects that are assigned to MRs.
 * This cache is populated during MR backfill and reused by MergeRequestsSyncManager
 * to resolve the `iteration` field on the MR mixin without repeated API calls.
 *
 * SLA note (Bug-7): iteration-only changes propagate within ≤ 5 min via backfill,
 * NOT 30 s. The default TTL of 5 minutes is intentional — GitLab iteration assignments
 * on MRs are low-frequency and do not require sub-minute freshness.
 */
export class IterationsCache {
  private readonly cache = new Map<string, IterationCacheEntry>()
  private readonly ttlMs: number

  constructor (ttlMs = 5 * 60 * 1000) {
    this.ttlMs = ttlMs
  }

  /**
   * Return all iterations for the given top-level group, using the cache when fresh.
   *
   * On a cache miss (first call or post-TTL), calls `client.listIterations(topGroupId)`
   * and stores results indexed by both `id` and `title`.
   */
  async list (client: GitLabClient, gitlabBaseUrl: string, topGroupId: number): Promise<SyncIteration[]> {
    const key = `${gitlabBaseUrl}:${topGroupId}`
    const entry = this.cache.get(key)
    if (entry !== undefined && Date.now() - entry.cachedAt < this.ttlMs) {
      return [...entry.byId.values()]
    }
    const iterations = await client.listIterations(topGroupId)
    const byId = new Map<string, SyncIteration>()
    const byTitle = new Map<string, SyncIteration>()
    for (const it of iterations) {
      byId.set(it.id, it)
      byTitle.set(it.title, it)
    }
    this.cache.set(key, { byId, byTitle, cachedAt: Date.now() })
    return iterations
  }

  /**
   * Look up a single iteration by its string id.
   * Returns `undefined` when the id is not found in the group's iteration list.
   */
  async getById (
    client: GitLabClient,
    gitlabBaseUrl: string,
    topGroupId: number,
    id: string
  ): Promise<SyncIteration | undefined> {
    const key = `${gitlabBaseUrl}:${topGroupId}`
    const entry = this.cache.get(key)
    if (entry !== undefined && Date.now() - entry.cachedAt < this.ttlMs) {
      return entry.byId.get(id)
    }
    await this.list(client, gitlabBaseUrl, topGroupId)
    return this.cache.get(key)?.byId.get(id)
  }

  /**
   * Invalidate cached entries.
   *
   * - `invalidate(baseUrl, topGroupId)` — clears the single entry for that key.
   * - `invalidate()` — clears all entries.
   */
  invalidate (gitlabBaseUrl?: string, topGroupId?: number): void {
    if (gitlabBaseUrl !== undefined && topGroupId !== undefined) {
      this.cache.delete(`${gitlabBaseUrl}:${topGroupId}`)
    } else {
      this.cache.clear()
    }
  }
}
