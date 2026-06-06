/**
 * Phase 3 / Phase 4 approval-action subsystem extracted from mr.ts (P4-T-11).
 *
 * Exports:
 *   - MRCredentialResolver interface
 *   - APPROVAL_RACE_WINDOW_MS constant
 *   - deriveApprovalStatusFromRules helper
 *   - applyApprovalActions / invokeApprovalAction orchestrator + per-actor call
 *   - postVisibilityComment / postFailureComment Huly comment helpers
 *   - getApprovalServiceAccountFallbackCount / resetApprovalServiceAccountFallbackCount
 *     (backward-compat re-exports backed by the central metrics registry)
 */
import type { PersonUuid, Ref, TxOperations, WorkspaceUuid } from '@hcengineering/core'
import tracker, { type Issue } from '@hcengineering/tracker'
import chunter from '@hcengineering/chunter'
import { ApprovalActionError } from '../adapter/errors'
import type { ApprovalStatus, SyncMergeRequest, SyncMRApprovalRule } from '../adapter/types'
import type { Logger } from '../logging'
import * as metrics from '../metrics'
import { METRIC_NAMES } from '../metrics'
import { type MRMixinDoc, readMRMixinAttributes } from './mr-mixin'
import type { MRCoreMixinDoc } from './mr-core-mixin'
import type { MRReviewMixinDoc } from './mr-review-mixin-doc'
import type { MRBindingContext } from './mr'
import type { BindingRef } from './types'
import { withOriginatedMarker } from './originated-marker'

/**
 * Phase 3 race window: when applyRemote sees fewer approvers in remote than
 * are currently in local mixin AND local was updated within this window, treat
 * the discrepancy as an in-flight `approveMR` round-trip and KEEP local.
 * Critic constraint C10 — see §"P3-T-07" in the Phase 3 plan.
 */
export const APPROVAL_RACE_WINDOW_MS = 30_000

export function getApprovalServiceAccountFallbackCount (): number {
  return metrics.get(METRIC_NAMES.APPROVAL_SERVICE_ACCOUNT_FALLBACK)
}

export function resetApprovalServiceAccountFallbackCount (): void {
  metrics.reset(METRIC_NAMES.APPROVAL_SERVICE_ACCOUNT_FALLBACK)
}

/**
 * Per-actor credential resolver. Phase 3 ships the API surface; the stub
 * implementation always returns `undefined`, which triggers the service-account
 * fallback path in approveMR/unapproveMR (with warn log + visibility comment).
 * P3-T-10 will wire the real per-user OAuth lookup behind this interface.
 */
export interface MRCredentialResolver {
  /**
   * Resolve a GitLab API token attributed to the given Huly person, scoped to
   * the binding's workspace. Phase 3 stub returns `undefined` (no UI for users
   * to self-link credentials yet).
   */
  resolveActorToken: (
    workspaceUuid: WorkspaceUuid,
    hulyPersonUuid: PersonUuid
  ) => Promise<string | undefined>
}

/**
 * Phase 4 EE rule-aware approval status derivation. When approval rules are
 * present, the MR is 'approved' only if EVERY rule has its threshold met.
 *
 * Bug-4 CE regression: callers MUST fall back to the Phase 3 CE derivation
 * when `rules === undefined` OR `rules.length === 0`.
 * This function is only consulted when `rules` is a non-empty array.
 */
export function deriveApprovalStatusFromRules (
  rules: readonly SyncMRApprovalRule[]
): ApprovalStatus {
  for (const rule of rules) {
    if (rule.approvedBy.length < rule.approvalsRequired) return 'pending'
  }
  return 'approved'
}

/**
 * Phase 3 (P3-T-07): translate approvedBy set deltas into GitLab approve /
 * unapprove calls. Per-user actor token resolved via `bctx.credentials`;
 * undefined triggers the service-account fallback path in the adapter, with
 * a visibility comment posted onto the parent Issue.
 *
 * Best-effort: an `ApprovalActionError` is logged + commented but does NOT
 * propagate (next-write-wins semantics — Phase 3 §"Error Handling").
 */
export async function applyApprovalActions (
  logger: Logger,
  bctx: MRBindingContext,
  binding: BindingRef,
  issueRef: Ref<Issue>,
  iid: number,
  incoming: PersonUuid[]
): Promise<void> {
  const hulyIssue = await bctx.hulyClient.findOne<Issue>(
    tracker.class.Issue,
    { _id: issueRef }
  )
  const existingMixin = hulyIssue !== undefined ? readMRMixinAttributes(hulyIssue) : undefined
  const current = existingMixin?.approvedBy ?? []

  const currentSet = new Set(current.map((u) => String(u)))
  const incomingSet = new Set(incoming.map((u) => String(u)))

  const added: PersonUuid[] = []
  for (const u of incoming) {
    if (!currentSet.has(String(u))) added.push(u)
  }
  const removed: PersonUuid[] = []
  for (const u of current) {
    if (!incomingSet.has(String(u))) removed.push(u)
  }

  for (const person of added) {
    await invokeApprovalAction(logger, bctx, binding, issueRef, iid, person, 'approve')
  }
  for (const person of removed) {
    await invokeApprovalAction(logger, bctx, binding, issueRef, iid, person, 'unapprove')
  }
}

export async function invokeApprovalAction (
  logger: Logger,
  bctx: MRBindingContext,
  binding: BindingRef,
  issueRef: Ref<Issue>,
  iid: number,
  person: PersonUuid,
  kind: 'approve' | 'unapprove'
): Promise<void> {
  const actorToken = await bctx.credentials.resolveActorToken(bctx.workspaceUuid, person)
  const usingServiceAccount = actorToken === undefined
  if (usingServiceAccount) {
    metrics.increment(METRIC_NAMES.APPROVAL_SERVICE_ACCOUNT_FALLBACK)
    logger.warn('approval.action.fallback.service_account', {
      binding,
      iid,
      person,
      kind
    })
  }

  try {
    if (kind === 'approve') {
      await bctx.gitlabClient.approveMR(bctx.gitlabProjectId, iid, actorToken)
    } else {
      await bctx.gitlabClient.unapproveMR(bctx.gitlabProjectId, iid, actorToken)
    }
  } catch (err) {
    if (err instanceof ApprovalActionError) {
      logger.error('mr.approval.action.failed', {
        binding,
        iid,
        person,
        kind,
        error: (err as Error).message
      })
      // On failure post a DIFFERENT visibility comment so the optimistic
      // "Approved via service account" message is NOT shown when the action
      // actually failed (B2 — visibility ordering).
      await postFailureComment(bctx, issueRef, kind)
      return
    }
    throw err
  }

  // Adapter call succeeded — only now post the optimistic visibility comment
  // (B2: post AFTER the adapter call, never before).
  if (usingServiceAccount) {
    await postVisibilityComment(logger, bctx, issueRef, kind)
  }
}

export async function postVisibilityComment (
  logger: Logger,
  bctx: MRBindingContext,
  issueRef: Ref<Issue>,
  kind: 'approve' | 'unapprove'
): Promise<void> {
  try {
    const verb = kind === 'approve' ? 'Approved' : 'Unapproved'
    const body = `${verb} via service account; per-user OAuth UI coming in Phase 4`
    await bctx.hulyClient.createDoc(
      chunter.class.ChatMessage,
      bctx.hulyProjectRef,
      withOriginatedMarker({
        attachedTo: issueRef,
        attachedToClass: tracker.class.Issue,
        collection: 'comments',
        message: body
      }) as unknown as Parameters<TxOperations['createDoc']>[2]
    )
  } catch (err) {
    logger.warn('mr.approval.visibility.comment.failed', {
      err: err instanceof Error ? err.message : String(err)
    })
  }
}

export async function postFailureComment (
  bctx: MRBindingContext,
  issueRef: Ref<Issue>,
  kind: 'approve' | 'unapprove'
): Promise<void> {
  try {
    const verb = kind === 'approve' ? 'Approval' : 'Unapproval'
    const body = `${verb} failed — see logs for details`
    await bctx.hulyClient.createDoc(
      chunter.class.ChatMessage,
      bctx.hulyProjectRef,
      withOriginatedMarker({
        attachedTo: issueRef,
        attachedToClass: tracker.class.Issue,
        collection: 'comments',
        message: body
      }) as unknown as Parameters<TxOperations['createDoc']>[2]
    )
  } catch {
    // Swallow — failure comment failure is non-fatal
  }
}

// ---------------------------------------------------------------------------
// Mixin delta builders (extracted from mr.ts — P4-T-11)
// ---------------------------------------------------------------------------

export function deriveApprovalStatus (
  approvedBy: PersonUuid[] | undefined,
  approvalsRequired: number | undefined
): ApprovalStatus {
  if (approvalsRequired !== undefined && approvalsRequired > 0 &&
      approvedBy !== undefined && approvedBy.length >= approvalsRequired) {
    return 'approved'
  }
  return 'pending'
}

export function buildMixinCreateData (
  syncMR: SyncMergeRequest,
  reviewerUuids: PersonUuid[] | undefined,
  approvedByUuids: PersonUuid[] | undefined
): Omit<MRMixinDoc, keyof Issue> {
  const base: Omit<MRMixinDoc, keyof Issue> = {
    sourceBranch: syncMR.sourceBranch,
    targetBranch: syncMR.targetBranch,
    draft: syncMR.draft,
    mergedAt: syncMR.mergedAt,
    mergeStatus: syncMR.mergeStatus,
    webUrl: syncMR.webUrl,
    gitlabIid: syncMR.iid,
    gitlabProjectId: syncMR.projectId
  }
  applyPhase3MixinFields(base, syncMR, reviewerUuids, approvedByUuids)
  return base
}

export function buildMixinUpdateData (
  syncMR: SyncMergeRequest,
  reviewerUuids: PersonUuid[] | undefined,
  approvedByUuids: PersonUuid[] | undefined
): Partial<Omit<MRMixinDoc, keyof Issue>> {
  const update: Partial<Omit<MRMixinDoc, keyof Issue>> = {
    sourceBranch: syncMR.sourceBranch,
    targetBranch: syncMR.targetBranch,
    draft: syncMR.draft,
    mergedAt: syncMR.mergedAt,
    mergeStatus: syncMR.mergeStatus,
    webUrl: syncMR.webUrl
  }
  applyPhase3MixinFields(update, syncMR, reviewerUuids, approvedByUuids)
  return update
}

// ---------------------------------------------------------------------------
// P5-T-17: split mixin builders for MR_CORE_MIXIN + MR_REVIEW_MIXIN_DOC.
// New writes go to these two mixins; legacy MR_MIXIN is no longer written.
// ---------------------------------------------------------------------------

/**
 * Build the core-mixin attribute object — the always-required GitLab-side
 * fields that mirror the MR shape on Huly. Used for BOTH create and update
 * paths because core fields are GitLab-authoritative (remote-wins).
 *
 * Note: `mergedAt` type on MR_CORE_MIXIN is `number | null` but legacy MRMixinDoc
 * carries a Date. Cast at the boundary; on-wire shape is unchanged for tests.
 */
export function buildCoreFromSyncMR (
  syncMR: SyncMergeRequest
): Omit<MRCoreMixinDoc, keyof Issue> {
  return {
    sourceBranch: syncMR.sourceBranch,
    targetBranch: syncMR.targetBranch,
    draft: syncMR.draft,
    mergedAt: syncMR.mergedAt as unknown as MRCoreMixinDoc['mergedAt'],
    mergeStatus: syncMR.mergeStatus,
    webUrl: syncMR.webUrl,
    gitlabIid: syncMR.iid,
    gitlabProjectId: syncMR.projectId
  }
}

/**
 * Build the review-mixin attribute object — Phase 3 + Phase 4 EE fields. Only
 * keys whose source data is defined on the incoming SyncMergeRequest are
 * populated (B2 "undefined means not yet fetched"). Returns an empty object
 * when no review-side data is present; callers should suppress the write in
 * that case (no point firing a no-op TxMixin).
 */
export function buildReviewFromSyncMR (
  syncMR: SyncMergeRequest,
  reviewerUuids: PersonUuid[] | undefined,
  approvedByUuids: PersonUuid[] | undefined
): Partial<Omit<MRReviewMixinDoc, keyof Issue>> {
  const target: Partial<Omit<MRReviewMixinDoc, keyof Issue>> = {}
  if (syncMR.reviewers !== undefined && reviewerUuids !== undefined) {
    target.reviewers = reviewerUuids
  }
  if (syncMR.approvedBy !== undefined && approvedByUuids !== undefined) {
    target.approvedBy = approvedByUuids
  }
  if (syncMR.approvalsRequired !== undefined) {
    target.approvalsRequired = syncMR.approvalsRequired
  }
  if (syncMR.approvalRules !== undefined) {
    target.approvalRules = syncMR.approvalRules
  }
  if (syncMR.approvalRules !== undefined && syncMR.approvalRules.length > 0) {
    target.approvalStatus = deriveApprovalStatusFromRules(syncMR.approvalRules)
  } else if (syncMR.approvedBy !== undefined && syncMR.approvalsRequired !== undefined) {
    target.approvalStatus = deriveApprovalStatus(
      approvedByUuids ?? [],
      syncMR.approvalsRequired
    )
  }
  if (syncMR.iteration !== undefined) {
    target.iteration = syncMR.iteration
  }
  if (syncMR.diffWebUrl !== undefined) {
    target.diffWebUrl = syncMR.diffWebUrl
  }
  if (syncMR.changedFiles !== undefined) {
    target.changedFiles = syncMR.changedFiles
  }
  return target
}

/**
 * Phase 3 field writer. Each field is written ONLY when the source data is
 * defined on the incoming SyncMergeRequest. Per B2: `undefined` means
 * "not yet fetched" — never clear the mixin field by defaulting to [] or 0.
 *
 * Phase 4 EE extensions (P4-T-08):
 *   - `approvalRules`: when present, written verbatim. When non-empty,
 *     `approvalStatus` is derived rule-by-rule (every rule must meet its
 *     threshold). Bug-4 CE regression: when rules are undefined OR empty,
 *     fall back to the Phase 3 `deriveApprovalStatus` derivation.
 *   - `iteration`: written verbatim, including explicit `null` to clear.
 *
 * AC-1: `parentEpicIid` is owned exclusively by EpicsSyncManager. This
 * function MUST NOT read or write that field — even if the incoming
 * SyncMergeRequest somehow carries one (the adapter type intentionally omits
 * it from `SyncMergeRequest`).
 */
export function applyPhase3MixinFields (
  target: Partial<Omit<MRMixinDoc, keyof Issue>>,
  syncMR: SyncMergeRequest,
  reviewerUuids: PersonUuid[] | undefined,
  approvedByUuids: PersonUuid[] | undefined
): void {
  if (syncMR.reviewers !== undefined && reviewerUuids !== undefined) {
    target.reviewers = reviewerUuids
  }
  if (syncMR.approvedBy !== undefined && approvedByUuids !== undefined) {
    target.approvedBy = approvedByUuids
  }
  if (syncMR.approvalsRequired !== undefined) {
    target.approvalsRequired = syncMR.approvalsRequired
  }
  // Phase 4 EE: approvalRules write + rule-aware approvalStatus derivation.
  if (syncMR.approvalRules !== undefined) {
    target.approvalRules = syncMR.approvalRules
  }
  // Bug-4 CE regression: rule-aware status only when rules are present and
  // non-empty. Undefined OR empty array → fall through to Phase 3 CE logic.
  if (syncMR.approvalRules !== undefined && syncMR.approvalRules.length > 0) {
    target.approvalStatus = deriveApprovalStatusFromRules(syncMR.approvalRules)
  } else if (syncMR.approvedBy !== undefined && syncMR.approvalsRequired !== undefined) {
    // B3: only derive approvalStatus when BOTH inputs are present. A partial
    // composite (e.g. only approvalsRequired arrived) MUST NOT clobber a
    // previously-known status by defaulting the missing half.
    target.approvalStatus = deriveApprovalStatus(
      approvedByUuids ?? [],
      syncMR.approvalsRequired
    )
  }
  // Phase 4 EE: iteration write — explicit null clears the field.
  if (syncMR.iteration !== undefined) {
    target.iteration = syncMR.iteration
  }
  if (syncMR.diffWebUrl !== undefined) {
    target.diffWebUrl = syncMR.diffWebUrl
  }
  if (syncMR.changedFiles !== undefined) {
    target.changedFiles = syncMR.changedFiles
  }
  // AC-1: parentEpicIid is owned exclusively by EpicsSyncManager.
  // Do NOT read or write `target.parentEpicIid` here under any circumstance.
}
