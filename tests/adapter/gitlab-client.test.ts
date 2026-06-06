import nock from 'nock'
import { GitLabClient, getMrCompositePartialCount, resetMrCompositePartialCount } from '../../src/adapter/gitlab-client'
import { detectCapabilities, clearCapabilityCache } from '../../src/adapter/capabilities'
import { registerProjectWebhook } from '../../src/adapter/webhooks'
import { ApprovalActionError, GitLabApiError, RateLimitError, ConfidentialIssueError, ConfidentialMergeRequestError } from '../../src/adapter/errors'
import type { Logger } from '../../src/logging'

const BASE_URL = 'http://gitlab.test'

interface LogCall { msg: string, ctx: Record<string, unknown> | undefined }

function makeLogger (): Logger & {
  infoCalls: LogCall[]
  warnCalls: LogCall[]
} {
  const infoCalls: LogCall[] = []
  const warnCalls: LogCall[] = []
  return {
    infoCalls,
    warnCalls,
    debug: () => {},
    info: (msg, ctx) => { infoCalls.push({ msg, ctx }) },
    warn: (msg, ctx) => { warnCalls.push({ msg, ctx }) },
    error: () => {}
  }
}

function makeClient (logger?: Logger): GitLabClient {
  return new GitLabClient({
    baseUrl: BASE_URL,
    token: 'test-token',
    logger: logger ?? makeLogger()
  })
}

afterEach(() => {
  nock.cleanAll()
  clearCapabilityCache()
})

// ---------------------------------------------------------------------------
// 1. listProjects happy path with pagination (X-Next-Page drives second fetch)
// ---------------------------------------------------------------------------
test('listProjects: happy path with pagination', async () => {
  const page1 = [
    {
      id: 1, name: 'proj-a', name_with_namespace: 'ns/proj-a', path: 'proj-a',
      path_with_namespace: 'ns/proj-a', description: null, web_url: 'http://gitlab.test/ns/proj-a',
      visibility: 'private', default_branch: 'main', created_at: '2024-01-01T00:00:00Z',
      last_activity_at: '2024-01-02T00:00:00Z'
    }
  ]
  const page2 = [
    {
      id: 2, name: 'proj-b', name_with_namespace: 'ns/proj-b', path: 'proj-b',
      path_with_namespace: 'ns/proj-b', description: null, web_url: 'http://gitlab.test/ns/proj-b',
      visibility: 'private', default_branch: 'main', created_at: '2024-01-01T00:00:00Z',
      last_activity_at: '2024-01-02T00:00:00Z'
    }
  ]

  nock(BASE_URL)
    .get('/api/v4/projects')
    .query({ page: '1', per_page: '20', membership: 'true' })
    .reply(200, page1, { 'x-next-page': '2' })

  nock(BASE_URL)
    .get('/api/v4/projects')
    .query({ page: '2', per_page: '20', membership: 'true' })
    .reply(200, page2, { 'x-next-page': '' })

  const client = makeClient()
  const result1 = await client.listProjects({ page: 1, perPage: 20 })
  expect(result1.items).toHaveLength(1)
  expect(result1.items[0].name).toBe('proj-a')
  expect(result1.nextPage).toBe(2)

  const result2 = await client.listProjects({ page: 2, perPage: 20 })
  expect(result2.items).toHaveLength(1)
  expect(result2.items[0].name).toBe('proj-b')
  expect(result2.nextPage).toBeNull()
})

// ---------------------------------------------------------------------------
// 2. getIssue happy path
// ---------------------------------------------------------------------------
test('getIssue: happy path returns SyncIssue', async () => {
  const rawIssue = {
    id: 100, iid: 5, project_id: 1, title: 'Test issue', description: 'desc',
    state: 'opened', labels: ['bug'], milestone: null, assignees: [],
    author: { id: 10, username: 'alice', name: 'Alice', email: 'alice@example.com', avatar_url: '', web_url: 'http://gitlab.test/alice' },
    confidential: false, created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-02T00:00:00Z',
    closed_at: null, web_url: 'http://gitlab.test/proj/issues/5'
  }

  nock(BASE_URL)
    .get('/api/v4/projects/1/issues/5')
    .reply(200, rawIssue)

  const client = makeClient()
  const issue = await client.getIssue(1, 5)
  expect(issue.iid).toBe(5)
  expect(issue.title).toBe('Test issue')
  expect(issue.confidential).toBe(false)
  expect(issue.labels).toEqual(['bug'])
})

// ---------------------------------------------------------------------------
// 3. listIssues with updatedAfter query param round-tripped
// ---------------------------------------------------------------------------
test('listIssues: updatedAfter query param is sent', async () => {
  nock(BASE_URL)
    .get('/api/v4/projects/1/issues')
    .query({ per_page: '100', confidential: 'false', updated_after: '2024-06-01T00:00:00Z' })
    .reply(200, [])

  const client = makeClient()
  const issues = await client.listIssues(1, { updatedAfter: '2024-06-01T00:00:00Z' })
  expect(issues).toEqual([])
})

// ---------------------------------------------------------------------------
// 4. listIssues skips confidential issues (query param asserted + metric logged)
// ---------------------------------------------------------------------------
test('listIssues: confidential=false query param sent and confidential rows filtered', async () => {
  const nonConfidential = {
    id: 1, iid: 1, project_id: 1, title: 'Public', description: null,
    state: 'opened', labels: [], milestone: null, assignees: [],
    author: { id: 10, username: 'alice', name: 'Alice', email: null, avatar_url: null, web_url: '' },
    confidential: false, created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z',
    closed_at: null, web_url: ''
  }
  // This should never appear in real GitLab responses given confidential=false,
  // but defense-in-depth ensures we filter it anyway
  const confidentialIssue = { ...nonConfidential, id: 2, iid: 2, title: 'Secret', confidential: true }

  nock(BASE_URL)
    .get('/api/v4/projects/1/issues')
    .query({ per_page: '100', confidential: 'false' })
    .reply(200, [nonConfidential, confidentialIssue])

  const logger = makeLogger()
  const client = makeClient(logger)
  const issues = await client.listIssues(1)

  expect(issues).toHaveLength(1)
  expect(issues[0].title).toBe('Public')
  // Metric emitted for the confidential issue
  expect(logger.infoCalls.some((c) => c.msg === 'gitlab.confidential.skipped')).toBe(true)
})

// ---------------------------------------------------------------------------
// 5. Rate-limit retry with Retry-After: 2 (integer seconds)
// ---------------------------------------------------------------------------
test('rate limit: retries on 429 with Retry-After integer seconds', async () => {
  const rawIssue = {
    id: 1, iid: 1, project_id: 1, title: 'Issue', description: null,
    state: 'opened', labels: [], milestone: null, assignees: [],
    author: { id: 10, username: 'alice', name: 'Alice', email: null, avatar_url: null, web_url: '' },
    confidential: false, created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z',
    closed_at: null, web_url: ''
  }

  nock(BASE_URL)
    .get('/api/v4/projects/1/issues/1')
    .reply(429, 'rate limited', { 'retry-after': '2' })
  nock(BASE_URL)
    .get('/api/v4/projects/1/issues/1')
    .reply(200, rawIssue)

  // Override setTimeout to avoid actual 2s wait
  const originalSetTimeout = global.setTimeout
  let delayUsed = 0
  jest.spyOn(global, 'setTimeout').mockImplementation((fn: (...args: unknown[]) => void, ms?: number) => {
    delayUsed = ms ?? 0
    fn()
    return {} as ReturnType<typeof setTimeout>
  })

  const client = makeClient()
  const issue = await client.getIssue(1, 1)
  expect(issue.iid).toBe(1)
  expect(delayUsed).toBeGreaterThanOrEqual(2000)

  jest.restoreAllMocks()
  void originalSetTimeout
})

// ---------------------------------------------------------------------------
// 6. Rate-limit retry with Retry-After: <HTTP-date>
// ---------------------------------------------------------------------------
test('rate limit: retries on 429 with Retry-After HTTP-date format', async () => {
  const rawIssue = {
    id: 1, iid: 1, project_id: 1, title: 'Issue', description: null,
    state: 'opened', labels: [], milestone: null, assignees: [],
    author: { id: 10, username: 'alice', name: 'Alice', email: null, avatar_url: null, web_url: '' },
    confidential: false, created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z',
    closed_at: null, web_url: ''
  }

  // Use a date well in the future so diff is positive
  const futureDate = new Date(Date.now() + 5000).toUTCString()

  nock(BASE_URL)
    .get('/api/v4/projects/1/issues/1')
    .reply(429, 'rate limited', { 'retry-after': futureDate })
  nock(BASE_URL)
    .get('/api/v4/projects/1/issues/1')
    .reply(200, rawIssue)

  jest.spyOn(global, 'setTimeout').mockImplementation((fn: (...args: unknown[]) => void) => {
    fn()
    return {} as ReturnType<typeof setTimeout>
  })

  const client = makeClient()
  const issue = await client.getIssue(1, 1)
  expect(issue.iid).toBe(1)

  jest.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// 7. 429 then 200 — eventually succeeds, retry count asserted
// ---------------------------------------------------------------------------
test('rate limit: 429 then 200 eventually succeeds', async () => {
  const rawUser = { id: 1, username: 'alice', name: 'Alice', email: 'alice@test.com', avatar_url: '', web_url: '' }

  nock(BASE_URL).get('/api/v4/user').reply(429, 'slow down', { 'retry-after': '1' })
  nock(BASE_URL).get('/api/v4/user').reply(429, 'slow down', { 'retry-after': '1' })
  nock(BASE_URL).get('/api/v4/user').reply(200, rawUser)

  let retryCount = 0
  jest.spyOn(global, 'setTimeout').mockImplementation((fn: (...args: unknown[]) => void) => {
    retryCount++
    fn()
    return {} as ReturnType<typeof setTimeout>
  })

  const client = makeClient()
  const user = await client.getCurrentUser()
  expect(user.username).toBe('alice')
  expect(retryCount).toBe(2)

  jest.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// 8. 5x 429 in a row — throws RateLimitError
// ---------------------------------------------------------------------------
test('rate limit: 5 consecutive 429s throws RateLimitError', async () => {
  for (let i = 0; i <= 5; i++) {
    nock(BASE_URL).get('/api/v4/user').reply(429, 'rate limited', { 'retry-after': '1' })
  }

  jest.spyOn(global, 'setTimeout').mockImplementation((fn: (...args: unknown[]) => void) => {
    fn()
    return {} as ReturnType<typeof setTimeout>
  })

  const client = makeClient()
  await expect(client.getCurrentUser()).rejects.toThrow(RateLimitError)

  jest.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// 9. Capability detection: CE response → edition='ce', graphqlAvailable=true
// ---------------------------------------------------------------------------
test('detectCapabilities: CE instance → edition=ce, graphqlAvailable=true', async () => {
  nock(BASE_URL)
    .get('/api/v4/version')
    .reply(200, { version: '16.11.0', revision: 'abc123' })

  nock(BASE_URL)
    .post('/api/graphql')
    .reply(200, { data: { __schema: { queryType: { name: 'Query' } } } })

  const client = makeClient()
  const caps = await detectCapabilities(client)
  expect(caps.edition).toBe('ce')
  expect(caps.gitlabVersion).toBe('16.11.0')
  expect(caps.graphqlAvailable).toBe(true)
  expect(caps.featureFlags['graphql.issue.notes']).toBe(true)
  expect(caps.featureFlags['graphql.issue.batchedNotes']).toBe(true)
})

// ---------------------------------------------------------------------------
// 10. Capability detection: EE response (revision ends with -ee) → edition='ee'
// ---------------------------------------------------------------------------
test('detectCapabilities: EE instance → edition=ee', async () => {
  nock(BASE_URL)
    .get('/api/v4/version')
    .reply(200, { version: '16.11.0', revision: 'abc123-ee' })

  nock(BASE_URL)
    .post('/api/graphql')
    .reply(200, { data: { __schema: { queryType: { name: 'Query' } } } })

  const client = makeClient()
  const caps = await detectCapabilities(client)
  expect(caps.edition).toBe('ee')
})

// ---------------------------------------------------------------------------
// 11. Capability detection: GraphQL ping fails → graphqlAvailable=false
// ---------------------------------------------------------------------------
test('detectCapabilities: GraphQL ping fails → graphqlAvailable=false', async () => {
  nock(BASE_URL)
    .get('/api/v4/version')
    .reply(200, { version: '16.11.0', revision: 'abc123' })

  nock(BASE_URL)
    .post('/api/graphql')
    .reply(403, { errors: [{ message: 'Forbidden' }] })

  const client = makeClient()
  const caps = await detectCapabilities(client)
  expect(caps.graphqlAvailable).toBe(false)
  expect(caps.featureFlags['graphql.issue.notes']).toBe(false)
  expect(caps.featureFlags['graphql.issue.batchedNotes']).toBe(false)
})

// ---------------------------------------------------------------------------
// 12. Capability cache TTL: second call within 1h does NOT hit network;
//     after 1h does re-fetch
// ---------------------------------------------------------------------------
test('detectCapabilities: cache hit within TTL, miss after TTL', async () => {
  let nowMs = Date.now()
  const nowFn = (): number => nowMs

  nock(BASE_URL)
    .get('/api/v4/version')
    .reply(200, { version: '16.0.0', revision: 'abc' })
  nock(BASE_URL)
    .post('/api/graphql')
    .reply(200, { data: { __schema: { queryType: { name: 'Query' } } } })

  const client = makeClient()
  const caps1 = await detectCapabilities(client, nowFn)
  expect(caps1.gitlabVersion).toBe('16.0.0')

  // Second call within TTL — nock would throw if a second /version request was made
  const caps2 = await detectCapabilities(client, nowFn)
  expect(caps2.gitlabVersion).toBe('16.0.0')

  // Advance time past TTL
  nowMs += 60 * 60 * 1000 + 1

  nock(BASE_URL)
    .get('/api/v4/version')
    .reply(200, { version: '16.1.0', revision: 'def' })
  nock(BASE_URL)
    .post('/api/graphql')
    .reply(200, { data: { __schema: { queryType: { name: 'Query' } } } })

  const caps3 = await detectCapabilities(client, nowFn)
  expect(caps3.gitlabVersion).toBe('16.1.0')
})

// ---------------------------------------------------------------------------
// 13. webhooks.registerProjectWebhook POSTs with correct event flags AND
//     excludes confidential_*_events
// ---------------------------------------------------------------------------
test('registerProjectWebhook: posts correct flags, excludes confidential events', async () => {
  let capturedBody: Record<string, unknown> = {}

  nock(BASE_URL)
    .post('/api/v4/projects/42/hooks', (body) => {
      capturedBody = body as Record<string, unknown>
      return true
    })
    .reply(201, {
      id: 99, url: 'https://example.com/webhook', created_at: '2024-01-01T00:00:00Z',
      issues_events: true, note_events: true, push_events: false,
      tag_push_events: false, merge_requests_events: false
    })

  const client = makeClient()
  const hook = await registerProjectWebhook(client, 42, {
    url: 'https://example.com/webhook',
    token: 'secret-abc',
    eventFlags: {
      issues_events: true,
      note_events: true
    }
  })

  expect(hook.id).toBe(99)
  expect(hook.issuesEvents).toBe(true)
  expect(hook.noteEvents).toBe(true)

  // Q5: confidential event flags must be absent or false
  expect(capturedBody.confidential_issues_events).toBe(false)
  expect(capturedBody.confidential_note_events).toBe(false)
  expect(capturedBody.issues_events).toBe(true)
  expect(capturedBody.note_events).toBe(true)
})

// ---------------------------------------------------------------------------
// 14. getIssue on confidential issue throws ConfidentialIssueError
// ---------------------------------------------------------------------------
test('getIssue: confidential issue throws ConfidentialIssueError', async () => {
  const confidentialIssue = {
    id: 99, iid: 7, project_id: 1, title: 'Secret', description: 'top secret',
    state: 'opened', labels: [], milestone: null, assignees: [],
    author: { id: 10, username: 'alice', name: 'Alice', email: null, avatar_url: null, web_url: '' },
    confidential: true, created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z',
    closed_at: null, web_url: ''
  }

  // Register two interceptors: one per rejects assertion
  nock(BASE_URL).get('/api/v4/projects/1/issues/7').reply(200, confidentialIssue)
  nock(BASE_URL).get('/api/v4/projects/1/issues/7').reply(200, confidentialIssue)

  const client = makeClient()
  await expect(client.getIssue(1, 7)).rejects.toThrow(ConfidentialIssueError)
  await expect(client.getIssue(1, 7)).rejects.toThrow('confidential')
})

// ---------------------------------------------------------------------------
// Helpers for MR / Pipeline tests
// ---------------------------------------------------------------------------

function makeMR (overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iid: 10, project_id: 1, title: 'My MR', description: 'desc',
    state: 'opened', draft: false,
    source_branch: 'feature', target_branch: 'main',
    merge_status: 'can_be_merged', merged_at: null,
    head_pipeline: null, labels: [], milestone: null,
    assignees: [], reviewers: [],
    author: { id: 10, username: 'alice', name: 'Alice', email: 'alice@example.com', avatar_url: '', web_url: '' },
    created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-02T00:00:00Z',
    web_url: 'http://gitlab.test/ns/proj/-/merge_requests/10',
    confidential: false,
    ...overrides
  }
}

function makeNote (overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1, body: 'A comment',
    author: { id: 10, username: 'alice', name: 'Alice', email: 'alice@example.com', avatar_url: '', web_url: '' },
    created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-02T00:00:00Z',
    system: false, confidential: false,
    ...overrides
  }
}

// ---------------------------------------------------------------------------
// 15. listMergeRequests: happy path with pagination (X-Next-Page)
// ---------------------------------------------------------------------------
test('listMergeRequests: happy path with pagination', async () => {
  nock(BASE_URL)
    .get('/api/v4/projects/1/merge_requests')
    .query({ per_page: '100', confidential: 'false', page: '1' })
    .reply(200, [makeMR({ iid: 10 })], { 'x-next-page': '2' })

  nock(BASE_URL)
    .get('/api/v4/projects/1/merge_requests')
    .query({ per_page: '100', confidential: 'false', page: '2' })
    .reply(200, [makeMR({ iid: 11 })], { 'x-next-page': '' })

  const client = makeClient()
  const mrs = await client.listMergeRequests(1)
  expect(mrs).toHaveLength(2)
  expect(mrs[0].iid).toBe(10)
  expect(mrs[1].iid).toBe(11)
})

// ---------------------------------------------------------------------------
// 16. listMergeRequests: confidential=false query param asserted
// ---------------------------------------------------------------------------
test('listMergeRequests: sends confidential=false query param', async () => {
  nock(BASE_URL)
    .get('/api/v4/projects/1/merge_requests')
    .query((q) => q.confidential === 'false')
    .reply(200, [], { 'x-next-page': '' })

  const client = makeClient()
  const mrs = await client.listMergeRequests(1)
  expect(mrs).toEqual([])
})

// ---------------------------------------------------------------------------
// 17. getMergeRequest: happy path returns SyncMergeRequest
// ---------------------------------------------------------------------------
test('getMergeRequest: happy path returns SyncMergeRequest', async () => {
  nock(BASE_URL)
    .get('/api/v4/projects/1/merge_requests/10')
    .reply(200, makeMR({ iid: 10, title: 'Feature MR' }))

  const client = makeClient()
  const mr = await client.getMergeRequest(1, 10)
  expect(mr.iid).toBe(10)
  expect(mr.title).toBe('Feature MR')
  expect(mr.sourceBranch).toBe('feature')
  expect(mr.mergeStatus).toBe('can_be_merged')
})

// ---------------------------------------------------------------------------
// 18. getMergeRequest: confidential=true throws ConfidentialMergeRequestError
// ---------------------------------------------------------------------------
test('getMergeRequest: confidential MR throws ConfidentialMergeRequestError', async () => {
  nock(BASE_URL)
    .get('/api/v4/projects/1/merge_requests/7')
    .reply(200, makeMR({ iid: 7, confidential: true }))
  nock(BASE_URL)
    .get('/api/v4/projects/1/merge_requests/7')
    .reply(200, makeMR({ iid: 7, confidential: true }))

  const client = makeClient()
  await expect(client.getMergeRequest(1, 7)).rejects.toThrow(ConfidentialMergeRequestError)
  await expect(client.getMergeRequest(1, 7)).rejects.toThrow('!7')
})

// ---------------------------------------------------------------------------
// 19. updateMergeRequest: PUT body shape with state_event='close'
// ---------------------------------------------------------------------------
test('updateMergeRequest: PUT body shape correct for state_event close', async () => {
  let capturedBody: Record<string, unknown> = {}

  nock(BASE_URL)
    .put('/api/v4/projects/1/merge_requests/10', (body) => {
      capturedBody = body as Record<string, unknown>
      return true
    })
    .reply(200, makeMR({ iid: 10, state: 'closed' }))

  const client = makeClient()
  const mr = await client.updateMergeRequest(1, 10, { state_event: 'close', title: 'Updated' })
  expect(capturedBody.state_event).toBe('close')
  expect(capturedBody.title).toBe('Updated')
  expect(mr.state).toBe('closed')
})

// ---------------------------------------------------------------------------
// 20. updateMergeRequest: 'locked' state round-trip (critic B2)
// ---------------------------------------------------------------------------
test('updateMergeRequest: locked state round-trip maps correctly', async () => {
  nock(BASE_URL)
    .put('/api/v4/projects/1/merge_requests/10')
    .reply(200, makeMR({ iid: 10, state: 'locked', merge_status: 'locked' }))

  const client = makeClient()
  const mr = await client.updateMergeRequest(1, 10, { title: 'Locked MR' })
  expect(mr.state).toBe('locked')
  expect(mr.mergeStatus).toBe('locked')
})

// ---------------------------------------------------------------------------
// 21. createMergeRequest: POST body shape correct
// ---------------------------------------------------------------------------
test('createMergeRequest: POST body shape correct', async () => {
  let capturedBody: Record<string, unknown> = {}

  nock(BASE_URL)
    .post('/api/v4/projects/1/merge_requests', (body) => {
      capturedBody = body as Record<string, unknown>
      return true
    })
    .reply(201, makeMR({ iid: 20, title: 'New MR' }))

  const client = makeClient()
  const mr = await client.createMergeRequest(1, {
    title: 'New MR',
    source_branch: 'feature',
    target_branch: 'main'
  })
  expect(capturedBody.title).toBe('New MR')
  expect(capturedBody.source_branch).toBe('feature')
  expect(capturedBody.target_branch).toBe('main')
  expect(mr.iid).toBe(20)
})

// ---------------------------------------------------------------------------
// 22. listMRNotes: paginated + sets noteableType='MergeRequest' on each
// ---------------------------------------------------------------------------
test('listMRNotes: paginated and sets noteableType=MergeRequest', async () => {
  nock(BASE_URL)
    .get('/api/v4/projects/1/merge_requests/10/notes')
    .query({ per_page: '100', page: '1' })
    .reply(200, [makeNote({ id: 1 })], { 'x-next-page': '2' })

  nock(BASE_URL)
    .get('/api/v4/projects/1/merge_requests/10/notes')
    .query({ per_page: '100', page: '2' })
    .reply(200, [makeNote({ id: 2 })], { 'x-next-page': '' })

  const client = makeClient()
  const notes = await client.listMRNotes(1, 10)
  expect(notes).toHaveLength(2)
  expect(notes[0].noteableType).toBe('MergeRequest')
  expect(notes[1].noteableType).toBe('MergeRequest')
  expect(notes[0].id).toBe(1)
  expect(notes[1].id).toBe(2)
})

// ---------------------------------------------------------------------------
// 23. createMRNote: body shape is {body: string} not bare string
// ---------------------------------------------------------------------------
test('createMRNote: body shape is {body: string}', async () => {
  let capturedBody: Record<string, unknown> = {}

  nock(BASE_URL)
    .post('/api/v4/projects/1/merge_requests/10/notes', (body) => {
      capturedBody = body as Record<string, unknown>
      return true
    })
    .reply(201, makeNote({ id: 5, body: 'Hello' }))

  const client = makeClient()
  const note = await client.createMRNote(1, 10, { body: 'Hello' })
  expect(capturedBody.body).toBe('Hello')
  expect(typeof capturedBody.body).toBe('string')
  expect(note.body).toBe('Hello')
  expect(note.noteableType).toBe('MergeRequest')
})

// ---------------------------------------------------------------------------
// 24. getPipeline: status mapping matrix (≥5 statuses)
// ---------------------------------------------------------------------------
test.each([
  ['success', 'success'],
  ['failed', 'failed'],
  ['canceled', 'canceled'],
  ['pending', 'pending'],
  ['running', 'running'],
  ['skipped', null],
  ['manual', null],
  ['scheduled', null]
] as const)('getPipeline: maps status %s -> %s', async (rawStatus, expected) => {
  nock(BASE_URL)
    .get('/api/v4/projects/1/pipelines/99')
    .reply(200, {
      id: 99,
      project_id: 1,
      status: rawStatus,
      updated_at: '2024-01-01T00:00:00Z',
      web_url: 'http://gitlab.test/ns/proj/-/pipelines/99',
      merge_request: null
    })

  const client = makeClient()
  const pipeline = await client.getPipeline(1, 99)
  expect(pipeline.status).toBe(expected)
  expect(pipeline.rawStatus).toBe(rawStatus)
  expect(pipeline.mergeRequestIid).toBeNull()
})

// ===========================================================================
// Phase 3 — P3-T-03: Review / Approval / Diff REST methods
// ===========================================================================

function makeDiscussionNote (overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1, body: 'Review comment',
    author: { id: 10, username: 'alice', name: 'Alice', email: 'a@b.c', avatar_url: '', web_url: '' },
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-02T00:00:00Z',
    system: false,
    resolvable: true,
    resolved: false,
    resolved_by: null,
    resolved_at: null,
    position: null,
    ...overrides
  }
}

function makeDiscussion (overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'disc-abc',
    individual_note: false,
    notes: [makeDiscussionNote()],
    ...overrides
  }
}

const textPosition = {
  base_sha: 'base', start_sha: 'start', head_sha: 'head',
  position_type: 'text',
  new_path: 'src/foo.ts', old_path: 'src/foo.ts',
  new_line: 42, old_line: null
}

// ---------------------------------------------------------------------------
// P3-T-03 / 1. listDiscussions: happy path with pagination
// ---------------------------------------------------------------------------
test('listDiscussions: happy path with pagination', async () => {
  nock(BASE_URL)
    .get('/api/v4/projects/1/merge_requests/10/discussions')
    .query({ per_page: '100', page: '1' })
    .reply(200, [makeDiscussion({ id: 'd1', notes: [makeDiscussionNote({ id: 1, position: textPosition })] })], { 'x-next-page': '2' })

  nock(BASE_URL)
    .get('/api/v4/projects/1/merge_requests/10/discussions')
    .query({ per_page: '100', page: '2' })
    .reply(200, [makeDiscussion({ id: 'd2', notes: [makeDiscussionNote({ id: 2 })] })], { 'x-next-page': '' })

  const client = makeClient()
  const threads = await client.listDiscussions(1, 10)
  expect(threads).toHaveLength(2)
  expect(threads[0].discussionId).toBe('d1')
  expect(threads[0].notes[0].position?.filePath).toBe('src/foo.ts')
  expect(threads[1].discussionId).toBe('d2')
  expect(threads[1].notes[0].position).toBeUndefined()
})

// ---------------------------------------------------------------------------
// P3-T-03 / 2. listDiscussions: drops position_type='image'/'file' + metric
// ---------------------------------------------------------------------------
test('listDiscussions: drops non-text position types and logs metric', async () => {
  const imagePos = { ...textPosition, position_type: 'image' }
  const filePos = { ...textPosition, position_type: 'file' }

  nock(BASE_URL)
    .get('/api/v4/projects/1/merge_requests/10/discussions')
    .query({ per_page: '100', page: '1' })
    .reply(200, [
      makeDiscussion({ id: 'keep', notes: [makeDiscussionNote({ id: 1, position: textPosition })] }),
      makeDiscussion({ id: 'drop-img', notes: [makeDiscussionNote({ id: 2, position: imagePos })] }),
      makeDiscussion({ id: 'drop-file', notes: [makeDiscussionNote({ id: 3, position: filePos })] })
    ], { 'x-next-page': '' })

  const logger = makeLogger()
  const client = makeClient(logger)
  const threads = await client.listDiscussions(1, 10)
  expect(threads).toHaveLength(1)
  expect(threads[0].discussionId).toBe('keep')

  const dropMsgs = logger.infoCalls.filter((c) => c.msg === 'discussion.position.unsupported')
  expect(dropMsgs).toHaveLength(2)
})

// ---------------------------------------------------------------------------
// P3-T-03 / 3. listDiscussions: updatedAfter query param passed through
// ---------------------------------------------------------------------------
test('listDiscussions: updatedAfter query param passes through', async () => {
  const since = new Date('2024-06-01T00:00:00Z')

  nock(BASE_URL)
    .get('/api/v4/projects/1/merge_requests/10/discussions')
    .query({ per_page: '100', page: '1', updated_after: since.toISOString() })
    .reply(200, [], { 'x-next-page': '' })

  const client = makeClient()
  const threads = await client.listDiscussions(1, 10, { updatedAfter: since })
  expect(threads).toEqual([])
})

// ---------------------------------------------------------------------------
// P3-T-03 / 4. createDiscussion: POST body shape is {body: string}
// ---------------------------------------------------------------------------
test('createDiscussion: POST body wraps the comment in an object', async () => {
  let capturedBody: Record<string, unknown> = {}

  nock(BASE_URL)
    .post('/api/v4/projects/1/merge_requests/10/discussions', (body) => {
      capturedBody = body as Record<string, unknown>
      return true
    })
    .reply(201, makeDiscussion({ id: 'created', notes: [makeDiscussionNote({ id: 99, body: 'hi' })] }))

  const client = makeClient()
  const thread = await client.createDiscussion(1, 10, { body: 'hi' })
  expect(capturedBody.body).toBe('hi')
  expect(typeof capturedBody.body).toBe('string')
  expect(thread.discussionId).toBe('created')
  expect(thread.notes[0].body).toBe('hi')
})

// ---------------------------------------------------------------------------
// P3-T-03 / 5. resolveDiscussion: PUT with resolved=true
// ---------------------------------------------------------------------------
test('resolveDiscussion: PUT with resolved=true', async () => {
  nock(BASE_URL)
    .put('/api/v4/projects/1/merge_requests/10/discussions/disc-1')
    .query({ resolved: 'true' })
    .reply(200, makeDiscussion({ id: 'disc-1' }))

  const client = makeClient()
  await expect(client.resolveDiscussion(1, 10, 'disc-1', true)).resolves.toBeUndefined()
})

// ---------------------------------------------------------------------------
// P3-T-03 / 6. resolveDiscussion: PUT with resolved=false (unresolve)
// ---------------------------------------------------------------------------
test('resolveDiscussion: PUT with resolved=false', async () => {
  nock(BASE_URL)
    .put('/api/v4/projects/1/merge_requests/10/discussions/disc-1')
    .query({ resolved: 'false' })
    .reply(200, makeDiscussion({ id: 'disc-1' }))

  const client = makeClient()
  await expect(client.resolveDiscussion(1, 10, 'disc-1', false)).resolves.toBeUndefined()
})

// ---------------------------------------------------------------------------
// P3-T-03 / 7. getMRApprovals: happy path returns approvedBy + approvalsRequired
// ---------------------------------------------------------------------------
test('getMRApprovals: happy path returns approvedBy + approvalsRequired', async () => {
  nock(BASE_URL)
    .get('/api/v4/projects/1/merge_requests/10/approvals')
    .reply(200, {
      approvals_required: 2,
      approved_by: [
        { user: { id: 11, username: 'bob', name: 'Bob', email: 'b@x', avatar_url: '', web_url: '' } },
        { user: { id: 12, username: 'carol', name: 'Carol', email: 'c@x', avatar_url: '', web_url: '' } }
      ]
    })

  const client = makeClient()
  const approvals = await client.getMRApprovals(1, 10)
  expect(approvals.approvalsRequired).toBe(2)
  expect(approvals.approvedBy).toHaveLength(2)
  expect(approvals.approvedBy[0].username).toBe('bob')
})

// ---------------------------------------------------------------------------
// P3-T-03 / 8. getMRApprovals: 404 returns defaults + increments mr.composite.partial
// ---------------------------------------------------------------------------
test('getMRApprovals: 404 returns defaults and increments mr.composite.partial', async () => {
  resetMrCompositePartialCount()

  nock(BASE_URL)
    .get('/api/v4/projects/1/merge_requests/10/approvals')
    .reply(404, { message: 'Not Found' })

  const logger = makeLogger()
  const client = makeClient(logger)
  const approvals = await client.getMRApprovals(1, 10)
  expect(approvals.approvedBy).toEqual([])
  expect(approvals.approvalsRequired).toBe(0)
  expect(getMrCompositePartialCount()).toBe(1)
  expect(logger.infoCalls.some((c) => c.msg === 'mr.composite.partial')).toBe(true)
})

// ---------------------------------------------------------------------------
// P3-T-03 / 9. approveMR with actorToken → PRIVATE-TOKEN is the override
// ---------------------------------------------------------------------------
test('approveMR: with actorToken, PRIVATE-TOKEN header is the override', async () => {
  let capturedToken: string | undefined

  nock(BASE_URL)
    .post('/api/v4/projects/1/merge_requests/10/approve')
    .reply(function () {
      capturedToken = this.req.headers['private-token'] as string | undefined
      return [201, {}]
    })

  const client = makeClient()
  await client.approveMR(1, 10, 'actor-oauth-token')
  expect(capturedToken).toBe('actor-oauth-token')
})

// ---------------------------------------------------------------------------
// P3-T-03 / 9b. approveMR without actorToken → service-account token + warn log
// ---------------------------------------------------------------------------
test('approveMR: without actorToken falls back to service token and warns', async () => {
  let capturedToken: string | undefined

  nock(BASE_URL)
    .post('/api/v4/projects/1/merge_requests/10/approve')
    .reply(function () {
      capturedToken = this.req.headers['private-token'] as string | undefined
      return [201, {}]
    })

  const logger = makeLogger()
  const client = makeClient(logger)
  await client.approveMR(1, 10)
  expect(capturedToken).toBe('test-token')
  expect(logger.warnCalls.some((c) => c.msg === 'approval.action.fallback.service_account')).toBe(true)
})

// ---------------------------------------------------------------------------
// P3-T-03 / 10. approveMR non-2xx → ApprovalActionError with correct fields
// ---------------------------------------------------------------------------
test('approveMR: 403 throws ApprovalActionError', async () => {
  nock(BASE_URL)
    .post('/api/v4/projects/1/merge_requests/10/approve')
    .reply(403, 'forbidden')

  const client = makeClient()
  await expect(client.approveMR(1, 10, 'actor-tok')).rejects.toMatchObject({
    name: 'ApprovalActionError',
    kind: 'approve',
    projectId: '1',
    mrIid: 10
  })
})

// ---------------------------------------------------------------------------
// P3-T-03 / 11. unapproveMR mirrors approveMR (actor token + 403 → error)
// ---------------------------------------------------------------------------
test('unapproveMR: with actorToken uses override and 403 → ApprovalActionError', async () => {
  let capturedToken: string | undefined
  nock(BASE_URL)
    .post('/api/v4/projects/1/merge_requests/10/unapprove')
    .reply(function () {
      capturedToken = this.req.headers['private-token'] as string | undefined
      return [201, {}]
    })

  const client = makeClient()
  await client.unapproveMR(1, 10, 'actor-x')
  expect(capturedToken).toBe('actor-x')

  nock(BASE_URL)
    .post('/api/v4/projects/1/merge_requests/10/unapprove')
    .reply(403, 'forbidden')

  await expect(client.unapproveMR(1, 10, 'actor-x')).rejects.toBeInstanceOf(ApprovalActionError)
})

// ---------------------------------------------------------------------------
// B8 / Security M1. actorToken with CRLF rejected before fetch is attempted.
// ---------------------------------------------------------------------------
test('approveMR: actorToken containing CRLF throws GitLabApiError, no fetch call', async () => {
  // Note: NO nock interceptor registered — if a fetch slipped through it would
  // raise a 'Nock: No match for request' error, distinct from GitLabApiError.
  const client = makeClient()
  await expect(client.approveMR(1, 10, 'good-token\r\nX-Inject: evil'))
    .rejects.toBeInstanceOf(GitLabApiError)
  await expect(client.unapproveMR(1, 10, '')).rejects.toBeInstanceOf(GitLabApiError)
  const oversized = 'x'.repeat(4097)
  await expect(client.approveMR(1, 10, oversized)).rejects.toBeInstanceOf(GitLabApiError)
  expect(nock.pendingMocks().length).toBe(0)
})

// ---------------------------------------------------------------------------
// P3-T-03 / 12. getMRChanges: happy path returns changed files + diffWebUrl
// ---------------------------------------------------------------------------
test('getMRChanges: happy path returns diffWebUrl and changedFiles', async () => {
  nock(BASE_URL)
    .get('/api/v4/projects/1/merge_requests/10/changes')
    .reply(200, {
      web_url: 'http://gitlab.test/ns/proj/-/merge_requests/10',
      changes: [
        { old_path: 'a.ts', new_path: 'a.ts', new_file: false, deleted_file: false, renamed_file: false },
        { old_path: 'b.ts', new_path: 'b.ts', new_file: true, deleted_file: false, renamed_file: false },
        { old_path: 'old.ts', new_path: 'new.ts', new_file: false, deleted_file: false, renamed_file: true }
      ]
    })

  const client = makeClient()
  const changes = await client.getMRChanges(1, 10)
  expect(changes.diffWebUrl).toBe('http://gitlab.test/ns/proj/-/merge_requests/10/diffs')
  expect(changes.changedFiles).toHaveLength(3)
  expect(changes.changedFiles[0].status).toBe('modified')
  expect(changes.changedFiles[1].status).toBe('added')
  expect(changes.changedFiles[2].status).toBe('renamed')
  expect(changes.changedFiles[2].oldPath).toBe('old.ts')
})

// ---------------------------------------------------------------------------
// P3-T-03 / 13. getMRChanges: 404 returns empty + derived diffWebUrl + metric
// ---------------------------------------------------------------------------
test('getMRChanges: 404 returns defaults using fallbackWebUrl and increments metric', async () => {
  resetMrCompositePartialCount()
  nock(BASE_URL)
    .get('/api/v4/projects/1/merge_requests/10/changes')
    .reply(404, { message: 'Not Found' })

  const logger = makeLogger()
  const client = makeClient(logger)
  const changes = await client.getMRChanges(1, 10, 'http://gitlab.test/ns/proj/-/merge_requests/10')
  expect(changes.changedFiles).toEqual([])
  expect(changes.diffWebUrl).toBe('http://gitlab.test/ns/proj/-/merge_requests/10/diffs')
  expect(getMrCompositePartialCount()).toBe(1)
})

// ---------------------------------------------------------------------------
// P3-T-03 / 14. getMergeRequest composite: 200/200/200 → all fields populated
// ---------------------------------------------------------------------------
test('getMergeRequest composite: 200/200/200 populates all Phase 3 fields', async () => {
  resetMrCompositePartialCount()

  const mr = makeMR({
    iid: 10,
    reviewers: [{ id: 21, username: 'rev', name: 'Rev', email: '', avatar_url: '', web_url: '' }]
  })
  nock(BASE_URL).get('/api/v4/projects/1/merge_requests/10').reply(200, mr)
  nock(BASE_URL).get('/api/v4/projects/1/merge_requests/10/approvals').reply(200, {
    approvals_required: 1,
    approved_by: [{ user: { id: 22, username: 'app', name: 'App', email: '', avatar_url: '', web_url: '' } }]
  })
  nock(BASE_URL).get('/api/v4/projects/1/merge_requests/10/changes').reply(200, {
    web_url: 'http://gitlab.test/ns/proj/-/merge_requests/10',
    changes: [{ old_path: 'x.ts', new_path: 'x.ts', new_file: false, deleted_file: false, renamed_file: false }]
  })

  const client = makeClient()
  const result = await client.getMergeRequest(1, 10)
  expect(result.reviewers).toHaveLength(1)
  expect(result.reviewers?.[0].username).toBe('rev')
  expect(result.approvedBy).toHaveLength(1)
  expect(result.approvalsRequired).toBe(1)
  expect(result.approvalStatus).toBe('approved')
  expect(result.diffWebUrl).toBe('http://gitlab.test/ns/proj/-/merge_requests/10/diffs')
  expect(result.changedFiles).toHaveLength(1)
  expect(getMrCompositePartialCount()).toBe(0)
})

// ---------------------------------------------------------------------------
// P3-T-03 / 15. getMergeRequest composite: 200/200/404 → partial degradation
// ---------------------------------------------------------------------------
test('getMergeRequest composite: 200/200/404 sets changes defaults and increments partial', async () => {
  resetMrCompositePartialCount()

  nock(BASE_URL).get('/api/v4/projects/1/merge_requests/10').reply(200, makeMR({
    iid: 10,
    reviewers: [{ id: 21, username: 'rev', name: 'Rev', email: '', avatar_url: '', web_url: '' }]
  }))
  nock(BASE_URL).get('/api/v4/projects/1/merge_requests/10/approvals').reply(200, {
    approvals_required: 0,
    approved_by: []
  })
  nock(BASE_URL).get('/api/v4/projects/1/merge_requests/10/changes').reply(404, { message: 'Not Found' })

  const client = makeClient()
  const result = await client.getMergeRequest(1, 10)
  expect(result.reviewers?.[0].username).toBe('rev')
  expect(result.approvedBy).toEqual([])
  expect(result.approvalsRequired).toBe(0)
  expect(result.approvalStatus).toBe('pending')
  // 404 inside getMRChanges → defaults populated, partial metric incremented
  expect(result.changedFiles).toEqual([])
  expect(result.diffWebUrl).toBe('http://gitlab.test/ns/proj/-/merge_requests/10/diffs')
  expect(getMrCompositePartialCount()).toBeGreaterThanOrEqual(1)
})

// ---------------------------------------------------------------------------
// P3-T-03 / 16. getMergeRequest composite: 5xx auxiliary → field undefined,
//             returns gracefully
// ---------------------------------------------------------------------------
test('getMergeRequest composite: 5xx in auxiliary leaves field undefined and degrades gracefully', async () => {
  resetMrCompositePartialCount()

  nock(BASE_URL).get('/api/v4/projects/1/merge_requests/10').reply(200, makeMR({ iid: 10 }))
  nock(BASE_URL).get('/api/v4/projects/1/merge_requests/10/approvals').reply(500, 'boom')
  nock(BASE_URL).get('/api/v4/projects/1/merge_requests/10/changes').reply(500, 'boom')

  const client = makeClient()
  const result = await client.getMergeRequest(1, 10)
  expect(result.iid).toBe(10)
  expect(result.approvedBy).toBeUndefined()
  expect(result.approvalsRequired).toBeUndefined()
  expect(result.approvalStatus).toBeUndefined()
  expect(result.diffWebUrl).toBeUndefined()
  expect(result.changedFiles).toBeUndefined()
  expect(getMrCompositePartialCount()).toBe(2)
})
