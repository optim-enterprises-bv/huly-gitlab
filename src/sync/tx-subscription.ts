/**
 * TxSubscriber — Path B closure for the Huly → GitLab sync direction.
 *
 * Spec: .omc/specs/p4-t-01b-tx-subscription-api.md (Path A confirmed).
 *
 * Subscribes to the platform `Client.notify` hook and translates incoming
 * `Tx` events into flat `change` envelopes that get dispatched to the
 * `SyncEngine.enqueueLocalEvent` API. The change-envelope shape is the
 * flat-key contract verified by P3-T-01b (`{ field: value }`).
 *
 * Critic-applied constraints:
 *   - MR-2 (echo storm): drop tx events authored by the pod's service
 *     account (`tx.modifiedBy === serviceAccountPersonId`). MR-2 protection
 *     is single-layer (service-account PersonId filter only). The original
 *     spec called for dual-layer with `_originated:'gitlab'` marker but
 *     stamping every applyRemote write site is invasive and was deferred.
 *     Service-account identity check is sufficient if `serviceAccountPersonId`
 *     is correctly resolved at startup. Operators MUST monitor
 *     `tx.subscription.echo.dropped` for healthy non-zero values during
 *     applyRemote bursts; a flat-zero counter indicates the service-account
 *     PersonId is not the same one platform writes use, and the filter is
 *     silently a no-op (see SH-1 below).
 *   - SH-1 (security hardening): `serviceAccountPersonId` is currently set
 *     to `systemAccountUuid` cast in `src/index.ts`. If real platform writes
 *     use a different `Tx.modifiedBy`, the echo filter is silently a no-op.
 *     Phase 4 ships with this limitation; production deployments should
 *     watch the `tx.subscription.echo.dropped` metric and alert on a
 *     0-rate during heavy applyRemote activity.
 *   - MR-1 (cold-start buffer): tx events received before `markEngineStarted`
 *     are buffered in a bounded FIFO (max 1024 entries). Overflow drops
 *     the new event and increments `tx.subscription.buffer.overflow`.
 *
 * Lifecycle wiring (start/stop, attach to BindingLoader cache eviction,
 * SIGTERM handling) is deferred to P4-T-19 per DAG-1. This file ships only
 * the core class.
 */

import type {
  Client,
  PersonId,
  Tx,
  TxCUD,
  TxMixin,
  TxUpdateDoc,
  TxCreateDoc,
  WorkspaceUuid,
  Doc
} from '@hcengineering/core'
import type { SyncEngine } from './engine'
import type { Logger } from '../logging'
import { increment, METRIC_NAMES } from '../metrics'
import { MR_MIXIN } from './mr-mixin'
import { MR_REVIEW_MIXIN } from './mr-review-mixin'

const BUFFER_MAX = 1024

/** Class refs used to discriminate tx variants at the wire format level. */
const TX_CLASS_CREATE = 'core:class:TxCreateDoc'
const TX_CLASS_UPDATE = 'core:class:TxUpdateDoc'
const TX_CLASS_REMOVE = 'core:class:TxRemoveDoc'
const TX_CLASS_MIXIN = 'core:class:TxMixin'

const HULY_CLASS_ISSUE = 'tracker:class:Issue'
const HULY_CLASS_CHAT_MESSAGE = 'chunter:class:ChatMessage'

/** Sync-engine `kind` strings — keep in lock-step with SyncManager.kind values. */
type SyncKind = 'merge_request' | 'review' | 'issue' | 'note'

/** Dependencies passed at construction time. */
export interface TxSubscriberDeps {
  client: Client
  syncEngine: SyncEngine
  workspaceUuid: WorkspaceUuid
  serviceAccountPersonId: PersonId
  /**
   * Map of project key → binding id. Populated by the caller (P4-T-19) from
   * the BindingLoader cache and updated on binding add/remove. Subscriber
   * consults this when resolving the bindingId for a tx; if the doc's binding
   * cannot be resolved, the tx is dropped with a debug log.
   *
   * B6: keys are strings via `bindingsByProjectKey(...)`:
   *   - single-instance: stringified projectId, e.g. `"42"`
   *   - multi-instance: `${hash8(baseUrl)}:${projectId}`, e.g. `"a1b2c3d4:42"`
   * Callers must pre-compose the key consistent with the BindingLoader.
   */
  bindingsByProject: Map<string, string>
  /**
   * Resolver from a Huly doc ref to the binding it belongs to. The
   * default behavior (returning `undefined`) drops the tx silently.
   * P4-T-19 wires a resolver that queries the idmap collection by huly ref.
   */
  resolveBindingForDoc?: (docRef: string, objectClass: string) => string | undefined
  logger: Logger
}

/**
 * Internal buffered entry — preserves the bindingId resolution decision
 * captured at receive time so a later drain does not re-evaluate against
 * a stale `bindingsByProject` snapshot.
 */
interface BufferedEntry {
  binding: string
  kind: SyncKind
  doc: string
  change: Record<string, unknown>
}

/**
 * NOTE (TG-1): fake-Client unit tests in `tx-subscription.test.ts` exercise
 * dispatch + filter + buffer logic by directly invoking `client.notify`.
 * Production divergence: the real `ClientImpl.updateFromRemote` synthesises
 * Tx objects through the model layer and applies them BEFORE calling notify;
 * the unit tests skip that step. Real signal lives in the P4-T-20 E2E.
 */
export class TxSubscriber {
  private buffer: BufferedEntry[] = []
  private readonly maxBufferSize = BUFFER_MAX
  private engineStarted = false
  private stopped = false

  constructor (private readonly deps: TxSubscriberDeps) {}

  /** Attach the notify handler to the underlying platform Client. */
  start (): void {
    this.stopped = false
    this.deps.client.notify = (...txes: Tx[]) => {
      for (const tx of txes) {
        try {
          this.onTx(tx)
        } catch (err) {
          this.deps.logger.warn('TxSubscriber: handler threw', {
            workspaceUuid: this.deps.workspaceUuid,
            err: err instanceof Error ? err.message : String(err)
          })
        }
      }
    }
  }

  /**
   * Called by P4-T-19 after `engine.start()` has resolved. Flushes the
   * cold-start buffer FIFO into the engine and switches subsequent events
   * to direct dispatch.
   */
  markEngineStarted (): void {
    this.engineStarted = true
    const drained = this.buffer.splice(0)
    for (const entry of drained) {
      this.deps.syncEngine.enqueueLocalEvent(entry.binding, entry.kind, entry.doc, entry.change)
    }
  }

  /** Detach the handler and clear any pending buffer. */
  stop (): void {
    this.stopped = true
    this.deps.client.notify = undefined
    this.buffer = []
  }

  private onTx (tx: Tx): void {
    if (this.stopped) return

    // MR-2 echo filter: drop self-authored txes. Compare as strings since
    // PersonId is a branded string at type level but identical on the wire.
    if ((tx.modifiedBy as unknown as string) === (this.deps.serviceAccountPersonId as unknown as string)) {
      increment(METRIC_NAMES.TX_SUBSCRIPTION_ECHO_DROPPED)
      return
    }

    const classified = this.classify(tx)
    if (classified === null) return

    const binding = this.resolveBinding(classified.doc, classified.objectClass)
    if (binding === undefined) {
      this.deps.logger.debug('TxSubscriber: no binding for tx — dropping', {
        workspaceUuid: this.deps.workspaceUuid,
        doc: classified.doc,
        kind: classified.kind
      })
      return
    }

    const entry: BufferedEntry = {
      binding,
      kind: classified.kind,
      doc: classified.doc,
      change: classified.change
    }

    if (!this.engineStarted) {
      if (this.buffer.length >= this.maxBufferSize) {
        increment(METRIC_NAMES.TX_SUBSCRIPTION_BUFFER_OVERFLOW)
        return
      }
      this.buffer.push(entry)
      return
    }

    this.deps.syncEngine.enqueueLocalEvent(entry.binding, entry.kind, entry.doc, entry.change)
  }

  /**
   * Map a tx onto (`kind`, `doc`, `change`) per the translation table.
   * Returns `null` when the tx does not correspond to a tracked resource.
   */
  private classify (tx: Tx): {
    kind: SyncKind
    doc: string
    change: Record<string, unknown>
    objectClass: string
  } | null {
    const txClass = tx._class as unknown as string

    if (txClass === TX_CLASS_MIXIN) {
      const mixinTx = tx as TxMixin<Doc, Doc>
      const mixinRef = mixinTx.mixin as unknown as string
      const objectClass = mixinTx.objectClass as unknown as string
      const doc = mixinTx.objectId as unknown as string
      const change = (mixinTx.attributes as unknown as Record<string, unknown>) ?? {}

      if (mixinRef === (MR_MIXIN as unknown as string)) {
        return { kind: 'merge_request', doc, change, objectClass }
      }
      if (mixinRef === (MR_REVIEW_MIXIN as unknown as string)) {
        return { kind: 'review', doc, change, objectClass }
      }
      return null
    }

    if (txClass === TX_CLASS_UPDATE) {
      const updateTx = tx as TxUpdateDoc<Doc>
      const objectClass = updateTx.objectClass as unknown as string
      const doc = updateTx.objectId as unknown as string
      const change = (updateTx.operations as unknown as Record<string, unknown>) ?? {}

      if (objectClass === HULY_CLASS_ISSUE) {
        return { kind: 'issue', doc, change, objectClass }
      }
      if (objectClass === HULY_CLASS_CHAT_MESSAGE) {
        return { kind: 'note', doc, change, objectClass }
      }
      return null
    }

    if (txClass === TX_CLASS_CREATE) {
      const createTx = tx as TxCreateDoc<Doc>
      const objectClass = createTx.objectClass as unknown as string
      const doc = createTx.objectId as unknown as string
      const change = (createTx.attributes as unknown as Record<string, unknown>) ?? {}

      if (objectClass === HULY_CLASS_ISSUE) {
        return { kind: 'issue', doc, change, objectClass }
      }
      if (objectClass === HULY_CLASS_CHAT_MESSAGE) {
        return { kind: 'note', doc, change, objectClass }
      }
      return null
    }

    if (txClass === TX_CLASS_REMOVE) {
      const removeTx = tx as TxCUD<Doc>
      const objectClass = removeTx.objectClass as unknown as string
      const doc = removeTx.objectId as unknown as string

      if (objectClass === HULY_CLASS_ISSUE) {
        return { kind: 'issue', doc, change: { _removed: true }, objectClass }
      }
      if (objectClass === HULY_CLASS_CHAT_MESSAGE) {
        return { kind: 'note', doc, change: { _removed: true }, objectClass }
      }
      return null
    }

    return null
  }

  /**
   * Resolve the binding id for a tx. Prefers an explicit resolver when
   * supplied; otherwise falls back to the project map (single-binding
   * cases where the caller pre-populates a deterministic mapping).
   */
  private resolveBinding (docRef: string, objectClass: string): string | undefined {
    if (this.deps.resolveBindingForDoc !== undefined) {
      return this.deps.resolveBindingForDoc(docRef, objectClass)
    }
    // Default: when only one binding is registered, use it. Otherwise
    // the caller MUST supply a resolver. Returning undefined drops the tx.
    if (this.deps.bindingsByProject.size === 1) {
      return this.deps.bindingsByProject.values().next().value
    }
    return undefined
  }
}
