import type { Ref } from '@hcengineering/core'
import { IssuePriority } from '@hcengineering/tracker'
import type { Status } from '@hcengineering/tracker'
import { mapHulyStatusToMRStateEvent, mapRemoteMRState } from '../../src/sync/mr-status-map'

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

const CURRENT_ACTIVE = 'active' as unknown as Ref<Status>
const CURRENT_DONE = 'done' as unknown as Ref<Status>
const CURRENT_CANCELLED = 'cancelled' as unknown as Ref<Status>

// 1. 'opened' + draft: false → first Active status, no priority change
test('mapRemoteMRState: opened non-draft → first Active status, no priority', () => {
  const result = mapRemoteMRState('opened', false, CURRENT_ACTIVE, STATUSES)
  expect(result.status).toBe('todo')
  expect(result.priority).toBeUndefined()
  expect(result.draft).toBeUndefined()
})

// 2. 'opened' + draft: true → first Active status + priority Low + draft:true
test('mapRemoteMRState: opened draft → first Active status + priority Low + draft:true', () => {
  const result = mapRemoteMRState('opened', true, CURRENT_ACTIVE, STATUSES)
  expect(result.status).toBe('todo')
  expect(result.priority).toBe(IssuePriority.Low)
  expect(result.draft).toBe(true)
})

// 3. 'closed' → first Cancelled status
test('mapRemoteMRState: closed → first Cancelled status', () => {
  const result = mapRemoteMRState('closed', false, CURRENT_ACTIVE, STATUSES)
  expect(result.status).toBe('cancelled')
  expect(result.priority).toBeUndefined()
})

// 4. 'merged' → first Done status
test('mapRemoteMRState: merged → first Done status', () => {
  const result = mapRemoteMRState('merged', false, CURRENT_ACTIVE, STATUSES)
  expect(result.status).toBe('done')
  expect(result.priority).toBeUndefined()
})

// 5. 'locked' (current status = Active) → status unchanged
test('mapRemoteMRState: locked → status unchanged (noop)', () => {
  const result = mapRemoteMRState('locked', false, CURRENT_ACTIVE, STATUSES)
  expect(result.status).toBe(CURRENT_ACTIVE)
  expect(result.priority).toBeUndefined()
  expect(result.draft).toBeUndefined()
})

// 6. Inverse: Huly Done status → 'close' state event
test('mapHulyStatusToMRStateEvent: Done status → close', () => {
  const result = mapHulyStatusToMRStateEvent(CURRENT_DONE, STATUSES)
  expect(result).toBe('close')
})

// 7. Inverse: Huly Active status when current GL = 'closed' → 'reopen' state event
test('mapHulyStatusToMRStateEvent: Active status → reopen', () => {
  const result = mapHulyStatusToMRStateEvent(CURRENT_ACTIVE, STATUSES)
  expect(result).toBe('reopen')
})

// 8. Inverse: no state change → undefined returned (unknown status ref)
test('mapHulyStatusToMRStateEvent: unknown status → undefined', () => {
  const unknown = 'unknown-ref' as unknown as Ref<Status>
  const result = mapHulyStatusToMRStateEvent(unknown, STATUSES)
  expect(result).toBeUndefined()
})

// 9. Symmetry: round-trip closed→Cancelled→close
test('symmetry: closed MR maps to Cancelled, Cancelled maps back to close event', () => {
  const mapping = mapRemoteMRState('closed', false, CURRENT_ACTIVE, STATUSES)
  expect(mapping.status).toBe('cancelled')
  const event = mapHulyStatusToMRStateEvent(mapping.status, STATUSES)
  expect(event).toBe('close')
})

// 10. Edge: project with NO Cancelled category → falls back to first Active for closed
test('mapRemoteMRState: closed with no Cancelled category → fallback to first Active, logger warns', () => {
  const warn = jest.fn()
  const logger = { debug: jest.fn(), info: jest.fn(), warn, error: jest.fn() }
  const noCancel: Status[] = [
    makeStatus('todo', 'task:statusCategory:ToDo'),
    makeStatus('done', 'task:statusCategory:Won')
  ]
  const current = 'todo' as unknown as Ref<Status>
  const result = mapRemoteMRState('closed', false, current, noCancel, logger)
  expect(result.status).toBe('todo')
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('no Cancelled category'))
})

// 10b. Edge: no logger passed → degrades silently, no throw
test('mapRemoteMRState: closed with no Cancelled category and no logger → silent fallback', () => {
  const noCancel: Status[] = [
    makeStatus('todo', 'task:statusCategory:ToDo'),
    makeStatus('done', 'task:statusCategory:Won')
  ]
  const current = 'todo' as unknown as Ref<Status>
  const result = mapRemoteMRState('closed', false, current, noCancel)
  expect(result.status).toBe('todo')
})
