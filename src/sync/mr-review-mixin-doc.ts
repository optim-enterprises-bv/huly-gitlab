import type { Ref, Mixin, PersonUuid } from '@hcengineering/core'
import type { Issue } from '@hcengineering/tracker'
import type { SyncChangedFile, SyncIteration, SyncMRApprovalRule, ApprovalStatus } from '../adapter/types'

export const MR_REVIEW_MIXIN_DOC = 'gitlab-mr-review' as unknown as Ref<Mixin<MRReviewMixinDoc>>

export interface MRReviewMixinDoc extends Issue {
  reviewers?: PersonUuid[]
  approvedBy?: PersonUuid[]
  approvalsRequired?: number
  approvalStatus?: ApprovalStatus
  diffWebUrl?: string
  changedFiles?: SyncChangedFile[]
  approvalRules?: SyncMRApprovalRule[]
  iteration?: SyncIteration | null
  parentEpicIid?: number
}
