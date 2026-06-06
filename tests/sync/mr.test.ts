import { type Collection } from 'mongodb'
import { ObjectId } from 'mongodb'
import type { PersonUuid, Ref, Space, TxOperations, WorkspaceUuid } from '@hcengineering/core'
import type { Issue, Status, TaskType } from '@hcengineering/tracker'
import { IssuePriority } from '@hcengineering/tracker'
import type { Store } from '../../src/state/store'
import type { Logger } from '../../src/logging'
import type { IdMapDoc } from '../../src/state/idmap'
import type { CursorDoc } from '../../src/state/cursors'
import type {
  SyncIteration,
  SyncMergeRequest,
  SyncMRApprovalRule,
  SyncMilestone,
  SyncUser as AdapterUser
} from '../../src/adapter/types'
import { UserIdentity } from '../../src/huly/users'
import { LabelCache } from '../../src/sync/label-cache'
import { MilestoneCache } from '../../src/sync/milestone-cache'
import {
  type MRBindingContext,
  MergeRequestsSyncManager,
  resolveMRRef
} from '../../src/sync/mr'
import type { SyncContext } from '../../src/sync/types'

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeLogger (): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
}

interface FakeIdMap extends Collection<IdMapDoc> {
  docs: IdMapDoc[]
}

function makeIdMap (): FakeIdMap {
  const docs: IdMapDoc[] = []
  return {
    docs,
    findOne: async (q: Record<string, unknown>) => {
      return docs.find((d) =>
        d.workspaceUuid === q.workspaceUuid &&
        ((q.gitlabKind === undefined || d.gitlabKind === q.gitlabKind) &&
         (q.gitlabId === undefined || d.gitlabId === q.gitlabId)) &&
        ((q.hulyClass === undefined || d.hulyClass === q.hulyClass) &&
         (q.hulyRef === undefined || d.hulyRef === q.hulyRef))
      ) ?? null
    },
    updateOne: async (q: Record<string, unknown>, update: Record<string, unknown>) => {
      const set = (update.$set as Record<string, unknown>) ?? {}
      const existingIdx = docs.findIndex((d) =>
        d.workspaceUuid === q.workspaceUuid &&
        d.gitlabKind === q.gitlabKind &&
        d.gitlabId === q.gitlabId
      )
      if (existingIdx >= 0) {
        docs[existingIdx] = { ...docs[existingIdx], ...set } as IdMapDoc
      } else {
        docs.push({ _id: new ObjectId(), ...(set as object) } as IdMapDoc)
      }
      return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0, acknowledged: true }
    }
  } as unknown as FakeIdMap
}

interface FakeCursors extends Collection<CursorDoc> {
  docs: CursorDoc[]
  sets: number
}

function makeCursors (): FakeCursors {
  const docs: CursorDoc[] = []
  let sets = 0
  return {
    docs,
    get sets (): number { return sets },
    findOne: async (q: Record<string, unknown>) =>
      docs.find((d) => d.bindingId === q.bindingId && d.kind === q.kind) ?? null,
    updateOne: async (q: Record<string, unknown>, update: Record<string, unknown>) => {
      sets++
      const set = (update.$set as Record<string, unknown>) ?? {}
      const idx = docs.findIndex((d) => d.bindingId === q.bindingId && d.kind === q.kind)
      if (idx >= 0) {
        docs[idx] = { ...docs[idx], ...set } as CursorDoc
      } else {
        docs.push({ ...set } as CursorDoc)
      }
      return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0, acknowledged: true }
    }
  } as unknown as FakeCursors
}

function makeStore (idmap: FakeIdMap, cursors: FakeCursors): Store {
  return {
    idmap: () => idmap,
    cursors: () => cursors
  } as unknown as Store
}

interface MixinCall {
  objectId: string
  objectClass: unknown
  objectSpace: unknown
  mixin: string
  attributes: Record<string, unknown>
}

interface FakeHulyClient extends TxOperations {
  issues: Map<Ref<Issue>, Issue>
  mixinByIssue: Map<string, Record<string, unknown>>
  creates: number
  updates: number
  createMixinCalls: MixinCall[]
  updateMixinCalls: MixinCall[]
  lastUpdate: Partial<Issue> | null
  getMixin: (issueRef: string) => Record<string, unknown> | undefined
}

function makeHulyClient (): FakeHulyClient {
  const issues = new Map<Ref<Issue>, Issue>()
  const mixinByIssue = new Map<string, Record<string, unknown>>()
  let creates = 0
  let updates = 0
  const createMixinCalls: MixinCall[] = []
  const updateMixinCalls: MixinCall[] = []
  let lastUpdate: Partial<Issue> | null = null
  let counter = 0

  const isIssueClass = (cls: unknown): boolean =>
    String(cls).includes('tracker') && String(cls).includes('Issue')

  const client = {
    issues,
    mixinByIssue,
    createMixinCalls,
    updateMixinCalls,
    get creates (): number { return creates },
    get updates (): number { return updates },
    get lastUpdate (): Partial<Issue> | null { return lastUpdate },
    getMixin: (issueRef: string): Record<string, unknown> | undefined =>
      mixinByIssue.get(issueRef),
    findOne: async (_cls: unknown, q: Partial<Issue>): Promise<Issue | undefined> => {
      if (q._id !== undefined) {
        const issue = issues.get(q._id)
        if (issue === undefined) return undefined
        // Mirror the platform behavior: mixin attributes are accessible under
        // the mixin Ref key on the Doc. Tests rely on this for readMixin().
        const mixinAttrs = mixinByIssue.get(String(q._id))
        if (mixinAttrs !== undefined) {
          return { ...issue, ['gitlab-mr']: mixinAttrs } as unknown as Issue
        }
        return issue
      }
      return undefined
    },
    findAll: async () => [],
    createDoc: async (cls: unknown, _space: unknown, attrs: Partial<Issue>): Promise<Ref<Issue>> => {
      counter++
      if (!isIssueClass(cls)) {
        return `aux-ref-${counter}` as unknown as Ref<Issue>
      }
      creates++
      const id = `huly-issue-${creates}` as unknown as Ref<Issue>
      const doc: Issue = {
        _id: id,
        _class: cls as Issue['_class'],
        space: 'space-x' as Issue['space'],
        modifiedOn: attrs.modifiedOn ?? Date.now(),
        modifiedBy: 'sys' as Issue['modifiedBy'],
        attachedTo: 'p' as Issue['attachedTo'],
        attachedToClass: cls as Issue['attachedToClass'],
        collection: 'issues',
        title: attrs.title ?? '',
        description: attrs.description ?? '',
        status: attrs.status ?? ('' as Ref<Status>),
        priority: attrs.priority ?? 0,
        assignee: attrs.assignee ?? null,
        labels: attrs.labels ?? [],
        milestone: attrs.milestone ?? null,
        kind: attrs.kind ?? ('' as Ref<Issue['kind']>)
      }
      issues.set(id, doc)
      return id
    },
    updateDoc: async (
      _cls: unknown,
      _space: unknown,
      id: Ref<Issue>,
      update: Partial<Issue>
    ): Promise<void> => {
      updates++
      lastUpdate = update
      const existing = issues.get(id)
      if (existing !== undefined) {
        issues.set(id, { ...existing, ...update } as Issue)
      }
    },
    createMixin: async (
      objectId: string,
      objectClass: unknown,
      objectSpace: unknown,
      mixin: string,
      attributes: Record<string, unknown>
    ) => {
      createMixinCalls.push({ objectId, objectClass, objectSpace, mixin, attributes })
      const key = String(objectId)
      const cur = mixinByIssue.get(key) ?? {}
      mixinByIssue.set(key, { ...cur, ...attributes })
      return {}
    },
    updateMixin: async (
      objectId: string,
      objectClass: unknown,
      objectSpace: unknown,
      mixin: string,
      attributes: Record<string, unknown>
    ) => {
      updateMixinCalls.push({ objectId, objectClass, objectSpace, mixin, attributes })
      const key = String(objectId)
      const cur = mixinByIssue.get(key) ?? {}
      mixinByIssue.set(key, { ...cur, ...attributes })
      return {}
    },
    close: async () => undefined
  } as unknown as FakeHulyClient

  return client
}

interface FakeGitLab {
  listMergeRequests: jest.Mock
  updateMergeRequest: jest.Mock
  createMergeRequest: jest.Mock
  listLabels: jest.Mock
  createLabel: jest.Mock
  listMilestones: jest.Mock
  createMilestone: jest.Mock
  // Phase 3 (P3-T-07): two-way approval + composite enrichment.
  approveMR: jest.Mock
  unapproveMR: jest.Mock
  getMRApprovals: jest.Mock
  getMRChanges: jest.Mock
}

function makeGitLab (overrides: Partial<FakeGitLab> = {}): FakeGitLab {
  return {
    listMergeRequests: jest.fn().mockResolvedValue([]),
    updateMergeRequest: jest.fn().mockResolvedValue({} as SyncMergeRequest),
    // Phase 2 scope cut — should never be invoked.
    createMergeRequest: jest.fn().mockResolvedValue({} as SyncMergeRequest),
    listLabels: jest.fn().mockResolvedValue([]),
    createLabel: jest.fn().mockImplementation(async (_pid, body) => ({
      id: 50,
      name: body.name,
      color: body.color,
      description: null
    })),
    listMilestones: jest.fn().mockResolvedValue([]),
    approveMR: jest.fn().mockResolvedValue(undefined),
    unapproveMR: jest.fn().mockResolvedValue(undefined),
    getMRApprovals: jest.fn().mockResolvedValue({ approvedBy: [], approvalsRequired: 0 }),
    getMRChanges: jest.fn().mockResolvedValue({ diffWebUrl: '', changedFiles: [] }),
    createMilestone: jest.fn().mockImplementation(async (_pid, body) => ({
      id: 88,
      iid: 1,
      title: body.title,
      description: body.description ?? null,
      state: 'active',
      dueDate: null,
      startDate: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    } as SyncMilestone)),
    ...overrides
  }
}

class FakeAccountClient {
  constructor (private readonly known: Map<string, PersonUuid> = new Map()) {}
  async findPersonBySocialKey (key: string): Promise<PersonUuid | undefined> {
    return this.known.get(key)
  }
}

interface FakeIdentityStore {
  records: Map<string, string>
  getIdMap: (workspace: string, kind: string, gid: string) => Promise<string | undefined>
  putIdMap: (workspace: string, kind: string, gid: string, ref: string) => Promise<void>
}

function makeIdentityStore (): FakeIdentityStore {
  const records = new Map<string, string>()
  return {
    records,
    getIdMap: async (w, k, g) => records.get(`${w}/${k}/${g}`),
    putIdMap: async (w, k, g, ref) => {
      records.set(`${w}/${k}/${g}`, ref)
    }
  }
}

const WORKSPACE = 'ws-1' as unknown as WorkspaceUuid

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function makeStatuses (): Status[] {
  const mk = (id: string, cat: string): Status => ({
    _id: id as unknown as Ref<Status>,
    _class: 'tracker:class:IssueStatus' as Status['_class'],
    space: 's' as Status['space'],
    modifiedOn: 0,
    modifiedBy: 'm' as Status['modifiedBy'],
    name: id,
    category: cat as unknown as Status['category']
  })
  return [
    mk('todo', 'task:statusCategory:ToDo'),
    mk('active', 'task:statusCategory:Active'),
    mk('done', 'task:statusCategory:Won'),
    mk('cancelled', 'task:statusCategory:Lost')
  ]
}

function makeUser (id: number, email: string | null = null): AdapterUser {
  return {
    id,
    username: `user${id}`,
    name: `User ${id}`,
    email,
    avatarUrl: null,
    webUrl: `https://gitlab.example/user${id}`
  }
}

function makeSyncMR (overrides: Partial<SyncMergeRequest> = {}): SyncMergeRequest {
  return {
    iid: 1,
    projectId: 42,
    title: 'Remote MR title',
    description: 'remote body',
    state: 'opened',
    draft: false,
    sourceBranch: 'feature/x',
    targetBranch: 'main',
    mergeStatus: 'can_be_merged',
    mergedAt: null,
    pipelineStatus: null,
    labels: [],
    milestone: null,
    assignees: [],
    reviewers: [],
    author: makeUser(1),
    createdAt: new Date('2024-01-01T10:00:00.000Z'),
    updatedAt: new Date('2024-01-01T10:00:00.000Z'),
    webUrl: 'https://gitlab.example/mr/1',
    confidential: false,
    ...overrides
  }
}

interface Harness {
  manager: MergeRequestsSyncManager
  ctx: SyncContext
  bctx: MRBindingContext
  idmap: FakeIdMap
  cursors: FakeCursors
  huly: FakeHulyClient
  gitlab: FakeGitLab
  identity: UserIdentity
  identityStore: FakeIdentityStore
  enqueued: Array<{ binding: string, kind: string, record: Record<string, unknown> }>
}

function buildHarness (opts: {
  gitlab?: Partial<FakeGitLab>
  knownUsers?: Map<string, PersonUuid>
  resolveActorToken?: (
    workspaceUuid: WorkspaceUuid,
    person: PersonUuid
  ) => Promise<string | undefined>
} = {}): Harness {
  const idmap = makeIdMap()
  const cursors = makeCursors()
  const store = makeStore(idmap, cursors)
  const huly = makeHulyClient()
  const gitlab = makeGitLab(opts.gitlab ?? {})
  const known = opts.knownUsers ?? new Map<string, PersonUuid>()
  const identityStore = makeIdentityStore()
  const identity = new UserIdentity(
    new FakeAccountClient(known) as unknown as ConstructorParameters<typeof UserIdentity>[0],
    identityStore,
    WORKSPACE,
    60_000
  )

  const projectId = 42
  const hulyProjectRef = 'huly-proj-1' as unknown as Ref<Space>
  const statuses = makeStatuses()
  const labelCache = new LabelCache(projectId, hulyProjectRef)
  const milestoneCache = new MilestoneCache(projectId, hulyProjectRef)

  const bctx: MRBindingContext = {
    workspaceUuid: WORKSPACE,
    gitlabProjectId: projectId,
    gitlabProjectPath: 'group/proj',
    hulyProjectRef,
    hulyClient: huly,
    gitlabClient: gitlab as unknown as MRBindingContext['gitlabClient'],
    statuses,
    userIdentity: identity,
    labelCache,
    milestoneCache,
    defaultTaskType: 'task:taskType:default' as unknown as Ref<TaskType>,
    gitlabBaseUrl: 'https://gitlab.example',
    credentials: {
      resolveActorToken: opts.resolveActorToken ?? (async () => undefined)
    }
  }

  const enqueued: Array<{ binding: string, kind: string, record: Record<string, unknown> }> = []
  const manager = new MergeRequestsSyncManager({
    loadBinding: async () => bctx,
    enqueuer: {
      enqueueBackfillRecord: async (binding, kind, record) => {
        enqueued.push({ binding, kind, record })
      }
    }
  })

  const ctx: SyncContext = {
    workspaceUuid: WORKSPACE,
    logger: makeLogger(),
    store
  }

  return { manager, ctx, bctx, idmap, cursors, huly, gitlab, identity, identityStore, enqueued }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('1. create remote→local: applyRemote creates Issue + mixin with expected fields', async () => {
  const h = buildHarness()
  const mr = makeSyncMR({ title: 'Hello MR', sourceBranch: 'feat/a', targetBranch: 'main', webUrl: 'https://gitlab.example/mr/1' })
  await h.manager.applyRemote(h.ctx, 'binding-1', mr)

  expect(h.huly.creates).toBe(1)
  expect(h.huly.createMixinCalls).toHaveLength(1)

  const issueRef = Array.from(h.huly.issues.keys())[0]
  const issue = h.huly.issues.get(issueRef)
  expect(issue?.title).toBe('Hello MR')
  expect(String(issue?.status)).toBe('todo') // 'opened' → first Active-category match (todo)

  // C8: mixin round-trip — readback via fake.
  const mixin = h.huly.getMixin(issueRef as unknown as string) ?? {}
  expect(mixin.sourceBranch).toBe('feat/a')
  expect(mixin.targetBranch).toBe('main')
  expect(mixin.draft).toBe(false)
  expect(mixin.webUrl).toBe('https://gitlab.example/mr/1')
  expect(mixin.mergeStatus).toBe('can_be_merged')
  expect(mixin.mergedAt).toBeNull()

  // Mixin call referenced 'gitlab-mr' as the mixin id.
  expect(String(h.huly.createMixinCalls[0].mixin)).toBe('gitlab-mr')

  // idmap upserted with the merge_request kind.
  expect(h.idmap.docs).toHaveLength(1)
  expect(h.idmap.docs[0].gitlabKind).toBe('merge_request')
  expect(h.idmap.docs[0].gitlabId).toBe('42:1')
  expect(h.cursors.sets).toBeGreaterThan(0)
})

test('2. applyLocal with no mapping → NOOP: Phase 2 does NOT call createMergeRequest', async () => {
  const h = buildHarness()
  await h.manager.applyLocal(h.ctx, 'binding-1', 'mr:huly-orphan', {
    title: 'From Huly'
  })
  expect(h.gitlab.createMergeRequest).not.toHaveBeenCalled()
  expect(h.gitlab.updateMergeRequest).not.toHaveBeenCalled()
})

test('3. edit title round-trip: LWW per timestamp picks newer remote', async () => {
  const h = buildHarness()
  await h.manager.applyRemote(h.ctx, 'binding-1', makeSyncMR({ title: 'Initial' }))
  const ref = Array.from(h.huly.issues.keys())[0]

  await h.manager.applyRemote(h.ctx, 'binding-1', makeSyncMR({
    title: 'Newer remote',
    updatedAt: new Date('2024-01-02T10:00:00.000Z')
  }))
  expect(h.huly.issues.get(ref)?.title).toBe('Newer remote')

  // Local push: applyLocal forwards through updateMergeRequest.
  await h.manager.applyLocal(h.ctx, 'binding-1', `mr:${String(ref)}`, { title: 'Local title' })
  expect(h.gitlab.updateMergeRequest).toHaveBeenCalledTimes(1)
  expect(h.gitlab.updateMergeRequest.mock.calls[0][2].title).toBe('Local title')
})

test('4. edit description round-trip: markdown markup persists', async () => {
  const h = buildHarness()
  await h.manager.applyRemote(h.ctx, 'binding-1', makeSyncMR({
    description: '# Header\n\nBody with `code`'
  }))
  const ref = Array.from(h.huly.issues.keys())[0]
  const markup = h.huly.issues.get(ref)?.description ?? ''
  expect(markup.length).toBeGreaterThan(0)
  expect(markup).toContain('Header')

  await h.manager.applyLocal(h.ctx, 'binding-1', `mr:${String(ref)}`, { description: markup })
  const sent = h.gitlab.updateMergeRequest.mock.calls[0][2].description as string
  expect(sent).toContain('Header')
})

test('5. label autocreate on Huly side when GitLab brings new label', async () => {
  const h = buildHarness()
  await h.manager.applyRemote(h.ctx, 'binding-1', makeSyncMR({ labels: ['urgent', 'frontend'] }))
  const ref = Array.from(h.huly.issues.keys())[0]
  const labels = h.huly.issues.get(ref)?.labels ?? []
  expect(labels.length).toBeGreaterThanOrEqual(2)
})

test('6. milestone autocreate (Huly side from GitLab payload)', async () => {
  const h = buildHarness()
  await h.manager.applyRemote(h.ctx, 'binding-1', makeSyncMR({
    milestone: { iid: 1, title: 'v1.0' }
  }))
  const ref = Array.from(h.huly.issues.keys())[0]
  expect(h.huly.issues.get(ref)?.milestone).toBeTruthy()
})

test('7. assignee mapped via UserIdentity → PersonUuid attached', async () => {
  const known = new Map<string, PersonUuid>([
    ['gitlab:55', 'person-uuid-aaa' as unknown as PersonUuid]
  ])
  const h = buildHarness({ knownUsers: known })
  await h.manager.applyRemote(h.ctx, 'binding-1', makeSyncMR({
    assignees: [makeUser(55, 'matched@example.com')]
  }))
  const ref = Array.from(h.huly.issues.keys())[0]
  expect(h.huly.issues.get(ref)?.assignee).toBe('person-uuid-aaa')
})

test('8. Phase 3 regression: no synthetic gitlab:reviewer:* labels created on new MR', async () => {
  const h = buildHarness()
  const ensureSpy = jest.spyOn(h.bctx.labelCache, 'ensureLocalTag')
  await h.manager.applyRemote(h.ctx, 'binding-1', makeSyncMR({
    reviewers: [makeUser(101), makeUser(102)]
  }))
  const calledNames = ensureSpy.mock.calls.map((c) => c[1])
  // Phase 3 (P3-T-07): synthetic labels are GONE. Migration helper (P3-T-09)
  // strips legacy labels separately; applyRemote must NOT recreate them.
  expect(calledNames).not.toContain('gitlab:reviewer:user101')
  expect(calledNames).not.toContain('gitlab:reviewer:user102')
})

test('9. locked state: status unchanged, mergeStatus mixin field = "locked"', async () => {
  const h = buildHarness()
  // Seed an existing MR first.
  await h.manager.applyRemote(h.ctx, 'binding-1', makeSyncMR({ iid: 5, state: 'opened' }))
  const ref = Array.from(h.huly.issues.keys())[0]
  const initialStatus = h.huly.issues.get(ref)?.status
  expect(String(initialStatus)).toBe('todo')

  // Now arrive with locked state.
  await h.manager.applyRemote(h.ctx, 'binding-1', makeSyncMR({
    iid: 5,
    state: 'locked',
    mergeStatus: 'locked',
    updatedAt: new Date('2024-02-01T10:00:00.000Z')
  }))
  // Status must NOT change.
  expect(h.huly.issues.get(ref)?.status).toBe(initialStatus)
  // Mixin mergeStatus must reflect 'locked'.
  const mixin = h.huly.getMixin(ref as unknown as string) ?? {}
  expect(mixin.mergeStatus).toBe('locked')
})

test('10. merged state: status → Done, mergedAt mixin populated', async () => {
  const h = buildHarness()
  await h.manager.applyRemote(h.ctx, 'binding-1', makeSyncMR({ iid: 9, state: 'opened' }))
  const ref = Array.from(h.huly.issues.keys())[0]

  const mergedAtIso = new Date('2024-02-15T12:00:00.000Z')
  await h.manager.applyRemote(h.ctx, 'binding-1', makeSyncMR({
    iid: 9,
    state: 'merged',
    mergedAt: mergedAtIso,
    updatedAt: new Date('2024-02-15T12:00:00.000Z')
  }))
  expect(String(h.huly.issues.get(ref)?.status)).toBe('done')
  const mixin = h.huly.getMixin(ref as unknown as string) ?? {}
  expect(mixin.mergedAt).toEqual(mergedAtIso)
})

test('11. conflict different fields: local title preserved, remote description applied', async () => {
  const h = buildHarness()
  await h.manager.applyRemote(h.ctx, 'binding-1', makeSyncMR({
    title: 'Initial',
    description: 'old body',
    updatedAt: new Date('2024-01-01T10:00:00.000Z')
  }))
  const ref = Array.from(h.huly.issues.keys())[0]

  // Push a local title change first.
  await h.manager.applyLocal(h.ctx, 'binding-1', `mr:${String(ref)}`, { title: 'Local title' })

  // Now remote arrives — description differs, title agrees with local.
  const updatesBefore = h.huly.updates
  await h.manager.applyRemote(h.ctx, 'binding-1', makeSyncMR({
    title: 'Local title',
    description: 'new remote body',
    updatedAt: new Date('2024-01-02T10:00:00.000Z')
  }))
  expect(h.huly.updates).toBeGreaterThan(updatesBefore)
  expect(h.huly.issues.get(ref)?.title).toBe('Local title')
  expect(h.huly.issues.get(ref)?.description).toContain('new remote body')
})

test('12. conflict same field: newer remote timestamp wins', async () => {
  const h = buildHarness()
  await h.manager.applyRemote(h.ctx, 'binding-1', makeSyncMR({
    title: 'v1', updatedAt: new Date('2024-01-01T10:00:00.000Z')
  }))
  const ref = Array.from(h.huly.issues.keys())[0]

  await h.manager.applyRemote(h.ctx, 'binding-1', makeSyncMR({
    title: 'v2-remote', updatedAt: new Date('2024-01-02T10:00:00.000Z')
  }))
  expect(h.huly.issues.get(ref)?.title).toBe('v2-remote')
})

test('13. idempotent re-delivery: same MR twice → no extra Issue create', async () => {
  const h = buildHarness()
  const mr = makeSyncMR({ iid: 1, title: 'Idem' })
  await h.manager.applyRemote(h.ctx, 'binding-1', mr)
  const createsAfterFirst = h.huly.creates
  const updatesAfterFirst = h.huly.updates

  await h.manager.applyRemote(h.ctx, 'binding-1', mr)
  expect(h.huly.creates).toBe(createsAfterFirst)
  expect(h.huly.updates).toBe(updatesAfterFirst)
})

test('14. draft MR: priority Low + draft mixin field = true', async () => {
  const h = buildHarness()
  await h.manager.applyRemote(h.ctx, 'binding-1', makeSyncMR({ draft: true }))
  const ref = Array.from(h.huly.issues.keys())[0]
  expect(h.huly.issues.get(ref)?.priority).toBe(IssuePriority.Low)
  const mixin = h.huly.getMixin(ref as unknown as string) ?? {}
  expect(mixin.draft).toBe(true)
})

test('15. applyRemote does NOT write pipelineStatus on the mixin (critic C2)', async () => {
  const h = buildHarness()
  // First create the Issue + mixin
  await h.manager.applyRemote(h.ctx, 'binding-1', makeSyncMR({ iid: 7 }))
  const issueRef = Array.from(h.huly.issues.keys())[0]
  // Pre-seed pipelineStatus on the mixin (simulating a concurrent Pipeline write).
  h.huly.mixinByIssue.set(issueRef as unknown as string, {
    ...(h.huly.getMixin(issueRef as unknown as string) ?? {}),
    pipelineStatus: 'success'
  })

  // Now arrive with an update event.
  await h.manager.applyRemote(h.ctx, 'binding-1', makeSyncMR({
    iid: 7,
    title: 'updated',
    updatedAt: new Date('2024-03-01T10:00:00.000Z')
  }))

  // CRITICAL: not a single createMixin/updateMixin call includes `pipelineStatus`.
  for (const call of h.huly.createMixinCalls) {
    expect(Object.keys(call.attributes)).not.toContain('pipelineStatus')
  }
  for (const call of h.huly.updateMixinCalls) {
    expect(Object.keys(call.attributes)).not.toContain('pipelineStatus')
  }
  // Mixin readback retains the pre-seeded pipelineStatus (because mr.applyRemote
  // applies a delta, not a replace, in the fake).
  expect(h.huly.getMixin(issueRef as unknown as string)?.pipelineStatus).toBe('success')
})

test('16. Phase 3 regression: two reviewers do NOT create labels (typed field used instead)', async () => {
  const h = buildHarness()
  const ensureSpy = jest.spyOn(h.bctx.labelCache, 'ensureLocalTag')
  await h.manager.applyRemote(h.ctx, 'binding-1', makeSyncMR({
    reviewers: [makeUser(11), makeUser(12)]
  }))
  const calledNames = ensureSpy.mock.calls.map((c) => c[1])
  expect(calledNames).not.toContain('gitlab:reviewer:user11')
  expect(calledNames).not.toContain('gitlab:reviewer:user12')
})

test('17. empty description coalesces to "" without throwing', async () => {
  const h = buildHarness()
  // description omitted entirely
  const partial = { ...makeSyncMR(), description: '' }
  await h.manager.applyRemote(h.ctx, 'binding-1', partial)
  expect(h.huly.creates).toBe(1)
})

test('18. empty assignees → no UserIdentity calls; create succeeds', async () => {
  const h = buildHarness()
  const mapSpy = jest.spyOn(h.identity, 'mapByGitlabUser')
  const stubSpy = jest.spyOn(h.identity, 'ensureStubGuest')
  await h.manager.applyRemote(h.ctx, 'binding-1', makeSyncMR({ assignees: [] }))
  expect(mapSpy).not.toHaveBeenCalled()
  expect(stubSpy).not.toHaveBeenCalled()
  const ref = Array.from(h.huly.issues.keys())[0]
  expect(h.huly.issues.get(ref)?.assignee).toBeNull()
})

test('resolveMRRef: returns undefined for unknown iid', async () => {
  const h = buildHarness()
  const ref = await resolveMRRef(h.ctx, { gitlabProjectId: 42 }, 999)
  expect(ref).toBeUndefined()
})

test('resolveMRRef: returns mapped ref after applyRemote', async () => {
  const h = buildHarness()
  await h.manager.applyRemote(h.ctx, 'binding-1', makeSyncMR({ iid: 88 }))
  const ref = await resolveMRRef(h.ctx, { gitlabProjectId: 42 }, 88)
  expect(ref).toBeDefined()
  expect(String(ref)).toMatch(/huly-issue-/)
})

test('backfill: enqueues each MR from listMergeRequests as a remote event', async () => {
  const h = buildHarness({
    gitlab: {
      listMergeRequests: jest.fn().mockResolvedValue([
        makeSyncMR({ iid: 1 }),
        makeSyncMR({ iid: 2 })
      ])
    }
  })
  await h.manager.backfill(h.ctx, 'binding-1', new Date('2024-01-01T00:00:00Z'))
  expect(h.enqueued).toHaveLength(2)
  expect(h.enqueued.every((e) => e.kind === 'merge_request')).toBe(true)
})

test('backfill: passes since as updatedAfter Date to listMergeRequests', async () => {
  const listMock = jest.fn().mockResolvedValue([])
  const h = buildHarness({ gitlab: { listMergeRequests: listMock } })
  const since = new Date('2024-06-15T00:00:00Z')
  await h.manager.backfill(h.ctx, 'binding-1', since)
  expect(listMock).toHaveBeenCalledWith(42, { updatedAfter: since })
})

// ---------------------------------------------------------------------------
// Phase 3 (P3-T-07) — typed reviewers, approvals two-way, diff metadata
// ---------------------------------------------------------------------------

import {
  getApprovalServiceAccountFallbackCount,
  resetApprovalServiceAccountFallbackCount
} from '../../src/sync/mr'
import { ApprovalActionError } from '../../src/adapter/errors'

beforeEach(() => {
  resetApprovalServiceAccountFallbackCount()
})

test('P3-1. applyRemote populates typed reviewers from syncMR.reviewers', async () => {
  const known = new Map<string, PersonUuid>([
    ['gitlab:201', 'person-r1' as unknown as PersonUuid],
    ['gitlab:202', 'person-r2' as unknown as PersonUuid]
  ])
  const h = buildHarness({ knownUsers: known })
  await h.manager.applyRemote(h.ctx, 'binding-1', makeSyncMR({
    reviewers: [makeUser(201), makeUser(202)]
  }))
  const issueRef = Array.from(h.huly.issues.keys())[0]
  const mixin = h.huly.getMixin(issueRef as unknown as string) ?? {}
  expect(mixin.reviewers).toEqual(['person-r1', 'person-r2'])
})

test('P3-2. applyRemote populates approvedBy + approvalsRequired + approvalStatus=approved when threshold met', async () => {
  const known = new Map<string, PersonUuid>([
    ['gitlab:301', 'person-a1' as unknown as PersonUuid]
  ])
  const h = buildHarness({ knownUsers: known })
  await h.manager.applyRemote(h.ctx, 'binding-1', makeSyncMR({
    approvedBy: [makeUser(301)],
    approvalsRequired: 1
  }))
  const issueRef = Array.from(h.huly.issues.keys())[0]
  const mixin = h.huly.getMixin(issueRef as unknown as string) ?? {}
  expect(mixin.approvedBy).toEqual(['person-a1'])
  expect(mixin.approvalsRequired).toBe(1)
  expect(mixin.approvalStatus).toBe('approved')
})

test('P3-3. applyRemote approvalStatus=pending when approvedBy < approvalsRequired', async () => {
  const h = buildHarness()
  await h.manager.applyRemote(h.ctx, 'binding-1', makeSyncMR({
    approvedBy: [],
    approvalsRequired: 2
  }))
  const issueRef = Array.from(h.huly.issues.keys())[0]
  const mixin = h.huly.getMixin(issueRef as unknown as string) ?? {}
  expect(mixin.approvalStatus).toBe('pending')
})

test('P3-4. applyRemote approvalStatus=pending when approvalsRequired=0', async () => {
  const known = new Map<string, PersonUuid>([
    ['gitlab:401', 'person-x1' as unknown as PersonUuid]
  ])
  const h = buildHarness({ knownUsers: known })
  await h.manager.applyRemote(h.ctx, 'binding-1', makeSyncMR({
    approvedBy: [makeUser(401)],
    approvalsRequired: 0
  }))
  const issueRef = Array.from(h.huly.issues.keys())[0]
  const mixin = h.huly.getMixin(issueRef as unknown as string) ?? {}
  expect(mixin.approvalStatus).toBe('pending')
})

test('P3-5. applyRemote populates diffWebUrl + changedFiles from composite fetch', async () => {
  const h = buildHarness()
  await h.manager.applyRemote(h.ctx, 'binding-1', makeSyncMR({
    diffWebUrl: 'https://gitlab.example/mr/1/diffs',
    changedFiles: [
      { path: 'a.ts', additions: 5, deletions: 1, status: 'modified' },
      { path: 'b.ts', additions: 10, deletions: 0, status: 'added' }
    ]
  }))
  const issueRef = Array.from(h.huly.issues.keys())[0]
  const mixin = h.huly.getMixin(issueRef as unknown as string) ?? {}
  expect(mixin.diffWebUrl).toBe('https://gitlab.example/mr/1/diffs')
  expect((mixin.changedFiles as unknown[]).length).toBe(2)
})

test('P3-6. applyRemote with syncMR.reviewers=undefined preserves existing mixin reviewers (B2)', async () => {
  const known = new Map<string, PersonUuid>([
    ['gitlab:501', 'person-pre1' as unknown as PersonUuid],
    ['gitlab:502', 'person-pre2' as unknown as PersonUuid]
  ])
  const h = buildHarness({ knownUsers: known })
  // 1st applyRemote with reviewers populated.
  await h.manager.applyRemote(h.ctx, 'binding-1', makeSyncMR({
    iid: 50,
    reviewers: [makeUser(501), makeUser(502)]
  }))
  const issueRef = Array.from(h.huly.issues.keys())[0]
  expect((h.huly.getMixin(issueRef as unknown as string) ?? {}).reviewers).toEqual(['person-pre1', 'person-pre2'])

  // 2nd applyRemote with reviewers undefined (e.g. listMergeRequests intermediate state).
  const mrNoReviewers = makeSyncMR({
    iid: 50,
    updatedAt: new Date('2024-05-01T10:00:00.000Z')
  })
  delete (mrNoReviewers as { reviewers?: unknown }).reviewers
  await h.manager.applyRemote(h.ctx, 'binding-1', mrNoReviewers)

  // Mixin retains the seeded reviewers.
  expect((h.huly.getMixin(issueRef as unknown as string) ?? {}).reviewers).toEqual(['person-pre1', 'person-pre2'])
})

test('P3-7. applyLocal add to approvedBy → calls approveMR; no stored token → service-account fallback', async () => {
  const h = buildHarness()
  // First create the MR via applyRemote.
  await h.manager.applyRemote(h.ctx, 'binding-1', makeSyncMR({ iid: 70 }))
  const issueRef = Array.from(h.huly.issues.keys())[0]

  await h.manager.applyLocal(
    h.ctx,
    'binding-1',
    `mr:${String(issueRef)}`,
    { approvedBy: ['person-new' as unknown as PersonUuid] as unknown }
  )
  expect(h.gitlab.approveMR).toHaveBeenCalledTimes(1)
  expect(h.gitlab.approveMR).toHaveBeenCalledWith(42, 70, undefined)
  expect(getApprovalServiceAccountFallbackCount()).toBe(1)
  // Visibility comment posted: one createDoc call on ChatMessage class (counter on aux-ref-*).
  // We just assert createMixin was still 1 (issue creation only — no extra mixins).
  expect(h.huly.createMixinCalls.length).toBe(1)
})

test('P3-8. applyLocal add with stored OAuth token → calls approveMR with actorToken', async () => {
  const tokenResolver = jest.fn(async () => 'oauth-token-abc')
  const h = buildHarness({ resolveActorToken: tokenResolver })
  await h.manager.applyRemote(h.ctx, 'binding-1', makeSyncMR({ iid: 71 }))
  const issueRef = Array.from(h.huly.issues.keys())[0]

  await h.manager.applyLocal(
    h.ctx,
    'binding-1',
    `mr:${String(issueRef)}`,
    { approvedBy: ['person-with-oauth' as unknown as PersonUuid] as unknown }
  )
  expect(h.gitlab.approveMR).toHaveBeenCalledTimes(1)
  expect(h.gitlab.approveMR).toHaveBeenCalledWith(42, 71, 'oauth-token-abc')
  expect(getApprovalServiceAccountFallbackCount()).toBe(0)
})

test('P3-9. applyLocal remove from approvedBy → calls unapproveMR', async () => {
  const known = new Map<string, PersonUuid>([
    ['gitlab:801', 'person-rm-1' as unknown as PersonUuid]
  ])
  const h = buildHarness({ knownUsers: known })
  // Seed an MR with one approver.
  await h.manager.applyRemote(h.ctx, 'binding-1', makeSyncMR({
    iid: 80,
    approvedBy: [makeUser(801)],
    approvalsRequired: 1
  }))
  const issueRef = Array.from(h.huly.issues.keys())[0]

  // Now Huly clears the approver list.
  await h.manager.applyLocal(
    h.ctx,
    'binding-1',
    `mr:${String(issueRef)}`,
    { approvedBy: [] as PersonUuid[] }
  )
  expect(h.gitlab.unapproveMR).toHaveBeenCalledTimes(1)
  expect(h.gitlab.unapproveMR).toHaveBeenCalledWith(42, 80, undefined)
  expect(h.gitlab.approveMR).not.toHaveBeenCalled()
})

test('P3-10. applyLocal mixed add+remove → both approve and unapprove called', async () => {
  const known = new Map<string, PersonUuid>([
    ['gitlab:901', 'person-keep' as unknown as PersonUuid],
    ['gitlab:902', 'person-leave' as unknown as PersonUuid]
  ])
  const h = buildHarness({ knownUsers: known })
  await h.manager.applyRemote(h.ctx, 'binding-1', makeSyncMR({
    iid: 90,
    approvedBy: [makeUser(901), makeUser(902)],
    approvalsRequired: 2
  }))
  const issueRef = Array.from(h.huly.issues.keys())[0]

  // Replace person-leave with a new approver person-new.
  await h.manager.applyLocal(
    h.ctx,
    'binding-1',
    `mr:${String(issueRef)}`,
    {
      approvedBy: [
        'person-keep' as unknown as PersonUuid,
        'person-new' as unknown as PersonUuid
      ] as unknown
    }
  )
  expect(h.gitlab.approveMR).toHaveBeenCalledTimes(1)
  expect(h.gitlab.unapproveMR).toHaveBeenCalledTimes(1)
})

test('P3-11. applyLocal ApprovalActionError is caught — no crash, no rethrow (best-effort)', async () => {
  const failingGitlab: Partial<FakeGitLab> = {
    approveMR: jest.fn().mockRejectedValue(
      new ApprovalActionError('approve', '42', 99, 'GitLab 500')
    )
  }
  const h = buildHarness({ gitlab: failingGitlab })
  await h.manager.applyRemote(h.ctx, 'binding-1', makeSyncMR({ iid: 99 }))
  const issueRef = Array.from(h.huly.issues.keys())[0]

  // The call should not throw — the manager swallows ApprovalActionError.
  await expect(h.manager.applyLocal(
    h.ctx,
    'binding-1',
    `mr:${String(issueRef)}`,
    { approvedBy: ['person-x' as unknown as PersonUuid] as unknown }
  )).resolves.toBeUndefined()
  expect(h.gitlab.approveMR).toHaveBeenCalledTimes(1)
})

test('P3-12. applyLocal change.reviewers set → warn logged, no GitLab call (Phase 3 deferred)', async () => {
  const h = buildHarness()
  const warnSpy = jest.spyOn(h.ctx.logger, 'warn')
  await h.manager.applyRemote(h.ctx, 'binding-1', makeSyncMR({ iid: 120 }))
  const issueRef = Array.from(h.huly.issues.keys())[0]

  await h.manager.applyLocal(
    h.ctx,
    'binding-1',
    `mr:${String(issueRef)}`,
    { reviewers: ['person-new-rev' as unknown as PersonUuid] as unknown }
  )
  // No approve/unapprove and no MR update for reviewer-only change.
  expect(h.gitlab.approveMR).not.toHaveBeenCalled()
  expect(h.gitlab.unapproveMR).not.toHaveBeenCalled()
  expect(h.gitlab.updateMergeRequest).not.toHaveBeenCalled()
  // The "unsynced" warn must fire.
  const reviewerWarn = warnSpy.mock.calls.find(
    (c) => String(c[0]).includes('mr.reviewers.huly.unsynced')
  )
  expect(reviewerWarn).toBeDefined()
})

test('P3-13. C2 isolation regression: applyRemote NEVER writes pipelineStatus (Phase 3 extension)', async () => {
  const h = buildHarness()
  await h.manager.applyRemote(h.ctx, 'binding-1', makeSyncMR({
    iid: 130,
    approvedBy: [makeUser(1300)],
    approvalsRequired: 1,
    diffWebUrl: 'https://gitlab.example/mr/130/diffs',
    changedFiles: [{ path: 'x.ts', additions: 1, deletions: 0, status: 'added' }],
    reviewers: [makeUser(1301)]
  }))
  for (const call of h.huly.createMixinCalls) {
    expect(Object.keys(call.attributes)).not.toContain('pipelineStatus')
  }
  for (const call of h.huly.updateMixinCalls) {
    expect(Object.keys(call.attributes)).not.toContain('pipelineStatus')
  }
})

test('P3-14. C10 race: local approvedBy=2, remote=1 within 30s → KEEP local 2', async () => {
  const known = new Map<string, PersonUuid>([
    ['gitlab:1401', 'person-r1' as unknown as PersonUuid]
  ])
  const h = buildHarness({ knownUsers: known })
  // First seed: create the MR (no approvers; modifiedOn = remoteTs of initial).
  await h.manager.applyRemote(h.ctx, 'binding-1', makeSyncMR({
    iid: 140,
    updatedAt: new Date('2024-01-01T10:00:00.000Z')
  }))
  const issueRef = Array.from(h.huly.issues.keys())[0]

  // Pre-seed mixin with 2 local approvers and bump Issue modifiedOn to "now"
  // (simulating an in-flight approveMR round-trip).
  h.huly.mixinByIssue.set(issueRef as unknown as string, {
    ...(h.huly.getMixin(issueRef as unknown as string) ?? {}),
    approvedBy: ['local-a', 'local-b']
  })
  const issue = h.huly.issues.get(issueRef)
  if (issue !== undefined) {
    h.huly.issues.set(issueRef, { ...issue, modifiedOn: Date.now() } as Issue)
  }

  // Remote arrives with only 1 approver and a stale timestamp (older than now).
  await h.manager.applyRemote(h.ctx, 'binding-1', makeSyncMR({
    iid: 140,
    approvedBy: [makeUser(1401)],
    approvalsRequired: 1,
    updatedAt: new Date(Date.now() - 5_000) // 5s old
  }))

  // Mixin retains the locally-tracked 2 approvers.
  const mixin = h.huly.getMixin(issueRef as unknown as string) ?? {}
  expect(mixin.approvedBy).toEqual(['local-a', 'local-b'])
})

test('P3-15. C10 race: local approvedBy=2 BUT older than 30s window → take remote 1', async () => {
  const known = new Map<string, PersonUuid>([
    ['gitlab:1501', 'person-remote1' as unknown as PersonUuid]
  ])
  const h = buildHarness({ knownUsers: known })
  await h.manager.applyRemote(h.ctx, 'binding-1', makeSyncMR({
    iid: 150,
    updatedAt: new Date('2024-01-01T10:00:00.000Z')
  }))
  const issueRef = Array.from(h.huly.issues.keys())[0]

  h.huly.mixinByIssue.set(issueRef as unknown as string, {
    ...(h.huly.getMixin(issueRef as unknown as string) ?? {}),
    approvedBy: ['local-a', 'local-b']
  })
  // Set Issue modifiedOn 10 minutes ago — OUTSIDE the 30s race window.
  const issue = h.huly.issues.get(issueRef)
  if (issue !== undefined) {
    h.huly.issues.set(issueRef, { ...issue, modifiedOn: Date.now() - 10 * 60_000 } as Issue)
  }

  await h.manager.applyRemote(h.ctx, 'binding-1', makeSyncMR({
    iid: 150,
    approvedBy: [makeUser(1501)],
    approvalsRequired: 1,
    updatedAt: new Date()
  }))

  const mixin = h.huly.getMixin(issueRef as unknown as string) ?? {}
  expect(mixin.approvedBy).toEqual(['person-remote1'])
})

// ---------------------------------------------------------------------------
// Phase 4 (P4-T-08) — EE field extensions: approvalRules, iteration; AC-1
// single-writer invariant for parentEpicIid; Bug-4 CE regression.
// ---------------------------------------------------------------------------

function makeApprovalRule (overrides: Partial<SyncMRApprovalRule> = {}): SyncMRApprovalRule {
  return {
    id: 1,
    name: 'Default',
    ruleType: 'regular',
    eligibleApprovers: [],
    approvalsRequired: 1,
    approvedBy: [],
    ...overrides
  }
}

function makeIteration (overrides: Partial<SyncIteration> = {}): SyncIteration {
  return {
    id: 'gid://gitlab/Iteration/1',
    title: 'Sprint 1',
    startDate: new Date('2024-04-01T00:00:00.000Z'),
    dueDate: new Date('2024-04-14T00:00:00.000Z'),
    state: 'started',
    webUrl: 'https://gitlab.example/groups/g/-/iterations/1',
    ...overrides
  }
}

test('P4-1. applyRemote writes approvalRules mixin field with EE rule data', async () => {
  const h = buildHarness()
  const rules: SyncMRApprovalRule[] = [
    makeApprovalRule({
      id: 11,
      name: 'Backend',
      ruleType: 'regular',
      eligibleApprovers: [makeUser(601), makeUser(602)],
      approvalsRequired: 2,
      approvedBy: [makeUser(601)]
    }),
    makeApprovalRule({
      id: 12,
      name: 'Code owners',
      ruleType: 'code_owner',
      eligibleApprovers: [makeUser(603)],
      approvalsRequired: 1,
      approvedBy: [makeUser(603)]
    })
  ]
  await h.manager.applyRemote(h.ctx, 'binding-1', makeSyncMR({
    iid: 601,
    approvalRules: rules
  }))
  const issueRef = Array.from(h.huly.issues.keys())[0]
  const mixin = h.huly.getMixin(issueRef as unknown as string) ?? {}
  const written = mixin.approvalRules as SyncMRApprovalRule[]
  expect(written).toHaveLength(2)
  expect(written[0].id).toBe(11)
  expect(written[0].name).toBe('Backend')
  expect(written[0].ruleType).toBe('regular')
  expect(written[0].approvalsRequired).toBe(2)
  expect(written[0].approvedBy.map((u) => u.id)).toEqual([601])
  expect(written[0].eligibleApprovers.map((u) => u.id)).toEqual([601, 602])
  expect(written[1].id).toBe(12)
  expect(written[1].ruleType).toBe('code_owner')
})

test('P4-2. approvalStatus="approved" when every EE rule meets its threshold', async () => {
  const h = buildHarness()
  const rules: SyncMRApprovalRule[] = [
    makeApprovalRule({
      id: 21, name: 'A', approvalsRequired: 1, approvedBy: [makeUser(701)]
    }),
    makeApprovalRule({
      id: 22, name: 'B', approvalsRequired: 2, approvedBy: [makeUser(702), makeUser(703)]
    })
  ]
  await h.manager.applyRemote(h.ctx, 'binding-1', makeSyncMR({
    iid: 602,
    approvalRules: rules
  }))
  const issueRef = Array.from(h.huly.issues.keys())[0]
  const mixin = h.huly.getMixin(issueRef as unknown as string) ?? {}
  expect(mixin.approvalStatus).toBe('approved')
})

test('P4-3. approvalStatus="pending" when any EE rule under-approved', async () => {
  const h = buildHarness()
  const rules: SyncMRApprovalRule[] = [
    makeApprovalRule({
      id: 31, name: 'A', approvalsRequired: 1, approvedBy: [makeUser(801)]
    }),
    makeApprovalRule({
      id: 32, name: 'B', approvalsRequired: 2, approvedBy: [makeUser(802)]
    })
  ]
  await h.manager.applyRemote(h.ctx, 'binding-1', makeSyncMR({
    iid: 603,
    approvalRules: rules
  }))
  const issueRef = Array.from(h.huly.issues.keys())[0]
  const mixin = h.huly.getMixin(issueRef as unknown as string) ?? {}
  expect(mixin.approvalStatus).toBe('pending')
})

test('P4-4. Bug-4 CE regression: approvalRules=undefined uses Phase 3 CE derivation (approved)', async () => {
  const known = new Map<string, PersonUuid>([
    ['gitlab:901', 'person-ce-a' as unknown as PersonUuid]
  ])
  const h = buildHarness({ knownUsers: known })
  await h.manager.applyRemote(h.ctx, 'binding-1', makeSyncMR({
    iid: 604,
    approvedBy: [makeUser(901)],
    approvalsRequired: 1
    // approvalRules intentionally omitted (CE path)
  }))
  const issueRef = Array.from(h.huly.issues.keys())[0]
  const mixin = h.huly.getMixin(issueRef as unknown as string) ?? {}
  expect(mixin.approvalRules).toBeUndefined()
  expect(mixin.approvalStatus).toBe('approved')
})

test('P4-5. Bug-4 CE regression: empty approvalRules array falls back to CE derivation', async () => {
  const known = new Map<string, PersonUuid>([
    ['gitlab:1001', 'person-ce-b' as unknown as PersonUuid]
  ])
  const h = buildHarness({ knownUsers: known })
  await h.manager.applyRemote(h.ctx, 'binding-1', makeSyncMR({
    iid: 605,
    approvedBy: [makeUser(1001)],
    approvalsRequired: 2,
    approvalRules: [] // EE returns []; CE falls through
  }))
  const issueRef = Array.from(h.huly.issues.keys())[0]
  const mixin = h.huly.getMixin(issueRef as unknown as string) ?? {}
  // Empty rules array is written as-is (B2: defined input is materialized).
  expect(mixin.approvalRules).toEqual([])
  // Status falls back to Phase 3 CE derivation: 1 approver < 2 required.
  expect(mixin.approvalStatus).toBe('pending')
})

test('P4-6. applyRemote writes iteration mixin field from syncMR.iteration', async () => {
  const h = buildHarness()
  const iteration = makeIteration({
    id: 'gid://gitlab/Iteration/77',
    title: 'Sprint 77',
    state: 'started'
  })
  await h.manager.applyRemote(h.ctx, 'binding-1', makeSyncMR({
    iid: 606,
    iteration
  }))
  const issueRef = Array.from(h.huly.issues.keys())[0]
  const mixin = h.huly.getMixin(issueRef as unknown as string) ?? {}
  const written = mixin.iteration as SyncIteration | null
  expect(written).not.toBeNull()
  expect(written?.id).toBe('gid://gitlab/Iteration/77')
  expect(written?.title).toBe('Sprint 77')
  expect(written?.state).toBe('started')
})

test('P4-7. iteration=null clears the field (explicit null write)', async () => {
  const h = buildHarness()
  // First create with an iteration.
  await h.manager.applyRemote(h.ctx, 'binding-1', makeSyncMR({
    iid: 607,
    iteration: makeIteration()
  }))
  const issueRef = Array.from(h.huly.issues.keys())[0]
  expect((h.huly.getMixin(issueRef as unknown as string) ?? {}).iteration).toBeTruthy()

  // Now apply with iteration explicitly null.
  await h.manager.applyRemote(h.ctx, 'binding-1', makeSyncMR({
    iid: 607,
    iteration: null,
    updatedAt: new Date('2024-05-01T10:00:00.000Z')
  }))
  // The last updateMixin call MUST carry an explicit iteration: null.
  const last = h.huly.updateMixinCalls[h.huly.updateMixinCalls.length - 1]
  expect(Object.keys(last.attributes)).toContain('iteration')
  expect(last.attributes.iteration).toBeNull()
})

test('P4-8. AC-1 single-writer: applyRemote NEVER writes parentEpicIid mixin field', async () => {
  const h = buildHarness()
  // Synthetic input: a SyncMergeRequest with a stray parentEpicIid attached.
  // The adapter type does not declare this field, so we coerce via cast to
  // exercise the runtime guard.
  const synthetic = makeSyncMR({
    iid: 608,
    approvalRules: [makeApprovalRule({ id: 41 })],
    iteration: makeIteration()
  }) as unknown as Record<string, unknown>
  synthetic.parentEpicIid = 7
  await h.manager.applyRemote(h.ctx, 'binding-1', synthetic as unknown as SyncMergeRequest)

  // Run an update to flush the updateMixin path as well.
  const updated = makeSyncMR({
    iid: 608,
    title: 'changed',
    updatedAt: new Date('2024-06-01T10:00:00.000Z'),
    approvalRules: [makeApprovalRule({ id: 41, approvedBy: [makeUser(101)] })]
  }) as unknown as Record<string, unknown>
  updated.parentEpicIid = 9
  await h.manager.applyRemote(h.ctx, 'binding-1', updated as unknown as SyncMergeRequest)

  for (const call of h.huly.createMixinCalls) {
    expect(Object.keys(call.attributes)).not.toContain('parentEpicIid')
  }
  for (const call of h.huly.updateMixinCalls) {
    expect(Object.keys(call.attributes)).not.toContain('parentEpicIid')
  }
})

test('P4-9. Phase 3 baseline regression: rules+approvedBy both undefined → existing behavior unchanged', async () => {
  const h = buildHarness()
  // No EE fields, no approvedBy/approvalsRequired — pure Phase 2 shape.
  await h.manager.applyRemote(h.ctx, 'binding-1', makeSyncMR({
    iid: 609,
    title: 'baseline'
  }))
  const issueRef = Array.from(h.huly.issues.keys())[0]
  const mixin = h.huly.getMixin(issueRef as unknown as string) ?? {}
  expect(mixin.approvalRules).toBeUndefined()
  expect(mixin.iteration).toBeUndefined()
  expect(mixin.approvalStatus).toBeUndefined()
  expect(mixin.approvedBy).toBeUndefined()
  expect(mixin.approvalsRequired).toBeUndefined()
  // createMixin attributes also do NOT include these keys.
  const createAttrs = h.huly.createMixinCalls[0].attributes
  expect(Object.keys(createAttrs)).not.toContain('approvalRules')
  expect(Object.keys(createAttrs)).not.toContain('iteration')
  expect(Object.keys(createAttrs)).not.toContain('approvalStatus')
  expect(Object.keys(createAttrs)).not.toContain('parentEpicIid')
})

test('P4-10. CE approvalStatus derivation matches Phase 3 (Bug-4 explicit regression replay)', async () => {
  // Replay of Phase 3 case P3-2 fixture against the new rule-aware path:
  // when approvalRules is undefined (CE), the result MUST be identical.
  const known = new Map<string, PersonUuid>([
    ['gitlab:301', 'person-a1' as unknown as PersonUuid]
  ])
  const h = buildHarness({ knownUsers: known })
  await h.manager.applyRemote(h.ctx, 'binding-1', makeSyncMR({
    iid: 610,
    approvedBy: [makeUser(301)],
    approvalsRequired: 1
  }))
  const issueRef = Array.from(h.huly.issues.keys())[0]
  const mixin = h.huly.getMixin(issueRef as unknown as string) ?? {}
  expect(mixin.approvedBy).toEqual(['person-a1'])
  expect(mixin.approvalsRequired).toBe(1)
  expect(mixin.approvalStatus).toBe('approved')
})
