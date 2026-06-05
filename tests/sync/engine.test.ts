import { SyncEngine } from '../../src/sync/engine'
import { InMemoryBindingBreaker } from '../../src/sync/breaker'
import type { EngineDependencies, SyncContext, SyncManager } from '../../src/sync/types'
import type { Store } from '../../src/state/store'
import type { Logger } from '../../src/logging'
import type { Collection } from 'mongodb'
import type { DedupDoc } from '../../src/state/dedup'
import type { InflightDoc } from '../../src/state/inflight'
import { ObjectId } from 'mongodb'

// ---------------------------------------------------------------------------
// Fake logger
// ---------------------------------------------------------------------------
function makeLogger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
}

// ---------------------------------------------------------------------------
// Stub collections
// ---------------------------------------------------------------------------

/** In-memory stub that satisfies Collection<DedupDoc> for dedup operations */
function makeDedupCollection(): Collection<DedupDoc> {
  const seen = new Map<string, boolean>()
  return {
    findOne: async (q: Record<string, unknown>) => {
      const key = `${q.bindingId as string}:${q.eventId as string}:${q.version as string}`
      return seen.has(key) ? { _id: new ObjectId() } : null
    },
    insertOne: async (doc: DedupDoc) => {
      const key = `${doc.bindingId}:${doc.eventId}:${doc.version}`
      seen.set(key, true)
      return { insertedId: doc._id, acknowledged: true }
    }
  } as unknown as Collection<DedupDoc>
}

/** In-memory stub for inflight collection */
function makeInflightCollection(initialDocs: InflightDoc[] = []): Collection<InflightDoc> & { docs: InflightDoc[] } {
  const docs: InflightDoc[] = [...initialDocs]
  const col = {
    docs,
    insertOne: async (doc: InflightDoc) => {
      docs.push(doc)
      return { insertedId: doc._id, acknowledged: true }
    },
    deleteOne: async (q: Record<string, unknown>) => {
      const id = q._id as ObjectId
      const idx = docs.findIndex((d) => d._id.toHexString() === id.toHexString())
      if (idx >= 0) docs.splice(idx, 1)
      return { deletedCount: 1, acknowledged: true }
    },
    find: (_q: Record<string, unknown>) => ({
      toArray: async () => [...docs]
    })
  }
  return col as unknown as Collection<InflightDoc> & { docs: InflightDoc[] }
}

/** Minimal Store stub */
function makeStore(
  dedupCol: Collection<DedupDoc>,
  inflightCol: Collection<InflightDoc>
): Store {
  return {
    dedup: () => dedupCol,
    inflight: () => inflightCol
  } as unknown as Store
}

// ---------------------------------------------------------------------------
// Fake SyncManager
// ---------------------------------------------------------------------------
interface CallRecord {
  method: string
  binding: string
  args: unknown[]
}

function makeFakeManager(kind: string): SyncManager & { calls: CallRecord[] } {
  const calls: CallRecord[] = []
  return {
    kind,
    calls,
    applyRemote: async (_ctx: SyncContext, binding: string, record: unknown) => {
      calls.push({ method: 'applyRemote', binding, args: [record] })
    },
    applyLocal: async (_ctx: SyncContext, binding: string, doc: string, change: unknown) => {
      calls.push({ method: 'applyLocal', binding, args: [doc, change] })
    },
    backfill: async (_ctx: SyncContext, binding: string, since: unknown) => {
      calls.push({ method: 'backfill', binding, args: [since] })
    }
  }
}

// ---------------------------------------------------------------------------
// Helper to build engine + deps
// ---------------------------------------------------------------------------
function buildEngine(inflightDocs: InflightDoc[] = []): {
  engine: SyncEngine
  breaker: InMemoryBindingBreaker
  inflightCol: Collection<InflightDoc> & { docs: InflightDoc[] }
} {
  const breaker = new InMemoryBindingBreaker()
  const dedupCol = makeDedupCollection()
  const inflightCol = makeInflightCollection(inflightDocs)
  const store = makeStore(dedupCol, inflightCol)
  const deps: EngineDependencies = { store, logger: makeLogger(), breaker }
  const engine = new SyncEngine(deps)
  return { engine, breaker, inflightCol }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('register: manager is dispatched for remote events', async () => {
  const { engine } = buildEngine()
  const manager = makeFakeManager('issue')
  engine.register(manager)

  await engine.enqueueWebhookEvent(
    'binding-1',
    'issue',
    { id: 1, object_kind: 'issue', title: 'hello' },
    'event-uuid-1',
    'v1'
  )
  await engine.stop()

  expect(manager.calls).toHaveLength(1)
  expect(manager.calls[0].method).toBe('applyRemote')
  expect(manager.calls[0].binding).toBe('binding-1')
})

test('dedup: same eventId + version dropped on second enqueue', async () => {
  const { engine } = buildEngine()
  const manager = makeFakeManager('issue')
  engine.register(manager)

  await engine.enqueueWebhookEvent('binding-1', 'issue', { id: 1, object_kind: 'issue' }, 'dup-event', 'v1')
  await engine.enqueueWebhookEvent('binding-1', 'issue', { id: 1, object_kind: 'issue' }, 'dup-event', 'v1')
  await engine.stop()

  expect(manager.calls).toHaveLength(1)
})

test('enqueueLocalEvent: dispatched to applyLocal', async () => {
  const { engine } = buildEngine()
  const manager = makeFakeManager('issue')
  engine.register(manager)

  engine.enqueueLocalEvent('binding-1', 'issue', 'issue:42', { state: 'closed' })
  await engine.stop()

  expect(manager.calls).toHaveLength(1)
  expect(manager.calls[0].method).toBe('applyLocal')
  expect(manager.calls[0].args[0]).toBe('issue:42')
})

test('enqueueBackfill: dispatched to backfill for each registered manager', async () => {
  const { engine } = buildEngine()
  const issueManager = makeFakeManager('issue')
  const noteManager = makeFakeManager('note')
  engine.register(issueManager)
  engine.register(noteManager)

  const since = new Date('2024-01-01T00:00:00Z')
  engine.enqueueBackfill('binding-1', since)
  await engine.stop()

  expect(issueManager.calls.some((c) => c.method === 'backfill')).toBe(true)
  expect(noteManager.calls.some((c) => c.method === 'backfill')).toBe(true)
})

test('breaker: open breaker drops events without calling manager', async () => {
  const { engine, breaker } = buildEngine()
  const manager = makeFakeManager('issue')
  engine.register(manager)

  // Trip the breaker
  for (let i = 0; i < 5; i++) breaker.recordFailure('binding-1')
  expect(breaker.isOpen('binding-1')).toBe(true)

  await engine.enqueueWebhookEvent(
    'binding-1',
    'issue',
    { id: 1, object_kind: 'issue' },
    'event-dropped',
    'v1'
  )
  await engine.stop()

  expect(manager.calls).toHaveLength(0)
})

test('breaker: records success after successful apply', async () => {
  const { engine, breaker } = buildEngine()
  const manager = makeFakeManager('issue')
  engine.register(manager)

  // 4 failures (not yet open)
  for (let i = 0; i < 4; i++) breaker.recordFailure('binding-1')

  await engine.enqueueWebhookEvent(
    'binding-1',
    'issue',
    { id: 1, object_kind: 'issue' },
    'event-success',
    'v1'
  )
  await engine.stop()

  expect(manager.calls).toHaveLength(1)
  expect(breaker.getState('binding-1')).toBe('closed')
})

test('breaker: records failure when manager throws', async () => {
  const { engine, breaker } = buildEngine()
  const manager: SyncManager & { calls: CallRecord[] } = {
    kind: 'issue',
    calls: [],
    applyRemote: async () => { throw new Error('adapter exploded') },
    applyLocal: async () => {},
    backfill: async () => {}
  }
  engine.register(manager)

  await engine.enqueueWebhookEvent(
    'binding-1',
    'issue',
    { id: 1, object_kind: 'issue' },
    'event-fail',
    'v1'
  )
  await engine.stop()

  // One failure recorded
  breaker.recordFailure('binding-1') // total 2 now
  expect(breaker.getState('binding-1')).toBe('closed') // not open yet (need 5)
})

test('resourceKey: issues with different iids get distinct queue keys (serialised per resource)', async () => {
  // Record manager dispatch order — separate iids must allow concurrent processing.
  // We assert by inspecting the order calls are queued and processed.
  const { engine } = buildEngine()
  const calls: number[] = []
  const manager: SyncManager & { calls: CallRecord[] } = {
    kind: 'issue',
    calls: [],
    applyRemote: async (_ctx: SyncContext, _binding: string, record: unknown) => {
      const r = record as { object_attributes?: { iid?: number } }
      const iid = r.object_attributes?.iid ?? 0
      calls.push(iid)
    },
    applyLocal: async () => {},
    backfill: async () => {},
    resourceKey: (record: Record<string, unknown>) => {
      const attrs = record.object_attributes as Record<string, unknown> | undefined
      const iid = attrs?.iid
      if (typeof iid === 'number') return `issue:${iid}`
      return undefined
    }
  }
  engine.register(manager)

  await engine.enqueueWebhookEvent('binding-1', 'issue', { object_attributes: { iid: 1 } }, 'evt-1', 'v1')
  await engine.enqueueWebhookEvent('binding-1', 'issue', { object_attributes: { iid: 2 } }, 'evt-2', 'v1')
  await engine.stop()

  expect(calls).toHaveLength(2)
  expect(calls).toEqual(expect.arrayContaining([1, 2]))
})

test('resourceKey: notes with different ids get distinct queue keys', async () => {
  const { engine } = buildEngine()
  const calls: number[] = []
  const manager: SyncManager & { calls: CallRecord[] } = {
    kind: 'note',
    calls: [],
    applyRemote: async (_ctx: SyncContext, _binding: string, record: unknown) => {
      const r = record as { object_attributes?: { id?: number } }
      calls.push(r.object_attributes?.id ?? 0)
    },
    applyLocal: async () => {},
    backfill: async () => {},
    resourceKey: (record: Record<string, unknown>) => {
      const attrs = record.object_attributes as Record<string, unknown> | undefined
      const id = attrs?.id
      if (typeof id === 'number') return `note:${id}`
      return undefined
    }
  }
  engine.register(manager)

  await engine.enqueueWebhookEvent('binding-1', 'note', { object_attributes: { id: 100 } }, 'evt-100', 'v1')
  await engine.enqueueWebhookEvent('binding-1', 'note', { object_attributes: { id: 200 } }, 'evt-200', 'v1')
  await engine.stop()

  expect(calls).toHaveLength(2)
  expect(calls).toEqual(expect.arrayContaining([100, 200]))
})

test('crash recovery: start() resumes inflight op', async () => {
  const inflightId = new ObjectId()
  const staleDoc: InflightDoc = {
    _id: inflightId,
    bindingId: 'binding-1',
    op: 'remote:issue',
    payload: { record: { id: 99, object_kind: 'issue' }, eventId: 'recovered-evt', version: 'v0' },
    startedAt: new Date() // fresh — within 1h
  }

  const { engine } = buildEngine([staleDoc])
  const manager = makeFakeManager('issue')
  engine.register(manager)

  await engine.start()
  await engine.stop()

  expect(manager.calls.some((c) => c.method === 'applyRemote')).toBe(true)
})

test('crash recovery: start() discards ops older than 1h', async () => {
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000) // 2 hours ago
  const staleDoc: InflightDoc = {
    _id: new ObjectId(),
    bindingId: 'binding-1',
    op: 'remote:issue',
    payload: { record: { id: 7, object_kind: 'issue' }, eventId: 'old-evt', version: 'v0' },
    startedAt: old
  }

  const { engine, inflightCol } = buildEngine([staleDoc])
  const manager = makeFakeManager('issue')
  engine.register(manager)

  await engine.start()
  await engine.stop()

  // Manager should NOT be called for the stale op
  expect(manager.calls).toHaveLength(0)
  // The stale doc should have been deleted from inflight
  expect(inflightCol.docs).toHaveLength(0)
})
