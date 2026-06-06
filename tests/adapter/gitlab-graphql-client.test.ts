import nock from 'nock'
import {
  GitLabGraphQLClient,
  detectGraphQLCapability,
  invalidateGraphQLCapability,
  getGraphQLCapabilityCacheSize
} from '../../src/adapter/gitlab-graphql-client'

const BASE_URL = 'http://gitlab.test'

afterEach(() => {
  nock.cleanAll()
  invalidateGraphQLCapability()
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
// 3. detectGraphQLCapability: success → graphqlAvailable=true
// ---------------------------------------------------------------------------
test('detectGraphQLCapability: probe succeeds → graphqlAvailable=true', async () => {
  nock(BASE_URL)
    .post('/api/graphql')
    .reply(200, { data: { currentUser: { id: 'gid://gitlab/User/1' } } })

  const caps = await detectGraphQLCapability(BASE_URL, 'test-token')
  expect(caps.graphqlAvailable).toBe(true)
  expect(caps.schemaVersion).toBeNull()
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
