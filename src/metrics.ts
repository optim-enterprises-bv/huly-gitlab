/**
 * Centralized metric registry. Phase 3 (C1) consolidation of module-level counters.
 * Use increment(name) / get(name) / reset() (tests only).
 */

const counters = new Map<string, number>()

export function increment (name: string, by: number = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + by)
}

export function get (name: string): number {
  return counters.get(name) ?? 0
}

export function getAll (): Record<string, number> {
  return Object.fromEntries(counters)
}

export function reset (name?: string): void {
  if (name === undefined) counters.clear()
  else counters.delete(name)
}

// Known metric names (documented for searchability)
export const METRIC_NAMES = {
  WEBHOOK_CONFIDENTIAL_SKIPPED: 'webhook.confidential.skipped',
  WEBHOOK_MR_SKIPPED: 'webhook.mr.skipped',
  WEBHOOK_UNBOUND_PIPELINE: 'webhook.pipeline.unbound',
  PIPELINE_LRU_DROP: 'pipeline.lru.drop',
  MR_COMPOSITE_PARTIAL: 'mr.composite.partial',
  APPROVAL_SERVICE_ACCOUNT_FALLBACK: 'approval.action.fallback.service_account',
  REVIEW_PARENT_MISSING: 'review.parent.missing',
  REVIEW_POSITION_MALFORMED: 'review.position.malformed',
  DISCUSSION_POSITION_UNSUPPORTED: 'discussion.position.unsupported',
  MIGRATION_REVIEWER_UNRESOLVED: 'migration.reviewer.unresolved'
} as const
