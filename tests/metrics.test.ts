import { increment, get, getAll, reset } from '../src/metrics'

beforeEach(() => {
  reset()
})

describe('metrics registry', () => {
  it('increment and get a counter', () => {
    increment('foo')
    expect(get('foo')).toBe(1)
    increment('foo')
    expect(get('foo')).toBe(2)
  })

  it('get returns 0 for unknown key', () => {
    expect(get('does.not.exist')).toBe(0)
  })

  it('reset() clears all; reset(name) clears only that counter', () => {
    increment('a')
    increment('b')
    reset('a')
    expect(get('a')).toBe(0)
    expect(get('b')).toBe(1)
    reset()
    expect(get('b')).toBe(0)
  })

  it('getAll returns a snapshot of all counters', () => {
    increment('x', 3)
    increment('y', 7)
    const all = getAll()
    expect(all).toEqual({ x: 3, y: 7 })
    // snapshot: mutations after getAll do not affect the returned object
    increment('x')
    expect(all.x).toBe(3)
  })
})
