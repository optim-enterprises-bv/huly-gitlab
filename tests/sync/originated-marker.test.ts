import {
  ORIGINATED_MARKER_KEY,
  ORIGINATED_MARKER_VALUE,
  withOriginatedMarker,
  withOriginatedMarkerForOperators
} from '../../src/sync/originated-marker'

test('1. withOriginatedMarker adds marker to plain attrs object', () => {
  const result = withOriginatedMarker({ title: 'foo' })
  expect(result).toEqual({ title: 'foo', [ORIGINATED_MARKER_KEY]: ORIGINATED_MARKER_VALUE })
  expect(result._originated).toBe('gitlab')
})

test('2. withOriginatedMarkerForOperators with $set places marker inside $set', () => {
  const result = withOriginatedMarkerForOperators({ $set: { title: 'foo' } })
  expect(result.$set).toEqual({ title: 'foo', [ORIGINATED_MARKER_KEY]: ORIGINATED_MARKER_VALUE })
  expect((result.$set as Record<string, unknown>)._originated).toBe('gitlab')
  // marker should NOT be at root when $set is present
  expect((result as Record<string, unknown>)._originated).toBeUndefined()
})

test('3. withOriginatedMarkerForOperators without $set places marker at root', () => {
  const result = withOriginatedMarkerForOperators({ $inc: { count: 1 } })
  expect((result as Record<string, unknown>)._originated).toBe('gitlab')
  expect((result as Record<string, unknown>).$inc).toEqual({ count: 1 })
})

test('4. idempotency: calling withOriginatedMarker twice yields same result', () => {
  const once = withOriginatedMarker({ title: 'x' })
  const twice = withOriginatedMarker(once)
  expect(twice).toEqual(once)
  // Only one marker key — value same
  expect(twice._originated).toBe('gitlab')
})
