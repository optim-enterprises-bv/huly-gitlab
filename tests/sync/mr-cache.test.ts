import { MRCache, type MRGitLabClient } from '../../src/sync/mr-cache'
import type { SyncMergeRequest } from '../../src/adapter/types'

function makeMR (iid: number, title: string = `MR ${iid}`): SyncMergeRequest {
  const author = { id: 1, username: 'user', name: 'User', email: null, avatarUrl: null, webUrl: '' }
  return {
    iid,
    projectId: 42,
    title,
    description: '',
    state: 'opened',
    draft: false,
    sourceBranch: 'feature',
    targetBranch: 'main',
    mergeStatus: 'can_be_merged',
    mergedAt: null,
    pipelineStatus: null,
    labels: [],
    milestone: null,
    assignees: [],
    reviewers: [],
    author,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    webUrl: `https://gitlab.example.com/mr/${iid}`,
    confidential: false
  }
}

function makeFakeClient (initial: SyncMergeRequest[] = []): MRGitLabClient & { listCalls: number } {
  let listCalls = 0
  return {
    get listCalls (): number { return listCalls },
    listMergeRequests: async (): Promise<SyncMergeRequest[]> => {
      listCalls++
      return [...initial]
    }
  } as unknown as MRGitLabClient & { listCalls: number }
}

const PID = 42

test('getMR: first call primes cache from listMergeRequests', async () => {
  const cache = new MRCache(PID)
  const client = makeFakeClient([makeMR(1), makeMR(2)])

  const mr = await cache.getMR(client, 1)

  expect(mr?.iid).toBe(1)
  expect(client.listCalls).toBe(1)
})

test('getMR: subsequent calls hit cache without re-calling listMergeRequests', async () => {
  const cache = new MRCache(PID)
  const client = makeFakeClient([makeMR(3)])

  await cache.getMR(client, 3)
  await cache.getMR(client, 3)
  await cache.getMR(client, 3)

  expect(client.listCalls).toBe(1)
})

test('invalidate(iid): removes specific entry; next getMR re-primes', async () => {
  const cache = new MRCache(PID)
  const client = makeFakeClient([makeMR(5)])

  await cache.getMR(client, 5)
  expect(client.listCalls).toBe(1)

  cache.invalidate(5)

  // After partial invalidation, primed flag is still true, so no re-prime
  const result = await cache.getMR(client, 5)
  expect(result).toBeUndefined()
  expect(client.listCalls).toBe(1)
})

test('invalidate(): clears entire cache and causes re-prime on next getMR', async () => {
  const cache = new MRCache(PID)
  const client = makeFakeClient([makeMR(7), makeMR(8)])

  await cache.getMR(client, 7)
  expect(client.listCalls).toBe(1)

  cache.invalidate()

  const mr = await cache.getMR(client, 8)
  expect(mr?.iid).toBe(8)
  expect(client.listCalls).toBe(2)
})

test('primeSync: seeds cache without calling listMergeRequests', async () => {
  const cache = new MRCache(PID)
  const client = makeFakeClient([makeMR(10)])

  cache.primeSync([makeMR(10), makeMR(11)])

  const mr = await cache.getMR(client, 11)
  expect(mr?.iid).toBe(11)
  expect(client.listCalls).toBe(0)
})
