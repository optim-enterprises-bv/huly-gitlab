import { InMemoryBindingBreaker } from '../../src/sync/breaker'

const BINDING = 'binding-1'

function failN(breaker: InMemoryBindingBreaker, n: number): void {
  for (let i = 0; i < n; i++) {
    breaker.recordFailure(BINDING)
  }
}

test('initial state is closed', () => {
  const b = new InMemoryBindingBreaker()
  expect(b.getState(BINDING)).toBe('closed')
  expect(b.isOpen(BINDING)).toBe(false)
})

test('4 failures: still closed', () => {
  const b = new InMemoryBindingBreaker()
  failN(b, 4)
  expect(b.getState(BINDING)).toBe('closed')
  expect(b.isOpen(BINDING)).toBe(false)
})

test('5 consecutive failures → open', () => {
  const b = new InMemoryBindingBreaker()
  failN(b, 5)
  expect(b.getState(BINDING)).toBe('open')
  expect(b.isOpen(BINDING)).toBe(true)
})

test('success resets failure count', () => {
  const b = new InMemoryBindingBreaker()
  failN(b, 4)
  b.recordSuccess(BINDING)
  failN(b, 4)
  expect(b.getState(BINDING)).toBe('closed')
})

test('open → half-open after 15 min (fake timers)', () => {
  jest.useFakeTimers()
  try {
    const b = new InMemoryBindingBreaker()
    failN(b, 5)
    expect(b.getState(BINDING)).toBe('open')

    jest.advanceTimersByTime(15 * 60 * 1000)

    expect(b.getState(BINDING)).toBe('half-open')
  } finally {
    jest.useRealTimers()
  }
})

test('half-open + success → closed', () => {
  jest.useFakeTimers()
  try {
    const b = new InMemoryBindingBreaker()
    failN(b, 5)
    jest.advanceTimersByTime(15 * 60 * 1000)
    expect(b.getState(BINDING)).toBe('half-open')

    b.recordSuccess(BINDING)
    expect(b.getState(BINDING)).toBe('closed')
    expect(b.isOpen(BINDING)).toBe(false)
  } finally {
    jest.useRealTimers()
  }
})

test('half-open + failure → open again', () => {
  jest.useFakeTimers()
  try {
    const b = new InMemoryBindingBreaker()
    failN(b, 5)
    jest.advanceTimersByTime(15 * 60 * 1000)
    expect(b.getState(BINDING)).toBe('half-open')

    b.recordFailure(BINDING)
    expect(b.getState(BINDING)).toBe('open')
    expect(b.isOpen(BINDING)).toBe(true)
  } finally {
    jest.useRealTimers()
  }
})

test('multiple bindings are independent', () => {
  const b = new InMemoryBindingBreaker()
  failN(b, 5) // trips BINDING
  b.recordFailure('other-binding')
  expect(b.getState(BINDING)).toBe('open')
  expect(b.getState('other-binding')).toBe('closed')
})

test('already-open breaker: extra failures do not change openedAt', () => {
  jest.useFakeTimers()
  try {
    const b = new InMemoryBindingBreaker()
    failN(b, 5)
    const stateAfterOpen = b.getState(BINDING)
    expect(stateAfterOpen).toBe('open')

    // Advance 10 min — still open
    jest.advanceTimersByTime(10 * 60 * 1000)
    b.recordFailure(BINDING)
    expect(b.getState(BINDING)).toBe('open')

    // Original 15 min window has not elapsed (only 10 min)
    // Advance another 6 min → total 16 min from original open
    jest.advanceTimersByTime(6 * 60 * 1000)
    expect(b.getState(BINDING)).toBe('half-open')
  } finally {
    jest.useRealTimers()
  }
})
