import type { BindingBreaker } from './types'

type BreakerState = 'closed' | 'open' | 'half-open'

const FAILURE_THRESHOLD = 5
const OPEN_DURATION_MS = 15 * 60 * 1000 // 15 minutes

interface BreakerEntry {
  state: BreakerState
  failures: number
  openedAt: number | null
}

/**
 * In-memory per-binding circuit breaker.
 *
 * State machine:
 *   closed → open after FAILURE_THRESHOLD consecutive failures
 *   open   → half-open after OPEN_DURATION_MS (15 min)
 *   half-open → closed on first success
 *   half-open → open on first failure
 */
export class InMemoryBindingBreaker implements BindingBreaker {
  private readonly entries = new Map<string, BreakerEntry>()

  private getEntry (bindingId: string): BreakerEntry {
    let entry = this.entries.get(bindingId)
    if (entry === undefined) {
      entry = { state: 'closed', failures: 0, openedAt: null }
      this.entries.set(bindingId, entry)
    }
    return entry
  }

  getState (bindingId: string): BreakerState {
    const entry = this.getEntry(bindingId)
    if (entry.state === 'open' && entry.openedAt !== null) {
      if (Date.now() - entry.openedAt >= OPEN_DURATION_MS) {
        entry.state = 'half-open'
      }
    }
    return entry.state
  }

  isOpen (bindingId: string): boolean {
    return this.getState(bindingId) === 'open'
  }

  recordSuccess (bindingId: string): void {
    const entry = this.getEntry(bindingId)
    // Refresh state (handles open → half-open transition)
    this.getState(bindingId)

    entry.failures = 0
    entry.state = 'closed'
    entry.openedAt = null
  }

  recordFailure (bindingId: string): void {
    const entry = this.getEntry(bindingId)
    // Refresh state (handles open → half-open transition)
    const currentState = this.getState(bindingId)

    if (currentState === 'half-open') {
      // Single failure in half-open re-opens the breaker
      entry.state = 'open'
      entry.openedAt = Date.now()
      entry.failures = FAILURE_THRESHOLD
      return
    }

    if (currentState === 'open') {
      // Already open — no change needed
      return
    }

    // closed state
    entry.failures += 1
    if (entry.failures >= FAILURE_THRESHOLD) {
      entry.state = 'open'
      entry.openedAt = Date.now()
    }
  }
}
