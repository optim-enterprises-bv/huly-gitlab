import { MR_CORE_MIXIN, type MRCoreMixinDoc } from '../../src/sync/mr-core-mixin'

describe('MRCoreMixinDoc', () => {
  it('MR_CORE_MIXIN constant equals gitlab-mr-core', () => {
    expect(typeof (MR_CORE_MIXIN as unknown as string)).toBe('string')
    expect(MR_CORE_MIXIN as unknown as string).toBe('gitlab-mr-core')
  })

  it('required fields accept correct value shapes', () => {
    const fields: Pick<
      MRCoreMixinDoc,
      'sourceBranch' | 'targetBranch' | 'draft' | 'mergedAt' | 'mergeStatus' | 'webUrl' | 'gitlabIid' | 'gitlabProjectId'
    > = {
      sourceBranch: 'feature/x',
      targetBranch: 'main',
      draft: false,
      mergedAt: null,
      mergeStatus: 'can_be_merged',
      webUrl: 'https://gitlab.example.com/foo/bar/-/merge_requests/1',
      gitlabIid: 1,
      gitlabProjectId: 42
    }
    expect(fields.sourceBranch).toBe('feature/x')
    expect(fields.targetBranch).toBe('main')
    expect(fields.draft).toBe(false)
    expect(fields.mergedAt).toBeNull()
    expect(fields.mergeStatus).toBe('can_be_merged')
    expect(fields.webUrl).toContain('merge_requests/1')
    expect(fields.gitlabIid).toBe(1)
    expect(fields.gitlabProjectId).toBe(42)
  })

  it('mergedAt accepts a numeric epoch ms', () => {
    const fields: Pick<MRCoreMixinDoc, 'mergedAt'> = { mergedAt: 1700000000000 }
    expect(fields.mergedAt).toBe(1700000000000)
  })
})
