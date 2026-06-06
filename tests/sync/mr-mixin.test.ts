import type { MRMixinDoc } from '../../src/sync/mr-mixin'
import { MR_MIXIN } from '../../src/sync/mr-mixin'

describe('MRMixinDoc Phase 3 fields', () => {
  it('MR_MIXIN constant is a string', () => {
    expect(typeof (MR_MIXIN as unknown as string)).toBe('string')
    expect(MR_MIXIN as unknown as string).toBe('gitlab-mr')
  })

  it('Phase 3 fields are optional — object without them satisfies the type', () => {
    // Type-level test: constructing a minimal object that omits all Phase 3 fields.
    // If any Phase 3 field were required this would fail to compile.
    const minimal: Pick<MRMixinDoc, 'reviewers' | 'approvedBy' | 'approvalsRequired' | 'approvalStatus' | 'diffWebUrl' | 'changedFiles'> = {}
    expect(minimal.reviewers).toBeUndefined()
    expect(minimal.approvedBy).toBeUndefined()
    expect(minimal.approvalsRequired).toBeUndefined()
    expect(minimal.approvalStatus).toBeUndefined()
    expect(minimal.diffWebUrl).toBeUndefined()
    expect(minimal.changedFiles).toBeUndefined()
  })

  it('Phase 3 fields accept correct value shapes', () => {
    const full: Pick<MRMixinDoc, 'reviewers' | 'approvedBy' | 'approvalsRequired' | 'approvalStatus' | 'diffWebUrl' | 'changedFiles'> = {
      reviewers: ['uuid-1' as MRMixinDoc['reviewers'] extends (infer U)[] | undefined ? U : never],
      approvedBy: [],
      approvalsRequired: 2,
      approvalStatus: 'approved',
      diffWebUrl: 'https://gitlab.example.com/org/repo/-/merge_requests/42/diffs',
      changedFiles: [{ path: 'src/foo.ts', additions: 10, deletions: 2, status: 'modified' }],
    }
    expect(full.approvalsRequired).toBe(2)
    expect(full.approvalStatus).toBe('approved')
    expect(full.changedFiles).toHaveLength(1)
  })
})
