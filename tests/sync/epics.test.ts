import { type Collection } from 'mongodb'
import { ObjectId } from 'mongodb'
import type { Ref, Space, TxOperations, WorkspaceUuid } from '@hcengineering/core'
import type { Issue, Status, TaskType } from '@hcengineering/tracker'
import type { Store } from '../../src/state/store'
import type { Logger } from '../../src/logging'
import type { IdMapDoc } from '../../src/state/idmap'
import type { CursorDoc } from '../../src/state/cursors'
import type { Capabilities, SyncEpic, SyncUser } from '../../src/adapter/types'
import { EpicsSyncManager, type EpicsBindingContext } from '../../src/sync/epics'
import { MR_EPIC_MIXIN } from '../../src/sync/epic-mixin'
import { MR_MIXIN } from '../../src/sync/mr-mixin'
import type { SyncContext } from '../../src/sync/types'
import * as metrics from '../../src/metrics'

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
        (q.gitlabKind === undefined || d.gitlabKind === q.gitlabKind) &&
        (q.gitlabId === undefined || d.gitlabId === q.gitlabId) &&
        (q.hulyClass === undefined || d.hulyClass === q.hulyClass) &&
        (q.hulyRef === undefined || d.hulyRef === q.hulyRef)
      ) ?? null
    },
    updateOne: async (q: Record<string, unknown>, update: Record<string, unknown>) => {
      const set = (update.$set as Record<string, unknown>) ?? {}
      const idx = docs.findIndex((d) =>
        d.workspaceUuid === q.workspaceUuid &&
        d.gitlabKind === q.gitlabKind &&
        d.gitlabId === q.gitlabId
      )
      if (idx >= 0) {
        docs[idx] = { ...docs[idx], ...set } as IdMapDoc
      } else {
        docs.push({ _id: new ObjectId(), ...(set as object) } as IdMapDoc)
      }
      return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0, acknowledged: true }
    }
  } as unknown as FakeIdMap
}

interface FakeCursors extends Collection<CursorDoc> {
  docs: CursorDoc[]
}

function makeCursors (): FakeCursors {
  const docs: CursorDoc[] = []
  return {
    docs,
    findOne: async (q: Record<string, unknown>) =>
      docs.find((d) => d.bindingId === q.bindingId && d.kind === q.kind) ?? null,
    updateOne: async (q: Record<string, unknown>, update: Record<string, unknown>) => {
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
}

function makeHulyClient (): FakeHulyClient {
  const issues = new Map<Ref<Issue>, Issue>()
  const mixinByIssue = new Map<string, Record<string, unknown>>()
  let creates = 0
  let updates = 0
  const createMixinCalls: MixinCall[] = []
  const updateMixinCalls: MixinCall[] = []
  let counter = 0

  const client = {
    issues,
    mixinByIssue,
    createMixinCalls,
    updateMixinCalls,
    get creates (): number { return creates },
    get updates (): number { return updates },
    findOne: async (_cls: unknown, q: Partial<Issue>): Promise<Issue | undefined> => {
      if (q._id !== undefined) return issues.get(q._id)
      return undefined
    },
    findAll: async () => [],
    createDoc: async (cls: unknown, _space: unknown, attrs: Partial<Issue>): Promise<Ref<Issue>> => {
      counter++
      creates++
      const id = `huly-issue-${counter}` as unknown as Ref<Issue>
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
      const existing = issues.get(id)
      if (existing !== undefined) {
        issues.set(id, { ...existing, ...update } as Issue)
      }
    },
    createMixin: async (
      objectId: string,
      _objectClass: unknown,
      _objectSpace: unknown,
      mixin: string,
      attributes: Record<string, unknown>
    ) => {
      createMixinCalls.push({ objectId, mixin, attributes })
      const cur = mixinByIssue.get(objectId) ?? {}
      mixinByIssue.set(objectId, { ...cur, ...attributes })
      return {}
    },
    updateMixin: async (
      objectId: string,
      _objectClass: unknown,
      _objectSpace: unknown,
      mixin: string,
      attributes: Record<string, unknown>
    ) => {
      updateMixinCalls.push({ objectId, mixin, attributes })
      const cur = mixinByIssue.get(objectId) ?? {}
      mixinByIssue.set(objectId, { ...cur, ...attributes })
      return {}
    },
    close: async () => undefined
  } as unknown as FakeHulyClient

  return client
}

interface FakeGitLab {
  listEpics: jest.Mock
  listEpicIssues: jest.Mock
  resolveTopLevelGroupForProject: jest.Mock
}

function makeGitLab (overrides: Partial<FakeGitLab> = {}): FakeGitLab {
  return {
    listEpics: jest.fn().mockResolvedValue([]),
    listEpicIssues: jest.fn().mockResolvedValue({ iids: [], projectIds: [] }),
    resolveTopLevelGroupForProject: jest.fn().mockResolvedValue(1000),
    ...overrides
  }
}

const WORKSPACE = 'ws-1' as unknown as WorkspaceUuid

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
    mk('backlog', 'task:statusCategory:Backlog'),
    mk('todo', 'task:statusCategory:ToDo'),
    mk('active', 'task:statusCategory:Active'),
    mk('done', 'task:statusCategory:Won')
  ]
}

function makeAuthor (): SyncUser {
  return {
    id: 1,
    username: 'author',
    name: 'Author',
    email: null,
    avatarUrl: null,
    webUrl: 'https://gitlab.example/author'
  }
}

function makeSyncEpic (overrides: Partial<SyncEpic> = {}): SyncEpic {
  return {
    iid: 7,
    groupId: 100,
    title: 'Remote epic title',
    description: 'remote epic body',
    state: 'opened',
    webUrl: 'https://gitlab.example/groups/100/-/epics/7',
    childIssueIids: [],
    author: makeAuthor(),
    createdAt: new Date('2024-01-01T10:00:00.000Z'),
    updatedAt: new Date('2024-01-01T10:00:00.000Z'),
    ...overrides
  }
}

interface Harness {
  manager: EpicsSyncManager
  ctx: SyncContext
  bctx: EpicsBindingContext
  idmap: FakeIdMap
  cursors: FakeCursors
  huly: FakeHulyClient
  gitlab: FakeGitLab
  enqueued: Array<{ binding: string, kind: string, record: Record<string, unknown> }>
}

function buildHarness (opts: {
  gitlab?: Partial<FakeGitLab>
  edition?: 'ee' | 'ce'
  isMultiInstanceWorkspace?: boolean
  gitlabBaseUrl?: string
  gitlabProjectId?: number
} = {}): Harness {
  const idmap = makeIdMap()
  const cursors = makeCursors()
  const store = makeStore(idmap, cursors)
  const huly = makeHulyClient()
  const gitlab = makeGitLab(opts.gitlab ?? {})
  const projectId = opts.gitlabProjectId ?? 42
  const hulyProjectRef = 'huly-proj-1' as unknown as Ref<Space>

  const capabilities: Capabilities = {
    gitlabVersion: '16.0.0',
    edition: opts.edition ?? 'ee',
    graphqlAvailable: true,
    featureFlags: {
      'graphql.issue.notes': true,
      'graphql.issue.batchedNotes': true
    }
  }

  const bctx: EpicsBindingContext = {
    workspaceUuid: WORKSPACE,
    gitlabProjectId: projectId,
    hulyProjectRef,
    hulyClient: huly,
    gitlabClient: gitlab as unknown as EpicsBindingContext['gitlabClient'],
    gitlabBaseUrl: opts.gitlabBaseUrl ?? 'https://gitlab.example',
    isMultiInstanceWorkspace: opts.isMultiInstanceWorkspace ?? false,
    statuses: makeStatuses(),
    defaultTaskType: 'task:taskType:default' as unknown as Ref<TaskType>,
    capabilities
  }

  const enqueued: Array<{ binding: string, kind: string, record: Record<string, unknown> }> = []
  const manager = new EpicsSyncManager({
    loadBinding: async () => bctx,
    backfillEnqueuer: async (binding, kind, record) => {
      enqueued.push({ binding, kind, record })
    }
  })

  const ctx: SyncContext = {
    workspaceUuid: WORKSPACE,
    logger: makeLogger(),
    store
  }

  return { manager, ctx, bctx, idmap, cursors, huly, gitlab, enqueued }
}

function seedIdMap (
  idmap: FakeIdMap,
  kind: IdMapDoc['gitlabKind'],
  gitlabId: string,
  hulyRef: string
): void {
  idmap.docs.push({
    _id: new ObjectId(),
    workspaceUuid: WORKSPACE,
    gitlabKind: kind,
    gitlabId,
    hulyClass: 'tracker:class:Issue',
    hulyRef
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EpicsSyncManager', () => {
  beforeEach(() => {
    metrics.reset()
  })

  test('resourceKey returns epic:<iid> from object_attributes', () => {
    const { manager } = buildHarness()
    expect(manager.resourceKey({ object_attributes: { iid: 42 } })).toBe('epic:42')
    expect(manager.resourceKey({ iid: 99 })).toBe('epic:99')
    expect(manager.resourceKey({})).toBeUndefined()
  })

  test('applyRemote on EE creates mirror Issue and gitlab-epic mixin', async () => {
    const h = buildHarness()
    const epic = makeSyncEpic({ childIssueIids: [11, 12] })

    await h.manager.applyRemote(h.ctx, 'binding-1', epic)

    expect(h.huly.creates).toBe(1)
    expect(h.huly.createMixinCalls).toHaveLength(1)
    const mc = h.huly.createMixinCalls[0]
    expect(mc.mixin).toBe(MR_EPIC_MIXIN as unknown as string)
    expect(mc.attributes.epicIid).toBe(7)
    expect(mc.attributes.groupId).toBe(100)
    expect(mc.attributes.state).toBe('opened')
    expect(mc.attributes.webUrl).toBe(epic.webUrl)
    expect(mc.attributes.childIssueIids).toEqual([11, 12])

    expect(h.idmap.docs.find((d) => d.gitlabKind === 'epic' && d.gitlabId === '100:7')).toBeDefined()
    expect(h.cursors.docs.find((d) => d.kind === 'epics')).toBeDefined()
  })

  test('AC-1 single writer: applyRemote propagates parentEpicIid to child MR mirror via MR_MIXIN', async () => {
    const h = buildHarness()
    // Seed a child MR mirror in idmap.
    seedIdMap(h.idmap, 'merge_request', '42:11', 'huly-mr-child-1')

    const epic = makeSyncEpic({ childIssueIids: [11] })
    await h.manager.applyRemote(h.ctx, 'binding-1', epic)

    const childMixinUpdate = h.huly.updateMixinCalls.find(
      (c) => c.objectId === 'huly-mr-child-1' && c.mixin === (MR_MIXIN as unknown as string)
    )
    expect(childMixinUpdate).toBeDefined()
    expect(childMixinUpdate?.attributes.parentEpicIid).toBe(7)

    // EpicsSyncManager wrote ONLY parentEpicIid on the child — not any
    // gitlab-mr core field (TG-3 field-ownership symmetry).
    expect(Object.keys(childMixinUpdate?.attributes ?? {})).toEqual(['parentEpicIid'])
    expect(childMixinUpdate?.attributes.sourceBranch).toBeUndefined()
    expect(childMixinUpdate?.attributes.mergeStatus).toBeUndefined()
    expect(childMixinUpdate?.attributes.targetBranch).toBeUndefined()
    expect(childMixinUpdate?.attributes.draft).toBeUndefined()
  })

  test('AC-1 propagates parentEpicIid to child Issue mirror when child is plain issue', async () => {
    const h = buildHarness()
    seedIdMap(h.idmap, 'issue', '42:22', 'huly-issue-child-1')

    const epic = makeSyncEpic({ childIssueIids: [22] })
    await h.manager.applyRemote(h.ctx, 'binding-1', epic)

    const childMixinUpdate = h.huly.updateMixinCalls.find(
      (c) => c.objectId === 'huly-issue-child-1'
    )
    expect(childMixinUpdate).toBeDefined()
    expect(childMixinUpdate?.attributes.parentEpicIid).toBe(7)
  })

  test('child not yet mirrored → no updateMixin call; epic.child.deferred metric increments', async () => {
    const h = buildHarness()
    // No idmap entries for any children.

    const epic = makeSyncEpic({ childIssueIids: [101, 102] })
    await h.manager.applyRemote(h.ctx, 'binding-1', epic)

    // Only the epic mirror itself got a createMixin; no updateMixin for missing children.
    expect(h.huly.updateMixinCalls).toHaveLength(0)
    expect(metrics.get('epic.child.deferred')).toBe(2)
  })

  test('multi-instance: idmap key is prefixed with baseUrl hash', async () => {
    const h = buildHarness({
      isMultiInstanceWorkspace: true,
      gitlabBaseUrl: 'https://gitlab.alpha.example'
    })
    const epic = makeSyncEpic()
    await h.manager.applyRemote(h.ctx, 'binding-1', epic)

    const idmapRow = h.idmap.docs.find((d) => d.gitlabKind === 'epic')
    expect(idmapRow).toBeDefined()
    // Hash-prefix shape: ${8-hex}:${groupId}:${iid}
    expect(idmapRow?.gitlabId).toMatch(/^[a-f0-9]{8}:100:7$/)
    expect(idmapRow?.gitlabId).not.toBe('100:7')
  })

  test('backfill resolves top-level group via resolveTopLevelGroupForProject (Bug-1) and paginates listEpics', async () => {
    const h = buildHarness({
      gitlab: {
        resolveTopLevelGroupForProject: jest.fn().mockResolvedValue(9999),
        listEpics: jest.fn().mockResolvedValue([
          makeSyncEpic({ iid: 1, groupId: 9999 }),
          makeSyncEpic({ iid: 2, groupId: 9999 })
        ]),
        listEpicIssues: jest.fn().mockResolvedValue({ iids: [], projectIds: [] })
      }
    })

    await h.manager.backfill(h.ctx, 'binding-1', new Date('2024-01-01'))

    expect(h.gitlab.resolveTopLevelGroupForProject).toHaveBeenCalledWith(42)
    expect(h.gitlab.listEpics).toHaveBeenCalledWith(
      9999,
      { updatedAfter: new Date('2024-01-01') }
    )
    expect(h.enqueued).toHaveLength(2)
    expect(h.enqueued[0].kind).toBe('epic')
  })

  test('applyLocal is a no-op: no GitLab call, no mixin write, no Huly mutation', async () => {
    const h = buildHarness()
    await h.manager.applyLocal(h.ctx, 'binding-1', 'huly-issue-1', { title: 'edit' })
    expect(h.gitlab.listEpics).not.toHaveBeenCalled()
    expect(h.gitlab.listEpicIssues).not.toHaveBeenCalled()
    expect(h.gitlab.resolveTopLevelGroupForProject).not.toHaveBeenCalled()
    expect(h.huly.creates).toBe(0)
    expect(h.huly.updates).toBe(0)
    expect(h.huly.createMixinCalls).toHaveLength(0)
    expect(h.huly.updateMixinCalls).toHaveLength(0)
  })

  test('sub-group project: backfill resolves correctly via resolveTopLevelGroupForProject (Bug-1)', async () => {
    // The project sits in a deeply nested sub-group; the adapter returns the
    // top-level group id and we use that for listEpics. We assert the manager
    // does NOT consult bctx.gitlabProjectId or any "namespace.id" assumption.
    const topGroupId = 7777
    const h = buildHarness({
      gitlab: {
        resolveTopLevelGroupForProject: jest.fn().mockResolvedValue(topGroupId),
        listEpics: jest.fn().mockResolvedValue([makeSyncEpic({ groupId: topGroupId })]),
        listEpicIssues: jest.fn().mockResolvedValue({ iids: [], projectIds: [] })
      }
    })

    await h.manager.backfill(h.ctx, 'binding-1', undefined)

    expect(h.gitlab.resolveTopLevelGroupForProject).toHaveBeenCalledWith(42)
    expect(h.gitlab.listEpics).toHaveBeenCalledWith(topGroupId, {})
    expect(h.gitlab.listEpicIssues).toHaveBeenCalledWith(topGroupId, 7)
  })

  test('TG-3 field-ownership symmetry: applyRemote does NOT write gitlab-mr core fields, only parentEpicIid', async () => {
    const h = buildHarness()
    // Seed both an MR child and an Issue child.
    seedIdMap(h.idmap, 'merge_request', '42:50', 'huly-mr-50')
    seedIdMap(h.idmap, 'issue', '42:51', 'huly-issue-51')

    const epic = makeSyncEpic({ childIssueIids: [50, 51] })
    await h.manager.applyRemote(h.ctx, 'binding-1', epic)

    const childWrites = h.huly.updateMixinCalls.filter(
      (c) => c.objectId === 'huly-mr-50' || c.objectId === 'huly-issue-51'
    )
    expect(childWrites).toHaveLength(2)
    for (const w of childWrites) {
      const keys = Object.keys(w.attributes)
      expect(keys).toEqual(['parentEpicIid'])
      expect(w.attributes.parentEpicIid).toBe(7)
      // Sentinel core MR fields must NOT appear.
      expect(w.attributes.sourceBranch).toBeUndefined()
      expect(w.attributes.targetBranch).toBeUndefined()
      expect(w.attributes.mergeStatus).toBeUndefined()
      expect(w.attributes.draft).toBeUndefined()
      expect(w.attributes.webUrl).toBeUndefined()
      expect(w.attributes.approvedBy).toBeUndefined()
      expect(w.attributes.iteration).toBeUndefined()
      expect(w.attributes.approvalRules).toBeUndefined()
    }
  })

  test('idempotent re-delivery: same epic applied twice does not duplicate mirror or idmap row', async () => {
    const h = buildHarness()
    const epic = makeSyncEpic()
    await h.manager.applyRemote(h.ctx, 'binding-1', epic)
    await h.manager.applyRemote(h.ctx, 'binding-1', epic)

    // One createDoc, one createMixin, then one updateMixin on re-delivery.
    expect(h.huly.creates).toBe(1)
    expect(h.huly.createMixinCalls).toHaveLength(1)
    // Second delivery refreshes the mixin (state/webUrl/childIssueIids).
    expect(h.huly.updateMixinCalls.filter((c) => c.mixin === (MR_EPIC_MIXIN as unknown as string))).toHaveLength(1)
    // Single epic idmap row.
    expect(h.idmap.docs.filter((d) => d.gitlabKind === 'epic')).toHaveLength(1)
  })

  test('applyRemote on CE returns silently (no Huly write) and increments epic.ee.skipped', async () => {
    const h = buildHarness({ edition: 'ce' })
    const epic = makeSyncEpic({ childIssueIids: [1, 2] })

    await h.manager.applyRemote(h.ctx, 'binding-1', epic)

    expect(h.huly.creates).toBe(0)
    expect(h.huly.createMixinCalls).toHaveLength(0)
    expect(h.huly.updateMixinCalls).toHaveLength(0)
    expect(h.idmap.docs).toHaveLength(0)
    expect(metrics.get('epic.ee.skipped')).toBe(1)
  })
})
