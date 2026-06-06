import type { MRReviewMixinDoc } from '../../src/sync/mr-review-mixin'
import { MR_REVIEW_MIXIN } from '../../src/sync/mr-review-mixin'

describe('MRReviewMixinDoc', () => {
  it('MR_REVIEW_MIXIN constant equals gitlab-review', () => {
    expect(typeof (MR_REVIEW_MIXIN as unknown as string)).toBe('string')
    expect(MR_REVIEW_MIXIN as unknown as string).toBe('gitlab-review')
  })

  it('optional fields are absent on a minimal object', () => {
    // Type-level: resolvedBy, resolvedAt, position are all optional.
    // If any were required this would fail to compile.
    const minimal: Pick<MRReviewMixinDoc, 'resolvedBy' | 'resolvedAt' | 'position'> = {}
    expect(minimal.resolvedBy).toBeUndefined()
    expect(minimal.resolvedAt).toBeUndefined()
    expect(minimal.position).toBeUndefined()
  })

  it('required fields accept correct value shapes', () => {
    const fields: Pick<MRReviewMixinDoc, 'threadId' | 'resolved' | 'resolvedBy' | 'resolvedAt' | 'position'> = {
      threadId: 'abc123discussion',
      resolved: true,
      resolvedBy: 'uuid-resolver' as MRReviewMixinDoc['resolvedBy'] extends infer U ? U : never,
      resolvedAt: 1700000000000,
      position: {
        filePath: 'src/foo.ts',
        oldLine: null,
        newLine: 42,
        baseSha: 'aaa',
        headSha: 'bbb',
        startSha: 'ccc',
        positionType: 'text',
      },
    }
    expect(fields.threadId).toBe('abc123discussion')
    expect(fields.resolved).toBe(true)
    expect(fields.resolvedAt).toBe(1700000000000)
    expect(fields.position?.filePath).toBe('src/foo.ts')
    expect(fields.position?.positionType).toBe('text')
  })
})
