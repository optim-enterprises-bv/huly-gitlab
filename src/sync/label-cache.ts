import type { Ref, Space, TxOperations } from '@hcengineering/core'
import tags, { type TagElement } from '@hcengineering/tags'
import tracker, { type Issue } from '@hcengineering/tracker'
import type { SyncLabel } from '../adapter/types'

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
  private readonly remoteByName = new Map<string, SyncLabel>()
  private readonly localByName = new Map<string, Ref<TagElement>>()
  private remoteLoaded = false
  private localLoaded = false

  constructor (
    private readonly gitlabProjectId: number | string,
    private readonly hulyProjectRef: Ref<Space>
  ) {}

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
    const existing = this.remoteByName.get(key)
    if (existing !== undefined) return existing

    const created = await client.createLabel(this.gitlabProjectId, { name, color })
    this.remoteByName.set(key, created)
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
    const existing = this.localByName.get(key)
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
    this.localByName.set(key, ref)
    return ref
  }

  /**
   * Test helper: seed cache without hitting any backing store.
   */
  primeRemoteSync (labels: readonly SyncLabel[]): void {
    for (const l of labels) {
      this.remoteByName.set(l.name.toLowerCase(), l)
    }
    this.remoteLoaded = true
  }

  primeLocalSync (entries: ReadonlyArray<{ name: string, ref: Ref<TagElement> }>): void {
    for (const e of entries) {
      this.localByName.set(e.name.toLowerCase(), e.ref)
    }
    this.localLoaded = true
  }

  private async primeRemote (client: LabelGitLabClient): Promise<void> {
    if (this.remoteLoaded) return
    const labels = await client.listLabels(this.gitlabProjectId)
    for (const l of labels) {
      this.remoteByName.set(l.name.toLowerCase(), l)
    }
    this.remoteLoaded = true
  }

  private async primeLocal (ops: TxOperations): Promise<void> {
    if (this.localLoaded) return
    const found = await ops.findAll<TagElement>(tags.class.TagElement, {})
    const issueClassRef = String(tracker.class.Issue)
    for (const t of found) {
      // Scope to issues on this project. Ref is a branded string at runtime.
      if (String(t.targetClass) === issueClassRef) {
        this.localByName.set(t.title.toLowerCase(), t._id)
      }
    }
    this.localLoaded = true
  }
}

export type { Issue }
