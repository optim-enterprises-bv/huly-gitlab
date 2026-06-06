import type { Mixin, PersonUuid, Ref } from '@hcengineering/core'
import type { Issue } from '@hcengineering/tracker'
import type { ApprovalStatus, MergeStatus, SyncChangedFile, SyncIteration, SyncMRApprovalRule } from '../adapter/types'

/**
 * Shape of the runtime `gitlab-mr` mixin written onto a tracker.Issue
 * that mirrors a GitLab merge request.
 *
 * Field-ownership partition (critic C2 + Phase 3 + Phase 4 extension):
 * Total fields: 16
 *
 *   MergeRequestsSyncManager owns:
 *     sourceBranch, targetBranch, draft, mergedAt, mergeStatus, webUrl,
 *     gitlabIid, gitlabProjectId,
 *     approvedBy, approvalsRequired, approvalStatus, diffWebUrl, changedFiles
 *
 *   MergeRequestsSyncManager AND reviewer-migration helper (P3-T-09) own:
 *     reviewers  — MergeRequestsSyncManager writes it on applyRemote;
 *                  the migration helper back-fills it from Phase 2 label data.
 *
 *   MergeRequestsSyncManager owns (Phase 4 EE additions):
 *     approvalRules  — approval rule definitions for this MR.
 *     iteration      — GitLab iteration the MR is assigned to (null if unset).
 *
 *   EpicsSyncManager owns EXCLUSIVELY (never written by MR manager):
 *     parentEpicIid  — iid of the parent epic; EpicsSyncManager is SOLE writer.
 *
 *   PipelineSyncManager owns EXCLUSIVELY (never written by MR manager):
 *     pipelineStatus  — NOT a field on this interface by design.
 *
 * No manager may write a field owned by another manager.
 */
export interface MRMixinDoc extends Issue {
  sourceBranch: string
  targetBranch: string
  draft: boolean
  mergedAt: Date | null
  mergeStatus: MergeStatus
  webUrl: string
  gitlabIid: number
  gitlabProjectId: number

  // Phase 3 additions — all optional (not present on pre-Phase-3 documents)
  /** Typed reviewer list. Written by MergeRequestsSyncManager.applyRemote and the reviewer-migration helper (P3-T-09). */
  reviewers?: PersonUuid[]
  /** Users who have approved this MR. Written exclusively by MergeRequestsSyncManager. */
  approvedBy?: PersonUuid[]
  /** Minimum approvals required. From GitLab approvals.approvals_required. */
  approvalsRequired?: number
  /** Derived approval state: 'pending' | 'approved' | 'changes_requested'. */
  approvalStatus?: ApprovalStatus
  /** Direct URL to the MR diff view on GitLab. */
  diffWebUrl?: string
  /** Files changed in this MR. From getMRChanges. */
  changedFiles?: SyncChangedFile[]

  // Phase 4 EE additions (owned by MergeRequestsSyncManager):
  /** Approval rule definitions for this MR. Written exclusively by MergeRequestsSyncManager. */
  approvalRules?: SyncMRApprovalRule[]
  /** GitLab iteration assigned to this MR. Null when unset. Written exclusively by MergeRequestsSyncManager. */
  iteration?: SyncIteration | null

  // Phase 4 cross-manager field (owned by EpicsSyncManager — see epic-mixin.ts):
  /** iid of the parent epic on GitLab. EpicsSyncManager is SOLE writer of this field. */
  parentEpicIid?: number
}

/** Runtime mixin id used to carry GitLab MR fields on a tracker.Issue. */
export const MR_MIXIN = 'gitlab-mr' as unknown as Ref<Mixin<MRMixinDoc>>
