import { randomBytes } from 'node:crypto'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { Store } from './store'
import { createBinding, listBindings, getBinding, deleteBinding } from './bindings'
import { getCursor, setCursor } from './cursors'
import { upsertIdMap, findByGitlab, findByHuly } from './idmap'
import { checkAndMarkSeen } from './dedup'
import { putCredential } from './credentials'

let mongod: MongoMemoryServer
let store: Store

const TEST_KEY = randomBytes(32)

beforeAll(async () => {
  mongod = await MongoMemoryServer.create()
  store = new Store(mongod.getUri(), 'test-state')
  await store.connect()
})

afterAll(async () => {
  await store.disconnect()
  await mongod.stop()
})

describe('Store.connect creates indexes', () => {
  it('creates unique index on bindings (workspaceUuid, gitlabProjectId)', async () => {
    const indexes = await store.bindings().listIndexes().toArray()
    const found = indexes.find((idx) => idx.name === 'bindings_workspace_project')
    expect(found).toBeDefined()
    expect(found?.unique).toBe(true)
  })

  it('creates unique index on cursors (bindingId, kind)', async () => {
    const indexes = await store.cursors().listIndexes().toArray()
    const found = indexes.find((idx) => idx.name === 'cursors_binding_kind')
    expect(found).toBeDefined()
    expect(found?.unique).toBe(true)
  })

  it('creates unique indexes on idmap (both directions)', async () => {
    const indexes = await store.idmap().listIndexes().toArray()
    const gitlab = indexes.find((idx) => idx.name === 'idmap_gitlab_direction')
    const huly = indexes.find((idx) => idx.name === 'idmap_huly_direction')
    expect(gitlab).toBeDefined()
    expect(gitlab?.unique).toBe(true)
    expect(huly).toBeDefined()
    expect(huly?.unique).toBe(true)
  })

  it('creates TTL index on dedup (7 days)', async () => {
    const indexes = await store.dedup().listIndexes().toArray()
    const ttlIdx = indexes.find((idx) => idx.name === 'dedup_ttl')
    expect(ttlIdx).toBeDefined()
    expect(ttlIdx?.expireAfterSeconds).toBe(7 * 24 * 60 * 60)
  })

  it('creates TTL index on inflight (1 hour)', async () => {
    const indexes = await store.inflight().listIndexes().toArray()
    const ttlIdx = indexes.find((idx) => idx.name === 'inflight_ttl')
    expect(ttlIdx).toBeDefined()
    expect(ttlIdx?.expireAfterSeconds).toBe(60 * 60)
  })
})

describe('Bindings CRUD', () => {
  beforeEach(async () => {
    await store.bindings().deleteMany({})
  })

  it('creates and retrieves a binding', async () => {
    const view = await createBinding(store.bindings(), {
      workspaceUuid: 'ws-1',
      hulyProjectRef: 'proj-ref',
      gitlabProjectId: 42,
      gitlabProjectPath: 'group/project',
      credentialRef: 'cred-1',
      webhookSecretRef: 'secret-ref-1'
    })
    expect(view.workspaceUuid).toBe('ws-1')
    expect(view.gitlabProjectId).toBe(42)
    expect(view.webhookRegistered).toBe(false)
    expect(view.disabled).toBe(false)

    const doc = await getBinding(store.bindings(), view.id)
    expect(doc).not.toBeNull()
    expect(doc?.gitlabProjectPath).toBe('group/project')
  })

  it('enforces uniqueness on (workspaceUuid, gitlabProjectId)', async () => {
    await createBinding(store.bindings(), {
      workspaceUuid: 'ws-dup',
      hulyProjectRef: 'ref-a',
      gitlabProjectId: 99,
      gitlabProjectPath: 'g/p',
      credentialRef: 'c1',
      webhookSecretRef: 'sr1'
    })
    await expect(
      createBinding(store.bindings(), {
        workspaceUuid: 'ws-dup',
        hulyProjectRef: 'ref-b',
        gitlabProjectId: 99,
        gitlabProjectPath: 'g/p2',
        credentialRef: 'c2',
        webhookSecretRef: 'sr2'
      })
    ).rejects.toThrow()
  })

  it('allows same gitlabProjectId in different workspaces', async () => {
    await createBinding(store.bindings(), {
      workspaceUuid: 'ws-a',
      hulyProjectRef: 'ref-a',
      gitlabProjectId: 77,
      gitlabProjectPath: 'g/p',
      credentialRef: 'c1',
      webhookSecretRef: 'sr1'
    })
    await expect(
      createBinding(store.bindings(), {
        workspaceUuid: 'ws-b',
        hulyProjectRef: 'ref-b',
        gitlabProjectId: 77,
        gitlabProjectPath: 'g/p',
        credentialRef: 'c2',
        webhookSecretRef: 'sr2'
      })
    ).resolves.toBeDefined()
  })

  it('deletes a binding', async () => {
    const view = await createBinding(store.bindings(), {
      workspaceUuid: 'ws-del',
      hulyProjectRef: 'ref',
      gitlabProjectId: 1,
      gitlabProjectPath: 'g/p',
      credentialRef: 'c',
      webhookSecretRef: 'sr'
    })
    await deleteBinding(store.bindings(), view.id)
    const doc = await getBinding(store.bindings(), view.id)
    expect(doc).toBeNull()
  })

  it('GET binding view does not include webhookSecret or webhookSecretRef', async () => {
    const view = await createBinding(store.bindings(), {
      workspaceUuid: 'ws-sec',
      hulyProjectRef: 'ref',
      gitlabProjectId: 55,
      gitlabProjectPath: 'g/p',
      credentialRef: 'cred',
      webhookSecretRef: 'secret-credential-id'
    })
    const viewStr = JSON.stringify(view)
    expect(viewStr).not.toContain('webhookSecret')
    expect(viewStr).not.toContain('webhookSecretRef')
    expect(viewStr).not.toContain('secret-credential-id')

    const list = await listBindings(store.bindings(), { workspaceUuid: 'ws-sec' })
    const listStr = JSON.stringify(list)
    expect(listStr).not.toContain('webhookSecret')
    expect(listStr).not.toContain('webhookSecretRef')
    expect(listStr).not.toContain('secret-credential-id')
  })
})

describe('Cursors upsert', () => {
  beforeEach(async () => {
    await store.cursors().deleteMany({})
  })

  it('returns null when no cursor exists', async () => {
    const result = await getCursor(store.cursors(), 'bind-1', 'issues')
    expect(result).toBeNull()
  })

  it('upserts and retrieves a cursor', async () => {
    const ts = new Date('2025-01-01T00:00:00Z')
    await setCursor(store.cursors(), 'bind-1', 'issues', ts)
    const result = await getCursor(store.cursors(), 'bind-1', 'issues')
    expect(result?.getTime()).toBe(ts.getTime())
  })

  it('overwrites existing cursor on upsert', async () => {
    const ts1 = new Date('2025-01-01T00:00:00Z')
    const ts2 = new Date('2025-06-01T00:00:00Z')
    await setCursor(store.cursors(), 'bind-1', 'notes', ts1)
    await setCursor(store.cursors(), 'bind-1', 'notes', ts2)
    const result = await getCursor(store.cursors(), 'bind-1', 'notes')
    expect(result?.getTime()).toBe(ts2.getTime())
  })

  it('stores issues and notes cursors independently', async () => {
    const ts1 = new Date('2025-01-01T00:00:00Z')
    const ts2 = new Date('2025-03-01T00:00:00Z')
    await setCursor(store.cursors(), 'bind-2', 'issues', ts1)
    await setCursor(store.cursors(), 'bind-2', 'notes', ts2)
    expect((await getCursor(store.cursors(), 'bind-2', 'issues'))?.getTime()).toBe(ts1.getTime())
    expect((await getCursor(store.cursors(), 'bind-2', 'notes'))?.getTime()).toBe(ts2.getTime())
  })

  it('upserts and retrieves a merge_requests cursor', async () => {
    const ts = new Date('2025-04-01T00:00:00Z')
    await setCursor(store.cursors(), 'bind-3', 'merge_requests', ts)
    const result = await getCursor(store.cursors(), 'bind-3', 'merge_requests')
    expect(result?.getTime()).toBe(ts.getTime())
  })

  it('upserts and retrieves a pipelines cursor', async () => {
    const ts = new Date('2025-05-01T00:00:00Z')
    await setCursor(store.cursors(), 'bind-3', 'pipelines', ts)
    const result = await getCursor(store.cursors(), 'bind-3', 'pipelines')
    expect(result?.getTime()).toBe(ts.getTime())
  })

  it('(bindingId, kind) uniqueness preserved across new kinds', async () => {
    const ts1 = new Date('2025-04-01T00:00:00Z')
    const ts2 = new Date('2025-05-01T00:00:00Z')
    await setCursor(store.cursors(), 'bind-4', 'merge_requests', ts1)
    await setCursor(store.cursors(), 'bind-4', 'pipelines', ts2)
    expect((await getCursor(store.cursors(), 'bind-4', 'merge_requests'))?.getTime()).toBe(ts1.getTime())
    expect((await getCursor(store.cursors(), 'bind-4', 'pipelines'))?.getTime()).toBe(ts2.getTime())
  })

  it('upserts and retrieves a reviews cursor', async () => {
    const ts = new Date('2025-07-01T00:00:00Z')
    await setCursor(store.cursors(), 'bind-5', 'reviews', ts)
    const result = await getCursor(store.cursors(), 'bind-5', 'reviews')
    expect(result?.getTime()).toBe(ts.getTime())
  })
})

describe('IdMap bidirectional lookup', () => {
  beforeEach(async () => {
    await store.idmap().deleteMany({})
  })

  it('upserts and finds by gitlab direction', async () => {
    await upsertIdMap(store.idmap(), 'ws-1', 'issue', '101', 'tracker.class.Issue', 'huly-ref-abc')
    const doc = await findByGitlab(store.idmap(), 'ws-1', 'issue', '101')
    expect(doc).not.toBeNull()
    expect(doc?.hulyRef).toBe('huly-ref-abc')
    expect(doc?.hulyClass).toBe('tracker.class.Issue')
  })

  it('finds by huly direction', async () => {
    await upsertIdMap(store.idmap(), 'ws-1', 'note', '202', 'chunter.class.ChatMessage', 'huly-msg-xyz')
    const doc = await findByHuly(store.idmap(), 'ws-1', 'chunter.class.ChatMessage', 'huly-msg-xyz')
    expect(doc).not.toBeNull()
    expect(doc?.gitlabId).toBe('202')
    expect(doc?.gitlabKind).toBe('note')
  })

  it('returns null for unknown gitlab entry', async () => {
    const doc = await findByGitlab(store.idmap(), 'ws-1', 'user', 'nonexistent')
    expect(doc).toBeNull()
  })

  it('returns null for unknown huly entry', async () => {
    const doc = await findByHuly(store.idmap(), 'ws-1', 'tracker.class.Issue', 'nonexistent')
    expect(doc).toBeNull()
  })

  it('scopes lookups per workspaceUuid', async () => {
    await upsertIdMap(store.idmap(), 'ws-A', 'label', 'lb-1', 'tracker.class.Tag', 'tag-ref-a')
    const inA = await findByGitlab(store.idmap(), 'ws-A', 'label', 'lb-1')
    const inB = await findByGitlab(store.idmap(), 'ws-B', 'label', 'lb-1')
    expect(inA).not.toBeNull()
    expect(inB).toBeNull()
  })

  it('updates existing entry on re-upsert', async () => {
    await upsertIdMap(store.idmap(), 'ws-1', 'milestone', 'ms-1', 'tracker.class.Milestone', 'old-ref')
    await upsertIdMap(store.idmap(), 'ws-1', 'milestone', 'ms-1', 'tracker.class.Milestone', 'new-ref')
    const doc = await findByGitlab(store.idmap(), 'ws-1', 'milestone', 'ms-1')
    expect(doc?.hulyRef).toBe('new-ref')
  })

  it('upserts merge_request kind and finds by both directions', async () => {
    await upsertIdMap(store.idmap(), 'ws-mr', 'merge_request', '42', 'tracker.class.Issue', 'huly-mr-abc')
    const byGitlab = await findByGitlab(store.idmap(), 'ws-mr', 'merge_request', '42')
    expect(byGitlab).not.toBeNull()
    expect(byGitlab?.hulyRef).toBe('huly-mr-abc')
    expect(byGitlab?.hulyClass).toBe('tracker.class.Issue')
    const byHuly = await findByHuly(store.idmap(), 'ws-mr', 'tracker.class.Issue', 'huly-mr-abc')
    expect(byHuly).not.toBeNull()
    expect(byHuly?.gitlabId).toBe('42')
    expect(byHuly?.gitlabKind).toBe('merge_request')
  })

  it('upserts pipeline kind and finds by both directions', async () => {
    await upsertIdMap(store.idmap(), 'ws-pl', 'pipeline', '99', 'tracker.class.Issue', 'huly-pl-xyz')
    const byGitlab = await findByGitlab(store.idmap(), 'ws-pl', 'pipeline', '99')
    expect(byGitlab).not.toBeNull()
    expect(byGitlab?.hulyRef).toBe('huly-pl-xyz')
    expect(byGitlab?.hulyClass).toBe('tracker.class.Issue')
    const byHuly = await findByHuly(store.idmap(), 'ws-pl', 'tracker.class.Issue', 'huly-pl-xyz')
    expect(byHuly).not.toBeNull()
    expect(byHuly?.gitlabId).toBe('99')
    expect(byHuly?.gitlabKind).toBe('pipeline')
  })

  it('does not collide across different gitlabKind values for same numeric id', async () => {
    await upsertIdMap(store.idmap(), 'ws-x', 'issue', '42', 'tracker.class.Issue', 'huly-issue-42')
    await upsertIdMap(store.idmap(), 'ws-x', 'merge_request', '42', 'tracker.class.Issue', 'huly-mr-42')
    const issue = await findByGitlab(store.idmap(), 'ws-x', 'issue', '42')
    const mr = await findByGitlab(store.idmap(), 'ws-x', 'merge_request', '42')
    expect(issue?.hulyRef).toBe('huly-issue-42')
    expect(mr?.hulyRef).toBe('huly-mr-42')
  })

  it('upserts review_thread kind and finds by both directions', async () => {
    await upsertIdMap(store.idmap(), 'ws-rt', 'review_thread', 'disc-abc', 'chunter.class.Thread', 'huly-thread-abc')
    const byGitlab = await findByGitlab(store.idmap(), 'ws-rt', 'review_thread', 'disc-abc')
    expect(byGitlab).not.toBeNull()
    expect(byGitlab?.hulyRef).toBe('huly-thread-abc')
    expect(byGitlab?.hulyClass).toBe('chunter.class.Thread')
    const byHuly = await findByHuly(store.idmap(), 'ws-rt', 'chunter.class.Thread', 'huly-thread-abc')
    expect(byHuly).not.toBeNull()
    expect(byHuly?.gitlabId).toBe('disc-abc')
    expect(byHuly?.gitlabKind).toBe('review_thread')
  })
})

describe('Dedup TTL behavior', () => {
  beforeEach(async () => {
    await store.dedup().deleteMany({})
  })

  it('returns false (new) then true (duplicate) for same event', async () => {
    const first = await checkAndMarkSeen(store.dedup(), 'bind-1', 'evt-1', 'v1')
    expect(first).toBe(false)
    const second = await checkAndMarkSeen(store.dedup(), 'bind-1', 'evt-1', 'v1')
    expect(second).toBe(true)
  })

  it('treats different versions as distinct events', async () => {
    const r1 = await checkAndMarkSeen(store.dedup(), 'bind-1', 'evt-2', 'v1')
    const r2 = await checkAndMarkSeen(store.dedup(), 'bind-1', 'evt-2', 'v2')
    expect(r1).toBe(false)
    expect(r2).toBe(false)
  })

  it('TTL index exists on createdAt field with 7-day expiry', async () => {
    const indexes = await store.dedup().listIndexes().toArray()
    const ttlIdx = indexes.find((idx) => idx.name === 'dedup_ttl')
    expect(ttlIdx).toBeDefined()
    expect(ttlIdx?.expireAfterSeconds).toBe(7 * 24 * 60 * 60)
    expect(ttlIdx?.key).toEqual({ createdAt: 1 })
  })
})

describe('Credentials encrypted round-trip via Store', () => {
  beforeEach(async () => {
    await store.credentials().deleteMany({})
  })

  it('stores and retrieves a credential', async () => {
    const id = await putCredential(store.credentials(), TEST_KEY, {
      kind: 'access_token',
      plaintext: 'my-token'
    })
    const { getCredential } = await import('./credentials')
    const result = await getCredential(store.credentials(), TEST_KEY, id)
    expect(result?.plaintext).toBe('my-token')
  })
})
