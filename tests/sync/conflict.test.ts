import { resolveLww, applyLwwFieldByField } from '../../src/sync/conflict'

const T1 = new Date('2024-01-01T10:00:00Z')
const T2 = new Date('2024-01-01T11:00:00Z') // newer than T1

// Case 1: remote newer → remote wins
test('LWW case 1: remote newer → remote', () => {
  const result = resolveLww('local-value', T1, 'remote-value', T2)
  expect(result.winner).toBe('remote')
  expect(result.value).toBe('remote-value')
})

// Case 2: local newer → local wins
test('LWW case 2: local newer → local', () => {
  const result = resolveLww('local-value', T2, 'remote-value', T1)
  expect(result.winner).toBe('local')
  expect(result.value).toBe('local-value')
})

// Case 3: equal timestamps → prefer remote (tiebreak)
test('LWW case 3: equal timestamps → remote tiebreak', () => {
  const result = resolveLww('local-value', T1, 'remote-value', T1)
  expect(result.winner).toBe('remote')
  expect(result.value).toBe('remote-value')
})

// Case 4: local missing, remote present → remote
test('LWW case 4: local missing → remote', () => {
  const result = resolveLww(undefined, undefined, 'remote-value', T2)
  expect(result.winner).toBe('remote')
  expect(result.value).toBe('remote-value')
})

// Case 5: remote missing, local present → local
test('LWW case 5: remote missing → local', () => {
  const result = resolveLww('local-value', T1, undefined, undefined)
  expect(result.winner).toBe('local')
  expect(result.value).toBe('local-value')
})

// Case 6: both missing → noop
test('LWW case 6: both missing → noop', () => {
  const result = resolveLww(undefined, undefined, undefined, undefined)
  expect(result.winner).toBe('noop')
  expect(result.value).toBeUndefined()
})

// Case 7: dedup — same value and timestamp returns remote (tiebreak, idempotent)
test('LWW case 7: same value same ts → remote (dedup-safe)', () => {
  const result = resolveLww('same', T1, 'same', T1)
  expect(result.winner).toBe('remote')
  expect(result.value).toBe('same')
})

// Case 8: field-by-field resolver handles mixed local/remote wins across fields
test('LWW case 8: field-by-field mixed winners', () => {
  const local = {
    title: { value: 'local-title', ts: T2 }, // local newer → local wins
    state: { value: 'opened', ts: T1 }        // equal ts → remote tiebreak
  }
  const remote = {
    title: { value: 'remote-title', ts: T1 },
    state: { value: 'closed', ts: T1 }
  }

  const decisions = applyLwwFieldByField(local, remote)

  expect(decisions.title).toBe('local')
  expect(decisions.state).toBe('remote')
})

// Additional edge cases

test('resolveLww: local value with no ts treated as missing', () => {
  const result = resolveLww('local-value', undefined, 'remote-value', T1)
  expect(result.winner).toBe('remote')
})

test('resolveLww: remote value with no ts treated as missing', () => {
  const result = resolveLww('local-value', T1, 'remote-value', undefined)
  expect(result.winner).toBe('local')
})

test('applyLwwFieldByField: field only in remote → remote wins', () => {
  const local = {} as Record<string, { value: unknown; ts: Date | undefined }>
  const remote = { description: { value: 'new desc', ts: T2 } }
  const decisions = applyLwwFieldByField(local, remote)
  expect(decisions.description).toBe('remote')
})

test('applyLwwFieldByField: field only in local → local wins', () => {
  const local = { description: { value: 'old desc', ts: T1 } }
  const remote = {} as Record<string, { value: unknown; ts: Date | undefined }>
  const decisions = applyLwwFieldByField(local, remote)
  expect(decisions.description).toBe('local')
})
