import type { Ref, Mixin } from '@hcengineering/core'
import type { Issue } from '@hcengineering/tracker'

export const MR_CORE_MIXIN = 'gitlab-mr-core' as unknown as Ref<Mixin<MRCoreMixinDoc>>

export interface MRCoreMixinDoc extends Issue {
  sourceBranch: string
  targetBranch: string
  draft: boolean
  mergedAt: number | null
  mergeStatus: 'can_be_merged' | 'cannot_be_merged' | 'unchecked' | 'locked'
  webUrl: string
  gitlabIid: number
  gitlabProjectId: number
}
