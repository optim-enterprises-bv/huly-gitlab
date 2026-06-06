import type { Collection } from 'mongodb'
import { ObjectId } from 'mongodb'
import type { PersonUuid, Ref, Space, TxOperations, WorkspaceUuid } from '@hcengineering/core'
import type { Store } from '../../src/state/store'
import type { Logger } from '../../src/logging'
import type { IdMapDoc } from '../../src/state/idmap'
import type { CursorDoc } from '../../src/state/cursors'
import type { SyncNote, SyncUser as AdapterUser } from '../../src/adapter/types'
import { UserIdentity } from '../../src/huly/users'
import type { SyncUser as IdentitySyncUser } from '../../src/huly/users'
import {
  NotesSyncManager,
  type NotesBindingContext,
  type NoteGitLabClient
} from '../../src/sync/notes'
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

interface FakeMessage {
  _id: string
  attachedTo: string
  attachedToClass: string
  message: string
  modifiedBy: string
  modifiedOn: number
}

interface FakeHulyClient extends TxOperations {
  messages: Map<string, FakeMessage>
  creates: number
  updates: number
  lastUpdate: Record<string, unknown> | null
}

function makeHulyClient (): FakeHulyClient {
  const messages = new Map<string, FakeMessage>()
  let creates = 0
  let updates = 0
  let lastUpdate: Record<string, unknown> | null = null
  let counter = 0

  return {
    messages,
    get creates (): number { return creates },
    get updates (): number { return updates },
    get lastUpdate (): Record<string, unknown> | null { return lastUpdate },
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
        attachedTo: attrs.attachedTo as string ?? '',
        attachedToClass: attrs.attachedToClass as string ?? '',
        message: attrs.message as string ?? '',
        modifiedBy: attrs.modifiedBy as string ?? '',
        modifiedOn: attrs.modifiedOn as number ?? 0
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
      lastUpdate = update
      const existing = messages.get(id)
      if (existing !== undefined) {
        messages.set(id, { ...existing, ...update } as FakeMessage)
      }
    },
    close: async () => undefined
  } as unknown as FakeHulyClient
}

interface FakeGitLab extends NoteGitLabClient {
  listNotes: jest.Mock
  createNote: jest.Mock
  updateNote: jest.Mock
  deleteNote: jest.Mock
  listIssues: jest.Mock
  listMergeRequests: jest.Mock
  listMRNotes: jest.Mock
  createMRNote: jest.Mock
  updateMRNote: jest.Mock
  deleteMRNote: jest.Mock
}

function makeSyncNote (overrides: Partial<SyncNote> = {}): SyncNote {
  return {
    id: 1,
    body: 'Hello world',
    author: makeUser(10),
    createdAt: '2024-01-01T10:00:00.000Z',
    updatedAt: '2024-01-01T10:00:00.000Z',
    system: false,
    confidential: false,
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

function makeGitLab (overrides: Partial<FakeGitLab> = {}): FakeGitLab {
  return {
    listNotes: jest.fn().mockResolvedValue([]),
    createNote: jest.fn().mockImplementation(async (_pid, _iid, body: { body: string }) =>
      makeSyncNote({ id: 999, body: body.body })
    ),
    updateNote: jest.fn().mockResolvedValue(makeSyncNote()),
    deleteNote: jest.fn().mockResolvedValue(undefined),
    listIssues: jest.fn().mockResolvedValue([]),
    listMergeRequests: jest.fn().mockResolvedValue([]),
    listMRNotes: jest.fn().mockResolvedValue([]),
    createMRNote: jest.fn().mockImplementation(async (_pid, _iid, body: { body: string }) =>
      makeSyncNote({ id: 888, body: body.body, noteableType: 'MergeRequest' })
    ),
    updateMRNote: jest.fn().mockResolvedValue(makeSyncNote({ noteableType: 'MergeRequest' })),
    deleteMRNote: jest.fn().mockResolvedValue(undefined),
    ...overrides
  } as FakeGitLab
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
    putIdMap: async (w, k, g, ref) => { records.set(`${w}/${k}/${g}`, ref) }
  }
}

const WORKSPACE = 'ws-1' as unknown as WorkspaceUuid
const PROJECT_ID = 42
const ISSUE_IID = 5
const ISSUE_REF = 'huly-issue-1'
const ISSUE_GITLAB_ID = `${PROJECT_ID}:${ISSUE_IID}`
const MR_IID = 7
const MR_REF = 'huly-mr-issue-1'
const MR_GITLAB_ID = `${PROJECT_ID}:${MR_IID}`

interface Harness {
  manager: NotesSyncManager
  ctx: SyncContext
  bctx: NotesBindingContext
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
  seedIssue?: boolean
  seedMR?: boolean
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

  const bctx: NotesBindingContext = {
    workspaceUuid: WORKSPACE,
    gitlabProjectId: PROJECT_ID,
    gitlabProjectPath: 'group/proj',
    hulyProjectRef: 'huly-proj-1' as unknown as Ref<Space>,
    hulyClient: huly,
    gitlabClient: gitlab,
    userIdentity: identity,
    gitlabBaseUrl: 'https://gitlab.example'
  }

  const enqueued: Array<{ binding: string, kind: string, record: Record<string, unknown> }> = []
  const manager = new NotesSyncManager({
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

  // Optionally seed an issue idmap entry so note tests can find a parent issue
  if (opts.seedIssue === true || opts.seedIssue === undefined) {
    // Pre-seed the issue mapping so resolveIssueRef succeeds
    void idmap.updateOne(
      { workspaceUuid: WORKSPACE, gitlabKind: 'issue', gitlabId: ISSUE_GITLAB_ID },
      { $set: { workspaceUuid: WORKSPACE, gitlabKind: 'issue', gitlabId: ISSUE_GITLAB_ID, hulyClass: 'tracker:class:Issue', hulyRef: ISSUE_REF } }
    )
  }

  // Optionally seed a merge_request idmap entry for MR note tests
  if (opts.seedMR === true) {
    void idmap.updateOne(
      { workspaceUuid: WORKSPACE, gitlabKind: 'merge_request', gitlabId: MR_GITLAB_ID },
      { $set: { workspaceUuid: WORKSPACE, gitlabKind: 'merge_request', gitlabId: MR_GITLAB_ID, hulyClass: 'tracker:class:Issue', hulyRef: MR_REF } }
    )
  }

  return { manager, ctx, bctx, idmap, cursors, huly, gitlab, identity, identityStore, enqueued }
}

function makeNoteRecord (noteOverrides: Partial<SyncNote> = {}): Record<string, unknown> {
  return {
    noteableIid: ISSUE_IID,
    note: makeSyncNote(noteOverrides)
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('1. create remote→local: SyncNote arrives, parent issue exists in idMap → ChatMessage created with correct attachedTo', async () => {
  const h = buildHarness()
  const record = makeNoteRecord({ body: 'First comment' })
  await h.manager.applyRemote(h.ctx, 'binding-1', record)

  expect(h.huly.creates).toBe(1)
  const msg = Array.from(h.huly.messages.values())[0]
  expect(msg).toBeDefined()
  expect(msg.attachedTo).toBe(ISSUE_REF)
  expect(msg.attachedToClass).toContain('Issue')
  expect(msg.message).toContain('First comment')
  expect(h.idmap.docs.some((d) => d.gitlabKind === 'note')).toBe(true)
  expect(h.cursors.sets).toBeGreaterThan(0)
})

test('2. create local→remote: ChatMessage created in Huly → createNote called with translated body', async () => {
  const h = buildHarness()
  const hulyRef = 'huly-msg-local-7'
  await h.manager.applyLocal(h.ctx, 'binding-1', `note:${hulyRef}`, {
    message: 'Local comment body',
    noteableIid: ISSUE_IID
  })

  expect(h.gitlab.createNote).toHaveBeenCalledTimes(1)
  const args = h.gitlab.createNote.mock.calls[0] as [number, number, { body: string }]
  expect(args[0]).toBe(PROJECT_ID)
  expect(args[1]).toBe(ISSUE_IID)
  expect(args[2]).toEqual(expect.objectContaining({ body: expect.any(String) }))
  expect(args[2].body.length).toBeGreaterThan(0)
})

test('3. edit body remote→local: LWW applies remote update when remote is newer', async () => {
  const h = buildHarness()

  // First arrival creates the message
  const record1 = makeNoteRecord({ id: 55, body: 'Original', updatedAt: '2024-01-01T10:00:00.000Z' })
  await h.manager.applyRemote(h.ctx, 'binding-1', record1)
  const msgRef = Array.from(h.huly.messages.keys())[0]
  expect(h.huly.messages.get(msgRef)?.message).toContain('Original')

  // Second arrival with newer timestamp — should update
  const record2 = makeNoteRecord({ id: 55, body: 'Updated body', updatedAt: '2024-01-02T10:00:00.000Z' })
  await h.manager.applyRemote(h.ctx, 'binding-1', record2)
  expect(h.huly.updates).toBe(1)
  expect(h.huly.messages.get(msgRef)?.message).toContain('Updated body')
})

test('4. edit body local→remote: applyLocal with existing idMap → updateNote called', async () => {
  const h = buildHarness()

  // Seed an existing note mapping
  const noteId = 77
  const gitlabNoteId = `${PROJECT_ID}:${noteId}`
  const hulyRef = 'huly-msg-existing'
  await h.idmap.updateOne(
    { workspaceUuid: WORKSPACE, gitlabKind: 'note', gitlabId: gitlabNoteId },
    { $set: { workspaceUuid: WORKSPACE, gitlabKind: 'note', gitlabId: gitlabNoteId, hulyClass: 'chunter.class.ChatMessage', hulyRef } }
  )

  await h.manager.applyLocal(h.ctx, 'binding-1', `note:${hulyRef}`, {
    message: 'Edited message',
    issueIid: ISSUE_IID
  })

  expect(h.gitlab.updateNote).toHaveBeenCalledTimes(1)
  const args = h.gitlab.updateNote.mock.calls[0] as [number, number, number, string]
  expect(args[0]).toBe(PROJECT_ID)
  expect(args[1]).toBe(ISSUE_IID)
  expect(args[2]).toBe(noteId)
})

test('4b. create local→remote: noteableIid resolved from hulyMessage.attachedTo via idmap', async () => {
  const h = buildHarness() // seeds issue mapping for ISSUE_REF → ISSUE_IID
  const hulyRef = 'huly-msg-local-attached'

  await h.manager.applyLocal(h.ctx, 'binding-1', `note:${hulyRef}`, {
    message: 'Comment via attachedTo lookup',
    hulyMessage: { attachedTo: ISSUE_REF }
  })

  expect(h.gitlab.createNote).toHaveBeenCalledTimes(1)
  const args = h.gitlab.createNote.mock.calls[0] as [number, number, { body: string }]
  expect(args[0]).toBe(PROJECT_ID)
  expect(args[1]).toBe(ISSUE_IID)
})

test('5. delete local→remote: deleteNote called on adapter', async () => {
  const h = buildHarness()

  const noteId = 88
  const gitlabNoteId = `${PROJECT_ID}:${noteId}`
  const hulyRef = 'huly-msg-to-delete'
  await h.idmap.updateOne(
    { workspaceUuid: WORKSPACE, gitlabKind: 'note', gitlabId: gitlabNoteId },
    { $set: { workspaceUuid: WORKSPACE, gitlabKind: 'note', gitlabId: gitlabNoteId, hulyClass: 'chunter.class.ChatMessage', hulyRef } }
  )

  await h.manager.applyLocal(h.ctx, 'binding-1', `note:${hulyRef}`, {
    deleted: true,
    issueIid: ISSUE_IID
  })

  expect(h.gitlab.deleteNote).toHaveBeenCalledTimes(1)
  const args = h.gitlab.deleteNote.mock.calls[0] as [number, number, number]
  expect(args[0]).toBe(PROJECT_ID)
  expect(args[1]).toBe(ISSUE_IID)
  expect(args[2]).toBe(noteId)
})

test('6. system note (system: true) → skipped, no apply', async () => {
  const h = buildHarness()
  const record = makeNoteRecord({ system: true, body: 'opened' })
  await h.manager.applyRemote(h.ctx, 'binding-1', record)

  expect(h.huly.creates).toBe(0)
  expect(h.idmap.docs.filter((d) => d.gitlabKind === 'note')).toHaveLength(0)
})

test('7. author unmatched → ensureStubGuest called, stub guest attached as author', async () => {
  const h = buildHarness() // no known users
  const ensureSpy = jest.spyOn(h.identity, 'ensureStubGuest')

  const record = makeNoteRecord({
    author: makeUser(99, 'unknown@example.com'),
    body: 'Anonymous comment'
  })
  await h.manager.applyRemote(h.ctx, 'binding-1', record)

  expect(ensureSpy).toHaveBeenCalledTimes(1)
  const identitySent = ensureSpy.mock.calls[0][0] as IdentitySyncUser
  expect(identitySent.gitlabId).toBe('99')

  const msg = Array.from(h.huly.messages.values())[0]
  expect(msg.modifiedBy).toBe('stub:gitlab:99')
})

test('8. parent issue missing from idMap → deferred (re-enqueued once), then dropped on second miss', async () => {
  // Build harness WITHOUT seeding an issue mapping
  const idmap = makeIdMap()
  const cursors = makeCursors()
  const store = makeStore(idmap, cursors)
  const huly = makeHulyClient()
  const gitlab = makeGitLab()
  const identityStore = makeIdentityStore()
  const identity = new UserIdentity(
    new class { async findPersonBySocialKey (_k: string): Promise<PersonUuid | undefined> { return undefined } }() as unknown as ConstructorParameters<typeof UserIdentity>[0],
    identityStore,
    WORKSPACE,
    60_000
  )

  const bctx: NotesBindingContext = {
    workspaceUuid: WORKSPACE,
    gitlabProjectId: PROJECT_ID,
    gitlabProjectPath: 'group/proj',
    hulyProjectRef: 'huly-proj-1' as unknown as Ref<Space>,
    hulyClient: huly,
    gitlabClient: gitlab,
    userIdentity: identity,
    gitlabBaseUrl: 'https://gitlab.example'
  }

  const enqueued: Array<{ binding: string, kind: string, record: Record<string, unknown> }> = []
  const manager = new NotesSyncManager({
    loadBinding: async () => bctx,
    enqueuer: {
      enqueueBackfillRecord: async (binding, kind, record) => {
        enqueued.push({ binding, kind, record })
      }
    }
  })

  const ctx: SyncContext = { workspaceUuid: WORKSPACE, logger: makeLogger(), store }

  // First attempt — no issue in idmap → should defer (re-enqueue)
  const record = makeNoteRecord({ id: 11, body: 'Orphan note' })
  await manager.applyRemote(ctx, 'binding-1', record)

  expect(huly.creates).toBe(0)
  expect(enqueued).toHaveLength(1)
  expect(enqueued[0].record._noteRetried).toBe(true)

  // Second attempt with _noteRetried=true → should drop, not re-enqueue
  await manager.applyRemote(ctx, 'binding-1', enqueued[0].record)
  expect(huly.creates).toBe(0)
  expect(enqueued).toHaveLength(1) // no second enqueue
})

test('backfill: enqueues non-system notes for each issue', async () => {
  const h = buildHarness({
    seedIssue: false,
    gitlab: {
      listIssues: jest.fn().mockResolvedValue([{ iid: 1 }, { iid: 2 }]),
      listNotes: jest.fn()
        .mockResolvedValueOnce([
          makeSyncNote({ id: 10, system: false }),
          makeSyncNote({ id: 11, system: true }) // system — should be skipped
        ])
        .mockResolvedValueOnce([
          makeSyncNote({ id: 20, system: false })
        ])
    }
  })

  await h.manager.backfill(h.ctx, 'binding-1', new Date('2024-01-01T00:00:00Z'))

  // Only 2 non-system notes should be enqueued
  expect(h.enqueued).toHaveLength(2)
  expect(h.enqueued.every((e) => e.kind === 'note')).toBe(true)
  // Each enqueued record carries noteableIid
  expect(h.enqueued[0].record.noteableIid).toBe(1)
  expect(h.enqueued[1].record.noteableIid).toBe(2)
})

// ---------------------------------------------------------------------------
// P2-T-09: MR note extension tests
// ---------------------------------------------------------------------------

test('P2-T-09 T1. applyRemote MR note: resolves parent via merge_request idmap; ChatMessage attached to MR-mirror Issue ref', async () => {
  const h = buildHarness({ seedIssue: false, seedMR: true })

  const record: Record<string, unknown> = {
    noteableIid: MR_IID,
    note: makeSyncNote({ id: 200, body: 'MR comment', noteableType: 'MergeRequest' })
  }
  await h.manager.applyRemote(h.ctx, 'binding-1', record)

  expect(h.huly.creates).toBe(1)
  const msg = Array.from(h.huly.messages.values())[0]
  expect(msg.attachedTo).toBe(MR_REF)
  expect(msg.attachedToClass).toContain('Issue')
  expect(h.idmap.docs.some((d) => d.gitlabKind === 'note')).toBe(true)
})

test('P2-T-09 T2. applyRemote MR note with unmapped parent: deferred once then dropped (critic B3)', async () => {
  // No MR seeded — simulates confidential MR not yet in idmap
  const h = buildHarness({ seedIssue: false, seedMR: false })

  const record: Record<string, unknown> = {
    noteableIid: MR_IID,
    note: makeSyncNote({ id: 201, body: 'Confidential MR comment', noteableType: 'MergeRequest' })
  }

  // First attempt — MR not in idmap → deferred
  await h.manager.applyRemote(h.ctx, 'binding-1', record)
  expect(h.huly.creates).toBe(0)
  expect(h.enqueued).toHaveLength(1)
  expect(h.enqueued[0].record._noteRetried).toBe(true)

  // Second attempt with _noteRetried=true → dropped, no second enqueue
  await h.manager.applyRemote(h.ctx, 'binding-1', h.enqueued[0].record)
  expect(h.huly.creates).toBe(0)
  expect(h.enqueued).toHaveLength(1)
})

test('P2-T-09 T3. applyLocal: parent maps to MR idmap entry → createMRNote called', async () => {
  // Seed a merge_request idmap entry for MR_REF (no issue entry for same ref)
  const h = buildHarness({ seedIssue: false, seedMR: false })
  await h.idmap.updateOne(
    { workspaceUuid: WORKSPACE, gitlabKind: 'merge_request', gitlabId: MR_GITLAB_ID },
    { $set: { workspaceUuid: WORKSPACE, gitlabKind: 'merge_request', gitlabId: MR_GITLAB_ID, hulyClass: 'tracker:class:Issue', hulyRef: MR_REF } }
  )

  const hulyRef = 'huly-msg-mr-local'
  await h.manager.applyLocal(h.ctx, 'binding-1', `note:${hulyRef}`, {
    message: 'MR note from Huly',
    hulyMessage: { attachedTo: MR_REF }
  })

  expect(h.gitlab.createMRNote).toHaveBeenCalledTimes(1)
  expect(h.gitlab.createNote).not.toHaveBeenCalled()
  const args = h.gitlab.createMRNote.mock.calls[0] as [number, number, { body: string }]
  expect(args[0]).toBe(PROJECT_ID)
  expect(args[1]).toBe(MR_IID)
  expect(args[2]).toEqual(expect.objectContaining({ body: expect.any(String) }))
})

test('P2-T-09 T4. applyLocal: parent maps to Issue idmap entry → createNote called (regression)', async () => {
  const h = buildHarness() // seeds issue mapping for ISSUE_REF

  const hulyRef = 'huly-msg-issue-local'
  await h.manager.applyLocal(h.ctx, 'binding-1', `note:${hulyRef}`, {
    message: 'Issue note from Huly',
    hulyMessage: { attachedTo: ISSUE_REF }
  })

  expect(h.gitlab.createNote).toHaveBeenCalledTimes(1)
  expect(h.gitlab.createMRNote).not.toHaveBeenCalled()
  const args = h.gitlab.createNote.mock.calls[0] as [number, number, { body: string }]
  expect(args[0]).toBe(PROJECT_ID)
  expect(args[1]).toBe(ISSUE_IID)
})

test('P2-T-09 T5. parseWebhookPayload sets noteableType Issue on Issue Hook notes', async () => {
  const h = buildHarness()

  const webhookPayload: Record<string, unknown> = {
    object_kind: 'note',
    object_attributes: {
      id: 300,
      body: 'Issue webhook note',
      noteable_type: 'Issue',
      system: false,
      confidential: false,
      created_at: '2024-01-01T10:00:00.000Z',
      updated_at: '2024-01-01T10:00:00.000Z',
      author: { id: 10, username: 'user10', name: 'User 10', email: null, avatar_url: null, url: '' }
    },
    issue: { iid: ISSUE_IID }
  }

  await h.manager.applyRemote(h.ctx, 'binding-1', webhookPayload)

  expect(h.huly.creates).toBe(1)
  // The note should be attached to the issue (not an MR) — confirms noteableType 'Issue' path
  const msg = Array.from(h.huly.messages.values())[0]
  expect(msg.attachedTo).toBe(ISSUE_REF)
})

test('P2-T-09 T6. parseWebhookPayload sets noteableType MergeRequest on MR Hook notes', async () => {
  const h = buildHarness({ seedIssue: false, seedMR: true })

  const webhookPayload: Record<string, unknown> = {
    object_kind: 'note',
    object_attributes: {
      id: 301,
      body: 'MR webhook note',
      noteable_type: 'MergeRequest',
      system: false,
      confidential: false,
      created_at: '2024-01-01T10:00:00.000Z',
      updated_at: '2024-01-01T10:00:00.000Z',
      author: { id: 10, username: 'user10', name: 'User 10', email: null, avatar_url: null, url: '' }
    },
    merge_request: { iid: MR_IID }
  }

  await h.manager.applyRemote(h.ctx, 'binding-1', webhookPayload)

  expect(h.huly.creates).toBe(1)
  const msg = Array.from(h.huly.messages.values())[0]
  expect(msg.attachedTo).toBe(MR_REF)
})

test('B3. parseWebhookPayload rejects unknown noteable_type (e.g. Snippet) — no Issue/MR create', async () => {
  const h = buildHarness({ seedMR: true })

  // Capture log warnings to assert the manager dropped the payload rather
  // than silently misrouting it as an Issue.
  const warn = jest.fn()
  h.ctx.logger.warn = warn

  const webhookPayload: Record<string, unknown> = {
    object_kind: 'note',
    object_attributes: {
      id: 500,
      body: 'Snippet comment',
      noteable_type: 'Snippet',
      system: false,
      confidential: false,
      created_at: '2024-01-01T10:00:00.000Z',
      updated_at: '2024-01-01T10:00:00.000Z',
      author: { id: 10, username: 'user10', name: 'User 10', email: null, avatar_url: null, url: '' }
    },
    snippet: { id: 9 }
  }

  await h.manager.applyRemote(h.ctx, 'binding-1', webhookPayload)

  expect(h.huly.creates).toBe(0)
  expect(h.idmap.docs.filter((d) => d.gitlabKind === 'note')).toHaveLength(0)
  expect(warn).toHaveBeenCalledWith(
    expect.stringContaining('could not parse note record'),
    expect.any(Object)
  )
})

test('B4. applyLocal UPDATE note attached to MR → updateMRNote (not updateNote)', async () => {
  const h = buildHarness({ seedMR: true })

  // Seed a note idmap entry — the note already exists on GitLab.
  const noteId = 600
  const gitlabNoteId = `${PROJECT_ID}:${noteId}`
  const hulyRef = 'huly-msg-mr-update'
  await h.idmap.updateOne(
    { workspaceUuid: WORKSPACE, gitlabKind: 'note', gitlabId: gitlabNoteId },
    { $set: { workspaceUuid: WORKSPACE, gitlabKind: 'note', gitlabId: gitlabNoteId, hulyClass: 'chunter.class.ChatMessage', hulyRef } }
  )

  await h.manager.applyLocal(h.ctx, 'binding-1', `note:${hulyRef}`, {
    message: 'Edited MR comment',
    issueIid: MR_IID,
    hulyMessage: { attachedTo: MR_REF }
  })

  expect(h.gitlab.updateMRNote).toHaveBeenCalledTimes(1)
  expect(h.gitlab.updateNote).not.toHaveBeenCalled()
  const args = h.gitlab.updateMRNote.mock.calls[0] as [number, number, number, { body: string }]
  expect(args[0]).toBe(PROJECT_ID)
  expect(args[1]).toBe(MR_IID)
  expect(args[2]).toBe(noteId)
})

test('B4. applyLocal DELETE note attached to MR → deleteMRNote (not deleteNote)', async () => {
  const h = buildHarness({ seedMR: true })

  const noteId = 601
  const gitlabNoteId = `${PROJECT_ID}:${noteId}`
  const hulyRef = 'huly-msg-mr-delete'
  await h.idmap.updateOne(
    { workspaceUuid: WORKSPACE, gitlabKind: 'note', gitlabId: gitlabNoteId },
    { $set: { workspaceUuid: WORKSPACE, gitlabKind: 'note', gitlabId: gitlabNoteId, hulyClass: 'chunter.class.ChatMessage', hulyRef } }
  )

  await h.manager.applyLocal(h.ctx, 'binding-1', `note:${hulyRef}`, {
    deleted: true,
    issueIid: MR_IID,
    hulyMessage: { attachedTo: MR_REF }
  })

  expect(h.gitlab.deleteMRNote).toHaveBeenCalledTimes(1)
  expect(h.gitlab.deleteNote).not.toHaveBeenCalled()
  const args = h.gitlab.deleteMRNote.mock.calls[0] as [number, number, number]
  expect(args[0]).toBe(PROJECT_ID)
  expect(args[1]).toBe(MR_IID)
  expect(args[2]).toBe(noteId)
})

test('B4. applyLocal UPDATE note attached to Issue → updateNote (regression)', async () => {
  const h = buildHarness() // seeds issue mapping

  const noteId = 602
  const gitlabNoteId = `${PROJECT_ID}:${noteId}`
  const hulyRef = 'huly-msg-issue-update'
  await h.idmap.updateOne(
    { workspaceUuid: WORKSPACE, gitlabKind: 'note', gitlabId: gitlabNoteId },
    { $set: { workspaceUuid: WORKSPACE, gitlabKind: 'note', gitlabId: gitlabNoteId, hulyClass: 'chunter.class.ChatMessage', hulyRef } }
  )

  await h.manager.applyLocal(h.ctx, 'binding-1', `note:${hulyRef}`, {
    message: 'Edited Issue comment',
    issueIid: ISSUE_IID,
    hulyMessage: { attachedTo: ISSUE_REF }
  })

  expect(h.gitlab.updateNote).toHaveBeenCalledTimes(1)
  expect(h.gitlab.updateMRNote).not.toHaveBeenCalled()
})

test('P2-T-09 T7. backfill enumerates MR-note backfill for bindings with MRs', async () => {
  const h = buildHarness({
    seedIssue: false,
    seedMR: false,
    gitlab: {
      listIssues: jest.fn().mockResolvedValue([]),
      listMergeRequests: jest.fn().mockResolvedValue([{ iid: MR_IID }, { iid: 99 }]),
      listMRNotes: jest.fn()
        .mockResolvedValueOnce([makeSyncNote({ id: 400, system: false })])
        .mockResolvedValueOnce([makeSyncNote({ id: 401, system: false })])
    }
  })

  await h.manager.backfill(h.ctx, 'binding-1', new Date('2024-01-01T00:00:00Z'))

  expect(h.bctx.gitlabClient.listMRNotes).toHaveBeenCalledTimes(2)
  expect((h.bctx.gitlabClient.listMRNotes as jest.Mock).mock.calls[0][1]).toBe(MR_IID)
  expect((h.bctx.gitlabClient.listMRNotes as jest.Mock).mock.calls[1][1]).toBe(99)

  // Both MR notes enqueued
  expect(h.enqueued).toHaveLength(2)
  expect(h.enqueued.every((e) => e.kind === 'note')).toBe(true)
  // noteableType set to MergeRequest in enqueued record
  const note0 = (h.enqueued[0].record as { note: SyncNote }).note
  expect(note0.noteableType).toBe('MergeRequest')
})

// ---------------------------------------------------------------------------
// P3-T-08: line-position routing extension tests
// NOTE (C9): these tests assert the enqueue CALL SHAPE only. Live engine wiring
// (kind 'review' registration) lands in P3-T-10.
// ---------------------------------------------------------------------------

function makePositionWebhookPayload (overrides: {
  noteId?: number
  body?: string
  headSha?: string
  baseSha?: string
  startSha?: string
  positionType?: string
  discussionId?: string
  newLine?: number | null
  oldLine?: number | null
} = {}): Record<string, unknown> {
  return {
    object_kind: 'note',
    object_attributes: {
      id: overrides.noteId ?? 700,
      body: overrides.body ?? 'Review line comment',
      noteable_type: 'MergeRequest',
      system: false,
      confidential: false,
      created_at: '2024-03-01T10:00:00.000Z',
      updated_at: '2024-03-01T10:00:00.000Z',
      discussion_id: overrides.discussionId ?? 'disc-abc-123',
      author: { id: 10, username: 'user10', name: 'User 10', email: null, avatar_url: null, url: '' },
      position: {
        position_type: overrides.positionType ?? 'text',
        head_sha: overrides.headSha ?? 'headabc',
        base_sha: overrides.baseSha ?? 'baseabc',
        start_sha: overrides.startSha ?? 'startabc',
        new_path: 'src/foo.ts',
        old_path: 'src/foo.ts',
        new_line: overrides.newLine !== undefined ? overrides.newLine : 42,
        old_line: overrides.oldLine !== undefined ? overrides.oldLine : null
      }
    },
    merge_request: { iid: MR_IID }
  }
}

test('P3-T-08 T1. position note re-enqueued with kind "review"; no ChatMessage created from notes path', async () => {
  // Seed MR so parent is found
  const h = buildHarness({ seedIssue: false, seedMR: true })
  const payload = makePositionWebhookPayload()

  await h.manager.applyRemote(h.ctx, 'binding-1', payload)

  // No ChatMessage created via notes path
  expect(h.huly.creates).toBe(0)
  // Exactly one re-enqueue with kind 'review'
  expect(h.enqueued).toHaveLength(1)
  expect(h.enqueued[0].kind).toBe('review')
  // The envelope carries the discussionId
  expect(h.enqueued[0].record.discussionId).toBe('disc-abc-123')
  // The envelope carries the correct mergeRequestIid
  expect(h.enqueued[0].record.mergeRequestIid).toBe(MR_IID)
})

test('P3-T-08 T2. note WITHOUT position → existing Issue/MR path (Phase 2 regression)', async () => {
  const h = buildHarness({ seedIssue: false, seedMR: true })

  const webhookPayload: Record<string, unknown> = {
    object_kind: 'note',
    object_attributes: {
      id: 701,
      body: 'Ordinary MR comment',
      noteable_type: 'MergeRequest',
      system: false,
      confidential: false,
      created_at: '2024-03-01T10:00:00.000Z',
      updated_at: '2024-03-01T10:00:00.000Z',
      author: { id: 10, username: 'user10', name: 'User 10', email: null, avatar_url: null, url: '' }
      // no position field
    },
    merge_request: { iid: MR_IID }
  }

  await h.manager.applyRemote(h.ctx, 'binding-1', webhookPayload)

  // Existing path: ChatMessage created, nothing enqueued as review
  expect(h.huly.creates).toBe(1)
  expect(h.enqueued.filter(e => e.kind === 'review')).toHaveLength(0)
})

test('P3-T-08 T3 (C3). Suggestion block in body passes through verbatim in re-enqueued record', async () => {
  const h = buildHarness({ seedIssue: false, seedMR: true })
  const suggestionBody = '```suggestion\nconst x = 1\n```\n<<<<<<< SUGGEST\nsome suggestion\n======='
  const payload = makePositionWebhookPayload({ noteId: 702, body: suggestionBody })

  await h.manager.applyRemote(h.ctx, 'binding-1', payload)

  expect(h.enqueued).toHaveLength(1)
  expect(h.enqueued[0].kind).toBe('review')
  // Body preserved verbatim in the enqueued thread's first note
  const notes = (h.enqueued[0].record as { notes: Array<{ body: string }> }).notes
  expect(notes).toHaveLength(1)
  expect(notes[0].body).toBe(suggestionBody)
})

test('P3-T-08 T4. position_type != "text" (e.g. "image") → falls through to notes path, not review path', async () => {
  const h = buildHarness({ seedIssue: false, seedMR: true })
  const payload = makePositionWebhookPayload({ noteId: 703, positionType: 'image' })

  await h.manager.applyRemote(h.ctx, 'binding-1', payload)

  // image-position notes route via notes path (not re-enqueued as review)
  expect(h.enqueued.filter(e => e.kind === 'review')).toHaveLength(0)
  // The MR parent is seeded, so a ChatMessage gets created
  expect(h.huly.creates).toBe(1)
})

test('P3-T-08 T5 (C13). Body edit + resolved flip simultaneously: notes path handles body; review guard returns on kind=review', async () => {
  // When a change arrives with both body update and kind='review', applyLocal
  // returns early so ReviewThreadsSyncManager handles the resolution flip.
  // Separately, a change without kind='review' but with a body update is handled by the notes path.
  const h = buildHarness()

  // Seed an existing note mapping for a review_thread (gitlabKind = 'review_thread')
  const noteId = 800
  const gitlabNoteId = `${PROJECT_ID}:${noteId}`
  const hulyRef = 'huly-msg-review-thread'
  await h.idmap.updateOne(
    { workspaceUuid: WORKSPACE, gitlabKind: 'review_thread', gitlabId: gitlabNoteId },
    { $set: { workspaceUuid: WORKSPACE, gitlabKind: 'review_thread', gitlabId: gitlabNoteId, hulyClass: 'chunter.class.ChatMessage', hulyRef } }
  )

  // Change with kind='review' → notes path returns immediately (review manager handles resolved flip)
  await h.manager.applyLocal(h.ctx, 'binding-1', `note:${hulyRef}`, {
    kind: 'review',
    resolved: true,
    message: 'Updated body text'
  })
  // No GitLab API calls from notes path
  expect(h.gitlab.updateNote).not.toHaveBeenCalled()
  expect(h.gitlab.updateMRNote).not.toHaveBeenCalled()

  // Change without kind='review' but mapping is review_thread → also skipped by notes path
  // (ReviewThreadsSyncManager owns review_thread entries)
  await h.manager.applyLocal(h.ctx, 'binding-1', `note:${hulyRef}`, {
    message: 'Body update for review thread'
  })
  expect(h.gitlab.updateNote).not.toHaveBeenCalled()
  expect(h.gitlab.updateMRNote).not.toHaveBeenCalled()
})

test('P3-T-08 T6 (C14). Deferred review retry: position note arrives before parent MR → _reviewRetried set; second arrival with MR present → re-enqueue with kind "review"', async () => {
  // First attempt: MR not seeded → deferred as note with _reviewRetried=true
  const h = buildHarness({ seedIssue: false, seedMR: false })
  const payload = makePositionWebhookPayload({ noteId: 900 })

  await h.manager.applyRemote(h.ctx, 'binding-1', payload)

  // Should be deferred back as 'note' (not review yet — parent missing)
  expect(h.enqueued).toHaveLength(1)
  expect(h.enqueued[0].kind).toBe('note')
  expect(h.enqueued[0].record._reviewRetried).toBe(true)
  expect(h.huly.creates).toBe(0)

  // Now seed the MR and retry
  await h.idmap.updateOne(
    { workspaceUuid: WORKSPACE, gitlabKind: 'merge_request', gitlabId: MR_GITLAB_ID },
    { $set: { workspaceUuid: WORKSPACE, gitlabKind: 'merge_request', gitlabId: MR_GITLAB_ID, hulyClass: 'tracker:class:Issue', hulyRef: MR_REF } }
  )

  await h.manager.applyRemote(h.ctx, 'binding-1', h.enqueued[0].record)

  // Second attempt: MR now present → enqueued as 'review'
  expect(h.enqueued).toHaveLength(2)
  expect(h.enqueued[1].kind).toBe('review')
  // _reviewRetried propagated into the review envelope
  expect(h.enqueued[1].record._reviewRetried).toBe(true)
})

test('P3-T-08 T7 (C14). Deferred drop: position note + parent still missing on retry → dropped, review.parent.missing metric logged', async () => {
  const h = buildHarness({ seedIssue: false, seedMR: false })
  const warn = jest.fn()
  h.ctx.logger.warn = warn

  const payload = makePositionWebhookPayload({ noteId: 901 })

  // First attempt → deferred
  await h.manager.applyRemote(h.ctx, 'binding-1', payload)
  expect(h.enqueued).toHaveLength(1)
  expect(h.enqueued[0].record._reviewRetried).toBe(true)

  // Second attempt with _reviewRetried=true, MR still missing → dropped
  await h.manager.applyRemote(h.ctx, 'binding-1', h.enqueued[0].record)

  // No further enqueue
  expect(h.enqueued).toHaveLength(1)
  expect(h.huly.creates).toBe(0)
  // review.parent.missing metric logged
  expect(warn).toHaveBeenCalledWith(
    expect.stringContaining('review note parent MR still missing after retry'),
    expect.objectContaining({ metric: 'review.parent.missing' })
  )
})

test('P3-T-08 T8. Position note + confidential MR (idmap miss) → deferred once then dropped (defense-in-depth)', async () => {
  // No MR in idmap — simulates confidential MR that the webhook layer filtered out
  const h = buildHarness({ seedIssue: false, seedMR: false })
  const payload = makePositionWebhookPayload({ noteId: 902 })

  // First attempt → deferred
  await h.manager.applyRemote(h.ctx, 'binding-1', payload)
  expect(h.enqueued).toHaveLength(1)
  expect(h.enqueued[0].kind).toBe('note')

  // Second attempt → dropped (MR never appears)
  await h.manager.applyRemote(h.ctx, 'binding-1', h.enqueued[0].record)
  expect(h.enqueued).toHaveLength(1) // no second enqueue
  expect(h.huly.creates).toBe(0)
})
