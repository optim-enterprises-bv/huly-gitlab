import type { Mixin, Ref } from '@hcengineering/core'
import type { Issue } from '@hcengineering/tracker'

/** Runtime mixin id used to carry GitLab epic fields on a tracker.Issue. */
export const MR_EPIC_MIXIN = 'gitlab-epic' as unknown as Ref<Mixin<MREpicMixinDoc>>

/**
 * Applied to the mirror Issue for each GitLab epic. Owned by EpicsSyncManager.
 *
 * EpicsSyncManager is the sole writer of all fields in this mixin.
 * No other manager may write these fields.
 */
export interface MREpicMixinDoc extends Issue {
  /** GitLab iid of this epic within its group. */
  epicIid: number
  /** GitLab group id that owns this epic. */
  groupId: number
  /** Current state of the epic on GitLab. */
  state: 'opened' | 'closed'
  /** Direct URL to the epic on GitLab. */
  webUrl: string
  /** GitLab iids of child issues/MRs in this epic. */
  childIssueIids: number[]
}
