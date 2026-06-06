import type { Ref, Space, TxOperations } from '@hcengineering/core'
import tracker, { type Issue } from '@hcengineering/tracker'
import type { SyncPipeline, SyncPipelineStatus } from '../adapter/types'
import { findByGitlab } from '../state/idmap'
import * as metrics from '../metrics'
import { METRIC_NAMES } from '../metrics'
import { MR_MIXIN, type MRMixinDoc } from './mr-mixin'
import { prefixGitlabIdForMultiInstance } from './multi-instance'
import type { BindingRef, SyncContext, SyncManager } from './types'
import { withOriginatedMarker } from './originated-marker'

export function getPipelineLruDropCount (): number {
  return metrics.get(METRIC_NAMES.PIPELINE_LRU_DROP)
}

export function incrementPipelineLruDrop (): void {
  metrics.increment(METRIC_NAMES.PIPELINE_LRU_DROP)
}

export function getUnboundPipelineCount (): number {
  return metrics.get(METRIC_NAMES.WEBHOOK_UNBOUND_PIPELINE)
}

/**
 * Context loaded per binding — everything PipelineSyncManager needs.
 *
 * B1: `gitlabBaseUrl` + `isMultiInstanceWorkspace` are optional because most
 * single-instance deployments never set them; when present they trigger
 * `prefixGitlabIdForMultiInstance` on the parent-MR idmap lookup to prevent
 * TG-4 cross-instance project-ID collisions.
 */
export interface PipelineBindingContext {
  workspaceUuid: string
  gitlabProjectId: number
  hulyProjectRef: Ref<Space>
  hulyClient: TxOperations
  /** Absolute base URL of the GitLab instance backing this binding. */
  gitlabBaseUrl?: string
  /** True when ≥ 2 distinct gitlabBaseUrl values exist for this workspace. */
  isMultiInstanceWorkspace?: boolean
}

export interface PipelineSyncManagerDeps {
  loadBinding: (binding: BindingRef) => Promise<PipelineBindingContext>
}

/**
 * PipelineSyncManager — writes pipeline CI status onto the Huly Issue mixin.
 *
 * applyRemote resolves the MR's Huly Issue ref and calls updateMixin with
 * ONLY the pipelineStatus field (critic C2: isolation — no other mixin fields
 * are touched).
 *
 * applyLocal is a no-op: pipelines are GitLab-source-of-truth.
 * Huly does not push pipeline state back to GitLab.
 *
 * backfill is a no-op: pipeline state is webhook-driven (per Q3 resolution).
 * Backfilling historical pipeline statuses is deferred to a future phase.
 */
export class PipelineSyncManager implements SyncManager<SyncPipeline> {
  readonly kind = 'pipeline'

  constructor (private readonly deps: PipelineSyncManagerDeps) {}

  resourceKey (record: Record<string, unknown>): string | undefined {
    // Prefer object_attributes.id (webhook shape), fall back to top-level id.
    const attrs = record.object_attributes
    if (attrs !== null && typeof attrs === 'object') {
      const id = (attrs as Record<string, unknown>).id
      if (typeof id === 'number') return `pipeline:${id}`
    }
    if (typeof record.id === 'number') return `pipeline:${record.id}`
    return undefined
  }

  async applyRemote (
    ctx: SyncContext,
    binding: BindingRef,
    syncPipeline: SyncPipeline
  ): Promise<void> {
    // Defense-in-depth: pipelines not tied to an MR are ignored.
    // The webhook layer should have filtered these already.
    if (syncPipeline.mergeRequestIid === null) {
      metrics.increment(METRIC_NAMES.WEBHOOK_UNBOUND_PIPELINE)
      ctx.logger.debug('PipelineSyncManager: dropping pipeline with no MR iid', {
        binding,
        pipelineId: syncPipeline.id
      })
      return
    }

    const bctx = await this.deps.loadBinding(binding)

    // Resolve the MR to its Huly Issue ref via the idmap.
    // MergeRequestsSyncManager writes idmap with `${gitlabProjectId}:${mrIid}` —
    // the lookup MUST use the same format or it will always miss.
    // B1: when multi-instance, both writer and reader prefix with the baseUrl hash.
    const gitlabId = prefixGitlabIdForMultiInstance(
      {
        isMultiInstanceWorkspace: bctx.isMultiInstanceWorkspace === true,
        gitlabBaseUrl: bctx.gitlabBaseUrl ?? ''
      },
      `${bctx.gitlabProjectId}:${syncPipeline.mergeRequestIid}`
    )
    const mrRef = await findByGitlab(
      ctx.store.idmap(),
      bctx.workspaceUuid,
      'merge_request',
      gitlabId
    )

    if (mrRef === null) {
      ctx.logger.debug('PipelineSyncManager: MR not yet mirrored — dropping pipeline status update', {
        binding,
        mergeRequestIid: syncPipeline.mergeRequestIid,
        pipelineId: syncPipeline.id
      })
      return
    }

    const issueRef = mrRef.hulyRef as Ref<Issue>

    // Write ONLY pipelineStatus onto the gitlab-mr mixin (critic C2: isolation).
    await bctx.hulyClient.updateMixin<Issue, MRMixinDoc & { pipelineStatus: SyncPipelineStatus | null }>(
      issueRef,
      tracker.class.Issue,
      bctx.hulyProjectRef,
      MR_MIXIN,
      withOriginatedMarker({ pipelineStatus: syncPipeline.status })
    )
  }

  // applyLocal is a no-op: pipelines are GitLab-source-of-truth.
  // Huly never pushes pipeline state back to GitLab.
  async applyLocal (
    _ctx: SyncContext,
    _binding: BindingRef,
    _doc: string,
    _change: Record<string, unknown>
  ): Promise<void> {}

  // backfill is a no-op: pipeline state is webhook-driven (per Q3 resolution).
  // Historical pipeline status backfill is deferred to a future phase.
  async backfill (
    _ctx: SyncContext,
    _binding: BindingRef,
    _since: Date | undefined
  ): Promise<void> {}
}
