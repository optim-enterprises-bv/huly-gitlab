import type { Doc, Ref, Space, TxOperations, WorkspaceUuid } from '@hcengineering/core'
import tracker, { type Issue, IssuePriority, type Status, type TaskType } from '@hcengineering/tracker'
import type { Capabilities, SyncEpic } from '../adapter/types'
import { gfmMarkdownToMarkup } from '../markdown'
import { findByGitlab, upsertIdMap } from '../state/idmap'
import { setCursor } from '../state/cursors'
import { prefixGitlabIdForMultiInstance } from './multi-instance'
import { MR_EPIC_MIXIN, type MREpicMixinDoc } from './epic-mixin'
import { MR_MIXIN, type MRMixinDoc } from './mr-mixin'
import type { BindingRef, SyncContext, SyncManager } from './types'
import * as metrics from '../metrics'

const HULY_CLASS_ISSUE = 'tracker:class:Issue'

/**
 * EpicsSyncManager — Phase 4 EE epic mirror.
 *
 * Mirrors a GitLab epic as a tracker.Issue (with a `gitlab-epic` runtime mixin)
 * scoped to the binding's Huly project.
 *
 * AC-1 INVARIANT (single writer for `parentEpicIid`): this manager is the SOLE
 * writer of the `parentEpicIid` field on every child mirror (MR or Issue). The
 * MergeRequestsSyncManager MUST NOT touch the field — neither read nor write.
 * The propagation happens in `applyRemote` step 5 by iterating
 * `syncEpic.childIssueIids` and calling `updateMixin` on each resolved child
 * with `{ parentEpicIid: syncEpic.iid }`. Children not yet mirrored are
 * skipped silently; the next backfill cycle re-runs the propagation.
 *
 * Phase 4 scope cuts:
 *   - applyLocal is a no-op: epic edits originating in Huly are NOT propagated
 *     back to GitLab (deferred to a hypothetical Phase 5).
 *   - Cross-project child issues (epics span groups; this integration is
 *     per-project) are dropped silently when not resolvable via idmap.
 */
export class EpicsSyncManager implements SyncManager<SyncEpic> {
  readonly kind = 'epic'

  constructor (private readonly deps: EpicsSyncManagerDeps) {}

  resourceKey (record: Record<string, unknown>): string | undefined {
    const objAttrs = record.object_attributes
    if (objAttrs !== null && typeof objAttrs === 'object') {
      const i = (objAttrs as Record<string, unknown>).iid
      if (typeof i === 'number') return `epic:${i}`
    }
    const iid = record.iid
    if (typeof iid === 'number') return `epic:${iid}`
    return undefined
  }

  private async enqueueRecord (
    binding: BindingRef,
    kind: string,
    record: Record<string, unknown>,
    eventId: string,
    version: string
  ): Promise<void> {
    if (this.deps.backfillEnqueuer !== undefined) {
      await this.deps.backfillEnqueuer(binding, kind, record, eventId, version)
      return
    }
    if (this.deps.enqueuer !== undefined) {
      await this.deps.enqueuer.enqueueBackfillRecord(binding, kind, record, eventId, version)
    }
  }

  async applyRemote (
    ctx: SyncContext,
    binding: BindingRef,
    syncEpic: SyncEpic
  ): Promise<void> {
    const bctx = await this.deps.loadBinding(binding)

    // EE gate: epics are EE-only on GitLab. CE silently no-ops at the adapter
    // (listEpics returns []), but applyRemote may still arrive via webhook on
    // a CE instance — short-circuit and increment a metric for visibility.
    if (bctx.capabilities !== undefined && bctx.capabilities.edition !== 'ee') {
      metrics.increment(metrics.METRIC_NAMES.EPIC_EE_SKIPPED)
      ctx.logger.debug('EpicsSyncManager: ee.feature.skipped', { binding, iid: syncEpic.iid })
      return
    }

    const rawId = `${syncEpic.groupId}:${syncEpic.iid}`
    const gitlabId = prefixGitlabIdForMultiInstance(bctx, rawId)

    const existing = await findByGitlab(ctx.store.idmap(), bctx.workspaceUuid, 'epic', gitlabId)

    const refUrl = `${bctx.gitlabBaseUrl.replace(/\/$/, '')}/groups/${syncEpic.groupId}/-/epics`
    const imageUrl = `${bctx.gitlabBaseUrl.replace(/\/$/, '')}/groups/${syncEpic.groupId}`
    const descriptionMarkup = gfmMarkdownToMarkup(syncEpic.description, refUrl, imageUrl)

    const statusRef = this.pickBacklogStatus(bctx.statuses)
    if (statusRef === undefined) {
      // L2: Huly project has no statuses at all — cannot create the mirror.
      // Warn and skip instead of silently falling through to a sentinel ref.
      ctx.logger.warn('EpicsSyncManager: no statuses available on project — skipping epic', {
        binding,
        iid: syncEpic.iid
      })
      return
    }
    const remoteTsMs = syncEpic.updatedAt.getTime()

    let issueRef: Ref<Issue>
    if (existing === null) {
      issueRef = await bctx.hulyClient.createDoc<Issue>(
        tracker.class.Issue,
        bctx.hulyProjectRef,
        {
          title: syncEpic.title,
          description: descriptionMarkup,
          status: statusRef,
          priority: IssuePriority.NoPriority,
          assignee: null as unknown as Ref<Doc> | null,
          labels: [],
          milestone: null,
          kind: bctx.defaultTaskType,
          modifiedOn: remoteTsMs
        }
      )
      await upsertIdMap(
        ctx.store.idmap(),
        bctx.workspaceUuid,
        'epic',
        gitlabId,
        HULY_CLASS_ISSUE,
        issueRef
      )

      await bctx.hulyClient.createMixin<Issue, MREpicMixinDoc>(
        issueRef,
        tracker.class.Issue,
        bctx.hulyProjectRef,
        MR_EPIC_MIXIN,
        buildEpicMixinCreateData(syncEpic)
      )
    } else {
      issueRef = existing.hulyRef as Ref<Issue>
      const hulyIssue = await bctx.hulyClient.findOne<Issue>(
        tracker.class.Issue,
        { _id: issueRef }
      )
      if (hulyIssue === undefined) {
        ctx.logger.warn('EpicsSyncManager: idMap points to missing issue', {
          binding,
          hulyRef: existing.hulyRef
        })
        return
      }

      const localTsMs = hulyIssue.modifiedOn
      if (localTsMs <= 0 || remoteTsMs > localTsMs) {
        const update: Partial<Issue> = {}
        let dirty = false
        if (hulyIssue.title !== syncEpic.title) {
          update.title = syncEpic.title
          dirty = true
        }
        if (hulyIssue.description !== descriptionMarkup) {
          update.description = descriptionMarkup
          dirty = true
        }
        if (dirty) {
          ;(update as Record<string, unknown>).modifiedOn = remoteTsMs
          await bctx.hulyClient.updateDoc<Issue>(
            tracker.class.Issue,
            bctx.hulyProjectRef,
            issueRef,
            update
          )
        }
      }

      await bctx.hulyClient.updateMixin<Issue, MREpicMixinDoc>(
        issueRef,
        tracker.class.Issue,
        bctx.hulyProjectRef,
        MR_EPIC_MIXIN,
        buildEpicMixinUpdateData(syncEpic)
      )
    }

    // AC-1 SOLE-WRITER parent-child propagation: only EpicsSyncManager writes
    // `parentEpicIid` on child mirrors. We attempt both `merge_request` and
    // `issue` idmap kinds — the child can be either, scoped to the binding's
    // project. Cross-project children (epics span groups; this integration is
    // per-binding scoped) are dropped silently here; backfill will retry.
    for (const childIid of syncEpic.childIssueIids) {
      const childGitlabId = prefixGitlabIdForMultiInstance(
        bctx,
        `${bctx.gitlabProjectId}:${childIid}`
      )
      const mrChild = await findByGitlab(
        ctx.store.idmap(),
        bctx.workspaceUuid,
        'merge_request',
        childGitlabId
      )
      if (mrChild !== null) {
        await bctx.hulyClient.updateMixin<Issue, MRMixinDoc>(
          mrChild.hulyRef as Ref<Issue>,
          tracker.class.Issue,
          bctx.hulyProjectRef,
          MR_MIXIN,
          { parentEpicIid: syncEpic.iid }
        )
        continue
      }
      const issueChild = await findByGitlab(
        ctx.store.idmap(),
        bctx.workspaceUuid,
        'issue',
        childGitlabId
      )
      if (issueChild !== null) {
        // Issue-mirror children carry parentEpicIid via the gitlab-mr mixin's
        // shared schema (P4-T-02: the field lives on `MRMixinDoc`; whichever
        // mixin is applied to the mirror Issue picks it up). For Phase 4 we
        // write it under MR_MIXIN since that's the only declared shape that
        // carries the field.
        await bctx.hulyClient.updateMixin<Issue, MRMixinDoc>(
          issueChild.hulyRef as Ref<Issue>,
          tracker.class.Issue,
          bctx.hulyProjectRef,
          MR_MIXIN,
          { parentEpicIid: syncEpic.iid }
        )
        continue
      }
      // Child not yet mirrored — natural eventual consistency: next backfill
      // cycle will re-apply the epic and pick up children that have arrived.
      metrics.increment(metrics.METRIC_NAMES.EPIC_CHILD_DEFERRED)
      ctx.logger.debug('EpicsSyncManager: child.deferred', {
        binding,
        epicIid: syncEpic.iid,
        childIid
      })
    }

    await setCursor(ctx.store.cursors(), binding, 'epics', syncEpic.updatedAt)
  }

  /**
   * Phase 4 scope cut: epic edits originating in Huly are NOT propagated back
   * to GitLab. Returns immediately. A hypothetical Phase 5 may revisit.
   */
  async applyLocal (
    ctx: SyncContext,
    binding: BindingRef,
    doc: string,
    _change: Record<string, unknown>
  ): Promise<void> {
    ctx.logger.debug('EpicsSyncManager: applyLocal.skipped', { binding, doc })
  }

  async backfill (
    ctx: SyncContext,
    binding: BindingRef,
    since: Date | undefined
  ): Promise<void> {
    const bctx = await this.deps.loadBinding(binding)

    // Bug-1: epics live at the top-level group, never the immediate sub-group.
    const topGroupId = await bctx.gitlabClient.resolveTopLevelGroupForProject(
      bctx.gitlabProjectId
    )

    const opts: { updatedAfter?: Date } = {}
    if (since !== undefined) opts.updatedAfter = since

    const epics = await bctx.gitlabClient.listEpics(topGroupId, opts)

    for (const epic of epics) {
      // listEpics does NOT populate childIssueIids — fetch them per epic.
      const { iids } = await bctx.gitlabClient.listEpicIssues(topGroupId, epic.iid)
      const enriched: SyncEpic = { ...epic, childIssueIids: iids }
      const versionIso = enriched.updatedAt.toISOString()
      const eventId = `backfill:epic:${enriched.groupId}:${enriched.iid}:${versionIso}`
      await this.enqueueRecord(
        binding,
        'epic',
        enriched as unknown as Record<string, unknown>,
        eventId,
        versionIso
      )
    }
  }

  private pickBacklogStatus (statuses: readonly Status[]): Ref<Status> | undefined {
    // Prefer the ToDo / Backlog category; fall back to the first status.
    for (const s of statuses) {
      const cat = String(s.category ?? '')
      if (cat.includes('Backlog') || cat.includes('ToDo')) {
        return s._id
      }
    }
    // L2: no synthetic empty-string sentinel — caller treats undefined as
    // "skip this epic" with a warn log.
    return statuses.length > 0 ? statuses[0]._id : undefined
  }
}

// ---------------------------------------------------------------------------
// Surface types
// ---------------------------------------------------------------------------

/**
 * Binding context required by EpicsSyncManager. Mirrors PipelineBindingContext
 * plus the EE adapter surface for epic fetches, the workspace identity, and
 * the multi-instance flag. Constructed by BindingLoader.loadForEpics, then
 * augmented at engine wiring time with the gitlabClient, statuses and
 * defaultTaskType (which loadForEpics does not currently surface — engine
 * extends the loader return at registration time per P4-T-19 wiring).
 */
export interface EpicsBindingContext {
  workspaceUuid: WorkspaceUuid
  gitlabProjectId: number
  hulyProjectRef: Ref<Space>
  hulyClient: TxOperations
  gitlabClient: EpicGitLabClient
  gitlabBaseUrl: string
  isMultiInstanceWorkspace: boolean
  statuses: readonly Status[]
  defaultTaskType: Ref<TaskType>
  /**
   * Capabilities of the connected GitLab instance. When undefined or
   * `edition !== 'ee'`, applyRemote short-circuits to a no-op (with metric).
   */
  capabilities?: Capabilities
}

/**
 * GitLab client surface used by EpicsSyncManager. The full GitLabClient
 * satisfies this structurally; tests pass a tiny fake.
 */
export interface EpicGitLabClient {
  listEpics: (
    groupId: number | string,
    opts?: { updatedAfter?: Date }
  ) => Promise<SyncEpic[]>
  listEpicIssues: (
    groupId: number | string,
    epicIid: number
  ) => Promise<{ iids: number[], projectIds: number[] }>
  resolveTopLevelGroupForProject: (
    projectId: number | string
  ) => Promise<number>
}

/** Loader function — engine asks for the EpicsBindingContext for a given BindingRef. */
export type EpicsBindingLoader = (binding: BindingRef) => Promise<EpicsBindingContext>

/** Enqueue contract used by backfill. */
export type EpicsBackfillEnqueuerFn = (
  binding: BindingRef,
  kind: string,
  record: Record<string, unknown>,
  eventId: string,
  version: string
) => Promise<void> | void

/** Object form preserved for test ergonomics. */
export interface EpicsBackfillEnqueuer {
  enqueueBackfillRecord: EpicsBackfillEnqueuerFn
}

export interface EpicsSyncManagerDeps {
  loadBinding: EpicsBindingLoader
  enqueuer?: EpicsBackfillEnqueuer
  backfillEnqueuer?: EpicsBackfillEnqueuerFn
}

// ---------------------------------------------------------------------------
// Mixin builders
// ---------------------------------------------------------------------------

function buildEpicMixinCreateData (
  syncEpic: SyncEpic
): Omit<MREpicMixinDoc, keyof Issue> {
  return {
    epicIid: syncEpic.iid,
    groupId: syncEpic.groupId,
    state: syncEpic.state,
    webUrl: syncEpic.webUrl,
    childIssueIids: syncEpic.childIssueIids.slice()
  }
}

function buildEpicMixinUpdateData (
  syncEpic: SyncEpic
): Partial<Omit<MREpicMixinDoc, keyof Issue>> {
  return {
    state: syncEpic.state,
    webUrl: syncEpic.webUrl,
    childIssueIids: syncEpic.childIssueIids.slice()
  }
}
