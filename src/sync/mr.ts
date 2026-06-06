/**
 * Phase 3 mixin-change-payload shape (verified P3-T-01b 2026-06-06):
 *   client.updateMixin(... MR_MIXIN, { approvedBy }) fires applyLocal with
 *   change carrying FLAT keys at the top level (matches Phase 2 convention).
 * applyLocal reads typed Phase 3 deltas via:
 *   change.approvedBy as PersonUuid[] | undefined
 *   change.reviewers  as PersonUuid[] | undefined
 * (NOT change['gitlab-mr.X'] — see Phase 3 plan §B3 / Path B.)
 */
import type {
  Doc,
  PersonUuid,
  Ref,
  Space,
  TxOperations,
  WorkspaceUuid
} from '@hcengineering/core'
import tracker, { type Issue, IssuePriority, type Status, type TaskType } from '@hcengineering/tracker'
import type { TagElement } from '@hcengineering/tags'
import { deepEqual } from 'fast-equals'
import type { GitLabClient } from '../adapter/gitlab-client'
import type {
  SyncMergeRequest,
  SyncMRApprovals,
  SyncMRChanges
} from '../adapter/types'
import { gfmMarkdownToMarkup, markupToGfmMarkdown } from '../markdown'
import { findByGitlab, findByHuly, upsertIdMap } from '../state/idmap'
import { setCursor } from '../state/cursors'
import { prefixGitlabIdForMultiInstance } from './multi-instance'
import type { SyncUser as IdentitySyncUser, UserIdentity } from '../huly/users'
import { applyLwwFieldByField, type FieldDecision, type FieldVersion } from './conflict'
import type { LabelCache } from './label-cache'
import type { MilestoneCache } from './milestone-cache'
import { MR_MIXIN, type MRMixinDoc } from './mr-mixin'
import { mapHulyStatusToMRStateEvent, mapRemoteMRState } from './mr-status-map'
import type { BindingRef, SyncContext, SyncManager } from './types'
import {
  APPROVAL_RACE_WINDOW_MS,
  applyApprovalActions,
  buildMixinCreateData,
  buildMixinUpdateData,
  type MRCredentialResolver
} from './mr-approvals'
export {
  getApprovalServiceAccountFallbackCount,
  resetApprovalServiceAccountFallbackCount,
  type MRCredentialResolver
} from './mr-approvals'

const HULY_CLASS_ISSUE = 'tracker:class:Issue'

export { MR_MIXIN, type MRMixinDoc } from './mr-mixin'

/**
 * Minimal binding shape needed for resolution. The real `BindingDoc` from state/bindings.ts
 * satisfies this structurally.
 *
 * B1: optional `gitlabBaseUrl` + `isMultiInstanceWorkspace` allow callers in
 * multi-instance workspaces to prefix the idmap gitlabId via
 * `prefixGitlabIdForMultiInstance` and avoid cross-instance projectId collisions.
 * When omitted (the common single-instance case) the raw key is used unchanged.
 */
export interface MRBindingResolverInput {
  gitlabProjectId: number
  gitlabBaseUrl?: string
  isMultiInstanceWorkspace?: boolean
}

/**
 * Resolve the Huly Issue ref that mirrors a GitLab merge request iid for a binding.
 *
 * Mirrors `resolveIssueRef` from issues.ts but uses the `merge_request` idmap kind.
 * Used by P2-T-09 (NotesSyncManager MR-route extension) for note parent resolution.
 */
export async function resolveMRRef (
  ctx: SyncContext,
  binding: MRBindingResolverInput,
  mrIid: number
): Promise<Ref<Issue> | undefined> {
  const rawId = `${binding.gitlabProjectId}:${mrIid}`
  const gitlabId = (binding.isMultiInstanceWorkspace === true && binding.gitlabBaseUrl !== undefined)
    ? prefixGitlabIdForMultiInstance({
      isMultiInstanceWorkspace: true,
      gitlabBaseUrl: binding.gitlabBaseUrl
    }, rawId)
    : rawId
  const mapping = await findByGitlab(ctx.store.idmap(), ctx.workspaceUuid, 'merge_request', gitlabId)
  if (mapping === null) return undefined
  return mapping.hulyRef as Ref<Issue>
}

/**
 * Loaded binding context — everything MergeRequestsSyncManager needs about a binding
 * to operate. Constructed by the engine wiring (P2-T-10) and passed in via the loader.
 */
export interface MRBindingContext {
  workspaceUuid: WorkspaceUuid
  gitlabProjectId: number
  gitlabProjectPath: string
  hulyProjectRef: Ref<Space>
  hulyClient: TxOperations
  gitlabClient: MRGitLabClient
  statuses: readonly Status[]
  userIdentity: UserIdentity
  labelCache: LabelCache
  milestoneCache: MilestoneCache
  /** Default TaskType assigned to newly-created Huly Issues for mirrored MRs. */
  defaultTaskType: Ref<TaskType>
  /** Absolute base URL used to resolve relative attachment links in markdown. */
  gitlabBaseUrl: string
  /**
   * Per-actor credential resolver — stub in Phase 3 (always returns
   * undefined). P3-T-10 wires the real implementation.
   */
  credentials: MRCredentialResolver
  /**
   * B1: true when ≥ 2 distinct GitLab base URLs are registered for this workspace.
   * When true, `findByGitlab`/`upsertIdMap` calls in this manager prefix the
   * gitlabId via `prefixGitlabIdForMultiInstance` to prevent project-ID collisions
   * between GitLab instances (TG-4 defense-in-depth).
   */
  isMultiInstanceWorkspace?: boolean
}

/** Loader callback — engine returns the per-binding context. */
export type MRBindingLoader = (binding: BindingRef) => Promise<MRBindingContext>

/**
 * GitLab client surface used by MergeRequestsSyncManager. The full GitLabClient
 * satisfies this structurally; tests pass a tiny fake.
 *
 * Note: Phase 2 deliberately omits `createMergeRequest` from this surface —
 * `applyLocal` is forbidden to create MRs (deferred to Phase 3 per critic).
 */
export interface MRGitLabClient {
  listMergeRequests: (
    projectId: number | string,
    opts: { updatedAfter?: Date }
  ) => Promise<SyncMergeRequest[]>
  updateMergeRequest: (
    projectId: number | string,
    mrIid: number,
    body: UpdateMRBody
  ) => Promise<SyncMergeRequest>
  listLabels: GitLabClient['listLabels']
  createLabel: GitLabClient['createLabel']
  listMilestones: GitLabClient['listMilestones']
  createMilestone: GitLabClient['createMilestone']
  /** Phase 3 (P3-T-07): two-way approval actions. */
  approveMR: (
    projectId: number | string,
    mrIid: number,
    actorToken?: string
  ) => Promise<void>
  unapproveMR: (
    projectId: number | string,
    mrIid: number,
    actorToken?: string
  ) => Promise<void>
  /** Phase 3 (P3-T-07): composite enrichment helpers. */
  getMRApprovals: (
    projectId: number | string,
    mrIid: number
  ) => Promise<SyncMRApprovals>
  getMRChanges: (
    projectId: number | string,
    mrIid: number,
    fallbackWebUrl?: string
  ) => Promise<SyncMRChanges>
}

export interface UpdateMRBody {
  title?: string
  description?: string
  state_event?: 'close' | 'reopen'
  labels?: string
  milestone_id?: number
  assignee_ids?: number[]
  target_branch?: string
  remove_source_branch?: boolean
  draft?: boolean
}

/**
 * Enqueue contract used by backfill — engine consumes records as if they
 * arrived via webhook, so backfill funnels through the same SyncManager dispatch.
 */
export type MRBackfillEnqueuerFn = (
  binding: BindingRef,
  kind: string,
  record: Record<string, unknown>,
  eventId: string,
  version: string
) => Promise<void> | void

/** Object form preserved for test ergonomics. */
export interface MRBackfillEnqueuer {
  enqueueBackfillRecord: MRBackfillEnqueuerFn
}

export interface MergeRequestsSyncManagerDeps {
  loadBinding: MRBindingLoader
  /** Object form (legacy / tests) */
  enqueuer?: MRBackfillEnqueuer
  /** Function form preferred for new wiring */
  backfillEnqueuer?: MRBackfillEnqueuerFn
}

/**
 * MergeRequestsSyncManager — two-way sync for GitLab merge requests.
 *
 * Mirrors `IssuesSyncManager` shape one-for-one. MRs are stored as
 * `tracker.class.Issue` documents with an additional runtime `gitlab-mr`
 * mixin carrying GitLab-specific fields.
 *
 * Critic constraints (must hold):
 *  - C2: `applyRemote` does NOT touch the `pipelineStatus` mixin field —
 *        that field is owned exclusively by PipelineSyncManager.
 *  - C4: reviewers are projected as synthetic `gitlab:reviewer:<username>`
 *        labels via the shared LabelCache.
 *  - Phase 2 scope cut: `applyLocal` does NOT call `createMergeRequest`.
 *        If the Huly doc has no idmap entry, the manager logs and returns.
 */
export class MergeRequestsSyncManager implements SyncManager<SyncMergeRequest> {
  readonly kind = 'merge_request'

  constructor (private readonly deps: MergeRequestsSyncManagerDeps) {}

  resourceKey (record: Record<string, unknown>): string | undefined {
    const iid = record.iid
    if (typeof iid === 'number') return `mr:${iid}`
    const objAttrs = record.object_attributes
    if (objAttrs !== null && typeof objAttrs === 'object') {
      const i = (objAttrs as Record<string, unknown>).iid
      if (typeof i === 'number') return `mr:${i}`
    }
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
    syncMR: SyncMergeRequest
  ): Promise<void> {
    const bctx = await this.deps.loadBinding(binding)
    const gitlabId = prefixGitlabIdForMultiInstance(
      { isMultiInstanceWorkspace: bctx.isMultiInstanceWorkspace === true, gitlabBaseUrl: bctx.gitlabBaseUrl },
      `${bctx.gitlabProjectId}:${syncMR.iid}`
    )

    const existing = await findByGitlab(ctx.store.idmap(), bctx.workspaceUuid, 'merge_request', gitlabId)

    const refUrl = `${bctx.gitlabBaseUrl.replace(/\/$/, '')}/${bctx.gitlabProjectPath}/-/merge_requests`
    const imageUrl = `${bctx.gitlabBaseUrl.replace(/\/$/, '')}/${bctx.gitlabProjectPath}`
    const descriptionMarkup = gfmMarkdownToMarkup(syncMR.description ?? '', refUrl, imageUrl)

    const assigneeRef = await this.resolveAssignee(syncMR.assignees, bctx.userIdentity)
    // Phase 3 (P3-T-07): typed reviewers replace synthetic labels.
    // resolveReviewerLabels remains exported below for the P3-T-09 migration helper
    // to scan, but is no longer called from applyRemote (B-C16).
    const reviewerUuids = await this.resolveReviewerUuids(syncMR.reviewers, bctx.userIdentity)
    const approvedByUuids = await this.resolveReviewerUuids(syncMR.approvedBy, bctx.userIdentity)
    const labelRefs = await this.resolveLocalLabels(syncMR.labels, bctx)

    const milestoneRef = syncMR.milestone !== null
      ? await bctx.milestoneCache.ensureLocalMilestone(
        bctx.hulyClient,
        syncMR.milestone.title
      )
      : null

    // Status mapping — relies on the current ref for 'locked' (which keeps the existing status).
    const projectStatuses = bctx.statuses as Status[]
    const remoteTs = new Date(syncMR.updatedAt)

    if (existing === null) {
      // CREATE — fresh Huly Issue + initial mixin write.
      const initialStatus = mapRemoteMRState(
        syncMR.state,
        syncMR.draft,
        // For a fresh issue there is no "current" status; pass a placeholder.
        // mapRemoteMRState only returns it back for the 'locked' branch, which
        // cannot occur on first ingest because the issue is newly created.
        '' as Ref<Status>,
        projectStatuses,
        ctx.logger
      )
      const statusRef = initialStatus.status
      if (statusRef === undefined || String(statusRef) === '') {
        ctx.logger.warn('MergeRequestsSyncManager: no status match for project', {
          binding,
          state: syncMR.state
        })
        return
      }

      const priority = (initialStatus.priority ?? IssuePriority.NoPriority) as IssuePriority

      const issueRef = await bctx.hulyClient.createDoc<Issue>(
        tracker.class.Issue,
        bctx.hulyProjectRef,
        {
          title: syncMR.title,
          description: descriptionMarkup,
          status: statusRef,
          priority,
          assignee: assigneeRef as Ref<Doc> | null,
          labels: labelRefs,
          milestone: milestoneRef,
          kind: bctx.defaultTaskType,
          modifiedOn: remoteTs.getTime()
        }
      )

      await bctx.hulyClient.createMixin<Issue, MRMixinDoc>(
        issueRef,
        tracker.class.Issue,
        bctx.hulyProjectRef,
        MR_MIXIN,
        buildMixinCreateData(syncMR, reviewerUuids, approvedByUuids)
      )

      await upsertIdMap(
        ctx.store.idmap(),
        bctx.workspaceUuid,
        'merge_request',
        gitlabId,
        HULY_CLASS_ISSUE,
        issueRef
      )
      await setCursor(ctx.store.cursors(), binding, 'merge_requests', remoteTs)
      return
    }

    // UPDATE — fetch existing Issue, run per-field LWW.
    const issueRef = existing.hulyRef as Ref<Issue>
    const hulyIssue = await bctx.hulyClient.findOne<Issue>(
      tracker.class.Issue,
      { _id: issueRef }
    )
    if (hulyIssue === undefined) {
      ctx.logger.warn('MergeRequestsSyncManager: idMap points to missing issue', {
        binding,
        hulyRef: existing.hulyRef
      })
      return
    }

    const localTs = hulyIssue.modifiedOn > 0 ? new Date(hulyIssue.modifiedOn) : undefined

    // 'locked' state: keep current status. For other states, derive a fresh one.
    const stateMapping = mapRemoteMRState(
      syncMR.state,
      syncMR.draft,
      hulyIssue.status,
      projectStatuses,
      ctx.logger
    )
    const remoteStatusRef = stateMapping.status

    type IssueFieldMap = Record<string, FieldVersion<unknown>>

    const local: IssueFieldMap = {
      title: { value: hulyIssue.title, ts: localTs },
      description: { value: hulyIssue.description, ts: localTs },
      status: { value: hulyIssue.status, ts: localTs },
      assignee: { value: hulyIssue.assignee, ts: localTs },
      milestone: { value: hulyIssue.milestone ?? null, ts: localTs },
      labels: { value: hulyIssue.labels ?? [], ts: localTs },
      priority: { value: hulyIssue.priority, ts: localTs }
    }
    const remote: IssueFieldMap = {
      title: { value: syncMR.title, ts: remoteTs },
      description: { value: descriptionMarkup, ts: remoteTs },
      // For 'locked' we keep status — same as local, so LWW becomes a noop.
      status: {
        value: syncMR.state === 'locked' ? hulyIssue.status : remoteStatusRef,
        ts: remoteTs
      },
      assignee: { value: assigneeRef as Ref<Doc> | null, ts: remoteTs },
      milestone: { value: milestoneRef, ts: remoteTs },
      labels: { value: labelRefs, ts: remoteTs },
      priority: {
        value: stateMapping.priority ?? hulyIssue.priority,
        ts: remoteTs
      }
    }

    const decisions = applyLwwFieldByField(local, remote)
    const update: Partial<Issue> = {}
    let dirty = false

    const take = (k: string, decision: FieldDecision | undefined): void => {
      if (decision !== 'remote') return
      const remoteVal = remote[k].value
      const localVal = local[k].value
      if (areEqual(remoteVal, localVal)) return
      ;(update as Record<string, unknown>)[k] = remoteVal
      dirty = true
    }

    take('title', decisions.title)
    take('description', decisions.description)
    take('status', decisions.status)
    take('assignee', decisions.assignee)
    take('milestone', decisions.milestone)
    take('labels', decisions.labels)
    take('priority', decisions.priority)

    if (dirty) {
      ;(update as Record<string, unknown>).modifiedOn = remoteTs.getTime()
      await bctx.hulyClient.updateDoc<Issue>(
        tracker.class.Issue,
        bctx.hulyProjectRef,
        issueRef,
        update
      )
    }

    // Phase 3: race mitigation (C10 / B6) — when remote.approvedBy is strictly
    // smaller than the locally-known set, keep local entries IF EITHER:
    //   (a) we are within the in-flight race window (local touched within 30s), OR
    //   (b) the local timestamp is newer than the remote payload.
    //
    // B6: Previous logic required BOTH (`&&`) the race window AND
    // `localTsMs >= remoteTsMs`. That blocked the exact race it defended:
    // Huly write at T0, GitLab webhook at T3 carries stale state with remote ts
    // NEWER (server clock advanced) — `localTsMs >= remoteTsMs` is false and
    // the guard never engages. Combining via OR engages on either signal.
    let resolvedApprovedBy: PersonUuid[] | undefined = approvedByUuids
    if (resolvedApprovedBy !== undefined) {
      const existingMixin = readMixin(hulyIssue)
      const localApprovedBy = (existingMixin?.approvedBy as PersonUuid[] | undefined) ?? []
      const localTsMs = hulyIssue.modifiedOn
      const remoteTsMs = remoteTs.getTime()
      const withinRace = localTsMs > 0 && (Date.now() - localTsMs) < APPROVAL_RACE_WINDOW_MS
      const localNewer = localTsMs > 0 && localTsMs >= remoteTsMs
      if (localApprovedBy.length > resolvedApprovedBy.length && (withinRace || localNewer)) {
        resolvedApprovedBy = localApprovedBy
      }
    }

    // Mixin-carried fields are GitLab-authoritative; always overwrite (remote-wins).
    // C2: NEVER write pipelineStatus here. PipelineSyncManager owns that field.
    await bctx.hulyClient.updateMixin<Issue, MRMixinDoc>(
      issueRef,
      tracker.class.Issue,
      bctx.hulyProjectRef,
      MR_MIXIN,
      buildMixinUpdateData(syncMR, reviewerUuids, resolvedApprovedBy)
    )

    if (localTs === undefined || remoteTs > localTs) {
      await setCursor(ctx.store.cursors(), binding, 'merge_requests', remoteTs)
    }
  }

  /**
   * NOTE (Phase 3 Path B gap): This method is reachable in production ONLY if a
   * TxProcessor subscription is wired to call `engine.enqueueLocalEvent`.
   * Currently no such wiring exists in `src/index.ts`. Calls from tests work
   * fine; real Huly UI mutations do NOT trigger this path. Phase 4 work.
   */
  async applyLocal (
    ctx: SyncContext,
    binding: BindingRef,
    doc: string,
    change: Record<string, unknown>
  ): Promise<void> {
    const bctx = await this.deps.loadBinding(binding)

    const hulyRef = stripDocPrefix(doc) as Ref<Issue>

    const mapping = await findByHuly(
      ctx.store.idmap(),
      bctx.workspaceUuid,
      HULY_CLASS_ISSUE,
      hulyRef
    )

    if (mapping === null) {
      // Phase 2 scope cut: Huly cannot create MRs on GitLab.
      ctx.logger.warn('MergeRequestsSyncManager: no mapping for Huly doc — Phase 2 cannot create MRs', {
        binding,
        hulyRef
      })
      return
    }

    const iid = parseIid(mapping.gitlabId)
    if (iid === null) {
      ctx.logger.warn('MergeRequestsSyncManager: malformed idMap gitlabId', { gitlabId: mapping.gitlabId })
      return
    }

    const refUrl = `${bctx.gitlabBaseUrl.replace(/\/$/, '')}/${bctx.gitlabProjectPath}/-/merge_requests`
    const imageUrl = `${bctx.gitlabBaseUrl.replace(/\/$/, '')}/${bctx.gitlabProjectPath}`

    const title = change.title as string | undefined
    const descriptionMarkup = change.description as string | undefined
    const statusRef = change.status as Ref<Status> | undefined
    const labels = change.labels as Array<{ name: string, color?: string }> | undefined
    const milestone = change.milestone as { title: string, description?: string } | null | undefined
    const assigneeIds = change.assigneeIds as number[] | undefined
    const targetBranch = change.targetBranch as string | undefined
    const sourceBranchEdit = change.sourceBranch as string | undefined

    if (sourceBranchEdit !== undefined) {
      ctx.logger.info('mr.sourceBranch.edit.ignored', { binding, hulyRef })
    }

    const labelNames = labels !== undefined
      ? await this.ensureRemoteLabels(labels, bctx)
      : undefined

    let milestoneId: number | undefined
    if (milestone !== undefined && milestone !== null) {
      const m = await bctx.milestoneCache.ensureRemoteMilestone(
        bctx.gitlabClient,
        milestone.title,
        milestone.description
      )
      milestoneId = m.id
    }

    const stateEvent = statusRef !== undefined
      ? mapHulyStatusToMRStateEvent(statusRef, bctx.statuses as Status[])
      : undefined

    const description = descriptionMarkup !== undefined
      ? markupToGfmMarkdown(descriptionMarkup, refUrl, imageUrl)
      : undefined

    const update: UpdateMRBody = {}
    if (title !== undefined) update.title = title
    if (description !== undefined) update.description = description
    if (labelNames !== undefined) update.labels = labelNames.join(',')
    if (milestoneId !== undefined) update.milestone_id = milestoneId
    if (assigneeIds !== undefined) update.assignee_ids = assigneeIds
    if (stateEvent !== undefined) update.state_event = stateEvent
    if (targetBranch !== undefined) update.target_branch = targetBranch

    let touchedRemote = false
    if (Object.keys(update).length > 0) {
      await bctx.gitlabClient.updateMergeRequest(bctx.gitlabProjectId, iid, update)
      touchedRemote = true
    }

    // Phase 3 (P3-T-07): approval action handling. Read flat keys per B3 / Path B.
    const approvedByChange = change.approvedBy as PersonUuid[] | undefined
    if (approvedByChange !== undefined) {
      await applyApprovalActions(
        ctx.logger, bctx, binding, hulyRef, iid, approvedByChange
      )
      touchedRemote = true
    }

    // Phase 3 (P3-T-07): Huly-side reviewer changes are NOT synced in Phase 3.
    // GitLab is authoritative; Phase 4 will route reviewer add/remove back.
    const reviewersChange = change.reviewers as PersonUuid[] | undefined
    if (reviewersChange !== undefined) {
      ctx.logger.warn('mr.reviewers.huly.unsynced', {
        binding,
        hulyRef,
        iid,
        note: 'Reviewer changes from Huly not synced; managed on GitLab.'
      })
    }

    if (!touchedRemote) return
    await setCursor(ctx.store.cursors(), binding, 'merge_requests', new Date())
  }

  async backfill (
    ctx: SyncContext,
    binding: BindingRef,
    since: Date | undefined
  ): Promise<void> {
    const bctx = await this.deps.loadBinding(binding)
    const opts: { updatedAfter?: Date } = {}
    if (since !== undefined) opts.updatedAfter = since

    const mrs = await bctx.gitlabClient.listMergeRequests(bctx.gitlabProjectId, opts)

    for (const mr of mrs) {
      const versionIso = mr.updatedAt.toISOString()
      const eventId = `backfill:mr:${bctx.gitlabProjectId}:${mr.iid}:${versionIso}`
      await this.enqueueRecord(
        binding,
        'merge_request',
        mr as unknown as Record<string, unknown>,
        eventId,
        versionIso
      )
    }
  }

  // ---------------------------------------------------------------------------

  private async resolveAssignee (
    assignees: SyncMergeRequest['assignees'],
    userIdentity: UserIdentity
  ): Promise<PersonUuid | string | null> {
    if (assignees.length === 0) return null
    const first = assignees[0]
    const identity: IdentitySyncUser = {
      gitlabId: String(first.id),
      ...(first.email !== null ? { email: first.email } : {}),
      ...(first.name !== '' ? { name: first.name } : {}),
      ...(first.username !== '' ? { username: first.username } : {})
    }
    const matched = await userIdentity.mapByGitlabUser(identity)
    if (matched !== undefined) return matched
    return await userIdentity.ensureStubGuest(identity)
  }

  private async resolveLocalLabels (
    names: readonly string[],
    bctx: MRBindingContext
  ): Promise<Array<Ref<TagElement>>> {
    const out: Array<Ref<TagElement>> = []
    for (const name of names) {
      const ref = await bctx.labelCache.ensureLocalTag(bctx.hulyClient, name)
      out.push(ref)
    }
    return out
  }

  /**
   * Project reviewers onto synthetic `gitlab:reviewer:<username>` labels.
   *
   * Phase 2 used this as the canonical reviewer representation (critic C4).
   * Phase 3 stops calling it from applyRemote (typed `reviewers` field replaces
   * the synthetic-label projection), but the function is RETAINED and exported
   * via the manager so the reviewer-migration helper (P3-T-09) can scan and
   * strip the legacy labels (C16).
   */
  async resolveReviewerLabels (
    reviewers: SyncMergeRequest['reviewers'],
    bctx: MRBindingContext
  ): Promise<Array<Ref<TagElement>>> {
    const out: Array<Ref<TagElement>> = []
    for (const r of reviewers ?? []) {
      const name = `gitlab:reviewer:${r.username}`
      const ref = await bctx.labelCache.ensureLocalTag(bctx.hulyClient, name)
      out.push(ref)
    }
    return out
  }

  /**
   * Phase 3 (P3-T-07): resolve a list of GitLab users to PersonUuids via the
   * UserIdentity, mirroring the assignee resolution path. Returns `undefined`
   * when the input itself is `undefined` (B2 — "not yet fetched" stays
   * "not yet fetched"; do NOT clear the mixin field by defaulting to []).
   */
  private async resolveReviewerUuids (
    users: SyncMergeRequest['reviewers'],
    userIdentity: UserIdentity
  ): Promise<PersonUuid[] | undefined> {
    if (users === undefined) return undefined
    const out: PersonUuid[] = []
    for (const u of users) {
      const identity: IdentitySyncUser = {
        gitlabId: String(u.id),
        ...(u.email !== null ? { email: u.email } : {}),
        ...(u.name !== '' ? { name: u.name } : {}),
        ...(u.username !== '' ? { username: u.username } : {})
      }
      const matched = await userIdentity.mapByGitlabUser(identity)
      if (matched !== undefined) {
        out.push(matched)
      } else {
        const stub = await userIdentity.ensureStubGuest(identity)
        out.push(stub as unknown as PersonUuid)
      }
    }
    return out
  }

  private async ensureRemoteLabels (
    labels: Array<{ name: string, color?: string }>,
    bctx: MRBindingContext
  ): Promise<string[]> {
    const names: string[] = []
    for (const l of labels) {
      const ensured = await bctx.labelCache.ensureRemoteLabel(bctx.gitlabClient, l.name, l.color)
      names.push(ensured.name)
    }
    return names
  }
}

/**
 * Read the runtime mixin attributes from a Huly Issue. The platform's mixin
 * accessor stores the attribute bag under the mixin Ref key on the Doc; tests
 * use a flat shape, so we accept both forms.
 */
function readMixin (issue: Issue): Record<string, unknown> | undefined {
  const obj = issue as unknown as Record<string, unknown>
  const mixinKey = MR_MIXIN as unknown as string
  const direct = obj[mixinKey]
  if (direct !== undefined && direct !== null && typeof direct === 'object') {
    return direct as Record<string, unknown>
  }
  return undefined
}

// ---------------------------------------------------------------------------

function stripDocPrefix (doc: string): string {
  const colon = doc.indexOf(':')
  if (colon < 0) return doc
  return doc.slice(colon + 1)
}

function parseIid (gitlabId: string): number | null {
  // B1: multi-instance keys are `${hash8}:${projectId}:${iid}`; single-instance
  // keys are `${projectId}:${iid}`. iid is always the LAST `:`-separated segment.
  const colon = gitlabId.lastIndexOf(':')
  if (colon < 0) return null
  const n = Number.parseInt(gitlabId.slice(colon + 1), 10)
  return Number.isFinite(n) ? n : null
}

function areEqual (a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    const sa = new Set(a as unknown[])
    const sb = new Set(b as unknown[])
    if (sa.size !== sb.size) return false
    for (const x of sa) {
      if (!sb.has(x)) return false
    }
    return true
  }
  return deepEqual(a, b)
}
