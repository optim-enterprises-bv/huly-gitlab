/**
 * Last-write-wins conflict resolution utilities.
 *
 * Used by T-10 (IssuesSyncManager) and T-11 (NotesSyncManager) for field-level merging.
 */

export type LwwWinner = 'local' | 'remote' | 'tie' | 'noop'

export interface LwwResult<T> {
  winner: LwwWinner
  value: T | undefined
}

/**
 * Scalar LWW resolver.
 *
 * Tiebreaker rules (spec R6-R10):
 *   - equal timestamps           → prefer remote (winner='remote')
 *   - local missing, remote present → remote
 *   - remote missing, local present → local
 *   - both missing               → noop
 */
export function resolveLww<T> (
  localValue: T | undefined,
  localTs: Date | undefined,
  remoteValue: T | undefined,
  remoteTs: Date | undefined
): LwwResult<T> {
  const localMissing = localValue === undefined || localTs === undefined
  const remoteMissing = remoteValue === undefined || remoteTs === undefined

  if (localMissing && remoteMissing) {
    return { winner: 'noop', value: undefined }
  }
  if (localMissing) {
    return { winner: 'remote', value: remoteValue }
  }
  if (remoteMissing) {
    return { winner: 'local', value: localValue }
  }

  const lt = localTs.getTime()
  const rt = remoteTs.getTime()

  if (rt > lt) return { winner: 'remote', value: remoteValue }
  if (lt > rt) return { winner: 'local', value: localValue }
  // equal timestamps → prefer remote
  return { winner: 'remote', value: remoteValue }
}

export interface FieldVersion<T> {
  value: T | undefined
  ts: Date | undefined
}

export type FieldDecision = 'local' | 'remote' | 'noop'

/**
 * Field-by-field LWW resolver for document merging.
 *
 * Returns a map of field → decision for each field present in either record.
 * T-10 uses this to apply the minimal set of changes when merging an issue.
 */
export function applyLwwFieldByField<T extends Record<string, FieldVersion<unknown>>> (
  local: T,
  remote: T
): Partial<Record<keyof T, FieldDecision>> {
  const result: Partial<Record<keyof T, FieldDecision>> = {}
  const allKeys = new Set([...Object.keys(local), ...Object.keys(remote)])

  for (const field of allKeys) {
    const l: FieldVersion<unknown> | undefined = local[field]
    const r: FieldVersion<unknown> | undefined = remote[field]
    const res = resolveLww(l?.value, l?.ts, r?.value, r?.ts)
    const decision: FieldDecision = res.winner === 'noop' ? 'noop' : (res.winner === 'tie' ? 'remote' : res.winner)
    result[field as keyof T] = decision
  }

  return result
}
