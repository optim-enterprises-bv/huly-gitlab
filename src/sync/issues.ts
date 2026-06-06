import type { Doc, PersonUuid, Ref, Space, TxOperations, WorkspaceUuid } from '@hcengineering/core'
import tracker, { type Issue, IssuePriority, type Status, type TaskType } from '@hcengineering/tracker'
import type { TagElement } from '@hcengineering/tags'
import { deepEqual } from 'fast-equals'
import type { GitLabClient } from '../adapter/gitlab-client'
import type { SyncIssue } from '../adapter/types'
import { gfmMarkdownToMarkup, markupToGfmMarkdown } from '../markdown'
import { findByGitlab, findByHuly, upsertIdMap } from '../state/idmap'
import { setCursor } from '../state/cursors'
import { prefixGitlabIdForMultiInstance } from './multi-instance'
import type { SyncUser as IdentitySyncUser, UserIdentity } from '../huly/users'
import { applyLwwFieldByField, type FieldDecision, type FieldVersion } from './conflict'
import type { LabelCache } from './label-cache'
import type { MilestoneCache } from './milestone-cache'
import { mapHulyStatus, mapRemoteState } from './status-map'
import type { BindingRef, SyncContext, SyncManager } from './types'
import type { MirrorDeps } from './attachments'
import { mirrorBodyGitlabToHuly, mirrorBodyHulyToGitlab } from './attachments'
import { withOriginatedMarker } from './originated-marker'

const HULY_CLASS_ISSUE = 'tracker:class:Issue'

/**
 * Resolve a Huly Issue ref for a given GitLab issue iid on a binding.
 * Published as a top-level export so T-11 (NotesSyncManager) can attach
 * notes/comments to the right issue.
 *
 * Returns undefined when the issue has not yet been mirrored into Huly.
 *
 * B1: when the caller is in a multi-instance workspace, the gitlabId is
 * prefixed via `prefixGitlabIdForMultiInstance` to avoid collisions across
 * GitLab instances sharing the same numeric projectId.
 */
export async function resolveIssueRef (
  ctx: SyncContext,
  binding: BindingResolverInput,
  gitlabIssueIid: number
): Promise<Ref<Issue> | undefined> {
  const rawId = `${binding.gitlabProjectId}:${gitlabIssueIid}`
  const gitlabId = (binding.isMultiInstanceWorkspace === true && binding.gitlabBaseUrl !== undefined)
    ? prefixGitlabIdForMultiInstance({
      isMultiInstanceWorkspace: true,
      gitlabBaseUrl: binding.gitlabBaseUrl
    }, rawId)
    : rawId
  const mapping = await findByGitlab(ctx.store.idmap(), ctx.workspaceUuid, 'issue', gitlabId)
  if (mapping === null) return undefined
  return mapping.hulyRef as Ref<Issue>
}

/**
 * Minimal binding shape needed for resolution. The real `BindingDoc` from state/bindings.ts
 * satisfies this structurally.
 *
 * B1: optional `gitlabBaseUrl` + `isMultiInstanceWorkspace` allow multi-instance
 * callers to prefix the idmap gitlabId. When omitted (single-instance default)
 * the raw key is used.
 */
export interface BindingResolverInput {
  gitlabProjectId: number
  gitlabBaseUrl?: string
  isMultiInstanceWorkspace?: boolean
}

/**
 * Loaded binding context — everything IssuesSyncManager needs about a binding
 * to operate. The caller (engine wiring or T-12 backfill) is responsible for
 * loading and passing these in via the BindingLoader callback.
 */
export interface BindingContext {
  workspaceUuid: WorkspaceUuid
  gitlabProjectId: number
  gitlabProjectPath: string
  hulyProjectRef: Ref<Space>
  hulyClient: TxOperations
  gitlabClient: IssueGitLabClient
  statuses: readonly Status[]
  userIdentity: UserIdentity
  labelCache: LabelCache
  milestoneCache: MilestoneCache
  /** Default TaskType to assign to newly-created Huly Issues */
  defaultTaskType: Ref<TaskType>
  /** Absolute base URL used to resolve relative attachment links in markdown */
  gitlabBaseUrl: string
  /**
   * B1: true when ≥ 2 distinct GitLab base URLs are registered for this
   * workspace. When true, idmap gitlabId values are prefixed via
   * `prefixGitlabIdForMultiInstance` to prevent project-ID collisions
   * between GitLab instances (TG-4 defense-in-depth).
   */
  isMultiInstanceWorkspace?: boolean
}

/**
 * Loader function — engine asks for the BindingContext for a given BindingRef.
 * Decoupled to keep this manager dependency-light and trivially testable.
 */
export type BindingLoader = (binding: BindingRef) => Promise<BindingContext>

/**
 * GitLab client surface IssuesSyncManager uses. The full GitLabClient satisfies this.
 */
export interface IssueGitLabClient {
  listIssues: (
    projectId: number | string,
    opts: { updatedAfter?: string }
  ) => Promise<SyncIssue[]>
  createIssue: (
    projectId: number | string,
    body: CreateIssueBody
  ) => Promise<SyncIssue>
  updateIssue: (
    projectId: number | string,
    iid: number,
    body: UpdateIssueBody
  ) => Promise<SyncIssue>
  listLabels: GitLabClient['listLabels']
  createLabel: GitLabClient['createLabel']
  listMilestones: GitLabClient['listMilestones']
  createMilestone: GitLabClient['createMilestone']
}

export interface CreateIssueBody {
  title: string
  description?: string
  labels?: string
  milestone_id?: number
  assignee_ids?: number[]
  state_event?: 'close' | 'reopen'
}

export interface UpdateIssueBody {
  title?: string
  description?: string
  labels?: string
  milestone_id?: number
  assignee_ids?: number[]
  state_event?: 'close' | 'reopen'
}

/**
 * Enqueue contract used by backfill — the engine consumes records as if they
 * arrived via webhook, so backfill funnels through the same SyncManager dispatch.
 */
export type BackfillEnqueuerFn = (
  binding: BindingRef,
  kind: string,
  record: Record<string, unknown>,
  eventId: string,
  version: string
) => Promise<void> | void

/** Object form preserved for test ergonomics. */
export interface BackfillEnqueuer {
  enqueueBackfillRecord: BackfillEnqueuerFn
}

export interface IssuesSyncManagerDeps {
  loadBinding: BindingLoader
  /** Object form (legacy) */
  enqueuer?: BackfillEnqueuer
  /** Function form preferred for new wiring */
  backfillEnqueuer?: BackfillEnqueuerFn
  /**
   * Optional attachment mirror deps. When present, GitLab upload links in issue
   * descriptions are mirrored into Huly (and vice versa). When absent or when
   * mirror fails, the original link is preserved (link-through fallback).
   */
  mirrorDeps?: MirrorDeps
}

/**
 * IssuesSyncManager — two-way sync for tracker Issues.
 *
 * Q5: confidential issues are filtered at adapter and webhook layers; this manager
 * assumes incoming SyncIssue records are non-confidential. No tracker mixin is
 * created — GitLab linkage is tracked solely via the idMap.
 */
export class IssuesSyncManager implements SyncManager<SyncIssue> {
  readonly kind = 'issue'

  constructor (private readonly deps: IssuesSyncManagerDeps) {}

  resourceKey (record: Record<string, unknown>): string | undefined {
    const iid = record.iid
    if (typeof iid === 'number') return `issue:${iid}`
    const objAttrs = record.object_attributes
    if (objAttrs !== null && typeof objAttrs === 'object') {
      const i = (objAttrs as Record<string, unknown>).iid
      if (typeof i === 'number') return `issue:${i}`
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
    syncIssue: SyncIssue
  ): Promise<void> {
    const bctx = await this.deps.loadBinding(binding)
    const gitlabId = prefixGitlabIdForMultiInstance(
      { isMultiInstanceWorkspace: bctx.isMultiInstanceWorkspace === true, gitlabBaseUrl: bctx.gitlabBaseUrl },
      `${bctx.gitlabProjectId}:${syncIssue.iid}`
    )
    const projectKey = String(bctx.gitlabProjectId)

    const existing = await findByGitlab(ctx.store.idmap(), bctx.workspaceUuid, 'issue', gitlabId)

    // Translate description (markdown → markup) once
    const refUrl = `${bctx.gitlabBaseUrl.replace(/\/$/, '')}/${bctx.gitlabProjectPath}/-/issues`
    const imageUrl = `${bctx.gitlabBaseUrl.replace(/\/$/, '')}/${bctx.gitlabProjectPath}`

    let rawDescription = syncIssue.description ?? ''
    if (this.deps.mirrorDeps !== undefined) {
      try {
        rawDescription = await mirrorBodyGitlabToHuly(
          this.deps.mirrorDeps,
          rawDescription,
          bctx.gitlabBaseUrl,
          bctx.gitlabProjectPath
        )
      } catch (err) {
        ctx.logger.warn('IssuesSyncManager: attachment mirror failed — using link-through', {
          binding,
          iid: syncIssue.iid,
          error: err instanceof Error ? err.message : String(err)
        })
        ctx.logger.info('ATTACHMENT_MIRROR_FAILED', { binding, iid: syncIssue.iid })
      }
    }

    const descriptionMarkup = gfmMarkdownToMarkup(rawDescription, refUrl, imageUrl)

    // Resolve assignee (first assignee mapped; multi-assignee not modelled in tracker.Issue.assignee)
    const assigneeRef = await this.resolveAssignee(syncIssue.assignees, bctx.userIdentity)

    // Resolve labels via LabelCache
    const labelRefs = await this.resolveLocalLabels(syncIssue.labels, bctx)

    // Resolve milestone via MilestoneCache
    const milestoneRef = syncIssue.milestone !== null
      ? await bctx.milestoneCache.ensureLocalMilestone(
        bctx.hulyClient,
        syncIssue.milestone.title,
        syncIssue.milestone.description ?? undefined
      )
      : null

    // Resolve status from project statuses
    const statusRef = mapRemoteState(projectKey, syncIssue.state, bctx.statuses)
    if (statusRef === undefined) {
      ctx.logger.warn('IssuesSyncManager: no status match for project', {
        binding,
        projectKey,
        state: syncIssue.state
      })
      return
    }

    if (existing === null) {
      // CREATE — no existing Huly issue; create from remote payload wholesale.
      // modifiedOn is seeded from the remote updatedAt so subsequent remote
      // updates with a newer timestamp win the per-field LWW comparison.
      const remoteTs = new Date(syncIssue.updatedAt).getTime()
      const issueRef = await bctx.hulyClient.createDoc<Issue>(
        tracker.class.Issue,
        bctx.hulyProjectRef,
        withOriginatedMarker({
          title: syncIssue.title,
          description: descriptionMarkup,
          status: statusRef,
          priority: IssuePriority.NoPriority,
          assignee: assigneeRef as Ref<Doc> | null,
          labels: labelRefs,
          milestone: milestoneRef,
          kind: bctx.defaultTaskType,
          modifiedOn: remoteTs
        })
      )
      await upsertIdMap(
        ctx.store.idmap(),
        bctx.workspaceUuid,
        'issue',
        gitlabId,
        HULY_CLASS_ISSUE,
        issueRef
      )
      await setCursor(ctx.store.cursors(), binding, 'issues', new Date(syncIssue.updatedAt))
      return
    }

    // UPDATE — fetch local Huly issue, apply per-field LWW.
    const hulyIssue = await bctx.hulyClient.findOne<Issue>(
      tracker.class.Issue,
      { _id: existing.hulyRef as Ref<Issue> }
    )
    if (hulyIssue === undefined) {
      ctx.logger.warn('IssuesSyncManager: idMap points to missing issue', {
        binding,
        hulyRef: existing.hulyRef
      })
      return
    }

    // Per-field LWW: use the Huly Doc's intrinsic modifiedOn as local timestamp.
    // 0 means "no local mutation" so remote always wins (matches new-issue path).
    const localTs = hulyIssue.modifiedOn > 0 ? new Date(hulyIssue.modifiedOn) : undefined
    const remoteTs = new Date(syncIssue.updatedAt)

    type IssueFieldMap = Record<string, FieldVersion<unknown>>

    const local: IssueFieldMap = {
      title: { value: hulyIssue.title, ts: localTs },
      description: { value: hulyIssue.description, ts: localTs },
      status: { value: hulyIssue.status, ts: localTs },
      assignee: { value: hulyIssue.assignee, ts: localTs },
      milestone: { value: hulyIssue.milestone ?? null, ts: localTs },
      labels: { value: hulyIssue.labels ?? [], ts: localTs }
    }
    const remote: IssueFieldMap = {
      title: { value: syncIssue.title, ts: remoteTs },
      description: { value: descriptionMarkup, ts: remoteTs },
      status: { value: statusRef, ts: remoteTs },
      assignee: { value: assigneeRef as Ref<Doc> | null, ts: remoteTs },
      milestone: { value: milestoneRef, ts: remoteTs },
      labels: { value: labelRefs, ts: remoteTs }
    }

    const decisions = applyLwwFieldByField(local, remote)
    const update: Partial<Issue> = {}
    let dirty = false

    const take = (k: string, decision: FieldDecision | undefined): void => {
      if (decision !== 'remote') return
      const remoteVal = remote[k].value
      const localVal = local[k].value
      if (areEqual(remoteVal, localVal)) return
      // Assignment is structurally safe — Issue has these exact fields.
      ;(update as Record<string, unknown>)[k] = remoteVal
      dirty = true
    }

    take('title', decisions.title)
    take('description', decisions.description)
    take('status', decisions.status)
    take('assignee', decisions.assignee)
    take('milestone', decisions.milestone)
    take('labels', decisions.labels)

    if (dirty) {
      // Bump modifiedOn so the next LWW round sees this remote as the local timestamp.
      ;(update as Record<string, unknown>).modifiedOn = remoteTs.getTime()
      await bctx.hulyClient.updateDoc<Issue>(
        tracker.class.Issue,
        bctx.hulyProjectRef,
        existing.hulyRef as Ref<Issue>,
        withOriginatedMarker(update)
      )
    }

    if (localTs === undefined || remoteTs > localTs) {
      await setCursor(ctx.store.cursors(), binding, 'issues', remoteTs)
    }
  }

  async applyLocal (
    ctx: SyncContext,
    binding: BindingRef,
    doc: string,
    change: Record<string, unknown>
  ): Promise<void> {
    const bctx = await this.deps.loadBinding(binding)
    const projectKey = String(bctx.gitlabProjectId)

    // doc is the Huly Issue ref (engine prefixes with "issue:" — strip it)
    const hulyRef = stripDocPrefix(doc) as Ref<Issue>

    const refUrl = `${bctx.gitlabBaseUrl.replace(/\/$/, '')}/${bctx.gitlabProjectPath}/-/issues`
    const imageUrl = `${bctx.gitlabBaseUrl.replace(/\/$/, '')}/${bctx.gitlabProjectPath}`

    const mapping = await findByHuly(
      ctx.store.idmap(),
      bctx.workspaceUuid,
      HULY_CLASS_ISSUE,
      hulyRef
    )

    const title = change.title as string | undefined
    const descriptionMarkup = change.description as string | undefined
    const statusRef = change.status as Ref<Status> | undefined
    const labels = change.labels as Array<{ name: string, color?: string }> | undefined
    const milestone = change.milestone as { title: string, description?: string } | null | undefined
    const assigneeIds = change.assigneeIds as number[] | undefined

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
      ? (mapHulyStatus(projectKey, statusRef, bctx.statuses) === 'closed' ? 'close' : 'reopen')
      : undefined

    let description = descriptionMarkup !== undefined
      ? markupToGfmMarkdown(descriptionMarkup, refUrl, imageUrl)
      : undefined

    if (description !== undefined && this.deps.mirrorDeps !== undefined) {
      try {
        description = await mirrorBodyHulyToGitlab(this.deps.mirrorDeps, description, bctx.gitlabProjectId)
      } catch (err) {
        ctx.logger.warn('IssuesSyncManager: attachment mirror (Huly→GitLab) failed — using link-through', {
          binding,
          hulyRef,
          error: err instanceof Error ? err.message : String(err)
        })
        ctx.logger.info('ATTACHMENT_MIRROR_FAILED', { binding, hulyRef })
      }
    }

    if (mapping === null) {
      // CREATE on GitLab side
      if (title === undefined) {
        ctx.logger.warn('IssuesSyncManager: cannot create remote issue without title', { binding, hulyRef })
        return
      }
      const body: CreateIssueBody = { title }
      if (description !== undefined) body.description = description
      if (labelNames !== undefined) body.labels = labelNames.join(',')
      if (milestoneId !== undefined) body.milestone_id = milestoneId
      if (assigneeIds !== undefined) body.assignee_ids = assigneeIds
      if (stateEvent !== undefined) body.state_event = stateEvent

      const created = await bctx.gitlabClient.createIssue(bctx.gitlabProjectId, body)
      const createdGitlabId = prefixGitlabIdForMultiInstance(
        { isMultiInstanceWorkspace: bctx.isMultiInstanceWorkspace === true, gitlabBaseUrl: bctx.gitlabBaseUrl },
        `${bctx.gitlabProjectId}:${created.iid}`
      )
      await upsertIdMap(
        ctx.store.idmap(),
        bctx.workspaceUuid,
        'issue',
        createdGitlabId,
        HULY_CLASS_ISSUE,
        hulyRef
      )
      await setCursor(ctx.store.cursors(), binding, 'issues', new Date())
      return
    }

    // UPDATE — extract iid from gitlabId "projectId:iid"
    const iid = parseIid(mapping.gitlabId)
    if (iid === null) {
      ctx.logger.warn('IssuesSyncManager: malformed idMap gitlabId', { gitlabId: mapping.gitlabId })
      return
    }

    const update: UpdateIssueBody = {}
    if (title !== undefined) update.title = title
    if (description !== undefined) update.description = description
    if (labelNames !== undefined) update.labels = labelNames.join(',')
    if (milestoneId !== undefined) update.milestone_id = milestoneId
    if (assigneeIds !== undefined) update.assignee_ids = assigneeIds
    if (stateEvent !== undefined) update.state_event = stateEvent

    if (Object.keys(update).length === 0) {
      // No-op — nothing changed
      return
    }

    await bctx.gitlabClient.updateIssue(bctx.gitlabProjectId, iid, update)
    await setCursor(ctx.store.cursors(), binding, 'issues', new Date())
  }

  async backfill (
    ctx: SyncContext,
    binding: BindingRef,
    since: Date | undefined
  ): Promise<void> {
    const bctx = await this.deps.loadBinding(binding)
    const opts: { updatedAfter?: string } = {}
    if (since !== undefined) opts.updatedAfter = since.toISOString()

    const issues = await bctx.gitlabClient.listIssues(bctx.gitlabProjectId, opts)

    for (const issue of issues) {
      const eventId = `backfill:${bctx.gitlabProjectId}:${issue.iid}:${issue.updatedAt}`
      const version = issue.updatedAt
      await this.enqueueRecord(
        binding,
        'issue',
        issue as unknown as Record<string, unknown>,
        eventId,
        version
      )
    }
  }

  // ---------------------------------------------------------------------------

  private async resolveAssignee (
    assignees: SyncIssue['assignees'],
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
    // Unmatched → ensure stub guest (R9 dedup inside)
    return await userIdentity.ensureStubGuest(identity)
  }

  private async resolveLocalLabels (
    names: readonly string[],
    bctx: BindingContext
  ): Promise<Array<Ref<TagElement>>> {
    const out: Array<Ref<TagElement>> = []
    for (const name of names) {
      const ref = await bctx.labelCache.ensureLocalTag(bctx.hulyClient, name)
      out.push(ref)
    }
    return out
  }

  private async ensureRemoteLabels (
    labels: Array<{ name: string, color?: string }>,
    bctx: BindingContext
  ): Promise<string[]> {
    const names: string[] = []
    for (const l of labels) {
      const ensured = await bctx.labelCache.ensureRemoteLabel(bctx.gitlabClient, l.name, l.color)
      names.push(ensured.name)
    }
    return names
  }
}

function stripDocPrefix (doc: string): string {
  const colon = doc.indexOf(':')
  if (colon < 0) return doc
  return doc.slice(colon + 1)
}

function parseIid (gitlabId: string): number | null {
  // B1: multi-instance keys are `${hash8}:${projectId}:${iid}`; single-instance
  // keys are `${projectId}:${iid}`. In both cases the iid is the LAST `:`-separated
  // segment, so parse from the rightmost colon.
  const colon = gitlabId.lastIndexOf(':')
  if (colon < 0) return null
  const n = Number.parseInt(gitlabId.slice(colon + 1), 10)
  return Number.isFinite(n) ? n : null
}

function areEqual (a: unknown, b: unknown): boolean {
  if (a === b) return true
  // Labels are order-insensitive — compare as sets when both sides are arrays of primitives.
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
