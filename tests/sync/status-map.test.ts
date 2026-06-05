import type { Ref } from '@hcengineering/core'
import type { Status } from '@hcengineering/tracker'
import { _clearStatusCache, mapHulyStatus, mapRemoteState } from '../../src/sync/status-map'

function makeStatus (id: string, category: string): Status {
  return {
    _id: id as unknown as Ref<Status>,
    _class: 'tracker:class:IssueStatus' as unknown as Ref<Status['_class']>,
    space: 'space:default' as unknown as Ref<Status['space']>,
    modifiedOn: 0,
    modifiedBy: 'm' as unknown as Ref<Status['modifiedBy']>,
    name: id,
    category: category as unknown as Ref<Status['category']>
  }
}

const STATUSES: Status[] = [
  makeStatus('todo', 'task:statusCategory:ToDo'),
  makeStatus('active', 'task:statusCategory:Active'),
  makeStatus('inprogress', 'task:statusCategory:InProgress'),
  makeStatus('done', 'task:statusCategory:Won'),
  makeStatus('cancelled', 'task:statusCategory:Lost')
]

beforeEach(() => {
  _clearStatusCache()
})

test('mapRemoteState: opened → first Active/ToDo/InProgress status', () => {
  const result = mapRemoteState('proj-1', 'opened', STATUSES)
  expect(result).toBe('todo')
})

test('mapRemoteState: closed → first Done/Cancelled status', () => {
  const result = mapRemoteState('proj-1', 'closed', STATUSES)
  expect(result).toBe('done')
})

test('mapHulyStatus: known status → correct gitlab state', () => {
  const active = 'active' as unknown as Ref<Status>
  const done = 'done' as unknown as Ref<Status>
  expect(mapHulyStatus('proj-1', active, STATUSES)).toBe('opened')
  expect(mapHulyStatus('proj-1', done, STATUSES)).toBe('closed')
})

test('mapHulyStatus: unknown status → fallback opened (safe default)', () => {
  const unknown = 'unknown-status-ref' as unknown as Ref<Status>
  expect(mapHulyStatus('proj-1', unknown, STATUSES)).toBe('opened')
})

test('cache: second call does not re-search statuses (deterministic, cached)', () => {
  const first = mapRemoteState('proj-cache', 'opened', STATUSES)
  // Pass a DIFFERENT statuses array on second call — if cache works,
  // the result MUST be the first result, not derived from the new statuses.
  const otherStatuses = [makeStatus('other-active', 'task:statusCategory:Active')]
  const second = mapRemoteState('proj-cache', 'opened', otherStatuses)
  expect(second).toBe(first)
  expect(second).toBe('todo')
})
