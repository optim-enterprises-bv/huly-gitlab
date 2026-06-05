import { EventQueue } from '../../src/sync/queue'
import type { Logger } from '../../src/logging'

function makeLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {}
  }
}

test('FIFO: items for same key processed in order', async () => {
  const processed: number[] = []

  const q = new EventQueue<number>(
    async (item) => {
      await new Promise<void>((r) => setImmediate(r))
      processed.push(item)
    },
    makeLogger()
  )

  q.enqueue('key-a', 1)
  q.enqueue('key-a', 2)
  q.enqueue('key-a', 3)

  await q.drainAll()

  expect(processed).toEqual([1, 2, 3])
})

test('parallel: different keys processed concurrently', async () => {
  const starts: string[] = []

  const q = new EventQueue<string>(
    async (item) => {
      starts.push(item)
      await new Promise<void>((r) => setTimeout(r, 10))
    },
    makeLogger()
  )

  q.enqueue('key-a', 'a1')
  q.enqueue('key-b', 'b1')

  await q.drainAll()

  // Both should have started (order not guaranteed across keys)
  expect(starts).toContain('a1')
  expect(starts).toContain('b1')
  expect(starts).toHaveLength(2)
})

test('LRU eviction: oldest key evicted when maxKeys exceeded', async () => {
  const warnMessages: string[] = []
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: (msg) => { warnMessages.push(msg) },
    error: () => {}
  }

  const q = new EventQueue<number>(async () => {}, logger, 2)

  q.enqueue('key-1', 1)
  await q.drainAll()

  q.enqueue('key-2', 2)
  await q.drainAll()

  // Adding key-3 should evict key-1 (LRU)
  q.enqueue('key-3', 3)
  await q.drainAll()

  expect(warnMessages.some((m) => m.includes('LRU evicted'))).toBe(true)
})

test('pendingCount: reflects items waiting', () => {
  let resolveFn: (() => void) | null = null

  const q = new EventQueue<number>(
    async () => {
      await new Promise<void>((r) => { resolveFn = r })
    },
    makeLogger()
  )

  q.enqueue('key-a', 1)
  q.enqueue('key-a', 2)

  // After first item starts processing, one item remains pending
  expect(q.pendingCount('key-a')).toBe(1)

  // Unblock the processor
  resolveFn?.()
})

test('isIdle: true for unknown key', () => {
  const q = new EventQueue<number>(async () => {}, makeLogger())
  expect(q.isIdle('unknown-key')).toBe(true)
})

test('isIdle: false while processing', () => {
  let resolveFn: (() => void) | null = null

  const q = new EventQueue<number>(
    async () => {
      await new Promise<void>((r) => { resolveFn = r })
    },
    makeLogger()
  )

  q.enqueue('key-a', 1)

  expect(q.isIdle('key-a')).toBe(false)

  resolveFn?.()
})

test('processor error: does not stall subsequent items', async () => {
  const processed: number[] = []

  const q = new EventQueue<number>(
    async (item) => {
      if (item === 2) throw new Error('boom')
      processed.push(item)
    },
    makeLogger()
  )

  q.enqueue('key-a', 1)
  q.enqueue('key-a', 2)
  q.enqueue('key-a', 3)

  await q.drainAll()

  expect(processed).toEqual([1, 3])
})

test('waitForIdle: resolves when key becomes idle', async () => {
  const processed: number[] = []

  const q = new EventQueue<number>(
    async (item) => {
      await new Promise<void>((r) => setImmediate(r))
      processed.push(item)
    },
    makeLogger()
  )

  q.enqueue('key-a', 42)
  await q.waitForIdle('key-a')

  expect(processed).toEqual([42])
})

test('waitForIdle: resolves via promise resolver, not busy-poll', async () => {
  let resolveProcessor!: () => void
  const processorStarted = new Promise<void>((r) => {
    resolveProcessor = r
  })

  let unblockProcessor!: () => void
  const processorBlock = new Promise<void>((r) => {
    unblockProcessor = r
  })

  const setImmediateSpy = jest.spyOn(globalThis, 'setImmediate')

  const q = new EventQueue<number>(
    async () => {
      resolveProcessor()
      await processorBlock
    },
    makeLogger()
  )

  q.enqueue('key-a', 1)
  await processorStarted

  const idleCallsBefore = setImmediateSpy.mock.calls.length

  // Unblock processor and wait for idle
  unblockProcessor()
  await q.waitForIdle('key-a')

  // setImmediate should not have been called for polling during waitForIdle
  expect(setImmediateSpy.mock.calls.length).toBe(idleCallsBefore)
  setImmediateSpy.mockRestore()
})

test('drainAll: throws when timeout fires before items complete', async () => {
  let unblock!: () => void
  const block = new Promise<void>((r) => { unblock = r })

  const q = new EventQueue<number>(
    async () => { await block },
    makeLogger()
  )

  q.enqueue('key-a', 1)

  await expect(q.drainAll(100)).rejects.toThrow('drainAll timed out after 100ms')

  // Unblock so the processor doesn't leak
  unblock()
})
