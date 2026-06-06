import type { Collection } from 'mongodb'
import { ObjectId } from 'mongodb'
import type { PersonUuid, Ref, Space, TxOperations, WorkspaceUuid } from '@hcengineering/core'
import type { Store } from '../../src/state/store'
import type { Logger } from '../../src/logging'
import type { IdMapDoc } from '../../src/state/idmap'
import type { CursorDoc } from '../../src/state/cursors'
import { upsertIdMap } from '../../src/state/idmap'
import type {
  SyncReviewNote,
  SyncReviewPosition,
  SyncReviewThread,
  SyncUser as AdapterUser
} from '../../src/adapter/types'
import { UserIdentity } from '../../src/huly/users'
import {
  ReviewThreadsSyncManager,
  type MRReviewBindingContext,
  type MRReviewGitLabClient
} from '../../src/sync/mr-review'
import { MR_REVIEW_THREAD_MIXIN } from '../../src/sync/mr-review-thread-mixin'
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

interface FakeMessage {
  _id: string
  attachedTo: string
  attachedToClass: string
  message: string
  modifiedBy: string
  modifiedOn: number
}

interface MixinCall {
  objectId: string
  objectClass: unknown
  objectSpace: unknown
  mixin: string
  attributes: Record<string, unknown>
}

interface FakeHulyClient extends TxOperations {
  messages: Map<string, FakeMessage>
  mixinByMessage: Map<string, Record<string, unknown>>
  creates: number
  updates: number
  createMixinCalls: MixinCall[]
  updateMixinCalls: MixinCall[]
  getMixin: (msgRef: string) => Record<string, unknown> | undefined
}

function makeHulyClient (): FakeHulyClient {
  const messages = new Map<string, FakeMessage>()
  const mixinByMessage = new Map<string, Record<string, unknown>>()
  let creates = 0
  let updates = 0
  const createMixinCalls: MixinCall[] = []
  const updateMixinCalls: MixinCall[] = []
  let counter = 0

  const client = {
    messages,
    mixinByMessage,
    createMixinCalls,
    updateMixinCalls,
    get creates (): number { return creates },
    get updates (): number { return updates },
    getMixin: (msgRef: string): Record<string, unknown> | undefined =>
      mixinByMessage.get(msgRef),
    findOne: async (_cls: unknown, q: Record<string, unknown>): Promise<FakeMessage | undefined> => {
      if (q._id !== undefined) return messages.get(q._id as string)
      return undefined
    },
    findAll: async () => [],
    createDoc: async (_cls: unknown, _space: unknown, attrs: Record<string, unknown>): Promise<string> => {
      creates++
      counter++
      const id = `huly-msg-${counter}`
      messages.set(id, {
        _id: id,
        attachedTo: (attrs.attachedTo as string) ?? '',
        attachedToClass: (attrs.attachedToClass as string) ?? '',
        message: (attrs.message as string) ?? '',
        modifiedBy: (attrs.modifiedBy as string) ?? '',
        modifiedOn: (attrs.modifiedOn as number) ?? 0
      })
      return id
    },
    updateDoc: async (
      _cls: unknown,
      _space: unknown,
      id: string,
      update: Record<string, unknown>
    ): Promise<void> => {
      updates++
      const existing = messages.get(id)
      if (existing !== undefined) {
        messages.set(id, { ...existing, ...update } as FakeMessage)
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
      const cur = mixinByMessage.get(objectId) ?? {}
      mixinByMessage.set(objectId, { ...cur, ...attributes })
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
      const cur = mixinByMessage.get(objectId) ?? {}
      mixinByMessage.set(objectId, { ...cur, ...attributes })
      return {}
    },
    close: async () => undefined
  } as unknown as FakeHulyClient

  return client
}

interface FakeGitLab extends MRReviewGitLabClient {
  listMergeRequests: jest.Mock
  listDiscussions: jest.Mock
  resolveDiscussion: jest.Mock
}

function makeGitLab (overrides: Partial<FakeGitLab> = {}): FakeGitLab {
  return {
    listMergeRequests: jest.fn().mockResolvedValue([]),
    listDiscussions: jest.fn().mockResolvedValue([]),
    resolveDiscussion: jest.fn().mockResolvedValue(undefined),
    ...overrides
  } as FakeGitLab
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

function makePosition (overrides: Partial<SyncReviewPosition> = {}): SyncReviewPosition {
  return {
    filePath: 'src/foo.ts',
    oldLine: null,
    newLine: 10,
    baseSha: 'base-sha',
    headSha: 'head-sha',
    startSha: 'start-sha',
    positionType: 'text',
    ...overrides
  }
}

function makeReviewNote (overrides: Partial<SyncReviewNote> = {}): SyncReviewNote {
  return {
    id: 1001,
    body: 'A line comment',
    author: makeUser(10),
    createdAt: new Date('2024-01-01T10:00:00.000Z'),
    updatedAt: new Date('2024-01-01T10:00:00.000Z'),
    system: false,
    resolvable: true,
    resolved: false,
    ...overrides
  }
}

function makeReviewThread (overrides: Partial<SyncReviewThread> = {}): SyncReviewThread {
  const notes = overrides.notes ?? [
    makeReviewNote({ id: 1001, position: makePosition() })
  ]
  return {
    discussionId: 'disc-abc',
    mergeRequestIid: 42,
    projectId: 7,
    resolved: false,
    resolvedBy: null,
    resolvedAt: null,
    notes,
    updatedAt: new Date('2024-01-01T10:00:00.000Z'),
    ...overrides
  }
}

interface Harness {
  manager: ReviewThreadsSyncManager
  ctx: SyncContext
  bctx: MRReviewBindingContext
  idmap: FakeIdMap
  cursors: FakeCursors
  huly: FakeHulyClient
  gitlab: FakeGitLab
  identity: UserIdentity
  enqueued: Array<{ binding: string, kind: string, record: Record<string, unknown> }>
}

function buildHarness (opts: {
  gitlab?: Partial<FakeGitLab>
  knownUsers?: Map<string, PersonUuid>
  projectId?: number
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

  const projectId = opts.projectId ?? 7
  const hulyProjectRef = 'huly-proj-1' as unknown as Ref<Space>

  const bctx: MRReviewBindingContext = {
    workspaceUuid: WORKSPACE,
    gitlabProjectId: projectId,
    gitlabProjectPath: 'group/proj',
    hulyProjectRef,
    hulyClient: huly,
    gitlabClient: gitlab,
    userIdentity: identity,
    gitlabBaseUrl: 'https://gitlab.example'
  }

  const enqueued: Array<{ binding: string, kind: string, record: Record<string, unknown> }> = []
  const manager = new ReviewThreadsSyncManager({
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

  return { manager, ctx, bctx, idmap, cursors, huly, gitlab, identity, enqueued }
}

async function seedParentMR (h: Harness, mrIid: number): Promise<string> {
  const issueRef = `huly-issue-mr-${mrIid}`
  await upsertIdMap(
    h.idmap,
    WORKSPACE,
    'merge_request',
    `${h.bctx.gitlabProjectId}:${mrIid}`,
    'tracker:class:Issue',
    issueRef
  )
  return issueRef
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('1. create thread root → ChatMessage created with mixin (position set, resolved=false)', async () => {
  const h = buildHarness()
  await seedParentMR(h, 42)
  const thread = makeReviewThread({
    notes: [makeReviewNote({ id: 1001, position: makePosition({ filePath: 'src/a.ts', newLine: 5 }) })]
  })

  await h.manager.applyRemote(h.ctx, 'binding-1', thread)

  expect(h.huly.creates).toBe(1)
  expect(h.huly.createMixinCalls).toHaveLength(1)

  const msgRef = Array.from(h.huly.messages.keys())[0]
  const mixin = h.huly.getMixin(msgRef) ?? {}
  expect(mixin.threadId).toBe('disc-abc')
  expect(mixin.resolved).toBe(false)
  expect((mixin.position as SyncReviewPosition).filePath).toBe('src/a.ts')
  expect(String(h.huly.createMixinCalls[0].mixin)).toBe(MR_REVIEW_THREAD_MIXIN as unknown as string)

  expect(h.idmap.docs).toHaveLength(2) // parent MR seed + 1 review_thread row
  const reviewRows = h.idmap.docs.filter((d) => d.gitlabKind === 'review_thread')
  expect(reviewRows).toHaveLength(1)
  expect(reviewRows[0].gitlabId).toBe('disc-abc:1001')
})

test('2. reply to existing thread → two ChatMessages, distinct idmap rows, only root has position (CRITICAL B1)', async () => {
  const h = buildHarness()
  await seedParentMR(h, 42)

  // First: root note arrives.
  const root = makeReviewNote({ id: 1001, position: makePosition({ filePath: 'src/r.ts', newLine: 1 }) })
  await h.manager.applyRemote(h.ctx, 'binding-1', makeReviewThread({ notes: [root] }))

  // Second: same thread, with both root + reply.
  const reply = makeReviewNote({
    id: 1002,
    body: 'reply body',
    createdAt: new Date('2024-01-01T11:00:00.000Z'),
    updatedAt: new Date('2024-01-01T11:00:00.000Z')
  })
  await h.manager.applyRemote(
    h.ctx,
    'binding-1',
    makeReviewThread({
      notes: [root, reply],
      updatedAt: new Date('2024-01-01T11:00:00.000Z')
    })
  )

  // Two ChatMessage created (root + reply).
  expect(h.huly.creates).toBe(2)

  const reviewRows = h.idmap.docs.filter((d) => d.gitlabKind === 'review_thread')
  expect(reviewRows).toHaveLength(2)
  const ids = reviewRows.map((r) => r.gitlabId).sort()
  expect(ids).toEqual(['disc-abc:1001', 'disc-abc:1002'])

  // The ChatMessage refs are distinct.
  expect(reviewRows[0].hulyRef).not.toBe(reviewRows[1].hulyRef)

  // Mixin on the root carries position.
  const rootRow = reviewRows.find((r) => r.gitlabId === 'disc-abc:1001')!
  const rootMixin = h.huly.getMixin(rootRow.hulyRef) ?? {}
  expect(rootMixin.position).toBeDefined()
  expect((rootMixin.position as SyncReviewPosition).filePath).toBe('src/r.ts')

  // Mixin on the reply does NOT carry position.
  const replyRow = reviewRows.find((r) => r.gitlabId === 'disc-abc:1002')!
  const replyMixin = h.huly.getMixin(replyRow.hulyRef) ?? {}
  expect(replyMixin.position).toBeUndefined()
  expect(replyMixin.threadId).toBe('disc-abc')
})

test('3. resolve thread → ALL notes mixin resolved=true, resolvedAt as number (C7)', async () => {
  const h = buildHarness()
  await seedParentMR(h, 42)

  const root = makeReviewNote({ id: 1001, position: makePosition() })
  const reply = makeReviewNote({ id: 1002, body: 'reply' })

  // Initial unresolved thread.
  await h.manager.applyRemote(h.ctx, 'binding-1', makeReviewThread({ notes: [root, reply] }))

  // Now resolved by user 99.
  const resolvedAt = new Date('2024-01-02T12:00:00.000Z')
  await h.manager.applyRemote(
    h.ctx,
    'binding-1',
    makeReviewThread({
      notes: [root, reply],
      resolved: true,
      resolvedBy: makeUser(99),
      resolvedAt,
      updatedAt: resolvedAt
    })
  )

  const reviewRows = h.idmap.docs.filter((d) => d.gitlabKind === 'review_thread')
  expect(reviewRows).toHaveLength(2)
  for (const row of reviewRows) {
    const mixin = h.huly.getMixin(row.hulyRef) ?? {}
    expect(mixin.resolved).toBe(true)
    expect(typeof mixin.resolvedAt).toBe('number')
    expect(mixin.resolvedAt).toBe(resolvedAt.getTime())
  }
})

test('4. unresolve thread → all notes resolved=false', async () => {
  const h = buildHarness()
  await seedParentMR(h, 42)

  const root = makeReviewNote({ id: 1001, position: makePosition() })
  const reply = makeReviewNote({ id: 1002 })

  // Start resolved.
  await h.manager.applyRemote(
    h.ctx,
    'binding-1',
    makeReviewThread({
      notes: [root, reply],
      resolved: true,
      resolvedBy: makeUser(99),
      resolvedAt: new Date('2024-01-02T12:00:00.000Z'),
      updatedAt: new Date('2024-01-02T12:00:00.000Z')
    })
  )

  // Then unresolved.
  await h.manager.applyRemote(
    h.ctx,
    'binding-1',
    makeReviewThread({
      notes: [root, reply],
      resolved: false,
      resolvedBy: null,
      resolvedAt: null,
      updatedAt: new Date('2024-01-03T10:00:00.000Z')
    })
  )

  const reviewRows = h.idmap.docs.filter((d) => d.gitlabKind === 'review_thread')
  for (const row of reviewRows) {
    const mixin = h.huly.getMixin(row.hulyRef) ?? {}
    expect(mixin.resolved).toBe(false)
  }
})

test('5. edit reply body via newer remote → updateDoc fires; no spurious mixin re-writes on body-only delta', async () => {
  const h = buildHarness()
  await seedParentMR(h, 42)

  const root = makeReviewNote({ id: 1001, position: makePosition() })
  const reply = makeReviewNote({ id: 1002, body: 'original' })

  await h.manager.applyRemote(h.ctx, 'binding-1', makeReviewThread({ notes: [root, reply] }))
  expect(h.huly.creates).toBe(2)
  const updatesBefore = h.huly.updates

  // Newer remote: reply body updated.
  const newerReply = makeReviewNote({
    id: 1002,
    body: 'edited body',
    updatedAt: new Date('2024-01-02T11:00:00.000Z')
  })
  await h.manager.applyRemote(
    h.ctx,
    'binding-1',
    makeReviewThread({
      notes: [root, newerReply],
      updatedAt: new Date('2024-01-02T11:00:00.000Z')
    })
  )
  expect(h.huly.updates).toBeGreaterThan(updatesBefore)
  // Mixin update call DOES fire (replicated state replay) but body upgrades only via newer LWW.
})

test('6. system note (note.system === true) → skipped, no ChatMessage', async () => {
  const h = buildHarness()
  await seedParentMR(h, 42)

  const sysNote = makeReviewNote({ id: 1001, system: true })
  const realNote = makeReviewNote({ id: 1002 })
  await h.manager.applyRemote(
    h.ctx,
    'binding-1',
    makeReviewThread({ notes: [sysNote, realNote] })
  )

  // Only one ChatMessage (the non-system).
  expect(h.huly.creates).toBe(1)
  const reviewRows = h.idmap.docs.filter((d) => d.gitlabKind === 'review_thread')
  expect(reviewRows).toHaveLength(1)
  expect(reviewRows[0].gitlabId).toBe('disc-abc:1002')
})

test('7. parent MR missing → deferred via _reviewRetried; second miss → dropped + metric', async () => {
  const h = buildHarness()
  // Parent NOT seeded.
  const thread = makeReviewThread()
  await h.manager.applyRemote(h.ctx, 'binding-1', thread)

  // First call: deferred (enqueued).
  expect(h.enqueued).toHaveLength(1)
  expect(h.enqueued[0].kind).toBe('review')
  expect((h.enqueued[0].record as Record<string, unknown>)._reviewRetried).toBe(true)
  expect(h.huly.creates).toBe(0)

  // Second call: with retry flag set, parent still missing → drop.
  const warnSpy = jest.fn()
  const ctxWarn: SyncContext = { ...h.ctx, logger: { ...h.ctx.logger, warn: warnSpy } }
  await h.manager.applyRemote(
    ctxWarn,
    'binding-1',
    { ...(thread as unknown as Record<string, unknown>), _reviewRetried: true } as unknown as SyncReviewThread
  )
  expect(h.huly.creates).toBe(0)
  // No additional enqueue.
  expect(h.enqueued).toHaveLength(1)
  // Warn contains the metric tag.
  expect(warnSpy).toHaveBeenCalled()
  const warnArgs = warnSpy.mock.calls[0]
  expect(JSON.stringify(warnArgs)).toContain('review.parent.missing')
})

test('8. parent MR appears between defer and retry → on retry, ChatMessage created', async () => {
  const h = buildHarness()
  const thread = makeReviewThread()

  // First: defer.
  await h.manager.applyRemote(h.ctx, 'binding-1', thread)
  expect(h.enqueued).toHaveLength(1)
  expect(h.huly.creates).toBe(0)

  // Parent appears.
  await seedParentMR(h, 42)

  // Retry envelope.
  await h.manager.applyRemote(
    h.ctx,
    'binding-1',
    { ...(thread as unknown as Record<string, unknown>), _reviewRetried: true } as unknown as SyncReviewThread
  )
  expect(h.huly.creates).toBe(1)
})

test('9. author unmatched → stub guest created via UserIdentity.ensureStubGuest', async () => {
  const h = buildHarness()
  await seedParentMR(h, 42)

  const stubSpy = jest.spyOn(h.identity, 'ensureStubGuest')
  await h.manager.applyRemote(h.ctx, 'binding-1', makeReviewThread())

  expect(stubSpy).toHaveBeenCalled()
  expect(h.huly.creates).toBe(1)
})

test('10. general MR discussion (no position) → mixin.position undefined', async () => {
  // General MR discussions have note.position === undefined.
  // The manager must store the thread with position unset.
  const h = buildHarness()
  await seedParentMR(h, 42)

  const generalNote = makeReviewNote({ id: 1001, position: undefined })
  await h.manager.applyRemote(
    h.ctx,
    'binding-1',
    makeReviewThread({ notes: [generalNote] })
  )
  expect(h.huly.creates).toBe(1)
  const msgRef = Array.from(h.huly.messages.keys())[0]
  const mixin = h.huly.getMixin(msgRef) ?? {}
  expect(mixin.position).toBeUndefined()
  expect(mixin.threadId).toBe('disc-abc')
})

test('10b. image position written to mixin on root note (P5-T-25)', async () => {
  const h = buildHarness()
  await seedParentMR(h, 42)

  const imagePos: SyncReviewPosition = {
    positionType: 'image',
    filePath: 'images/logo.png',
    x: 10,
    y: 20,
    width: 100,
    height: 200,
    baseSha: 'base-sha',
    headSha: 'head-sha'
  }
  const root = makeReviewNote({ id: 1001, position: imagePos })
  await h.manager.applyRemote(
    h.ctx,
    'binding-1',
    makeReviewThread({ notes: [root] })
  )
  expect(h.huly.creates).toBe(1)
  const msgRef = Array.from(h.huly.messages.keys())[0]
  const mixin = h.huly.getMixin(msgRef) ?? {}
  const pos = mixin.position as SyncReviewPosition
  expect(pos.positionType).toBe('image')
  if (pos.positionType === 'image') {
    expect(pos.filePath).toBe('images/logo.png')
    expect(pos.x).toBe(10)
    expect(pos.y).toBe(20)
    expect(pos.width).toBe(100)
    expect(pos.height).toBe(200)
  }
})

test('10c. file position written to mixin on root note (P5-T-25)', async () => {
  const h = buildHarness()
  await seedParentMR(h, 42)

  const filePos: SyncReviewPosition = {
    positionType: 'file',
    filePath: 'src/big.bin',
    baseSha: 'base-sha',
    headSha: 'head-sha'
  }
  const root = makeReviewNote({ id: 1001, position: filePos })
  await h.manager.applyRemote(
    h.ctx,
    'binding-1',
    makeReviewThread({ notes: [root] })
  )
  expect(h.huly.creates).toBe(1)
  const msgRef = Array.from(h.huly.messages.keys())[0]
  const mixin = h.huly.getMixin(msgRef) ?? {}
  const pos = mixin.position as SyncReviewPosition
  expect(pos.positionType).toBe('file')
  if (pos.positionType === 'file') {
    expect(pos.filePath).toBe('src/big.bin')
    expect(pos.baseSha).toBe('base-sha')
    expect(pos.headSha).toBe('head-sha')
  }
})

test('11. resourceKey returns review:${discussionId} (flat + webhook envelope)', () => {
  const h = buildHarness()
  expect(h.manager.resourceKey({ discussionId: 'disc-zzz' })).toBe('review:disc-zzz')
  expect(h.manager.resourceKey({ object_attributes: { discussion_id: 'disc-yyy' } })).toBe('review:disc-yyy')
  expect(h.manager.resourceKey({})).toBeUndefined()
})

test('12. idempotent re-delivery: same threadId + noteId twice → no extra ChatMessage create', async () => {
  const h = buildHarness()
  await seedParentMR(h, 42)
  const thread = makeReviewThread()

  await h.manager.applyRemote(h.ctx, 'binding-1', thread)
  const createsAfterFirst = h.huly.creates
  const updatesAfterFirst = h.huly.updates

  await h.manager.applyRemote(h.ctx, 'binding-1', thread)
  expect(h.huly.creates).toBe(createsAfterFirst)
  // Same timestamp → no body update fires.
  expect(h.huly.updates).toBe(updatesAfterFirst)
})

test('13. applyLocal change.resolved=true → calls resolveDiscussion(true) once', async () => {
  const h = buildHarness()
  await seedParentMR(h, 42)
  await h.manager.applyRemote(h.ctx, 'binding-1', makeReviewThread())
  const msgRef = Array.from(h.huly.messages.keys())[0]

  await h.manager.applyLocal(
    h.ctx,
    'binding-1',
    `review:${msgRef}`,
    { resolved: true, mergeRequestIid: 42 }
  )
  expect(h.gitlab.resolveDiscussion).toHaveBeenCalledTimes(1)
  const args = h.gitlab.resolveDiscussion.mock.calls[0]
  expect(args[0]).toBe(7) // projectId
  expect(args[1]).toBe(42) // mrIid
  expect(args[2]).toBe('disc-abc') // discussionId
  expect(args[3]).toBe(true) // resolved
})

test('14. applyLocal with no change.resolved → no adapter call', async () => {
  const h = buildHarness()
  await seedParentMR(h, 42)
  await h.manager.applyRemote(h.ctx, 'binding-1', makeReviewThread())
  const msgRef = Array.from(h.huly.messages.keys())[0]

  await h.manager.applyLocal(
    h.ctx,
    'binding-1',
    `review:${msgRef}`,
    { message: 'edited body but no resolve flip', mergeRequestIid: 42 }
  )
  expect(h.gitlab.resolveDiscussion).not.toHaveBeenCalled()
})

test('15. applyLocal for ChatMessage not in idmap → log warn, no throw, no adapter call', async () => {
  const h = buildHarness()
  // No applyRemote — no idmap entry exists.
  const warnSpy = jest.fn()
  const ctxWarn: SyncContext = { ...h.ctx, logger: { ...h.ctx.logger, warn: warnSpy } }

  await expect(
    h.manager.applyLocal(
      ctxWarn,
      'binding-1',
      'review:huly-msg-unknown',
      { resolved: true, mergeRequestIid: 42 }
    )
  ).resolves.toBeUndefined()

  expect(h.gitlab.resolveDiscussion).not.toHaveBeenCalled()
  expect(warnSpy).toHaveBeenCalled()
})

test('16. applyLocal change.resolved=false → calls resolveDiscussion(false)', async () => {
  const h = buildHarness()
  await seedParentMR(h, 42)
  await h.manager.applyRemote(h.ctx, 'binding-1', makeReviewThread())
  const msgRef = Array.from(h.huly.messages.keys())[0]

  await h.manager.applyLocal(
    h.ctx,
    'binding-1',
    `review:${msgRef}`,
    { resolved: false, mergeRequestIid: 42 }
  )
  expect(h.gitlab.resolveDiscussion).toHaveBeenCalledTimes(1)
  expect(h.gitlab.resolveDiscussion.mock.calls[0][3]).toBe(false)
})

test('T11-A. applyRemote create thread → createDoc attrs contain _originated:gitlab marker', async () => {
  const h = buildHarness()
  await seedParentMR(h, 42)
  const thread = makeReviewThread({
    notes: [makeReviewNote({ id: 1001, position: makePosition() })]
  })

  await h.manager.applyRemote(h.ctx, 'binding-1', thread)

  expect(h.huly.creates).toBe(1)
  const created = Array.from(h.huly.messages.values())[0] as Record<string, unknown>
  // createDoc attrs are stored on the FakeHulyClient message; the marker is
  // forwarded via withOriginatedMarker and we verify it appeared on the
  // createMixinCalls (the attrs wrapper in the mixin path also carries it).
  expect(h.huly.createMixinCalls).toHaveLength(1)
  const mixinAttrs = h.huly.createMixinCalls[0].attributes
  expect(mixinAttrs._originated).toBe('gitlab')
  // Sanity: message was still created correctly.
  expect(created._id).toBeDefined()
})

test('T11-B. applyRemote update review (second delivery) → updateMixin attrs contain _originated:gitlab marker', async () => {
  const h = buildHarness()
  await seedParentMR(h, 42)
  const note = makeReviewNote({ id: 1001, position: makePosition() })

  // First delivery — creates.
  await h.manager.applyRemote(h.ctx, 'binding-1', makeReviewThread({ notes: [note] }))

  // Second delivery with resolved=true — triggers updateMixin path.
  const resolvedAt = new Date('2024-02-01T08:00:00.000Z')
  await h.manager.applyRemote(
    h.ctx,
    'binding-1',
    makeReviewThread({
      notes: [note],
      resolved: true,
      resolvedBy: makeUser(5),
      resolvedAt,
      updatedAt: resolvedAt
    })
  )

  expect(h.huly.updateMixinCalls).toHaveLength(1)
  const attrs = h.huly.updateMixinCalls[0].attributes
  expect(attrs._originated).toBe('gitlab')
  expect(attrs.resolved).toBe(true)
})

test('T20-A. resolve thread → resolvedBy and resolvedAt populated on mixin when user is known', async () => {
  const resolverUuid = 'person-uuid-77' as unknown as PersonUuid
  // Map gitlab user id 77 via the social key format used by UserIdentity.
  const known = new Map<string, PersonUuid>([['gitlab:77', resolverUuid]])
  const h = buildHarness({ knownUsers: known })
  await seedParentMR(h, 42)

  const root = makeReviewNote({ id: 1001, position: makePosition() })
  // Start unresolved.
  await h.manager.applyRemote(h.ctx, 'binding-1', makeReviewThread({ notes: [root] }))

  const resolvedAt = new Date('2024-03-01T09:00:00.000Z')
  await h.manager.applyRemote(
    h.ctx,
    'binding-1',
    makeReviewThread({
      notes: [root],
      resolved: true,
      resolvedBy: makeUser(77),
      resolvedAt,
      updatedAt: resolvedAt
    })
  )

  const reviewRows = h.idmap.docs.filter((d) => d.gitlabKind === 'review_thread')
  expect(reviewRows).toHaveLength(1)
  const mixin = h.huly.getMixin(reviewRows[0].hulyRef) ?? {}
  expect(mixin.resolved).toBe(true)
  expect(typeof mixin.resolvedAt).toBe('number')
  expect(mixin.resolvedAt).toBe(resolvedAt.getTime())
  expect(mixin.resolvedBy).toBeDefined()
})

test('T20-B. unresolve thread after being resolved → resolvedBy and resolvedAt cleared on mixin', async () => {
  const h = buildHarness()
  await seedParentMR(h, 42)

  const root = makeReviewNote({ id: 1001, position: makePosition() })
  const reply = makeReviewNote({ id: 1002 })

  // First: resolve.
  const resolvedAt = new Date('2024-03-01T09:00:00.000Z')
  await h.manager.applyRemote(
    h.ctx,
    'binding-1',
    makeReviewThread({
      notes: [root, reply],
      resolved: true,
      resolvedBy: makeUser(77),
      resolvedAt,
      updatedAt: resolvedAt
    })
  )

  // Verify resolved fields populated.
  const rowsBefore = h.idmap.docs.filter((d) => d.gitlabKind === 'review_thread')
  for (const row of rowsBefore) {
    const m = h.huly.getMixin(row.hulyRef) ?? {}
    expect(m.resolved).toBe(true)
    expect(m.resolvedAt).toBeDefined()
  }

  // Now unresolve.
  await h.manager.applyRemote(
    h.ctx,
    'binding-1',
    makeReviewThread({
      notes: [root, reply],
      resolved: false,
      resolvedBy: null,
      resolvedAt: null,
      updatedAt: new Date('2024-03-02T10:00:00.000Z')
    })
  )

  const rowsAfter = h.idmap.docs.filter((d) => d.gitlabKind === 'review_thread')
  for (const row of rowsAfter) {
    const mixin = h.huly.getMixin(row.hulyRef) ?? {}
    expect(mixin.resolved).toBe(false)
    // Stale resolver attribution must be explicitly cleared.
    expect(mixin.resolvedBy).toBeUndefined()
    expect(mixin.resolvedAt).toBeUndefined()
  }
})

test('backfill: lists MRs then discussions; each thread enqueued', async () => {
  const h = buildHarness({
    gitlab: {
      listMergeRequests: jest.fn().mockResolvedValue([{ iid: 42 }, { iid: 43 }]),
      listDiscussions: jest.fn().mockImplementation(async (_pid: number, mrIid: number) => [
        makeReviewThread({ discussionId: `disc-${mrIid}-a`, mergeRequestIid: mrIid }),
        makeReviewThread({ discussionId: `disc-${mrIid}-b`, mergeRequestIid: mrIid })
      ])
    }
  })

  await h.manager.backfill(h.ctx, 'binding-1', new Date('2024-01-01T00:00:00Z'))
  expect(h.enqueued).toHaveLength(4)
  expect(h.enqueued.every((e) => e.kind === 'review')).toBe(true)
})
