/**
 * Shared deferred-retry helper for notes / review managers.
 *
 * Pattern: when a child record (note, review thread) arrives before its
 * parent (issue, MR) is mirrored, we defer once via a transient flag on
 * the record envelope, then drop on second miss.
 */
export type DeferredRetryRecord = Record<string, unknown>

/**
 * Returns `true` if this record has NOT been retried yet (caller should
 * re-enqueue with flag set). Returns `false` if already retried (caller
 * should DROP).
 *
 * Idempotent: calling repeatedly with same record returns false the
 * second time.
 */
export function markAndRetry (record: DeferredRetryRecord, flagKey: string): boolean {
  if (record[flagKey] === true) return false
  record[flagKey] = true
  return true
}

/** Backward-compatible aliases for the existing flag names. */
export const NOTE_RETRY_FLAG = '_noteRetried'
export const REVIEW_RETRY_FLAG = '_reviewRetried'
