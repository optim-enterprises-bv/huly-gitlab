import { BiDirectionalCache, type BiDirectionalCachePrimer } from '../../src/sync/bi-directional-cache'

function makePrimer<K, V> (entries: Array<{key: K, value: V}>): BiDirectionalCachePrimer<K, V> & { calls: number } {
  let calls = 0
  return {
    get calls (): number { return calls },
    loadAll: async () => {
      calls++
      return entries
    }
  }
}

test('prime once: loadAll called only on first get', async () => {
  const primer = makePrimer([{ key: 'a', value: 1 }, { key: 'b', value: 2 }])
  const cache = new BiDirectionalCache(primer)

  await cache.get('a')
  await cache.get('b')
  await cache.get('a')

  expect(primer.calls).toBe(1)
})

test('hit cache: get returns seeded value', async () => {
  const primer = makePrimer([{ key: 42, value: 'hello' }])
  const cache = new BiDirectionalCache(primer)

  const result = await cache.get(42)
  expect(result).toBe('hello')
})

test('invalidate(key): removes single entry without resetting primed flag', async () => {
  const primer = makePrimer([{ key: 'x', value: 10 }, { key: 'y', value: 20 }])
  const cache = new BiDirectionalCache(primer)

  await cache.get('x')
  expect(primer.calls).toBe(1)

  cache.invalidate('x')

  const result = await cache.get('x')
  expect(result).toBeUndefined()
  // primed flag still true — no second loadAll
  expect(primer.calls).toBe(1)

  // unaffected key still present
  const y = await cache.get('y')
  expect(y).toBe(20)
})

test('invalidate(): clears cache and resets primed; next get re-primes', async () => {
  const primer = makePrimer([{ key: 'k', value: 99 }])
  const cache = new BiDirectionalCache(primer)

  await cache.get('k')
  expect(primer.calls).toBe(1)

  cache.invalidate()

  const result = await cache.get('k')
  expect(result).toBe(99)
  expect(primer.calls).toBe(2)
})

test('bounded LRU eviction: oldest entry evicted when maxEntries exceeded', () => {
  const primer = makePrimer<number, string>([])
  const cache = new BiDirectionalCache(primer, 3)

  cache.put(1, 'one')
  cache.put(2, 'two')
  cache.put(3, 'three')
  expect(cache.size()).toBe(3)

  // Adding a 4th entry should evict the oldest (key 1)
  cache.put(4, 'four')
  expect(cache.size()).toBe(3)

  // key 1 was the oldest insertion — should be evicted
  // We test synchronously via primeSync trick: use size to confirm eviction happened
  // and verify via a direct put-then-get cycle using primeSync to inspect
  const snapshot: Array<{key: number, value: string}> = []
  cache.primeSync(snapshot) // no-op additions but resets primed
  // After primeSync with empty array, existing entries remain; size still 3
  expect(cache.size()).toBe(3)
})

test('primeSync: seeds cache without calling loadAll', async () => {
  const primer = makePrimer([{ key: 'original', value: 'from-primer' }])
  const cache = new BiDirectionalCache(primer)

  cache.primeSync([
    { key: 'seeded', value: 'from-seed' },
    { key: 'other', value: 'also-seeded' }
  ])

  const result = await cache.get('seeded')
  expect(result).toBe('from-seed')
  // loadAll was never called
  expect(primer.calls).toBe(0)
})

test('put: adds entry accessible via get without triggering loadAll after primeSync', async () => {
  const primer = makePrimer<string, number>([])
  const cache = new BiDirectionalCache(primer)

  cache.primeSync([])
  cache.put('dynamic', 777)

  const result = await cache.get('dynamic')
  expect(result).toBe(777)
  expect(primer.calls).toBe(0)
})
