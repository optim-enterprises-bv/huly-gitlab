/**
 * Phase 5 §C: Defense-in-depth marker for MR-2 echo storm prevention.
 *
 * Every applyRemote write path stamps `_originated: 'gitlab'` on the operation/attribute
 * payload. TxSubscriber sees the marker on the resulting Tx and drops it (layer 2 defense;
 * layer 1 is the service-account PersonId filter).
 *
 * TxRemoveDoc has no attributes — N/A for removes (carve-out per critic blocking item 5).
 *
 * Helpers:
 * - `withOriginatedMarker(attrs)` — for createDoc / updateDoc / createMixin / updateMixin attrs
 * - `withOriginatedMarkerForOperators(ops)` — for TxUpdateDoc operations that use $set/$inc
 */

export const ORIGINATED_MARKER_KEY = '_originated'
export const ORIGINATED_MARKER_VALUE = 'gitlab'

export function withOriginatedMarker<T extends Record<string, unknown>> (attrs: T): T & Record<string, unknown> {
  return { ...attrs, [ORIGINATED_MARKER_KEY]: ORIGINATED_MARKER_VALUE }
}

/** For TxUpdateDoc operations using $set/$inc/$push etc., place marker under $set so it appears on the resulting doc. */
export function withOriginatedMarkerForOperators<T extends Record<string, unknown>> (ops: T): T & Record<string, unknown> {
  const setOp = (ops as Record<string, unknown>).$set
  if (setOp !== undefined && typeof setOp === 'object' && setOp !== null) {
    return { ...ops, $set: { ...(setOp as Record<string, unknown>), [ORIGINATED_MARKER_KEY]: ORIGINATED_MARKER_VALUE } }
  }
  // No $set operator — add the marker at root too (defense in depth)
  return { ...ops, [ORIGINATED_MARKER_KEY]: ORIGINATED_MARKER_VALUE }
}
