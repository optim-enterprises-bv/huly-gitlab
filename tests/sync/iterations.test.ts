import { IterationsCache } from '../../src/sync/iterations'
import type { SyncIteration } from '../../src/adapter/types'

function makeIteration (id: string, title: string): SyncIteration {
  return {
    id,
    title,
    startDate: new Date('2024-01-01'),
    dueDate: new Date('2024-01-14'),
    state: 'started',
    webUrl: `https://gitlab.example.com/groups/1/-/iterations/${id}`
  }
}

function makeClient (iterations: SyncIteration[]): {
  listIterations: jest.Mock<Promise<SyncIteration[]>, [number | string]>
} {
  return {
    listIterations: jest.fn().mockResolvedValue(iterations)
  }
}

const BASE_URL = 'https://gitlab.example.com'
const GROUP_ID = 10

test('first call invokes listIterations once and populates cache', async () => {
  const iterations = [makeIteration('1', 'Sprint 1'), makeIteration('2', 'Sprint 2')]
  const client = makeClient(iterations)
  const cache = new IterationsCache()

  const result = await cache.list(client as never, BASE_URL, GROUP_ID)

  expect(client.listIterations).toHaveBeenCalledTimes(1)
  expect(client.listIterations).toHaveBeenCalledWith(GROUP_ID)
  expect(result).toHaveLength(2)
  expect(result.map((i) => i.id)).toEqual(['1', '2'])
})

test('second call within TTL is a cache hit — no second listIterations call', async () => {
  const iterations = [makeIteration('1', 'Sprint 1')]
  const client = makeClient(iterations)
  const cache = new IterationsCache()

  await cache.list(client as never, BASE_URL, GROUP_ID)
  const result = await cache.list(client as never, BASE_URL, GROUP_ID)

  expect(client.listIterations).toHaveBeenCalledTimes(1)
  expect(result).toHaveLength(1)
})

test('call after TTL expiry triggers a re-fetch', async () => {
  const iterations = [makeIteration('1', 'Sprint 1')]
  const client = makeClient(iterations)
  const cache = new IterationsCache(100) // 100ms TTL

  await cache.list(client as never, BASE_URL, GROUP_ID)

  await new Promise((resolve) => setTimeout(resolve, 150))

  await cache.list(client as never, BASE_URL, GROUP_ID)

  expect(client.listIterations).toHaveBeenCalledTimes(2)
})

test('getById returns the matching iteration', async () => {
  const iterations = [makeIteration('42', 'Sprint 42'), makeIteration('99', 'Sprint 99')]
  const client = makeClient(iterations)
  const cache = new IterationsCache()

  const result = await cache.getById(client as never, BASE_URL, GROUP_ID, '42')

  expect(result).toBeDefined()
  expect(result?.id).toBe('42')
  expect(result?.title).toBe('Sprint 42')
})

test('getById returns undefined for unknown id', async () => {
  const iterations = [makeIteration('1', 'Sprint 1')]
  const client = makeClient(iterations)
  const cache = new IterationsCache()

  const result = await cache.getById(client as never, BASE_URL, GROUP_ID, '999')

  expect(result).toBeUndefined()
})

test('invalidate with specific key clears only that entry', async () => {
  const iterA = [makeIteration('1', 'Sprint 1')]
  const iterB = [makeIteration('2', 'Sprint 2')]
  const clientA = makeClient(iterA)
  const clientB = makeClient(iterB)
  const cache = new IterationsCache()

  await cache.list(clientA as never, BASE_URL, 10)
  await cache.list(clientB as never, BASE_URL, 20)

  cache.invalidate(BASE_URL, 10)

  // Group 10 re-fetches after invalidation
  await cache.list(clientA as never, BASE_URL, 10)
  expect(clientA.listIterations).toHaveBeenCalledTimes(2)

  // Group 20 still cached — no extra call
  await cache.list(clientB as never, BASE_URL, 20)
  expect(clientB.listIterations).toHaveBeenCalledTimes(1)
})

test('invalidate with no args clears all entries', async () => {
  const iterA = [makeIteration('1', 'Sprint 1')]
  const iterB = [makeIteration('2', 'Sprint 2')]
  const clientA = makeClient(iterA)
  const clientB = makeClient(iterB)
  const cache = new IterationsCache()

  await cache.list(clientA as never, BASE_URL, 10)
  await cache.list(clientB as never, BASE_URL, 20)

  cache.invalidate()

  await cache.list(clientA as never, BASE_URL, 10)
  await cache.list(clientB as never, BASE_URL, 20)

  expect(clientA.listIterations).toHaveBeenCalledTimes(2)
  expect(clientB.listIterations).toHaveBeenCalledTimes(2)
})

test('multiple keys with different baseUrl and topGroupId are cached independently', async () => {
  const BASE_URL_2 = 'https://gitlab2.example.com'
  const iterA = [makeIteration('1', 'Sprint 1')]
  const iterB = [makeIteration('2', 'Sprint 2')]
  const iterC = [makeIteration('3', 'Sprint 3')]
  const clientA = makeClient(iterA)
  const clientB = makeClient(iterB)
  const clientC = makeClient(iterC)
  const cache = new IterationsCache()

  const resA = await cache.list(clientA as never, BASE_URL, 10)
  const resB = await cache.list(clientB as never, BASE_URL, 20)
  const resC = await cache.list(clientC as never, BASE_URL_2, 10)

  expect(resA[0].id).toBe('1')
  expect(resB[0].id).toBe('2')
  expect(resC[0].id).toBe('3')

  // All three were independent fetches
  expect(clientA.listIterations).toHaveBeenCalledTimes(1)
  expect(clientB.listIterations).toHaveBeenCalledTimes(1)
  expect(clientC.listIterations).toHaveBeenCalledTimes(1)

  // Second calls all hit cache
  await cache.list(clientA as never, BASE_URL, 10)
  await cache.list(clientB as never, BASE_URL, 20)
  await cache.list(clientC as never, BASE_URL_2, 10)

  expect(clientA.listIterations).toHaveBeenCalledTimes(1)
  expect(clientB.listIterations).toHaveBeenCalledTimes(1)
  expect(clientC.listIterations).toHaveBeenCalledTimes(1)
})
