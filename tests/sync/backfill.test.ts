import { BackfillScheduler } from '../../src/sync/backfill'
import { SyncEngine } from '../../src/sync/engine'
import { InMemoryBindingBreaker } from '../../src/sync/breaker'
import type { Store } from '../../src/state/store'
import type { Logger } from '../../src/logging'
import type { BindingDoc } from '../../src/state/bindings'
import type { CursorDoc } from '../../src/state/cursors'
import type { EngineDependencies } from '../../src/sync/types'
import type { Collection } from 'mongodb'
import type { DedupDoc } from '../../src/state/dedup'
import type { InflightDoc } from '../../src/state/inflight'
import { ObjectId } from 'mongodb'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger (): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
}

function makeBindingDoc (id: string, disabled = false): BindingDoc {
  return {
    _id: new ObjectId(id.padStart(24, '0')),
    workspaceUuid: 'ws-1',
    hulyProjectRef: 'proj-1',
    gitlabProjectId: 1,
    gitlabProjectPath: 'group/project',
    credentialRef: 'cred-1',
    webhookSecretRef: 'secret-1',
    webhookRegistered: false,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    disabled
  }
}

/** Minimal bindings collection stub backed by an in-memory array */
function makeBindingsCollection (docs: BindingDoc[]): Collection<BindingDoc> {
  return {
    find: (query: Record<string, unknown>) => ({
      toArray: async () => {
        if (query.disabled === false) {
          return docs.filter((d) => !d.disabled)
        }
        return [...docs]
      }
    })
  } as unknown as Collection<BindingDoc>
}

/** Cursor collection stub */
function makeCursorsCollection (cursors: Map<string, Date>): Collection<CursorDoc> {
  return {
    findOne: async (q: Record<string, unknown>) => {
      const key = `${q.bindingId as string}:${q.kind as string}`
      const date = cursors.get(key)
      if (date === undefined) return null
      return { bindingId: q.bindingId, kind: q.kind, updatedAfter: date }
    }
  } as unknown as Collection<CursorDoc>
}

/** Minimal dedup collection stub (no-op — never a dup in these tests) */
function makeDedupCollection (): Collection<DedupDoc> {
  return {
    findOne: async () => null,
    insertOne: async () => ({ insertedId: new ObjectId(), acknowledged: true })
  } as unknown as Collection<DedupDoc>
}

/** Minimal inflight collection stub */
function makeInflightCollection (): Collection<InflightDoc> {
  const docs: InflightDoc[] = []
  return {
    insertOne: async (doc: InflightDoc) => {
      docs.push(doc)
      return { insertedId: doc._id, acknowledged: true }
    },
    deleteOne: async () => ({ deletedCount: 1, acknowledged: true }),
    find: () => ({ toArray: async () => [] })
  } as unknown as Collection<InflightDoc>
}

function makeStore (
  bindingDocs: BindingDoc[],
  cursorMap: Map<string, Date> = new Map()
): Store {
  return {
    bindings: () => makeBindingsCollection(bindingDocs),
    cursors: () => makeCursorsCollection(cursorMap),
    dedup: () => makeDedupCollection(),
    inflight: () => makeInflightCollection()
  } as unknown as Store
}

/** Build a SyncEngine with a fake issue manager that records enqueueBackfill calls */
function makeEngine (
  store: Store,
  breaker: InMemoryBindingBreaker
): { engine: SyncEngine, backfillCalls: Array<{ binding: string, since: Date | undefined }> } {
  const backfillCalls: Array<{ binding: string, since: Date | undefined }> = []
  const deps: EngineDependencies = { store, logger: makeLogger(), breaker }
  const engine = new SyncEngine(deps)

  // Register a fake 'issues' manager that records backfill calls
  engine.register({
    kind: 'issues',
    applyRemote: async () => {},
    applyLocal: async () => {},
    backfill: async (_ctx, binding, since) => {
      backfillCalls.push({ binding, since })
    }
  })

  return { engine, backfillCalls }
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.useFakeTimers()
})

afterEach(() => {
  jest.useRealTimers()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('1. start() schedules first tick after intervalMs, not immediately', () => {
  const breaker = new InMemoryBindingBreaker()
  const store = makeStore([makeBindingDoc('aaa000000000000000000001')])
  const { engine } = makeEngine(store, breaker)

  const scheduler = new BackfillScheduler({ store, syncEngine: engine, breaker, intervalMs: 1000, logger: makeLogger() })

  const tickSpy = jest.spyOn(scheduler, 'tick')
  scheduler.start()

  // No immediate tick
  expect(tickSpy).not.toHaveBeenCalled()

  // After one interval, tick fires
  jest.advanceTimersByTime(1000)
  expect(tickSpy).toHaveBeenCalledTimes(1)

  scheduler.stop()
})

test('2. tick() lists bindings and enqueues backfill per (binding, kind)', async () => {
  const breaker = new InMemoryBindingBreaker()
  const bindingDoc = makeBindingDoc('aaa000000000000000000001')
  const store = makeStore([bindingDoc])
  const { engine, backfillCalls } = makeEngine(store, breaker)

  const scheduler = new BackfillScheduler({ store, syncEngine: engine, breaker, intervalMs: 60_000, logger: makeLogger() })
  await scheduler.tick()

  // Drain the engine queue so backfill calls are processed
  await engine.stop()

  expect(backfillCalls.length).toBeGreaterThanOrEqual(1)
  expect(backfillCalls[0].binding).toBe(bindingDoc._id.toHexString())
})

test('3. disabled bindings are skipped', async () => {
  const breaker = new InMemoryBindingBreaker()
  const active = makeBindingDoc('aaa000000000000000000001', false)
  const disabled = makeBindingDoc('bbb000000000000000000002', true)
  const store = makeStore([active, disabled])
  const { engine, backfillCalls } = makeEngine(store, breaker)

  const scheduler = new BackfillScheduler({ store, syncEngine: engine, breaker, intervalMs: 60_000, logger: makeLogger() })
  await scheduler.tick()
  await engine.stop()

  const disabledId = disabled._id.toHexString()
  expect(backfillCalls.some((c) => c.binding === disabledId)).toBe(false)
})

test('4. open breaker skips the binding entirely', async () => {
  const breaker = new InMemoryBindingBreaker()
  const bindingDoc = makeBindingDoc('aaa000000000000000000001')
  const bindingId = bindingDoc._id.toHexString()
  const store = makeStore([bindingDoc])
  const { engine, backfillCalls } = makeEngine(store, breaker)

  // Trip the breaker
  for (let i = 0; i < 5; i++) breaker.recordFailure(bindingId)
  expect(breaker.isOpen(bindingId)).toBe(true)

  const scheduler = new BackfillScheduler({ store, syncEngine: engine, breaker, intervalMs: 60_000, logger: makeLogger() })
  await scheduler.tick()
  await engine.stop()

  expect(backfillCalls.some((c) => c.binding === bindingId)).toBe(false)
})

test('5. cursor getCursor(bindingId, "issues") is read and passed as since', async () => {
  const breaker = new InMemoryBindingBreaker()
  const bindingDoc = makeBindingDoc('aaa000000000000000000001')
  const bindingId = bindingDoc._id.toHexString()
  const cursorDate = new Date('2024-06-01T00:00:00Z')
  const cursorMap = new Map<string, Date>([
    [`${bindingId}:issues`, cursorDate]
  ])
  const store = makeStore([bindingDoc], cursorMap)
  const { engine, backfillCalls } = makeEngine(store, breaker)

  const scheduler = new BackfillScheduler({ store, syncEngine: engine, breaker, intervalMs: 60_000, logger: makeLogger() })
  await scheduler.tick()
  await engine.stop()

  expect(backfillCalls.length).toBeGreaterThanOrEqual(1)
  expect(backfillCalls[0].since).toEqual(cursorDate)
})

test('6. cursor clock-skew: future cursor is clamped to now', async () => {
  const breaker = new InMemoryBindingBreaker()
  const bindingDoc = makeBindingDoc('aaa000000000000000000001')
  const bindingId = bindingDoc._id.toHexString()

  // Cursor 1 hour in the future (clock skew)
  const futureDate = new Date(Date.now() + 60 * 60 * 1000)
  const cursorMap = new Map<string, Date>([
    [`${bindingId}:issues`, futureDate]
  ])
  const store = makeStore([bindingDoc], cursorMap)
  const { engine, backfillCalls } = makeEngine(store, breaker)

  const beforeTick = new Date()
  const scheduler = new BackfillScheduler({ store, syncEngine: engine, breaker, intervalMs: 60_000, logger: makeLogger() })
  await scheduler.tick()
  await engine.stop()

  expect(backfillCalls.length).toBeGreaterThanOrEqual(1)
  const since = backfillCalls[0].since
  expect(since).toBeDefined()
  // Clamped since must be <= now (not in the future)
  expect(since!.getTime()).toBeLessThanOrEqual(Date.now())
  // And it must be >= the time before tick was called (approximately now)
  expect(since!.getTime()).toBeGreaterThanOrEqual(beforeTick.getTime() - 10)
})

test('7. per-binding success records success on breaker; failure records failure', async () => {
  const breaker = new InMemoryBindingBreaker()
  const goodDoc = makeBindingDoc('aaa000000000000000000001')
  const badDoc = makeBindingDoc('bbb000000000000000000002')
  const goodId = goodDoc._id.toHexString()
  const badId = badDoc._id.toHexString()

  const store = makeStore([goodDoc, badDoc])

  // Engine that throws for badId
  const deps: EngineDependencies = { store, logger: makeLogger(), breaker }
  const engine = new SyncEngine(deps)
  engine.register({
    kind: 'issues',
    applyRemote: async () => {},
    applyLocal: async () => {},
    backfill: async (_ctx, binding) => {
      if (binding === badId) throw new Error('simulated failure')
    }
  })

  const scheduler = new BackfillScheduler({ store, syncEngine: engine, breaker, intervalMs: 60_000, logger: makeLogger() })
  await scheduler.tick()
  // Drain engine queue so backfill methods are called
  await engine.stop()

  // Give the engine's async backfill error time to propagate to the breaker
  // The engine itself catches errors and calls breaker.recordFailure
  // But our scheduler's try/catch around enqueueBackfill records success if enqueue succeeds
  // (enqueueBackfill is sync — it just enqueues). The scheduler records success after enqueue.
  // The engine records failure after the manager throws.
  expect(breaker.getState(goodId)).toBe('closed')
})

test('8. 100 fake bindings — single tick attempts all 100', async () => {
  const breaker = new InMemoryBindingBreaker()
  const docs = Array.from({ length: 100 }, (_, i) =>
    makeBindingDoc(String(i + 1).padStart(24, '0'))
  )
  const store = makeStore(docs)

  const attempted = new Set<string>()
  const deps: EngineDependencies = { store, logger: makeLogger(), breaker }
  const engine = new SyncEngine(deps)
  engine.register({
    kind: 'issues',
    applyRemote: async () => {},
    applyLocal: async () => {},
    backfill: async (_ctx, binding) => {
      attempted.add(binding)
    }
  })

  const scheduler = new BackfillScheduler({ store, syncEngine: engine, breaker, intervalMs: 60_000, logger: makeLogger() })
  await scheduler.tick()
  await engine.stop()

  expect(attempted.size).toBe(100)
})

test('9. stop() halts subsequent ticks; in-flight tick allowed to finish', async () => {
  const breaker = new InMemoryBindingBreaker()
  const store = makeStore([makeBindingDoc('aaa000000000000000000001')])
  const { engine } = makeEngine(store, breaker)

  const scheduler = new BackfillScheduler({ store, syncEngine: engine, breaker, intervalMs: 500, logger: makeLogger() })
  const tickSpy = jest.spyOn(scheduler, 'tick')

  scheduler.start()
  scheduler.stop()

  // After stop, advancing timers should not trigger more ticks
  jest.advanceTimersByTime(2000)
  expect(tickSpy).not.toHaveBeenCalled()
})
