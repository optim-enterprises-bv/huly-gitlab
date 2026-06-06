import nock from 'nock'
import {
  GitLabClient,
  GRAPHQL_MR_COMPOSITE_QUERY,
  mapGraphQLMRResponse,
  mapGraphQLEpicNode,
  mapGraphQLMRListNode
} from '../../src/adapter/gitlab-client'
import { invalidateGraphQLCapability } from '../../src/adapter/gitlab-graphql-client'
import { ConfidentialMergeRequestError } from '../../src/adapter/errors'
import * as metrics from '../../src/metrics'
import { METRIC_NAMES } from '../../src/metrics'
import type { Logger } from '../../src/logging'

const BASE_URL = 'http://gitlab.test'
const PROJECT_PATH = 'ns/proj'
const MR_IID = 10

function silentLogger (): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
}

function makeClient (): GitLabClient {
  return new GitLabClient({ baseUrl: BASE_URL, token: 'test-token', logger: silentLogger() })
}

function graphqlMRPayload (overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iid: '10',
    title: 'Feature MR',
    description: 'desc',
    state: 'opened',
    draft: false,
    sourceBranch: 'feature',
    targetBranch: 'main',
    mergeStatus: 'can_be_merged',
    mergedAt: null,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-02T00:00:00Z',
    webUrl: 'http://gitlab.test/ns/proj/-/merge_requests/10',
    confidential: false,
    labels: { nodes: [{ title: 'bug' }, { title: 'p1' }] },
    milestone: null,
    author: {
      id: 'gid://gitlab/User/10', username: 'alice', name: 'Alice',
      publicEmail: 'alice@example.com', avatarUrl: '', webUrl: ''
    },
    assignees: { nodes: [] },
    reviewers: {
      nodes: [{
        id: 'gid://gitlab/User/11', username: 'bob', name: 'Bob',
        publicEmail: null, avatarUrl: null, webUrl: ''
      }]
    },
    headPipeline: { status: 'success' },
    approved: true,
    approvalsRequired: 2,
    approvedBy: {
      nodes: [
        { id: 'gid://gitlab/User/12', username: 'carol', name: 'Carol', publicEmail: null, avatarUrl: null, webUrl: '' },
        { id: 'gid://gitlab/User/13', username: 'dan', name: 'Dan', publicEmail: null, avatarUrl: null, webUrl: '' }
      ]
    },
    approvalState: {
      rules: [
        {
          id: 'gid://gitlab/ApprovalRule/100',
          name: 'security',
          type: 'regular',
          approvalsRequired: 1,
          eligibleApprovers: [
            { id: 'gid://gitlab/User/12', username: 'carol', name: 'Carol', publicEmail: null, avatarUrl: null, webUrl: '' }
          ],
          approvedBy: {
            nodes: [
              { id: 'gid://gitlab/User/12', username: 'carol', name: 'Carol', publicEmail: null, avatarUrl: null, webUrl: '' }
            ]
          }
        },
        {
          id: 'gid://gitlab/ApprovalRule/101',
          name: 'codeowners',
          type: 'code_owner',
          approvalsRequired: 1,
          eligibleApprovers: [],
          approvedBy: { nodes: [] }
        }
      ]
    },
    diffStats: [
      { path: 'src/a.ts', additions: 3, deletions: 1 },
      { path: 'src/b.ts', additions: 0, deletions: 5 }
    ],
    ...overrides
  }
}

function makeRESTMR (overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iid: MR_IID, project_id: 1, title: 'Feature MR', description: 'desc',
    state: 'opened', draft: false,
    source_branch: 'feature', target_branch: 'main',
    merge_status: 'can_be_merged', merged_at: null,
    head_pipeline: { status: 'success' }, labels: ['bug', 'p1'], milestone: null,
    assignees: [],
    reviewers: [
      { id: 11, username: 'bob', name: 'Bob', email: null, avatar_url: null, web_url: '' }
    ],
    author: { id: 10, username: 'alice', name: 'Alice', email: 'alice@example.com', avatar_url: '', web_url: '' },
    created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-02T00:00:00Z',
    web_url: 'http://gitlab.test/ns/proj/-/merge_requests/10',
    confidential: false,
    ...overrides
  }
}

function mockCapabilityProbeOK (): void {
  // First probe call by detectGraphQLCapability + the actual composite query
  // both POST /api/graphql. We rely on test setup to drain in order.
  nock(BASE_URL).post('/api/graphql').reply(200, { data: { currentUser: { id: 'gid://gitlab/User/1' } } })
}

function mockCapabilityProbeFail (): void {
  nock(BASE_URL).post('/api/graphql').reply(500, 'err')
}

beforeEach(() => {
  metrics.reset()
  invalidateGraphQLCapability()
})

afterEach(() => {
  nock.cleanAll()
  metrics.reset()
  invalidateGraphQLCapability()
})

// ---------------------------------------------------------------------------
// 1. GraphQL capability=true → composite query fires; mapped to SyncMergeRequest
// ---------------------------------------------------------------------------
test('getMergeRequest: GraphQL preferred when capability=true; mapped to SyncMergeRequest', async () => {
  mockCapabilityProbeOK()
  const compositeScope = nock(BASE_URL)
    .post('/api/graphql', (body: { query: string, variables: { projectFullPath: string, mrIid: string } }) => {
      return body.query.includes('MRComposite') &&
        body.variables.projectFullPath === PROJECT_PATH &&
        body.variables.mrIid === String(MR_IID)
    })
    .reply(200, { data: { project: { mergeRequest: graphqlMRPayload() } } })

  const client = makeClient()
  const mr = await client.getMergeRequest(PROJECT_PATH, MR_IID)

  expect(compositeScope.isDone()).toBe(true)
  expect(mr.iid).toBe(MR_IID)
  expect(mr.title).toBe('Feature MR')
  expect(mr.sourceBranch).toBe('feature')
  expect(mr.mergeStatus).toBe('can_be_merged')
  expect(mr.approvalsRequired).toBe(2)
  expect(mr.approvedBy).toHaveLength(2)
  expect(mr.approvalStatus).toBe('approved')
  expect(mr.changedFiles).toHaveLength(2)
  expect(mr.changedFiles?.[0].path).toBe('src/a.ts')
  expect(mr.reviewers).toHaveLength(1)
  expect(mr.labels).toEqual(['bug', 'p1'])
  expect(metrics.get(METRIC_NAMES.MR_COMPOSITE_GRAPHQL_HIT)).toBe(1)
  expect(metrics.get(METRIC_NAMES.MR_COMPOSITE_GRAPHQL_HIT_PATH_KNOWN)).toBe(1)
  expect(metrics.get(METRIC_NAMES.MR_COMPOSITE_REST_FALLBACK)).toBe(0)
})

// ---------------------------------------------------------------------------
// 2. GraphQL capability=false → REST composite runs; fallback metric incremented
// ---------------------------------------------------------------------------
test('getMergeRequest: GraphQL capability=false → REST fallback path used', async () => {
  mockCapabilityProbeFail()
  nock(BASE_URL).get(`/api/v4/projects/${PROJECT_PATH}/merge_requests/${MR_IID}`).reply(200, makeRESTMR())
  nock(BASE_URL).get(`/api/v4/projects/${PROJECT_PATH}/merge_requests/${MR_IID}/approvals`).reply(200, {
    approvals_required: 1, approved_by: []
  })
  nock(BASE_URL).get(`/api/v4/projects/${PROJECT_PATH}/merge_requests/${MR_IID}/changes`).reply(200, {
    web_url: 'http://gitlab.test/ns/proj/-/merge_requests/10', changes: []
  })

  const client = makeClient()
  const mr = await client.getMergeRequest(PROJECT_PATH, MR_IID)

  expect(mr.iid).toBe(MR_IID)
  expect(mr.title).toBe('Feature MR')
  expect(metrics.get(METRIC_NAMES.MR_COMPOSITE_GRAPHQL_HIT)).toBe(0)
  expect(metrics.get(METRIC_NAMES.MR_COMPOSITE_REST_FALLBACK)).toBe(1)
})

// ---------------------------------------------------------------------------
// 3. GraphQL query throws after capability=true → REST fallback; no propagation
// ---------------------------------------------------------------------------
test('getMergeRequest: GraphQL composite query throws → REST fallback; no error propagation', async () => {
  mockCapabilityProbeOK()
  // Composite query 500s
  nock(BASE_URL)
    .post('/api/graphql', (body: { query: string }) => body.query.includes('MRComposite'))
    .reply(500, 'graphql blew up')
  nock(BASE_URL).get(`/api/v4/projects/${PROJECT_PATH}/merge_requests/${MR_IID}`).reply(200, makeRESTMR())
  nock(BASE_URL).get(`/api/v4/projects/${PROJECT_PATH}/merge_requests/${MR_IID}/approvals`).reply(200, {
    approvals_required: 0, approved_by: []
  })
  nock(BASE_URL).get(`/api/v4/projects/${PROJECT_PATH}/merge_requests/${MR_IID}/changes`).reply(200, { changes: [] })

  const client = makeClient()
  const mr = await client.getMergeRequest(PROJECT_PATH, MR_IID)

  expect(mr.iid).toBe(MR_IID)
  expect(mr.title).toBe('Feature MR')
  expect(metrics.get(METRIC_NAMES.MR_COMPOSITE_GRAPHQL_HIT)).toBe(0)
  expect(metrics.get(METRIC_NAMES.MR_COMPOSITE_REST_FALLBACK)).toBe(1)
})

// ---------------------------------------------------------------------------
// 4. Parity: GraphQL path produces same canonical shape as REST on same MR
// ---------------------------------------------------------------------------
test('getMergeRequest: GraphQL response shape matches REST path on equivalent MR', async () => {
  // Build a GraphQL payload that mirrors the REST fixture above (no reviewers,
  // empty approval rules, empty diff stats) so we can compare the canonical
  // fields the caller relies on.
  const minimalGraphQL = graphqlMRPayload({
    reviewers: { nodes: [] },
    approved: false,
    approvalsRequired: 0,
    approvedBy: { nodes: [] },
    approvalState: { rules: [] },
    diffStats: [],
    labels: { nodes: [] },
    headPipeline: null
  })
  mockCapabilityProbeOK()
  nock(BASE_URL).post('/api/graphql').reply(200, { data: { project: { mergeRequest: minimalGraphQL } } })

  const clientA = makeClient()
  const graphqlMR = await clientA.getMergeRequest(PROJECT_PATH, MR_IID)

  // Cleanup + run REST path
  invalidateGraphQLCapability()
  nock.cleanAll()
  mockCapabilityProbeFail()
  nock(BASE_URL).get(`/api/v4/projects/${PROJECT_PATH}/merge_requests/${MR_IID}`)
    .reply(200, makeRESTMR({ head_pipeline: null, labels: [], reviewers: [] }))
  nock(BASE_URL).get(`/api/v4/projects/${PROJECT_PATH}/merge_requests/${MR_IID}/approvals`)
    .reply(200, { approvals_required: 0, approved_by: [] })
  nock(BASE_URL).get(`/api/v4/projects/${PROJECT_PATH}/merge_requests/${MR_IID}/changes`)
    .reply(200, { web_url: 'http://gitlab.test/ns/proj/-/merge_requests/10', changes: [] })

  const clientB = makeClient()
  const restMR = await clientB.getMergeRequest(PROJECT_PATH, MR_IID)

  // Compare canonical fields that BOTH paths must populate identically.
  expect(graphqlMR.iid).toBe(restMR.iid)
  expect(graphqlMR.title).toBe(restMR.title)
  expect(graphqlMR.sourceBranch).toBe(restMR.sourceBranch)
  expect(graphqlMR.targetBranch).toBe(restMR.targetBranch)
  expect(graphqlMR.state).toBe(restMR.state)
  expect(graphqlMR.mergeStatus).toBe(restMR.mergeStatus)
  expect(graphqlMR.webUrl).toBe(restMR.webUrl)
  expect(graphqlMR.confidential).toBe(restMR.confidential)
  expect(graphqlMR.labels).toEqual(restMR.labels)
  expect(graphqlMR.approvedBy).toEqual(restMR.approvedBy)
  expect(graphqlMR.approvalsRequired).toBe(restMR.approvalsRequired)
  expect(graphqlMR.approvalStatus).toBe(restMR.approvalStatus)
  expect(graphqlMR.changedFiles).toEqual(restMR.changedFiles)
  expect(graphqlMR.reviewers).toEqual(restMR.reviewers)
})

// ---------------------------------------------------------------------------
// 5. Confidential MR via GraphQL → ConfidentialMergeRequestError
// ---------------------------------------------------------------------------
test('getMergeRequest: confidential MR via GraphQL → throws ConfidentialMergeRequestError', async () => {
  mockCapabilityProbeOK()
  nock(BASE_URL).post('/api/graphql').reply(200, {
    data: { project: { mergeRequest: graphqlMRPayload({ confidential: true }) } }
  })

  const client = makeClient()
  await expect(client.getMergeRequest(PROJECT_PATH, MR_IID)).rejects.toThrow(ConfidentialMergeRequestError)
  expect(metrics.get(METRIC_NAMES.MR_COMPOSITE_GRAPHQL_HIT)).toBe(0)
})

// ---------------------------------------------------------------------------
// 6. Approval rules in GraphQL response → mapped to SyncMRApprovalRule[] correctly
// ---------------------------------------------------------------------------
test('mapGraphQLMRResponse: maps approval rules array to SyncMRApprovalRule[]', () => {
  const data = { project: { mergeRequest: graphqlMRPayload() } }
  const mr = mapGraphQLMRResponse(data)

  expect(mr.approvalRules).toHaveLength(2)
  const securityRule = mr.approvalRules?.[0]
  expect(securityRule?.id).toBe(100)
  expect(securityRule?.name).toBe('security')
  expect(securityRule?.ruleType).toBe('regular')
  expect(securityRule?.approvalsRequired).toBe(1)
  expect(securityRule?.eligibleApprovers).toHaveLength(1)
  expect(securityRule?.eligibleApprovers[0].username).toBe('carol')
  expect(securityRule?.approvedBy).toHaveLength(1)
  expect(securityRule?.approvedBy[0].username).toBe('carol')

  const ownerRule = mr.approvalRules?.[1]
  expect(ownerRule?.id).toBe(101)
  expect(ownerRule?.name).toBe('codeowners')
  expect(ownerRule?.ruleType).toBe('code_owner')
  expect(ownerRule?.approvalsRequired).toBe(1)
  expect(ownerRule?.eligibleApprovers).toEqual([])
  expect(ownerRule?.approvedBy).toEqual([])
})

// Sanity guard: the exported GraphQL query has the expected operation name.
test('GRAPHQL_MR_COMPOSITE_QUERY: includes MRComposite operation', () => {
  expect(GRAPHQL_MR_COMPOSITE_QUERY).toMatch(/query MRComposite/)
  expect(GRAPHQL_MR_COMPOSITE_QUERY).toMatch(/mergeRequest\(iid: \$mrIid\)/)
})

// ===========================================================================
// P5-T-23: listEpicsWithChildren
// ===========================================================================

const GROUP_PATH = 'acme'

function setEeCaps (client: GitLabClient): void {
  client.capabilities = {
    gitlabVersion: '17.0.0-ee',
    edition: 'ee',
    graphqlAvailable: true,
    featureFlags: { 'graphql.issue.notes': true, 'graphql.issue.batchedNotes': true }
  }
}

function graphqlEpicNode (overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iid: '7',
    title: 'Q1 roadmap',
    description: 'top-level',
    state: 'opened',
    webUrl: 'http://gitlab.test/groups/acme/-/epics/7',
    confidential: false,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-02T00:00:00Z',
    group: { id: 'gid://gitlab/Group/42' },
    author: {
      id: 'gid://gitlab/User/1', username: 'root', name: 'Root',
      publicEmail: null, avatarUrl: null, webUrl: ''
    },
    issues: { nodes: [{ iid: 11 }, { iid: 12 }, { iid: 13 }] },
    ...overrides
  }
}

function makeRESTEpic (overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 700,
    iid: 7,
    group_id: 42,
    title: 'Q1 roadmap',
    description: 'top-level',
    state: 'opened',
    web_url: 'http://gitlab.test/groups/acme/-/epics/7',
    author: { id: 1, username: 'root', name: 'Root', email: '', avatar_url: '', web_url: '' },
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-02T00:00:00Z',
    confidential: false,
    ...overrides
  }
}

test('listEpicsWithChildren: GraphQL hit → epics + children populated; metric incremented', async () => {
  mockCapabilityProbeOK()
  const scope = nock(BASE_URL)
    .post('/api/graphql', (body: { query: string, variables: { groupFullPath: string } }) => {
      return body.query.includes('EpicsWithChildren') && body.variables.groupFullPath === GROUP_PATH
    })
    .reply(200, {
      data: {
        group: {
          epics: {
            nodes: [
              graphqlEpicNode(),
              graphqlEpicNode({ iid: '8', title: 'Q2 roadmap', issues: { nodes: [{ iid: 21 }] } })
            ]
          }
        }
      }
    })

  const client = makeClient()
  setEeCaps(client)
  const epics = await client.listEpicsWithChildren(GROUP_PATH)

  expect(scope.isDone()).toBe(true)
  expect(epics).toHaveLength(2)
  expect(epics[0].iid).toBe(7)
  expect(epics[0].title).toBe('Q1 roadmap')
  expect(epics[0].childIssueIids).toEqual([11, 12, 13])
  expect(epics[0].groupId).toBe(42)
  expect(epics[1].childIssueIids).toEqual([21])
  expect(metrics.get(METRIC_NAMES.EPICS_LIST_GRAPHQL_HIT)).toBe(1)
  expect(metrics.get(METRIC_NAMES.EPICS_LIST_REST_FALLBACK)).toBe(0)
})

test('listEpicsWithChildren: capability=false → REST N+1 fallback path used; metric incremented', async () => {
  mockCapabilityProbeFail()
  // listEpics page
  nock(BASE_URL)
    .get(`/api/v4/groups/${GROUP_PATH}/epics`)
    .query(true)
    .reply(200, [makeRESTEpic(), makeRESTEpic({ id: 800, iid: 8, title: 'Q2 roadmap' })])
  // listEpicIssues for each epic
  nock(BASE_URL)
    .get(`/api/v4/groups/${GROUP_PATH}/epics/7/issues`)
    .query(true)
    .reply(200, [
      { id: 1100, iid: 11, project_id: 9 },
      { id: 1200, iid: 12, project_id: 9 }
    ])
  nock(BASE_URL)
    .get(`/api/v4/groups/${GROUP_PATH}/epics/8/issues`)
    .query(true)
    .reply(200, [{ id: 2100, iid: 21, project_id: 9 }])

  const client = makeClient()
  setEeCaps(client)
  const epics = await client.listEpicsWithChildren(GROUP_PATH)

  expect(epics).toHaveLength(2)
  expect(epics[0].childIssueIids).toEqual([11, 12])
  expect(epics[1].childIssueIids).toEqual([21])
  expect(metrics.get(METRIC_NAMES.EPICS_LIST_GRAPHQL_HIT)).toBe(0)
  expect(metrics.get(METRIC_NAMES.EPICS_LIST_REST_FALLBACK)).toBe(1)
})

test('listEpicsWithChildren: GraphQL query throws → REST fallback; no error propagation', async () => {
  mockCapabilityProbeOK()
  nock(BASE_URL)
    .post('/api/graphql', (body: { query: string }) => body.query.includes('EpicsWithChildren'))
    .reply(500, 'graphql blew up')
  nock(BASE_URL)
    .get(`/api/v4/groups/${GROUP_PATH}/epics`)
    .query(true)
    .reply(200, [makeRESTEpic()])
  nock(BASE_URL)
    .get(`/api/v4/groups/${GROUP_PATH}/epics/7/issues`)
    .query(true)
    .reply(200, [{ id: 1100, iid: 11, project_id: 9 }])

  const client = makeClient()
  setEeCaps(client)
  const epics = await client.listEpicsWithChildren(GROUP_PATH)

  expect(epics).toHaveLength(1)
  expect(epics[0].iid).toBe(7)
  expect(epics[0].childIssueIids).toEqual([11])
  expect(metrics.get(METRIC_NAMES.EPICS_LIST_GRAPHQL_HIT)).toBe(0)
  expect(metrics.get(METRIC_NAMES.EPICS_LIST_REST_FALLBACK)).toBe(1)
})

// Sanity: mapGraphQLEpicNode mapper handles confidential and missing groups.
test('mapGraphQLEpicNode: maps GraphQL epic node to SyncEpic with childIssueIids', () => {
  const epic = mapGraphQLEpicNode(graphqlEpicNode() as unknown as Parameters<typeof mapGraphQLEpicNode>[0])
  expect(epic.iid).toBe(7)
  expect(epic.groupId).toBe(42)
  expect(epic.state).toBe('opened')
  expect(epic.childIssueIids).toEqual([11, 12, 13])
  expect(epic.author.username).toBe('root')
})

// ===========================================================================
// P5-T-24: listMergeRequestsWithApprovals
// ===========================================================================

test('listMergeRequestsWithApprovals: GraphQL hit → MRs + approvals; metric incremented', async () => {
  mockCapabilityProbeOK()
  const scope = nock(BASE_URL)
    .post('/api/graphql', (body: { query: string, variables: { projectFullPath: string } }) => {
      return body.query.includes('MRListWithApprovals') && body.variables.projectFullPath === PROJECT_PATH
    })
    .reply(200, {
      data: {
        project: {
          mergeRequests: {
            nodes: [
              graphqlMRPayload(),
              graphqlMRPayload({ iid: '11', title: 'Second MR', webUrl: 'http://gitlab.test/ns/proj/-/merge_requests/11' })
            ]
          }
        }
      }
    })

  const client = makeClient()
  const mrs = await client.listMergeRequestsWithApprovals(PROJECT_PATH)

  expect(scope.isDone()).toBe(true)
  expect(mrs).toHaveLength(2)
  expect(mrs[0].iid).toBe(10)
  expect(mrs[0].title).toBe('Feature MR')
  expect(mrs[0].approvalsRequired).toBe(2)
  expect(mrs[0].approvedBy).toHaveLength(2)
  expect(mrs[0].approvalStatus).toBe('approved')
  expect(mrs[0].changedFiles).toHaveLength(2)
  expect(mrs[0].approvalRules).toHaveLength(2)
  expect(mrs[1].iid).toBe(11)
  expect(metrics.get(METRIC_NAMES.MR_LIST_GRAPHQL_HIT)).toBe(1)
  expect(metrics.get(METRIC_NAMES.MR_LIST_REST_FALLBACK)).toBe(0)
})

test('listMergeRequestsWithApprovals: capability=false → REST N+1 fallback over composite; metric incremented', async () => {
  mockCapabilityProbeFail()
  // listMergeRequests page
  nock(BASE_URL)
    .get(`/api/v4/projects/${PROJECT_PATH}/merge_requests`)
    .query(true)
    .reply(200, [makeRESTMR()], { 'x-next-page': '' })
  // Composite per MR: base + approvals + changes (CE; ensureEE=false by default)
  nock(BASE_URL).get(`/api/v4/projects/${PROJECT_PATH}/merge_requests/${MR_IID}`).reply(200, makeRESTMR())
  nock(BASE_URL).get(`/api/v4/projects/${PROJECT_PATH}/merge_requests/${MR_IID}/approvals`).reply(200, {
    approvals_required: 1, approved_by: []
  })
  nock(BASE_URL).get(`/api/v4/projects/${PROJECT_PATH}/merge_requests/${MR_IID}/changes`).reply(200, {
    web_url: 'http://gitlab.test/ns/proj/-/merge_requests/10', changes: []
  })

  const client = makeClient()
  const mrs = await client.listMergeRequestsWithApprovals(PROJECT_PATH)

  expect(mrs).toHaveLength(1)
  expect(mrs[0].iid).toBe(MR_IID)
  expect(mrs[0].title).toBe('Feature MR')
  expect(mrs[0].approvalsRequired).toBe(1)
  expect(metrics.get(METRIC_NAMES.MR_LIST_GRAPHQL_HIT)).toBe(0)
  expect(metrics.get(METRIC_NAMES.MR_LIST_REST_FALLBACK)).toBe(1)
})

test('listMergeRequestsWithApprovals: GraphQL query throws → REST fallback; no error propagation', async () => {
  mockCapabilityProbeOK()
  nock(BASE_URL)
    .post('/api/graphql', (body: { query: string }) => body.query.includes('MRListWithApprovals'))
    .reply(500, 'graphql blew up')
  nock(BASE_URL)
    .get(`/api/v4/projects/${PROJECT_PATH}/merge_requests`)
    .query(true)
    .reply(200, [makeRESTMR()], { 'x-next-page': '' })
  // After GraphQL throws, getMergeRequest is called per row. Capability cache is
  // now positive (probe succeeded earlier), so getMergeRequest will try GraphQL
  // composite first — mock it for the fetched MR.
  nock(BASE_URL)
    .post('/api/graphql', (body: { query: string }) => body.query.includes('MRComposite'))
    .reply(200, { data: { project: { mergeRequest: graphqlMRPayload() } } })

  const client = makeClient()
  const mrs = await client.listMergeRequestsWithApprovals(PROJECT_PATH)

  expect(mrs).toHaveLength(1)
  expect(mrs[0].iid).toBe(MR_IID)
  expect(mrs[0].title).toBe('Feature MR')
  expect(metrics.get(METRIC_NAMES.MR_LIST_GRAPHQL_HIT)).toBe(0)
  expect(metrics.get(METRIC_NAMES.MR_LIST_REST_FALLBACK)).toBe(1)
})

// Sanity: mapGraphQLMRListNode is a thin reuse of mapGraphQLMRResponse.
test('mapGraphQLMRListNode: maps a single GraphQL MR list node to SyncMergeRequest', () => {
  const mr = mapGraphQLMRListNode(graphqlMRPayload() as unknown as Parameters<typeof mapGraphQLMRListNode>[0])
  expect(mr.iid).toBe(10)
  expect(mr.approvalsRequired).toBe(2)
  expect(mr.changedFiles).toHaveLength(2)
})
