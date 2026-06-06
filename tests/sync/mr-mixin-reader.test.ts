import { MR_MIXIN, readMRMixinAttributes } from '../../src/sync/mr-mixin'
import { MR_CORE_MIXIN } from '../../src/sync/mr-core-mixin'
import { MR_REVIEW_MIXIN_DOC } from '../../src/sync/mr-review-mixin-doc'

const MR_MIXIN_KEY = MR_MIXIN as unknown as string
const MR_CORE_KEY = MR_CORE_MIXIN as unknown as string
const MR_REVIEW_KEY = MR_REVIEW_MIXIN_DOC as unknown as string

describe('readMRMixinAttributes', () => {
  it('returns legacy attrs when only gitlab-mr mixin is present', () => {
    const issue = {
      [MR_MIXIN_KEY]: {
        sourceBranch: 'feat/legacy',
        targetBranch: 'main',
        gitlabIid: 1
      }
    }
    const result = readMRMixinAttributes(issue as never)
    expect(result.sourceBranch).toBe('feat/legacy')
    expect(result.gitlabIid).toBe(1)
  })

  it('returns merged new attrs when only gitlab-mr-core + gitlab-mr-review are present', () => {
    const issue = {
      [MR_CORE_KEY]: {
        sourceBranch: 'feat/new',
        targetBranch: 'main',
        gitlabIid: 2
      },
      [MR_REVIEW_KEY]: {
        approvedBy: ['uuid-a'],
        approvalsRequired: 1
      }
    }
    const result = readMRMixinAttributes(issue as never)
    expect(result.sourceBranch).toBe('feat/new')
    expect(result.gitlabIid).toBe(2)
    expect(result.approvedBy).toEqual(['uuid-a'])
    expect(result.approvalsRequired).toBe(1)
  })

  it('prefers new split mixins over legacy when both are present', () => {
    const issue = {
      [MR_MIXIN_KEY]: {
        sourceBranch: 'feat/legacy',
        targetBranch: 'main',
        gitlabIid: 99
      },
      [MR_CORE_KEY]: {
        sourceBranch: 'feat/new',
        targetBranch: 'main',
        gitlabIid: 3
      },
      [MR_REVIEW_KEY]: {
        approvedBy: ['uuid-b']
      }
    }
    const result = readMRMixinAttributes(issue as never)
    expect(result.sourceBranch).toBe('feat/new')
    expect(result.gitlabIid).toBe(3)
    expect(result.approvedBy).toEqual(['uuid-b'])
  })

  it('returns empty object when issue has no mixin data', () => {
    const issue = { _id: 'issue-1', title: 'plain issue' }
    const result = readMRMixinAttributes(issue as never)
    expect(result).toEqual({})
  })

  it('returns empty object for null issue', () => {
    expect(readMRMixinAttributes(null)).toEqual({})
  })

  it('returns empty object for undefined issue', () => {
    expect(readMRMixinAttributes(undefined)).toEqual({})
  })
})
