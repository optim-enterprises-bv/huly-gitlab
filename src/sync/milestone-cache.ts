import type { Ref, Space, TxOperations } from '@hcengineering/core'
import tracker, { type Milestone } from '@hcengineering/tracker'
import type { SyncMilestone } from '../adapter/types'
import { BiDirectionalCache } from './bi-directional-cache'

/**
 * Minimal GitLab client surface used by MilestoneCache.
 */
export interface MilestoneGitLabClient {
  listMilestones: (projectId: number | string) => Promise<SyncMilestone[]>
  createMilestone: (
    projectId: number | string,
    body: { title: string, description?: string }
  ) => Promise<SyncMilestone>
}

/**
 * Per-binding cache of GitLab milestones and Huly Milestone refs.
 */
export class MilestoneCache {
  private readonly remoteByTitle: BiDirectionalCache<string, SyncMilestone>
  private readonly localByLabel: BiDirectionalCache<string, Ref<Milestone>>
  private remoteLoaded = false
  private localLoaded = false

  constructor (
    private readonly gitlabProjectId: number | string,
    private readonly hulyProjectRef: Ref<Space>
  ) {
    this.remoteByTitle = new BiDirectionalCache({ loadAll: async () => [] })
    this.localByLabel = new BiDirectionalCache({ loadAll: async () => [] })
  }

  async ensureRemoteMilestone (
    client: MilestoneGitLabClient,
    title: string,
    description?: string
  ): Promise<SyncMilestone> {
    await this.primeRemote(client)
    const key = title.toLowerCase()
    const existing = await this.remoteByTitle.get(key)
    if (existing !== undefined) return existing

    const body: { title: string, description?: string } = { title }
    if (description !== undefined) body.description = description

    const created = await client.createMilestone(this.gitlabProjectId, body)
    this.remoteByTitle.put(key, created)
    return created
  }

  async ensureLocalMilestone (
    ops: TxOperations,
    label: string,
    description?: string
  ): Promise<Ref<Milestone>> {
    await this.primeLocal(ops)
    const key = label.toLowerCase()
    const existing = await this.localByLabel.get(key)
    if (existing !== undefined) return existing

    const attrs: Partial<Milestone> = { label }
    if (description !== undefined) attrs.description = description
    const ref = await ops.createDoc<Milestone>(
      tracker.class.Milestone,
      this.hulyProjectRef,
      attrs
    )
    this.localByLabel.put(key, ref)
    return ref
  }

  primeRemoteSync (milestones: readonly SyncMilestone[]): void {
    this.remoteByTitle.primeSync(milestones.map(m => ({ key: m.title.toLowerCase(), value: m })))
    this.remoteLoaded = true
  }

  primeLocalSync (entries: ReadonlyArray<{ label: string, ref: Ref<Milestone> }>): void {
    this.localByLabel.primeSync(entries.map(e => ({ key: e.label.toLowerCase(), value: e.ref })))
    this.localLoaded = true
  }

  private async primeRemote (client: MilestoneGitLabClient): Promise<void> {
    if (this.remoteLoaded) return
    const ms = await client.listMilestones(this.gitlabProjectId)
    this.remoteByTitle.primeSync(ms.map(m => ({ key: m.title.toLowerCase(), value: m })))
    this.remoteLoaded = true
  }

  private async primeLocal (ops: TxOperations): Promise<void> {
    if (this.localLoaded) return
    const found = await ops.findAll<Milestone>(tracker.class.Milestone, {})
    const entries: Array<{ key: string, value: Ref<Milestone> }> = []
    for (const m of found) {
      if (m.space === this.hulyProjectRef) {
        entries.push({ key: m.label.toLowerCase(), value: m._id })
      }
    }
    this.localByLabel.primeSync(entries)
    this.localLoaded = true
  }
}
