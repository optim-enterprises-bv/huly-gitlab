import nock from 'nock'
import {
  GitLabGraphQLClient,
  detectGraphQLCapability,
  invalidateGraphQLCapability,
  getGraphQLCapabilityCacheSize,
  CAPABILITY_POSITIVE_TTL_MS,
  CAPABILITY_NEGATIVE_TTL_MS
} from '../../src/adapter/gitlab-graphql-client'
import { get as getMetric, reset as resetMetrics, METRIC_NAMES } from '../../src/metrics'

const BASE_URL = 'http://gitlab.test'

afterEach(() => {
  nock.cleanAll()
  invalidateGraphQLCapability()
  resetMetrics()
})

// ---------------------------------------------------------------------------
// 1. Constructor: valid baseUrl accepted; malformed rejected via SSRF allowlist
// ---------------------------------------------------------------------------
test('GitLabGraphQLClient: constructor accepts valid baseUrl', () => {
  const client = new GitLabGraphQLClient({ baseUrl: BASE_URL, token: 'test-token' })
  expect(client.baseUrl).toBe(BASE_URL)
})

test('GitLabGraphQLClient: constructor rejects malformed baseUrl', () => {
  expect(() => new GitLabGraphQLClient({ baseUrl: 'not-a-url', token: 'x' })).toThrow()
  expect(() => new GitLabGraphQLClient({ baseUrl: 'ftp://gitlab.test', token: 'x' })).toThrow()
})

// ---------------------------------------------------------------------------
// 2. query: POSTs to /api/graphql with Bearer auth and returns the data field
// ---------------------------------------------------------------------------
test('GitLabGraphQLClient.query: POSTs to /api/graphql with bearer header', async () => {
  const scope = nock(BASE_URL, {
    reqheaders: { authorization: 'Bearer test-token' }
  })
    .post('/api/graphql')
    .reply(200, { data: { currentUser: { id: 'gid://gitlab/User/1' } } })

  const client = new GitLabGraphQLClient({ baseUrl: BASE_URL, token: 'test-token' })
  const result = await client.query<{ currentUser: { id: string } }>('{ currentUser { id } }')
  expect(result.currentUser.id).toBe('gid://gitlab/User/1')
  expect(scope.isDone()).toBe(true)
})

// ---------------------------------------------------------------------------
// 3. detectGraphQLCapability: success → graphqlAvailable=true, 1h TTL
// ---------------------------------------------------------------------------
test('detectGraphQLCapability: probe succeeds → graphqlAvailable=true with 1h TTL', async () => {
  let nowMs = 1_000_000
  const nowFn = (): number => nowMs

  nock(BASE_URL)
    .post('/api/graphql')
    .reply(200, { data: { currentUser: { id: 'gid://gitlab/User/1' } } })

  const caps = await detectGraphQLCapability(BASE_URL, 'test-token', nowFn)
  expect(caps.graphqlAvailable).toBe(true)
  expect(caps.schemaVersion).toBeNull()

  // Still cached at TTL boundary minus 1ms
  nowMs += CAPABILITY_POSITIVE_TTL_MS - 1
  const second = await detectGraphQLCapability(BASE_URL, 'test-token', nowFn)
  expect(second.graphqlAvailable).toBe(true)
  expect(nock.pendingMocks()).toHaveLength(0)
})

// ---------------------------------------------------------------------------
// 4. detectGraphQLCapability: failure → graphqlAvailable=false
// ---------------------------------------------------------------------------
test('detectGraphQLCapability: probe fails → graphqlAvailable=false', async () => {
  nock(BASE_URL)
    .post('/api/graphql')
    .reply(404, { errors: [{ message: 'Not found' }] })

  const caps = await detectGraphQLCapability(BASE_URL, 'test-token')
  expect(caps.graphqlAvailable).toBe(false)
  expect(caps.schemaVersion).toBeNull()
})

// ---------------------------------------------------------------------------
// 5. Cache hit within TTL: second call does NOT re-probe
// ---------------------------------------------------------------------------
test('detectGraphQLCapability: second call within TTL hits cache (no re-probe)', async () => {
  let nowMs = 1_000_000
  const nowFn = (): number => nowMs

  nock(BASE_URL)
    .post('/api/graphql')
    .reply(200, { data: { currentUser: { id: 'gid://gitlab/User/1' } } })

  const first = await detectGraphQLCapability(BASE_URL, 'test-token', nowFn)
  expect(first.graphqlAvailable).toBe(true)

  // Advance time slightly (still within TTL). If we hit the network again,
  // nock would throw NetConnectNotAllowed because no interceptor remains.
  nowMs += 10_000
  const second = await detectGraphQLCapability(BASE_URL, 'test-token', nowFn)
  expect(second.graphqlAvailable).toBe(true)
  expect(nock.pendingMocks()).toHaveLength(0)
})

// ---------------------------------------------------------------------------
// 6. invalidateGraphQLCapability(baseUrl): single-entry bust forces re-probe
// ---------------------------------------------------------------------------
test('invalidateGraphQLCapability(baseUrl): removes that entry; next call re-probes', async () => {
  nock(BASE_URL)
    .post('/api/graphql')
    .reply(200, { data: { currentUser: { id: 'gid://gitlab/User/1' } } })

  const first = await detectGraphQLCapability(BASE_URL, 'test-token')
  expect(first.graphqlAvailable).toBe(true)
  expect(getGraphQLCapabilityCacheSize()).toBe(1)

  invalidateGraphQLCapability(BASE_URL)
  expect(getGraphQLCapabilityCacheSize()).toBe(0)

  // Subsequent call MUST re-probe → wire a new interceptor returning false.
  nock(BASE_URL)
    .post('/api/graphql')
    .reply(500, { errors: [{ message: 'down' }] })

  const second = await detectGraphQLCapability(BASE_URL, 'test-token')
  expect(second.graphqlAvailable).toBe(false)
})

// ---------------------------------------------------------------------------
// 7. invalidateGraphQLCapability(): clears all entries
// ---------------------------------------------------------------------------
test('invalidateGraphQLCapability(): undefined baseUrl clears all entries', async () => {
  const OTHER_URL = 'http://gitlab.oauth.test'

  nock(BASE_URL)
    .post('/api/graphql')
    .reply(200, { data: { currentUser: { id: 'gid://gitlab/User/1' } } })
  nock(OTHER_URL)
    .post('/api/graphql')
    .reply(200, { data: { currentUser: { id: 'gid://gitlab/User/2' } } })

  await detectGraphQLCapability(BASE_URL, 'token-a')
  await detectGraphQLCapability(OTHER_URL, 'token-b')
  expect(getGraphQLCapabilityCacheSize()).toBe(2)

  invalidateGraphQLCapability()
  expect(getGraphQLCapabilityCacheSize()).toBe(0)
})

// ---------------------------------------------------------------------------
// 8. 502 → short (5min) TTL; re-probes after TTL expires
// ---------------------------------------------------------------------------
test('detectGraphQLCapability: 502 → 5min negative TTL; re-probes after TTL', async () => {
  let nowMs = 1_000_000
  const nowFn = (): number => nowMs

  nock(BASE_URL)
    .post('/api/graphql')
    .reply(502, 'Bad Gateway')

  const first = await detectGraphQLCapability(BASE_URL, 'test-token', nowFn)
  expect(first.graphqlAvailable).toBe(false)
  expect(getGraphQLCapabilityCacheSize()).toBe(1)

  // Within 5min TTL → cache hit, no re-probe
  nowMs += CAPABILITY_NEGATIVE_TTL_MS - 1
  const second = await detectGraphQLCapability(BASE_URL, 'test-token', nowFn)
  expect(second.graphqlAvailable).toBe(false)
  expect(nock.pendingMocks()).toHaveLength(0)

  // After 5min TTL → re-probes
  nowMs += 2
  nock(BASE_URL)
    .post('/api/graphql')
    .reply(200, { data: { currentUser: { id: 'gid://gitlab/User/1' } } })

  const third = await detectGraphQLCapability(BASE_URL, 'test-token', nowFn)
  expect(third.graphqlAvailable).toBe(true)
})

// ---------------------------------------------------------------------------
// 9. 401 → no cache entry; second probe re-probes immediately
// ---------------------------------------------------------------------------
test('detectGraphQLCapability: 401 → no cache entry; second call re-probes', async () => {
  let probeCount = 0

  nock(BASE_URL)
    .post('/api/graphql')
    .twice()
    .reply(() => {
      probeCount++
      return [401, { errors: [{ message: 'Unauthorized' }] }]
    })

  const first = await detectGraphQLCapability(BASE_URL, 'bad-token')
  expect(first.graphqlAvailable).toBe(false)
  expect(getGraphQLCapabilityCacheSize()).toBe(0)

  const second = await detectGraphQLCapability(BASE_URL, 'bad-token')
  expect(second.graphqlAvailable).toBe(false)
  expect(probeCount).toBe(2)
})

// ---------------------------------------------------------------------------
// 10. 403 → no cache entry; second probe re-probes immediately
// ---------------------------------------------------------------------------
test('detectGraphQLCapability: 403 → no cache entry; second call re-probes', async () => {
  nock(BASE_URL)
    .post('/api/graphql')
    .twice()
    .reply(403, { errors: [{ message: 'Forbidden' }] })

  await detectGraphQLCapability(BASE_URL, 'limited-token')
  expect(getGraphQLCapabilityCacheSize()).toBe(0)

  await detectGraphQLCapability(BASE_URL, 'limited-token')
  expect(getGraphQLCapabilityCacheSize()).toBe(0)
})

// ---------------------------------------------------------------------------
// 11. 404 → 1h negative TTL
// ---------------------------------------------------------------------------
test('detectGraphQLCapability: 404 → 1h negative TTL', async () => {
  let nowMs = 1_000_000
  const nowFn = (): number => nowMs

  nock(BASE_URL)
    .post('/api/graphql')
    .reply(404, { errors: [{ message: 'Not Found' }] })

  const first = await detectGraphQLCapability(BASE_URL, 'test-token', nowFn)
  expect(first.graphqlAvailable).toBe(false)
  expect(getGraphQLCapabilityCacheSize()).toBe(1)

  // After 5min — still cached (1h TTL for 4xx)
  nowMs += CAPABILITY_NEGATIVE_TTL_MS + 1
  const second = await detectGraphQLCapability(BASE_URL, 'test-token', nowFn)
  expect(second.graphqlAvailable).toBe(false)
  expect(nock.pendingMocks()).toHaveLength(0)

  // After 1h — cache expired, re-probes
  nowMs = 1_000_000 + CAPABILITY_POSITIVE_TTL_MS + 1
  nock(BASE_URL)
    .post('/api/graphql')
    .reply(200, { data: { currentUser: { id: 'gid://gitlab/User/1' } } })

  const third = await detectGraphQLCapability(BASE_URL, 'test-token', nowFn)
  expect(third.graphqlAvailable).toBe(true)
})

// ---------------------------------------------------------------------------
// 12. 200 with malformed body → 1h negative TTL
// ---------------------------------------------------------------------------
test('detectGraphQLCapability: 200 with malformed body → 1h negative TTL', async () => {
  let nowMs = 1_000_000
  const nowFn = (): number => nowMs

  // graphql-request throws on responses with `errors` field even on 200
  nock(BASE_URL)
    .post('/api/graphql')
    .reply(200, { errors: [{ message: 'something went wrong' }] })

  const first = await detectGraphQLCapability(BASE_URL, 'test-token', nowFn)
  expect(first.graphqlAvailable).toBe(false)
  expect(getGraphQLCapabilityCacheSize()).toBe(1)

  // After 5min — still cached (1h TTL since no status code → treated as permanent)
  nowMs += CAPABILITY_NEGATIVE_TTL_MS + 1
  const second = await detectGraphQLCapability(BASE_URL, 'test-token', nowFn)
  expect(second.graphqlAvailable).toBe(false)
  expect(nock.pendingMocks()).toHaveLength(0)
})

// ---------------------------------------------------------------------------
// 13. Negative cache hit increments GRAPHQL_CAPABILITY_NEGATIVE_CACHE_HIT metric
// ---------------------------------------------------------------------------
test('detectGraphQLCapability: negative cache hit increments metric', async () => {
  let nowMs = 1_000_000
  const nowFn = (): number => nowMs

  nock(BASE_URL)
    .post('/api/graphql')
    .reply(502, 'Bad Gateway')

  await detectGraphQLCapability(BASE_URL, 'test-token', nowFn)
  expect(getMetric(METRIC_NAMES.GRAPHQL_CAPABILITY_NEGATIVE_CACHE_HIT)).toBe(0)

  // Second call hits negative cache
  nowMs += 1_000
  await detectGraphQLCapability(BASE_URL, 'test-token', nowFn)
  expect(getMetric(METRIC_NAMES.GRAPHQL_CAPABILITY_NEGATIVE_CACHE_HIT)).toBe(1)

  // Third call also hits negative cache
  nowMs += 1_000
  await detectGraphQLCapability(BASE_URL, 'test-token', nowFn)
  expect(getMetric(METRIC_NAMES.GRAPHQL_CAPABILITY_NEGATIVE_CACHE_HIT)).toBe(2)
})

// ---------------------------------------------------------------------------
// 14. Positive cache hit does NOT increment negative metric
// ---------------------------------------------------------------------------
test('detectGraphQLCapability: positive cache hit does not increment negative metric', async () => {
  let nowMs = 1_000_000
  const nowFn = (): number => nowMs

  nock(BASE_URL)
    .post('/api/graphql')
    .reply(200, { data: { currentUser: { id: 'gid://gitlab/User/1' } } })

  await detectGraphQLCapability(BASE_URL, 'test-token', nowFn)
  nowMs += 10_000
  await detectGraphQLCapability(BASE_URL, 'test-token', nowFn)

  expect(getMetric(METRIC_NAMES.GRAPHQL_CAPABILITY_NEGATIVE_CACHE_HIT)).toBe(0)
})
