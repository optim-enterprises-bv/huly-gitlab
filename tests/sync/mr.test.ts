import { type Collection } from 'mongodb'
import { ObjectId } from 'mongodb'
import type { PersonUuid, Ref, Space, TxOperations, WorkspaceUuid } from '@hcengineering/core'
import type { Issue, Status, TaskType } from '@hcengineering/tracker'
import { IssuePriority } from '@hcengineering/tracker'
import type { Store } from '../../src/state/store'
import type { Logger } from '../../src/logging'
import type { IdMapDoc } from '../../src/state/idmap'
import type { CursorDoc } from '../../src/state/cursors'
import type { SyncMergeRequest, SyncMilestone, SyncUser as AdapterUser } from '../../src/adapter/types'
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
      if (q._id !== undefined) return issues.get(q._id)
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
    gitlabBaseUrl: 'https://gitlab.example'
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

test('8. reviewer mapping → synthetic gitlab:reviewer:<u> label created (critic C4)', async () => {
  const h = buildHarness()
  const ensureSpy = jest.spyOn(h.bctx.labelCache, 'ensureLocalTag')
  await h.manager.applyRemote(h.ctx, 'binding-1', makeSyncMR({
    reviewers: [makeUser(101), makeUser(102)]
  }))
  // Reviewer labels must be created with the synthetic prefix.
  const calledNames = ensureSpy.mock.calls.map((c) => c[1])
  expect(calledNames).toContain('gitlab:reviewer:user101')
  expect(calledNames).toContain('gitlab:reviewer:user102')
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

test('16. two reviewers → two synthetic labels via LabelCache.ensureLocalTag', async () => {
  const h = buildHarness()
  const ensureSpy = jest.spyOn(h.bctx.labelCache, 'ensureLocalTag')
  await h.manager.applyRemote(h.ctx, 'binding-1', makeSyncMR({
    reviewers: [makeUser(11), makeUser(12)]
  }))
  const calledNames = ensureSpy.mock.calls.map((c) => c[1])
  expect(calledNames).toContain('gitlab:reviewer:user11')
  expect(calledNames).toContain('gitlab:reviewer:user12')
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
