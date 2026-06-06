/**
 * Unit tests for TxSubscriber (P4-T-09).
 *
 * Spec: .omc/specs/p4-t-01b-tx-subscription-api.md
 *
 * TG-1 documented limitation: these tests exercise a fake `Client` whose
 * `notify` field is invoked directly. Production divergence — the real
 * `ClientImpl.updateFromRemote` synthesises and applies model txes BEFORE
 * calling notify; we skip that step. Real end-to-end signal lives in the
 * P4-T-20 E2E that drives a live transactor.
 */

import type { Client, PersonId, Tx, WorkspaceUuid } from '@hcengineering/core'
import { TxSubscriber, type TxSubscriberDeps } from '../../src/sync/tx-subscription'
import type { SyncEngine } from '../../src/sync/engine'
import type { Logger } from '../../src/logging'
import { MR_MIXIN } from '../../src/sync/mr-mixin'
import { MR_REVIEW_MIXIN } from '../../src/sync/mr-review-mixin'
import { get as getMetric, reset as resetMetrics, METRIC_NAMES } from '../../src/metrics'

const WORKSPACE = 'ws-1' as WorkspaceUuid
const SERVICE_ACCOUNT = 'system-account' as unknown as PersonId
const USER_ACCOUNT = 'user-account' as unknown as PersonId

interface EnqueueCall {
  binding: string
  kind: string
  doc: string
  change: Record<string, unknown>
}

function makeLogger (): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
}

function makeFakeClient (): Client {
  return {
    notify: undefined,
    findOne: async () => undefined,
    findAll: async () => [] as never,
    close: async () => {}
  } as unknown as Client
}

function makeFakeEngine (sink: EnqueueCall[]): SyncEngine {
  return {
    enqueueLocalEvent: (binding: string, kind: string, doc: string, change: Record<string, unknown>) => {
      sink.push({ binding, kind, doc, change })
    }
  } as unknown as SyncEngine
}

function makeDeps (overrides: Partial<TxSubscriberDeps> = {}): {
  deps: TxSubscriberDeps
  client: Client
  enqueueCalls: EnqueueCall[]
} {
  const client = overrides.client ?? makeFakeClient()
  const enqueueCalls: EnqueueCall[] = []
  const syncEngine = overrides.syncEngine ?? makeFakeEngine(enqueueCalls)
  const deps: TxSubscriberDeps = {
    client,
    syncEngine,
    workspaceUuid: WORKSPACE,
    serviceAccountPersonId: SERVICE_ACCOUNT,
    bindingsByProject: overrides.bindingsByProject ?? new Map<string, string>([['101', 'binding-1']]),
    resolveBindingForDoc: overrides.resolveBindingForDoc,
    logger: overrides.logger ?? makeLogger()
  }
  return { deps, client, enqueueCalls }
}

function mkTxMixin (
  mixinRef: string,
  doc: string,
  attributes: Record<string, unknown>,
  modifiedBy: PersonId = USER_ACCOUNT,
  objectClass: string = 'tracker:class:Issue'
): Tx {
  return {
    _id: `tx-${Math.random().toString(36).slice(2)}`,
    _class: 'core:class:TxMixin',
    objectId: doc,
    objectClass,
    mixin: mixinRef,
    attributes,
    modifiedBy
  } as unknown as Tx
}

function mkTxUpdate (
  objectClass: string,
  doc: string,
  operations: Record<string, unknown>,
  modifiedBy: PersonId = USER_ACCOUNT
): Tx {
  return {
    _id: `tx-${Math.random().toString(36).slice(2)}`,
    _class: 'core:class:TxUpdateDoc',
    objectId: doc,
    objectClass,
    operations,
    modifiedBy
  } as unknown as Tx
}

beforeEach(() => {
  resetMetrics(METRIC_NAMES.TX_SUBSCRIPTION_ECHO_DROPPED)
  resetMetrics(METRIC_NAMES.TX_SUBSCRIPTION_BUFFER_OVERFLOW)
})

describe('TxSubscriber: start() and notify wiring', () => {
  it('start() sets client.notify; tx delivery dispatches to engine after markEngineStarted', () => {
    const { deps, client, enqueueCalls } = makeDeps()
    const sub = new TxSubscriber(deps)

    expect(client.notify).toBeUndefined()
    sub.start()
    expect(typeof client.notify).toBe('function')

    sub.markEngineStarted()

    const tx = mkTxMixin(MR_MIXIN as unknown as string, 'doc-1', { draft: true })
    client.notify?.(tx)

    expect(enqueueCalls).toEqual([
      { binding: 'binding-1', kind: 'merge_request', doc: 'doc-1', change: { draft: true } }
    ])
  })
})

describe('TxSubscriber: MR-2 echo storm filter', () => {
  it('drops txes authored by the service account; metric increments', () => {
    const { deps, client, enqueueCalls } = makeDeps()
    const sub = new TxSubscriber(deps)
    sub.start()
    sub.markEngineStarted()

    const echoTx = mkTxMixin(
      MR_MIXIN as unknown as string,
      'doc-echo',
      { draft: false },
      SERVICE_ACCOUNT
    )
    client.notify?.(echoTx)

    expect(enqueueCalls).toHaveLength(0)
    expect(getMetric(METRIC_NAMES.TX_SUBSCRIPTION_ECHO_DROPPED)).toBe(1)
  })

  // B3: _originated:'gitlab' marker check was removed. The marker is never
  // stamped by any applyRemote write path; the dual-defense layer was
  // documented but never wired. MR-2 is now single-defense (service-account
  // PersonId filter only). A tx that carries the marker but is authored by
  // a non-service-account is forwarded to the engine like any other tx.
  it('B3: tx with _originated marker but non-service-account modifiedBy is NOT dropped', () => {
    const { deps, client, enqueueCalls } = makeDeps()
    const sub = new TxSubscriber(deps)
    sub.start()
    sub.markEngineStarted()

    const markedTx = mkTxMixin(
      MR_MIXIN as unknown as string,
      'doc-marked',
      { draft: false, _originated: 'gitlab' }
    )
    client.notify?.(markedTx)

    expect(enqueueCalls).toHaveLength(1)
    expect(getMetric(METRIC_NAMES.TX_SUBSCRIPTION_ECHO_DROPPED)).toBe(0)
  })
})

describe('TxSubscriber: MR-1 cold-start buffering', () => {
  it('buffers txes received before markEngineStarted', () => {
    const { deps, client, enqueueCalls } = makeDeps()
    const sub = new TxSubscriber(deps)
    sub.start()

    const tx = mkTxMixin(MR_MIXIN as unknown as string, 'doc-buffered', { draft: true })
    client.notify?.(tx)

    expect(enqueueCalls).toHaveLength(0)
  })

  it('markEngineStarted drains buffer in FIFO order', () => {
    const { deps, client, enqueueCalls } = makeDeps()
    const sub = new TxSubscriber(deps)
    sub.start()

    const tx1 = mkTxMixin(MR_MIXIN as unknown as string, 'doc-1', { draft: true })
    const tx2 = mkTxMixin(MR_MIXIN as unknown as string, 'doc-2', { draft: false })
    const tx3 = mkTxMixin(MR_REVIEW_MIXIN as unknown as string, 'doc-3', { resolved: true })
    client.notify?.(tx1)
    client.notify?.(tx2)
    client.notify?.(tx3)

    expect(enqueueCalls).toHaveLength(0)
    sub.markEngineStarted()

    expect(enqueueCalls).toEqual([
      { binding: 'binding-1', kind: 'merge_request', doc: 'doc-1', change: { draft: true } },
      { binding: 'binding-1', kind: 'merge_request', doc: 'doc-2', change: { draft: false } },
      { binding: 'binding-1', kind: 'review', doc: 'doc-3', change: { resolved: true } }
    ])
  })

  it('buffer overflow at 1024 drops new entries and increments overflow metric', () => {
    const { deps, client, enqueueCalls } = makeDeps()
    const sub = new TxSubscriber(deps)
    sub.start()

    // Fill buffer to capacity.
    for (let i = 0; i < 1024; i++) {
      client.notify?.(mkTxMixin(MR_MIXIN as unknown as string, `doc-${i}`, { idx: i }))
    }
    expect(getMetric(METRIC_NAMES.TX_SUBSCRIPTION_BUFFER_OVERFLOW)).toBe(0)

    // Three more — overflow.
    client.notify?.(mkTxMixin(MR_MIXIN as unknown as string, 'doc-overflow-1', {}))
    client.notify?.(mkTxMixin(MR_MIXIN as unknown as string, 'doc-overflow-2', {}))
    client.notify?.(mkTxMixin(MR_MIXIN as unknown as string, 'doc-overflow-3', {}))

    expect(getMetric(METRIC_NAMES.TX_SUBSCRIPTION_BUFFER_OVERFLOW)).toBe(3)

    sub.markEngineStarted()
    // Only the first 1024 drained; overflow entries dropped.
    expect(enqueueCalls).toHaveLength(1024)
    expect(enqueueCalls[0].doc).toBe('doc-0')
    expect(enqueueCalls[1023].doc).toBe('doc-1023')
  })
})

describe('TxSubscriber: kind classification', () => {
  it('TxMixin on MR_MIXIN → kind merge_request', () => {
    const { deps, client, enqueueCalls } = makeDeps()
    const sub = new TxSubscriber(deps)
    sub.start()
    sub.markEngineStarted()

    client.notify?.(
      mkTxMixin(MR_MIXIN as unknown as string, 'mr-doc', { draft: true, mergeStatus: 'can_be_merged' })
    )

    expect(enqueueCalls).toEqual([
      {
        binding: 'binding-1',
        kind: 'merge_request',
        doc: 'mr-doc',
        change: { draft: true, mergeStatus: 'can_be_merged' }
      }
    ])
  })

  it('TxMixin on MR_REVIEW_MIXIN → kind review', () => {
    const { deps, client, enqueueCalls } = makeDeps()
    const sub = new TxSubscriber(deps)
    sub.start()
    sub.markEngineStarted()

    client.notify?.(
      mkTxMixin(
        MR_REVIEW_MIXIN as unknown as string,
        'review-doc',
        { resolved: true },
        USER_ACCOUNT,
        'chunter:class:ChatMessage'
      )
    )

    expect(enqueueCalls).toEqual([
      { binding: 'binding-1', kind: 'review', doc: 'review-doc', change: { resolved: true } }
    ])
  })

  it('TxUpdateDoc on tracker.class.Issue → kind issue', () => {
    const { deps, client, enqueueCalls } = makeDeps()
    const sub = new TxSubscriber(deps)
    sub.start()
    sub.markEngineStarted()

    client.notify?.(
      mkTxUpdate('tracker:class:Issue', 'issue-doc', { title: 'New title' })
    )

    expect(enqueueCalls).toEqual([
      { binding: 'binding-1', kind: 'issue', doc: 'issue-doc', change: { title: 'New title' } }
    ])
  })

  it('TxUpdateDoc on chunter.class.ChatMessage → kind note', () => {
    const { deps, client, enqueueCalls } = makeDeps()
    const sub = new TxSubscriber(deps)
    sub.start()
    sub.markEngineStarted()

    client.notify?.(
      mkTxUpdate('chunter:class:ChatMessage', 'note-doc', { message: 'Edited' })
    )

    expect(enqueueCalls).toEqual([
      { binding: 'binding-1', kind: 'note', doc: 'note-doc', change: { message: 'Edited' } }
    ])
  })
})

describe('TxSubscriber: stop()', () => {
  it('clears client.notify; subsequent txes via leftover handler reference are ignored', () => {
    const { deps, client, enqueueCalls } = makeDeps()
    const sub = new TxSubscriber(deps)
    sub.start()
    sub.markEngineStarted()

    const leakedHandler = client.notify
    expect(typeof leakedHandler).toBe('function')

    sub.stop()
    expect(client.notify).toBeUndefined()

    // Even if some caller still holds a reference to the original handler,
    // the subscriber's stopped flag short-circuits dispatch.
    leakedHandler?.(mkTxMixin(MR_MIXIN as unknown as string, 'doc-after-stop', { draft: true }))
    expect(enqueueCalls).toHaveLength(0)
  })
})

describe('TxSubscriber: binding resolution', () => {
  it('drops tx silently when no binding is registered for the project', () => {
    const { deps, client, enqueueCalls } = makeDeps({
      bindingsByProject: new Map<string, string>()
    })
    const sub = new TxSubscriber(deps)
    sub.start()
    sub.markEngineStarted()

    client.notify?.(mkTxMixin(MR_MIXIN as unknown as string, 'orphan-doc', { draft: true }))
    expect(enqueueCalls).toHaveLength(0)
  })

  it('uses explicit resolveBindingForDoc when supplied', () => {
    const { deps, client, enqueueCalls } = makeDeps({
      bindingsByProject: new Map<string, string>(),
      resolveBindingForDoc: (docRef) => (docRef === 'doc-known' ? 'binding-explicit' : undefined)
    })
    const sub = new TxSubscriber(deps)
    sub.start()
    sub.markEngineStarted()

    client.notify?.(mkTxMixin(MR_MIXIN as unknown as string, 'doc-known', { draft: false }))
    client.notify?.(mkTxMixin(MR_MIXIN as unknown as string, 'doc-unknown', { draft: false }))

    expect(enqueueCalls).toEqual([
      { binding: 'binding-explicit', kind: 'merge_request', doc: 'doc-known', change: { draft: false } }
    ])
  })
})
