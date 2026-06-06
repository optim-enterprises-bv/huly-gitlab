import { MR_REVIEW_MIXIN_DOC, type MRReviewMixinDoc } from '../../src/sync/mr-review-mixin-doc'
import { MR_CORE_MIXIN } from '../../src/sync/mr-core-mixin'
import { MR_MIXIN } from '../../src/sync/mr-mixin'

describe('MRReviewMixinDoc (split review-side MR fields)', () => {
  it('MR_REVIEW_MIXIN_DOC constant equals gitlab-mr-review', () => {
    expect(typeof (MR_REVIEW_MIXIN_DOC as unknown as string)).toBe('string')
    expect(MR_REVIEW_MIXIN_DOC as unknown as string).toBe('gitlab-mr-review')
  })

  it('all fields are optional on a minimal object', () => {
    const minimal: MRReviewMixinDoc = {} as unknown as MRReviewMixinDoc
    expect(minimal.reviewers).toBeUndefined()
    expect(minimal.approvedBy).toBeUndefined()
    expect(minimal.approvalsRequired).toBeUndefined()
    expect(minimal.approvalStatus).toBeUndefined()
    expect(minimal.diffWebUrl).toBeUndefined()
    expect(minimal.changedFiles).toBeUndefined()
    expect(minimal.approvalRules).toBeUndefined()
    expect(minimal.iteration).toBeUndefined()
    expect(minimal.parentEpicIid).toBeUndefined()
  })

  it('MR_CORE_MIXIN, MR_REVIEW_MIXIN_DOC, and MR_MIXIN are three distinct runtime ids', () => {
    const core = MR_CORE_MIXIN as unknown as string
    const review = MR_REVIEW_MIXIN_DOC as unknown as string
    const legacy = MR_MIXIN as unknown as string
    expect(core).not.toBe(review)
    expect(core).not.toBe(legacy)
    expect(review).not.toBe(legacy)
    expect(new Set([core, review, legacy]).size).toBe(3)
  })
})
