import type { Logger } from '../logging'
import type { Store } from '../state/store'

/** Opaque reference to a Binding document _id */
export type BindingRef = string

/**
 * Per-binding circuit breaker.
 * Implemented by InMemoryBindingBreaker (breaker.ts).
 * Consumed by SyncEngine (T-07) and BackfillScheduler (T-12).
 */
export interface BindingBreaker {
  isOpen: (bindingId: string) => boolean
  recordSuccess: (bindingId: string) => void
  recordFailure: (bindingId: string) => void
  getState: (bindingId: string) => 'closed' | 'open' | 'half-open'
}

/**
 * Discriminated union of all events that flow through the SyncEngine queue.
 *
 * - remote: a webhook-delivered record from GitLab
 * - local: a change originating in Huly that must be pushed to GitLab
 * - backfill: a catch-up sweep from a given point in time
 */
export type SyncEvent =
  | {
    kind: 'remote'
    binding: BindingRef
    /** Canonical record type as returned by the GitLab adapter */
    record: Record<string, unknown>
    /** Opaque identifier supplied by the GitLab webhook X-Gitlab-Event-UUID header */
    eventId: string
    /** Stringified webhook version / X-Gitlab-Token hash for dedup */
    version: string
  }
  | {
    kind: 'local'
    binding: BindingRef
    /** Huly document ref */
    doc: string
    /** Serialisable change payload produced by the Huly client watcher */
    change: Record<string, unknown>
  }
  | {
    kind: 'backfill'
    binding: BindingRef
    /** If undefined, perform a full backfill from the beginning of time */
    since: Date | undefined
  }

/**
 * SyncManager is the per-resource-kind handler registered with SyncEngine.
 *
 * T-10 (IssuesSyncManager), T-11 (NotesSyncManager) implement this interface.
 *
 * @template TRecord - the canonical GitLab adapter record type (e.g. SyncIssue)
 */
export interface SyncManager<TRecord = Record<string, unknown>> {
  /** Resource kind this manager handles, e.g. 'issue' or 'note' */
  readonly kind: string

  /**
   * Apply a record received from GitLab into Huly.
   * Called for each remote SyncEvent whose kind matches this manager.
   */
  applyRemote: (
    ctx: SyncContext,
    binding: BindingRef,
    record: TRecord
  ) => Promise<void>

  /**
   * Push a local Huly change to GitLab.
   * Called for each local SyncEvent whose kind matches this manager.
   */
  applyLocal: (
    ctx: SyncContext,
    binding: BindingRef,
    doc: string,
    change: Record<string, unknown>
  ) => Promise<void>

  /**
   * Perform a catch-up backfill from GitLab.
   * `since` is undefined for a full backfill.
   */
  backfill: (
    ctx: SyncContext,
    binding: BindingRef,
    since: Date | undefined
  ) => Promise<void>

  /**
   * Optional per-kind resource key resolver. Engine uses the return value
   * to serialise updates to the same logical resource (e.g. `issue:42`).
   * Returns undefined to fall back to engine default.
   */
  resourceKey?: (record: Record<string, unknown>) => string | undefined
}

/**
 * Ambient context passed to every SyncManager method.
 * Provides scoped logger, workspace identity, and store access.
 */
export interface SyncContext {
  workspaceUuid: string
  logger: Logger
  store: Store
}

/**
 * Dependencies injected into SyncEngine at construction time.
 */
export interface EngineDependencies {
  store: Store
  logger: Logger
  breaker: BindingBreaker
}
