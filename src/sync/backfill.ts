import { getCursor } from '../state/cursors'
import { createLogger } from '../logging'
import type { Logger } from '../logging'
import type { Store } from '../state/store'
import type { BindingBreaker } from './types'
import type { SyncEngine } from './engine'

/**
 * BackfillScheduler — periodic catch-up sweep for all non-disabled bindings.
 *
 * Polling-always semantics (v2 spec): polling runs every intervalMs for ALL
 * non-disabled bindings, regardless of webhookRegistered. Webhooks are best-effort
 * real-time delivery; the backfill is the authoritative catch-up mechanism.
 *
 * The scheduler reuses the same BindingBreaker instance as the SyncEngine so that
 * failures recorded during backfill affect the real-time circuit breaker state and
 * vice-versa (R-real-time-breaker per v2 plan).
 */

const BACKFILL_CONCURRENCY = 16

export interface BackfillSchedulerOptions {
  store: Store
  syncEngine: SyncEngine
  /** Shared breaker instance — MUST be the same object passed to SyncEngine */
  breaker: BindingBreaker
  /** Defaults to Config.BackfillIntervalMs (300_000 ms = 5 min) */
  intervalMs?: number
  logger?: Logger
}

export class BackfillScheduler {
  private readonly store: Store
  private readonly syncEngine: SyncEngine
  private readonly breaker: BindingBreaker
  private readonly intervalMs: number
  private readonly logger: Logger
  private timer: ReturnType<typeof setInterval> | null = null

  constructor (opts: BackfillSchedulerOptions) {
    this.store = opts.store
    this.syncEngine = opts.syncEngine
    this.breaker = opts.breaker
    // Default: 5 minutes (matches Config.BackfillIntervalMs env default of 300000)
    this.intervalMs = opts.intervalMs ?? 300_000
    this.logger = opts.logger ?? createLogger('BackfillScheduler')
  }

  /**
   * Start periodic polling. First tick fires after intervalMs (not immediately)
   * to avoid a thundering herd at boot when many services start concurrently.
   */
  start (): void {
    if (this.timer !== null) {
      this.logger.warn('BackfillScheduler: already started')
      return
    }
    this.timer = setInterval(() => {
      void this.tick()
    }, this.intervalMs)
    this.logger.info('BackfillScheduler: started', { intervalMs: this.intervalMs })
  }

  /** Stop periodic polling. Any in-flight tick is allowed to complete. */
  stop (): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
      this.logger.info('BackfillScheduler: stopped')
    }
  }

  /**
   * Execute one backfill sweep. Exported as a method so tests can invoke it directly.
   *
   * Processes up to BACKFILL_CONCURRENCY (16) bindings in parallel via
   * Promise.allSettled; remaining batches are processed serially for fairness.
   */
  async tick (): Promise<void> {
    const tickStart = Date.now()
    this.logger.debug('BackfillScheduler: tick start')

    let bindings
    try {
      const docs = await this.store.bindings().find({ disabled: false }).toArray()
      bindings = docs
    } catch (err) {
      this.logger.error('BackfillScheduler: failed to list bindings', {
        err: err instanceof Error ? err.message : String(err)
      })
      return
    }

    // Process in batches of BACKFILL_CONCURRENCY for fairness
    for (let i = 0; i < bindings.length; i += BACKFILL_CONCURRENCY) {
      const batch = bindings.slice(i, i + BACKFILL_CONCURRENCY)
      await Promise.allSettled(
        batch.map(async (binding) => { await this.processBinding(binding._id.toHexString()) })
      )
    }

    this.logger.debug('BackfillScheduler: tick complete', {
      bindingCount: bindings.length,
      durationMs: Date.now() - tickStart
    })
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private async processBinding (bindingId: string): Promise<void> {
    const correlationId = `backfill-${bindingId}-${Date.now()}`
    const log = createLogger('BackfillScheduler', correlationId)

    if (this.breaker.isOpen(bindingId)) {
      log.debug('BackfillScheduler: skipping — breaker open', { bindingId })
      return
    }

    try {
      const since = await this.resolveSince(bindingId)
      log.info('BackfillScheduler: enqueueing backfill', { bindingId, since: since?.toISOString() ?? null })
      this.syncEngine.enqueueBackfill(bindingId, since)
      this.breaker.recordSuccess(bindingId)
    } catch (err) {
      log.error('BackfillScheduler: per-binding error', {
        bindingId,
        err: err instanceof Error ? err.message : String(err)
      })
      this.breaker.recordFailure(bindingId)
    }
  }

  /**
   * Resolve the `since` cursor for a binding.
   *
   * Reads cursors for all known sync kinds and returns the minimum (oldest)
   * so no resource type is starved. If no cursor exists, returns undefined
   * (full backfill from beginning of time).
   *
   * Clock-skew guard: if a stored cursor is in the future, clamp it to now.
   * This prevents a misconfigured clock from skipping recent records.
   */
  private async resolveSince (bindingId: string): Promise<Date | undefined> {
    const now = new Date()
    const kinds = ['issues', 'notes'] as const

    const dates: Date[] = []
    for (const kind of kinds) {
      const cursor = await getCursor(this.store.cursors(), bindingId, kind)
      if (cursor !== null) {
        // Clock-skew guard: clamp future cursors to now
        const clamped = cursor > now ? now : cursor
        dates.push(clamped)
      }
    }

    if (dates.length === 0) return undefined

    // Use minimum cursor so all resource types are caught up
    return dates.reduce((min, d) => (d < min ? d : min))
  }
}
