import type { Mixin, Ref } from '@hcengineering/core'
import type { Issue } from '@hcengineering/tracker'
import type { MergeStatus } from '../adapter/types'

/**
 * Shape of the runtime `gitlab-mr` mixin written onto a tracker.Issue
 * that mirrors a GitLab merge request.
 *
 * Intentionally does NOT include `pipelineStatus` — that field is owned
 * exclusively by PipelineSyncManager (critic C2).
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
}

/** Runtime mixin id used to carry GitLab MR fields on a tracker.Issue. */
export const MR_MIXIN = 'gitlab-mr' as unknown as Ref<Mixin<MRMixinDoc>>
