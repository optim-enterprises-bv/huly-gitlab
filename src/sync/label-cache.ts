import type { Ref, Space, TxOperations } from '@hcengineering/core'
import tags, { type TagElement } from '@hcengineering/tags'
import tracker, { type Issue } from '@hcengineering/tracker'
import type { SyncLabel } from '../adapter/types'
import { BiDirectionalCache } from './bi-directional-cache'

/**
 * Minimal GitLab client surface used by LabelCache.
 * Decoupled from the full GitLabClient so tests can pass a tiny fake.
 */
export interface LabelGitLabClient {
  listLabels: (projectId: number | string) => Promise<SyncLabel[]>
  createLabel: (
    projectId: number | string,
    body: { name: string, color: string, description?: string }
  ) => Promise<SyncLabel>
}

/**
 * Per-binding cache of GitLab labels and Huly tag elements.
 *
 * Two directions:
 *   - ensureRemoteLabel: name → SyncLabel (creates on GitLab if missing)
 *   - ensureLocalTag:    name → Ref<TagElement> (creates on Huly if missing)
 *
 * The cache is keyed by lowercase label name to be case-insensitive on lookups.
 */
export class LabelCache {
  private readonly remoteByName: BiDirectionalCache<string, SyncLabel>
  private readonly localByName: BiDirectionalCache<string, Ref<TagElement>>
  private remoteLoaded = false
  private localLoaded = false

  constructor (
    private readonly gitlabProjectId: number | string,
    private readonly hulyProjectRef: Ref<Space>
  ) {
    this.remoteByName = new BiDirectionalCache({ loadAll: async () => [] })
    this.localByName = new BiDirectionalCache({ loadAll: async () => [] })
  }

  /**
   * Get-or-create a GitLab label by name. Reuses the per-binding cache after the first
   * listLabels call to avoid round-tripping the GitLab API on every lookup.
   */
  async ensureRemoteLabel (
    client: LabelGitLabClient,
    name: string,
    color: string = '#A0A0A0'
  ): Promise<SyncLabel> {
    await this.primeRemote(client)
    const key = name.toLowerCase()
    const existing = await this.remoteByName.get(key)
    if (existing !== undefined) return existing

    const created = await client.createLabel(this.gitlabProjectId, { name, color })
    this.remoteByName.put(key, created)
    return created
  }

  /**
   * Get-or-create a Huly TagElement under the bound project.
   */
  async ensureLocalTag (
    ops: TxOperations,
    name: string,
    color: number = 0
  ): Promise<Ref<TagElement>> {
    await this.primeLocal(ops)
    const key = name.toLowerCase()
    const existing = await this.localByName.get(key)
    if (existing !== undefined) return existing

    const ref = await ops.createDoc<TagElement>(
      tags.class.TagElement,
      this.hulyProjectRef,
      {
        title: name,
        targetClass: tracker.class.Issue,
        color
      }
    )
    this.localByName.put(key, ref)
    return ref
  }

  /**
   * Test helper: seed cache without hitting any backing store.
   */
  primeRemoteSync (labels: readonly SyncLabel[]): void {
    this.remoteByName.primeSync(labels.map(l => ({ key: l.name.toLowerCase(), value: l })))
    this.remoteLoaded = true
  }

  primeLocalSync (entries: ReadonlyArray<{ name: string, ref: Ref<TagElement> }>): void {
    this.localByName.primeSync(entries.map(e => ({ key: e.name.toLowerCase(), value: e.ref })))
    this.localLoaded = true
  }

  private async primeRemote (client: LabelGitLabClient): Promise<void> {
    if (this.remoteLoaded) return
    const labels = await client.listLabels(this.gitlabProjectId)
    this.remoteByName.primeSync(labels.map(l => ({ key: l.name.toLowerCase(), value: l })))
    this.remoteLoaded = true
  }

  private async primeLocal (ops: TxOperations): Promise<void> {
    if (this.localLoaded) return
    const found = await ops.findAll<TagElement>(tags.class.TagElement, {})
    const issueClassRef = String(tracker.class.Issue)
    const entries: Array<{ key: string, value: Ref<TagElement> }> = []
    for (const t of found) {
      if (String(t.targetClass) === issueClassRef) {
        entries.push({ key: t.title.toLowerCase(), value: t._id })
      }
    }
    this.localByName.primeSync(entries)
    this.localLoaded = true
  }
}

export type { Issue }
