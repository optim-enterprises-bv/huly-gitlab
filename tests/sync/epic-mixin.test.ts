import type { MREpicMixinDoc } from '../../src/sync/epic-mixin'
import { MR_EPIC_MIXIN } from '../../src/sync/epic-mixin'

describe('MREpicMixinDoc', () => {
  it('MR_EPIC_MIXIN constant is a string equal to gitlab-epic', () => {
    expect(typeof (MR_EPIC_MIXIN as unknown as string)).toBe('string')
    expect(MR_EPIC_MIXIN as unknown as string).toBe('gitlab-epic')
  })

  it('MREpicMixinDoc fields accept correct value shapes', () => {
    const doc: Pick<MREpicMixinDoc, 'epicIid' | 'groupId' | 'state' | 'webUrl' | 'childIssueIids'> = {
      epicIid: 7,
      groupId: 123,
      state: 'opened',
      webUrl: 'https://gitlab.example.com/groups/org/-/epics/7',
      childIssueIids: [1, 2, 3],
    }
    expect(doc.epicIid).toBe(7)
    expect(doc.groupId).toBe(123)
    expect(doc.state).toBe('opened')
    expect(doc.childIssueIids).toHaveLength(3)
  })
})
