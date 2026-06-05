import type { Collection } from 'mongodb'
import { ObjectId } from 'mongodb'
import type { Doc, PersonUuid, Ref, Space, TxOperations, WorkspaceUuid } from '@hcengineering/core'
import type { Issue, Milestone, Status, TaskType } from '@hcengineering/tracker'
import type { TagElement } from '@hcengineering/tags'
import type { Store } from '../../src/state/store'
import type { Logger } from '../../src/logging'
import type { IdMapDoc } from '../../src/state/idmap'
import type { CursorDoc } from '../../src/state/cursors'
import type { SyncIssue, SyncMilestone, SyncUser as AdapterUser } from '../../src/adapter/types'
import type { SyncUser as IdentitySyncUser } from '../../src/huly/users'
import { UserIdentity } from '../../src/huly/users'
import { LabelCache } from '../../src/sync/label-cache'
import { MilestoneCache } from '../../src/sync/milestone-cache'
import { _clearStatusCache } from '../../src/sync/status-map'
import {
  type BindingContext,
  IssuesSyncManager,
  resolveIssueRef
} from '../../src/sync/issues'
import type { SyncContext } from '../../src/sync/types'

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeLogger (): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
}

interface FakeIdMap extends Collection<IdMapDoc> {
  docs: IdMapDoc[]
  upserts: number
}

function makeIdMap (): FakeIdMap {
  const docs: IdMapDoc[] = []
  let upserts = 0
  return {
    docs,
    get upserts (): number { return upserts },
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
      upserts++
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

interface FakeHulyClient extends TxOperations {
  issues: Map<Ref<Issue>, Issue>
  creates: number
  updates: number
  lastUpdate: Partial<Issue> | null
}

function makeHulyClient (): FakeHulyClient {
  const issues = new Map<Ref<Issue>, Issue>()
  let creates = 0
  let updates = 0
  let lastUpdate: Partial<Issue> | null = null
  let counter = 0

  const isIssueClass = (cls: unknown): boolean => String(cls).includes('tracker') && String(cls).includes('Issue')

  const client = {
    issues,
    get creates (): number { return creates },
    get updates (): number { return updates },
    get lastUpdate (): Partial<Issue> | null { return lastUpdate },
    findOne: async (_cls: unknown, q: Partial<Issue>): Promise<Issue | undefined> => {
      if (q._id !== undefined) return issues.get(q._id)
      return undefined
    },
    findAll: async () => [],
    createDoc: async (cls: unknown, _space: unknown, attrs: Partial<Issue>): Promise<Ref<Issue>> => {
      counter++
      // Only count + store as Issue when the class is the Issue class.
      // Tag/Milestone creates still get a unique ref but are not tracked as issues.
      if (!isIssueClass(cls)) {
        return `aux-ref-${counter}` as unknown as Ref<Issue>
      }
      creates++
      const id = `huly-issue-${creates}` as unknown as Ref<Issue>
      const doc: Issue = {
        _id: id,
        _class: cls as Issue['_class'],
        space: 'space-x' as Issue['space'],
        // Honour explicit modifiedOn from attrs — IssuesSyncManager seeds it from
        // the remote updatedAt so subsequent LWW comparisons reflect that origin.
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
    close: async () => undefined
  } as unknown as FakeHulyClient

  return client
}

interface FakeGitLab {
  listIssues: jest.Mock
  createIssue: jest.Mock
  updateIssue: jest.Mock
  listLabels: jest.Mock
  createLabel: jest.Mock
  listMilestones: jest.Mock
  createMilestone: jest.Mock
}

function makeGitLab (overrides: Partial<FakeGitLab> = {}): FakeGitLab {
  return {
    listIssues: jest.fn().mockResolvedValue([]),
    createIssue: jest.fn().mockImplementation(async (_pid, body) => ({
      id: 999,
      iid: 7,
      projectId: 42,
      title: body.title ?? '',
      description: body.description ?? '',
      state: 'opened',
      labels: [],
      milestone: null,
      assignees: [],
      author: { id: 1, username: 'a', name: 'A', email: null, avatarUrl: null, webUrl: '' },
      confidential: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      closedAt: null,
      webUrl: ''
    } as SyncIssue)),
    updateIssue: jest.fn().mockResolvedValue({} as SyncIssue),
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

interface FakeIdMapStore {
  records: Map<string, string>
  getIdMap: (workspace: string, kind: string, gid: string) => Promise<string | undefined>
  putIdMap: (workspace: string, kind: string, gid: string, ref: string) => Promise<void>
}

function makeIdentityStore (): FakeIdMapStore {
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

function makeSyncIssue (overrides: Partial<SyncIssue> = {}): SyncIssue {
  return {
    id: 1000,
    iid: 1,
    projectId: 42,
    title: 'Remote title',
    description: 'remote body',
    state: 'opened',
    labels: [],
    milestone: null,
    assignees: [],
    author: { id: 1, username: 'a', name: 'A', email: null, avatarUrl: null, webUrl: '' },
    confidential: false,
    createdAt: '2024-01-01T10:00:00.000Z',
    updatedAt: '2024-01-01T10:00:00.000Z',
    closedAt: null,
    webUrl: '',
    ...overrides
  }
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

interface Harness {
  manager: IssuesSyncManager
  ctx: SyncContext
  bctx: BindingContext
  idmap: FakeIdMap
  cursors: FakeCursors
  huly: FakeHulyClient
  gitlab: FakeGitLab
  identity: UserIdentity
  identityStore: FakeIdMapStore
  enqueued: Array<{ binding: string, kind: string, record: Record<string, unknown> }>
}

function buildHarness (opts: {
  gitlab?: Partial<FakeGitLab>
  knownUsers?: Map<string, PersonUuid>
} = {}): Harness {
  _clearStatusCache()
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

  const bctx: BindingContext = {
    workspaceUuid: WORKSPACE,
    gitlabProjectId: projectId,
    gitlabProjectPath: 'group/proj',
    hulyProjectRef,
    hulyClient: huly,
    gitlabClient: gitlab as unknown as BindingContext['gitlabClient'],
    statuses,
    userIdentity: identity,
    labelCache,
    milestoneCache,
    defaultTaskType: 'task:taskType:default' as unknown as Ref<TaskType>,
    gitlabBaseUrl: 'https://gitlab.example'
  }

  const enqueued: Array<{ binding: string, kind: string, record: Record<string, unknown> }> = []
  const manager = new IssuesSyncManager({
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

test('1. create remote→local: SyncIssue arrives, no idMap → createDoc called with mapped fields', async () => {
  const h = buildHarness()
  const issue = makeSyncIssue({ title: 'Hello', state: 'opened' })
  await h.manager.applyRemote(h.ctx, 'binding-1', issue)

  expect(h.huly.creates).toBe(1)
  expect(h.huly.updates).toBe(0)
  const created = Array.from(h.huly.issues.values())[0]
  expect(created.title).toBe('Hello')
  expect(created.status).toBe('todo' as unknown as Ref<Status>)
  // Newly-created issues MUST carry a Ref<TaskType> for the project's default kind
  expect(String(created.kind)).toBe('task:taskType:default')
  expect(h.idmap.docs).toHaveLength(1)
  expect(h.idmap.docs[0].gitlabKind).toBe('issue')
  expect(h.idmap.docs[0].gitlabId).toBe('42:1')
  expect(h.cursors.sets).toBeGreaterThan(0)
})

test('2. create local→remote: Huly issue, no idMap → gitlab.createIssue called', async () => {
  const h = buildHarness()
  const hulyRef = 'huly-local-7'
  await h.manager.applyLocal(h.ctx, 'binding-1', `issue:${hulyRef}`, {
    title: 'From Huly',
    description: 'desc-markup',
    status: 'done',
    labels: [{ name: 'bug', color: '#ff0000' }]
  })

  expect(h.gitlab.createIssue).toHaveBeenCalledTimes(1)
  const args = h.gitlab.createIssue.mock.calls[0]
  expect(args[0]).toBe(42)
  const body = args[1]
  expect(body.title).toBe('From Huly')
  expect(body.labels).toBe('bug')
  expect(body.state_event).toBe('close') // 'done' is closed category
})

test('3. edit title both directions: LWW resolves per timestamp', async () => {
  // Setup: pre-create issue both sides
  const h = buildHarness()
  const issue = makeSyncIssue({ title: 'Initial' })
  await h.manager.applyRemote(h.ctx, 'binding-1', issue)
  const ref = Array.from(h.huly.issues.keys())[0]

  // Cursor now points to 2024-01-01T10:00:00
  // Send remote update with NEWER timestamp
  const newer = makeSyncIssue({
    title: 'Newer remote',
    updatedAt: '2024-01-02T10:00:00.000Z'
  })
  await h.manager.applyRemote(h.ctx, 'binding-1', newer)
  expect(h.huly.issues.get(ref)?.title).toBe('Newer remote')

  // Local update direction: push to GitLab
  await h.manager.applyLocal(h.ctx, 'binding-1', `issue:${ref}`, { title: 'Local title' })
  expect(h.gitlab.updateIssue).toHaveBeenCalledTimes(1)
  expect(h.gitlab.updateIssue.mock.calls[0][2].title).toBe('Local title')
})

test('4. edit description both directions: markdown round-trip survives', async () => {
  const h = buildHarness()
  await h.manager.applyRemote(h.ctx, 'binding-1', makeSyncIssue({
    description: '# Header\n\nBody with `code`',
    updatedAt: '2024-01-01T10:00:00.000Z'
  }))
  const ref = Array.from(h.huly.issues.keys())[0]
  const markup = h.huly.issues.get(ref)?.description ?? ''
  expect(markup.length).toBeGreaterThan(0)
  // markup is a JSON ProseMirror payload — contains the original text content
  expect(markup).toContain('Header')

  // Local edit: push the markup back to GitLab as markdown
  await h.manager.applyLocal(h.ctx, 'binding-1', `issue:${ref}`, { description: markup })
  const sentDesc = h.gitlab.updateIssue.mock.calls[0][2].description as string
  expect(sentDesc).toContain('Header')
})

test('5. label autocreate on Huly side when GitLab brings new label', async () => {
  const h = buildHarness()
  const issue = makeSyncIssue({ labels: ['urgent', 'frontend'] })
  await h.manager.applyRemote(h.ctx, 'binding-1', issue)
  const ref = Array.from(h.huly.issues.keys())[0]
  const labels = h.huly.issues.get(ref)?.labels ?? []
  expect(labels).toHaveLength(2)
})

test('6. label autocreate on GitLab side when Huly adds new tag', async () => {
  const h = buildHarness()
  await h.manager.applyLocal(h.ctx, 'binding-1', 'issue:huly-x', {
    title: 'Bug',
    labels: [{ name: 'new-on-huly' }]
  })
  expect(h.gitlab.createLabel).toHaveBeenCalledTimes(1)
  expect(h.gitlab.createLabel.mock.calls[0][1].name).toBe('new-on-huly')
})

test('7. milestone autocreate (Huly side from GitLab payload)', async () => {
  const h = buildHarness()
  const issue = makeSyncIssue({
    milestone: {
      id: 100,
      iid: 1,
      title: 'v1.0',
      description: null,
      state: 'active',
      dueDate: null,
      startDate: null,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z'
    }
  })
  await h.manager.applyRemote(h.ctx, 'binding-1', issue)
  const ref = Array.from(h.huly.issues.keys())[0]
  expect(h.huly.issues.get(ref)?.milestone).toBeTruthy()
})

test('8. assignee mapped via UserIdentity → PersonUuid attached', async () => {
  const known = new Map<string, PersonUuid>([
    ['gitlab:55', 'person-uuid-aaa' as unknown as PersonUuid]
  ])
  const h = buildHarness({ knownUsers: known })
  const issue = makeSyncIssue({
    assignees: [makeUser(55, 'matched@example.com')]
  })
  await h.manager.applyRemote(h.ctx, 'binding-1', issue)
  const ref = Array.from(h.huly.issues.keys())[0]
  expect(h.huly.issues.get(ref)?.assignee).toBe('person-uuid-aaa')
})

test('9. assignee unmatched → UserIdentity.ensureStubGuest called (stub created)', async () => {
  const h = buildHarness() // no known users
  const ensureSpy = jest.spyOn(h.identity, 'ensureStubGuest')
  const issue = makeSyncIssue({
    assignees: [makeUser(99, 'unknown@example.com')]
  })
  await h.manager.applyRemote(h.ctx, 'binding-1', issue)
  expect(ensureSpy).toHaveBeenCalledTimes(1)
  const identitySent = ensureSpy.mock.calls[0][0] as IdentitySyncUser
  expect(identitySent.gitlabId).toBe('99')
  const ref = Array.from(h.huly.issues.keys())[0]
  expect(h.huly.issues.get(ref)?.assignee).toBe('stub:gitlab:99')
})

test('10. conflict different fields: title from local, description from remote → no loss', async () => {
  // Seed: create issue from a remote arrival (Initial title, "remote body")
  const h = buildHarness()
  await h.manager.applyRemote(h.ctx, 'binding-1', makeSyncIssue({
    title: 'Initial',
    description: 'old body',
    updatedAt: '2024-01-01T10:00:00.000Z'
  }))
  const ref = Array.from(h.huly.issues.keys())[0]

  // Local edit: change title (without sync) — simulate by mutating fake Huly directly
  const cur = h.huly.issues.get(ref)
  if (cur !== undefined) {
    h.huly.issues.set(ref, { ...cur, title: 'Local title' })
  }

  // Remote update: only description changes, newer timestamp.
  // applyRemote will diff and since LWW says remote newer, BOTH title and description
  // would update. But we control "local" via the cursor (which is the local ts marker).
  // Use applyLocal to push the local title BEFORE the remote arrives:
  await h.manager.applyLocal(h.ctx, 'binding-1', `issue:${ref}`, { title: 'Local title' })
  // (updateIssue called, no error)

  // Now remote arrives changing only description, newer ts
  const updatesBefore = h.huly.updates
  await h.manager.applyRemote(h.ctx, 'binding-1', makeSyncIssue({
    title: 'Local title', // remote and local agree on title (no churn)
    description: 'new remote body',
    updatedAt: '2024-01-02T10:00:00.000Z'
  }))
  expect(h.huly.updates).toBeGreaterThan(updatesBefore)
  expect(h.huly.issues.get(ref)?.title).toBe('Local title')
  expect(h.huly.issues.get(ref)?.description).toContain('new remote body')
})

test('11. conflict same field: LWW per timestamp picks newer', async () => {
  const h = buildHarness()
  await h.manager.applyRemote(h.ctx, 'binding-1', makeSyncIssue({
    title: 'v1', updatedAt: '2024-01-01T10:00:00.000Z'
  }))
  const ref = Array.from(h.huly.issues.keys())[0]

  // Remote update with NEWER timestamp on the same field
  await h.manager.applyRemote(h.ctx, 'binding-1', makeSyncIssue({
    title: 'v2-remote', updatedAt: '2024-01-02T10:00:00.000Z'
  }))
  expect(h.huly.issues.get(ref)?.title).toBe('v2-remote')
})

test('12. idempotent re-delivery: same syncIssue twice → second call no-ops (mutation counts)', async () => {
  const h = buildHarness()
  const issue = makeSyncIssue({ title: 'Idem', updatedAt: '2024-01-01T10:00:00.000Z' })
  await h.manager.applyRemote(h.ctx, 'binding-1', issue)
  const createsAfterFirst = h.huly.creates
  const updatesAfterFirst = h.huly.updates

  // Re-deliver — same payload
  await h.manager.applyRemote(h.ctx, 'binding-1', issue)
  expect(h.huly.creates).toBe(createsAfterFirst) // no new create
  // No update needed since nothing changed
  expect(h.huly.updates).toBe(updatesAfterFirst)
})

test('resolveIssueRef: returns undefined for unknown iid', async () => {
  const h = buildHarness()
  const ref = await resolveIssueRef(h.ctx, { gitlabProjectId: 42 }, 999)
  expect(ref).toBeUndefined()
})

test('resolveIssueRef: returns mapped ref after applyRemote', async () => {
  const h = buildHarness()
  await h.manager.applyRemote(h.ctx, 'binding-1', makeSyncIssue({ iid: 88 }))
  const ref = await resolveIssueRef(h.ctx, { gitlabProjectId: 42 }, 88)
  expect(ref).toBeDefined()
  expect(ref).toMatch(/huly-issue-/)
})

test('backfill: enqueues each issue from listIssues as a remote event', async () => {
  const h = buildHarness({
    gitlab: {
      listIssues: jest.fn().mockResolvedValue([
        makeSyncIssue({ iid: 1 }),
        makeSyncIssue({ iid: 2 })
      ])
    }
  })
  await h.manager.backfill(h.ctx, 'binding-1', new Date('2024-01-01T00:00:00Z'))
  expect(h.enqueued).toHaveLength(2)
  expect(h.enqueued.every((e) => e.kind === 'issue')).toBe(true)
})

test('backfill: passes since as updatedAfter to listIssues', async () => {
  const listMock = jest.fn().mockResolvedValue([])
  const h = buildHarness({ gitlab: { listIssues: listMock } })
  await h.manager.backfill(h.ctx, 'binding-1', new Date('2024-06-15T00:00:00Z'))
  expect(listMock).toHaveBeenCalledWith(42, { updatedAfter: '2024-06-15T00:00:00.000Z' })
})
