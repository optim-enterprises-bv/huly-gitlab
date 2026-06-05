import { createLogger } from '../logging'
import { checkAndMarkSeen } from '../state/dedup'
import { createInflight, deleteInflight, listInflight } from '../state/inflight'
import { getBinding } from '../state/bindings'
import { EventQueue } from './queue'
import type { BindingRef, EngineDependencies, SyncContext, SyncEvent, SyncManager } from './types'

const INFLIGHT_MAX_AGE_MS = 60 * 60 * 1000 // 1 hour — matches inflight TTL index

interface QueueEntry {
  event: SyncEvent
  kind: string
  inflightId?: string
}

/**
 * SyncEngine — central dispatcher.
 *
 * Responsibilities:
 *   - register SyncManagers by kind
 *   - enqueue remote webhook events (deduped via dedup collection)
 *   - enqueue local Huly → GitLab events
 *   - enqueue backfill sweeps
 *   - consult BindingBreaker before dispatching; drop if open
 *   - start(): resume inflight ops from crash recovery, discard stale (> 1h)
 *   - stop(): drain in-flight queue
 *
 * Provider-shape leakage: the engine does NOT inspect GitLab payload fields
 * (e.g. object_kind). Every enqueue call provides an explicit `kind`; the
 * matching SyncManager is responsible for record-shape interpretation.
 */
export class SyncEngine {
  private readonly managers = new Map<string, SyncManager>()
  private readonly logger = createLogger('SyncEngine')
  private readonly queue: EventQueue<QueueEntry>

  constructor (private readonly deps: EngineDependencies) {
    this.queue = new EventQueue(
      async (entry) => {
        await this.dispatch(entry)
      },
      deps.logger
    )
  }

  /** Register a SyncManager. Must be called before start(). */
  register (manager: SyncManager): void {
    if (this.managers.has(manager.kind)) {
      this.logger.warn('SyncEngine: overwriting manager for kind', { kind: manager.kind })
    }
    this.managers.set(manager.kind, manager)
    this.logger.info('SyncEngine: registered manager', { kind: manager.kind })
  }

  /**
   * Enqueue a remote webhook event.
   * Deduplication check against the dedup collection; drops silently if duplicate.
   */
  async enqueueWebhookEvent (
    binding: BindingRef,
    kind: string,
    record: Record<string, unknown>,
    eventId: string,
    version: string
  ): Promise<void> {
    const isDup = await checkAndMarkSeen(this.deps.store.dedup(), binding, eventId, version)
    if (isDup) {
      this.logger.debug('SyncEngine: duplicate webhook event dropped', { binding, eventId, version })
      return
    }

    const event: SyncEvent = { kind: 'remote', binding, record, eventId, version }
    const resourceKey = this.resourceKeyForKind(kind, record)
    const queueKey = this.queueKey(binding, resourceKey)

    const inflightId = await createInflight(this.deps.store.inflight(), binding, `remote:${kind}`, {
      eventId,
      version,
      record
    })

    this.queue.enqueue(queueKey, { event, kind, inflightId })
  }

  /** Enqueue a local Huly change event. */
  enqueueLocalEvent (
    binding: BindingRef,
    kind: string,
    doc: string,
    change: Record<string, unknown>
  ): void {
    const event: SyncEvent = { kind: 'local', binding, doc, change }
    const resourceKey = `${kind}:${doc}`
    this.queue.enqueue(this.queueKey(binding, resourceKey), { event, kind })
  }

  /**
   * Enqueue a backfill for all registered manager kinds.
   * Each manager kind gets its own queue entry.
   */
  enqueueBackfill (binding: BindingRef, since: Date | undefined): void {
    for (const kind of this.managers.keys()) {
      const event: SyncEvent = { kind: 'backfill', binding, since }
      this.queue.enqueue(this.queueKey(binding, `backfill:${kind}`), { event, kind })
    }
  }

  /**
   * Boot: scan inflight collection, resume queued ops, discard ops older than 1h.
   */
  async start (): Promise<void> {
    this.logger.info('SyncEngine: starting — scanning inflight ops')
    const ops = await listInflight(this.deps.store.inflight())
    const cutoff = new Date(Date.now() - INFLIGHT_MAX_AGE_MS)

    let resumed = 0
    let discarded = 0

    for (const op of ops) {
      if (op.startedAt < cutoff) {
        this.logger.warn('SyncEngine: discarding stale inflight op', {
          id: op._id.toHexString(),
          bindingId: op.bindingId,
          op: op.op,
          startedAt: op.startedAt.toISOString()
        })
        await deleteInflight(this.deps.store.inflight(), op._id.toHexString())
        discarded++
        continue
      }

      // Re-enqueue based on op type prefix
      if (op.op.startsWith('remote:')) {
        const kind = op.op.slice('remote:'.length)
        const record = (op.payload.record as Record<string, unknown>) ?? {}
        const eventId = String(op.payload.eventId ?? op._id.toHexString())
        const version = String(op.payload.version ?? '0')
        const event: SyncEvent = {
          kind: 'remote',
          binding: op.bindingId,
          record,
          eventId,
          version
        }
        const resourceKey = this.resourceKeyForKind(kind, record)
        this.queue.enqueue(this.queueKey(op.bindingId, resourceKey), {
          event,
          kind,
          inflightId: op._id.toHexString()
        })
        resumed++
      } else if (op.op.startsWith('local:')) {
        const doc = String(op.payload.doc ?? '')
        const change = (op.payload.change as Record<string, unknown>) ?? {}
        const kind = op.op.slice('local:'.length)
        const event: SyncEvent = { kind: 'local', binding: op.bindingId, doc, change }
        this.queue.enqueue(this.queueKey(op.bindingId, `${kind}:${doc}`), {
          event,
          kind,
          inflightId: op._id.toHexString()
        })
        resumed++
      } else {
        // Unknown op type — discard
        await deleteInflight(this.deps.store.inflight(), op._id.toHexString())
        discarded++
      }
    }

    this.logger.info('SyncEngine: start complete', { resumed, discarded })
  }

  /** Drain in-flight queue — waits for all currently-enqueued items to complete. */
  async stop (): Promise<void> {
    this.logger.info('SyncEngine: stopping — draining queue')
    await this.queue.drainAll()
    this.logger.info('SyncEngine: stopped')
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private async dispatch (entry: QueueEntry): Promise<void> {
    const { event, kind, inflightId } = entry
    const { breaker, store, logger } = this.deps
    const binding = event.binding

    if (breaker.isOpen(binding)) {
      logger.warn('SyncEngine: breaker open — dropping event', { binding, kind: event.kind })
      if (inflightId !== undefined) {
        await deleteInflight(store.inflight(), inflightId)
      }
      return
    }

    const manager = this.managers.get(kind)
    if (manager === undefined) {
      logger.warn('SyncEngine: no manager for kind', { kind, binding })
      if (inflightId !== undefined) {
        await deleteInflight(store.inflight(), inflightId)
      }
      return
    }

    // Resolve real workspace UUID from binding doc (binding param is the binding _id).
    let workspaceUuid: string = binding
    try {
      const bindingDoc = await getBinding(store.bindings(), binding)
      if (bindingDoc !== null) {
        workspaceUuid = bindingDoc.workspaceUuid
      } else {
        logger.warn('SyncEngine: binding not found — using bindingId as workspace fallback', { binding })
      }
    } catch (err) {
      logger.warn('SyncEngine: failed to load binding doc', {
        binding,
        err: err instanceof Error ? err.message : String(err)
      })
    }

    const ctx: SyncContext = {
      workspaceUuid,
      logger: createLogger(`SyncEngine:${kind}`),
      store
    }

    try {
      if (event.kind === 'remote') {
        await manager.applyRemote(ctx, binding, event.record)
      } else if (event.kind === 'local') {
        await manager.applyLocal(ctx, binding, event.doc, event.change)
      } else if (event.kind === 'backfill') {
        await manager.backfill(ctx, binding, event.since)
      }

      breaker.recordSuccess(binding)
    } catch (err) {
      logger.error('SyncEngine: manager threw', {
        kind,
        binding,
        err: err instanceof Error ? err.message : String(err)
      })
      breaker.recordFailure(binding)
    } finally {
      if (inflightId !== undefined) {
        await deleteInflight(store.inflight(), inflightId)
      }
    }
  }

  private resourceKeyForKind (kind: string, record: Record<string, unknown>): string {
    const manager = this.managers.get(kind)
    if (manager?.resourceKey !== undefined) {
      const explicit = manager.resourceKey(record)
      if (explicit !== undefined) return explicit
    }
    return '*'
  }

  private queueKey (binding: BindingRef, resourceKey: string): string {
    return `${binding}/${resourceKey}`
  }
}
