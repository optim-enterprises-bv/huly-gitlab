import { MongoMemoryServer } from 'mongodb-memory-server'
import { Store } from '../../src/state/store'
import { findMirroredAttachment, insertMirroredAttachment } from '../../src/state/attachment-mirror'

let mongod: MongoMemoryServer
let store: Store

beforeAll(async () => {
  mongod = await MongoMemoryServer.create()
  store = new Store(mongod.getUri(), 'test-attachment-mirror')
  await store.connect()
})

afterAll(async () => {
  await store.disconnect()
  await mongod.stop()
})

describe('Store.attachmentMirror accessor and index', () => {
  it('provides the attachment_mirror collection', () => {
    const col = store.attachmentMirror()
    expect(col).toBeDefined()
    expect(col.collectionName).toBe('attachment_mirror')
  })

  it('creates unique index on (contentHash, origin)', async () => {
    const indexes = await store.attachmentMirror().listIndexes().toArray()
    const idx = indexes.find((i) => i.name === 'attachment_mirror_hash_origin')
    expect(idx).toBeDefined()
    expect(idx?.unique).toBe(true)
    expect(idx?.key).toEqual({ contentHash: 1, origin: 1 })
  })
})

describe('findMirroredAttachment', () => {
  beforeEach(async () => {
    await store.attachmentMirror().deleteMany({})
  })

  it('returns null when no entry exists', async () => {
    const result = await findMirroredAttachment(store.attachmentMirror(), 'nonexistent-hash', 'gitlab')
    expect(result).toBeNull()
  })

  it('returns the entry when it exists', async () => {
    await insertMirroredAttachment(
      store.attachmentMirror(),
      'abc123hash',
      'gitlab',
      'https://gitlab.example/uploads/aa/file.png',
      'attachments://huly-ref'
    )
    const result = await findMirroredAttachment(store.attachmentMirror(), 'abc123hash', 'gitlab')
    expect(result).not.toBeNull()
    expect(result?.targetUrl).toBe('attachments://huly-ref')
    expect(result?.sourceUrl).toBe('https://gitlab.example/uploads/aa/file.png')
    expect(result?.origin).toBe('gitlab')
  })

  it('scopes by origin — gitlab and huly entries are independent', async () => {
    const hash = 'same-hash-different-origin'
    await insertMirroredAttachment(
      store.attachmentMirror(), hash, 'gitlab',
      'https://gitlab.example/uploads/aa/f.png', 'attachments://from-gitlab'
    )
    await insertMirroredAttachment(
      store.attachmentMirror(), hash, 'huly',
      'attachments://huly-source', 'https://gitlab.example/uploads/bb/f.png'
    )

    const gitlabEntry = await findMirroredAttachment(store.attachmentMirror(), hash, 'gitlab')
    const hulyEntry = await findMirroredAttachment(store.attachmentMirror(), hash, 'huly')
    expect(gitlabEntry?.targetUrl).toBe('attachments://from-gitlab')
    expect(hulyEntry?.targetUrl).toBe('https://gitlab.example/uploads/bb/f.png')
  })
})

describe('insertMirroredAttachment', () => {
  beforeEach(async () => {
    await store.attachmentMirror().deleteMany({})
  })

  it('inserts a new document', async () => {
    await insertMirroredAttachment(
      store.attachmentMirror(),
      'hash-new',
      'gitlab',
      'https://gitlab.example/uploads/zz/f.png',
      'attachments://ref-new'
    )
    const doc = await store.attachmentMirror().findOne({ contentHash: 'hash-new', origin: 'gitlab' })
    expect(doc).not.toBeNull()
    expect(doc?.targetUrl).toBe('attachments://ref-new')
    expect(doc?.createdAt).toBeInstanceOf(Date)
  })

  it('is idempotent — duplicate insert does not throw', async () => {
    const hash = 'hash-dup'
    await insertMirroredAttachment(
      store.attachmentMirror(), hash, 'gitlab',
      'https://gitlab.example/uploads/dup/f.png', 'attachments://ref-dup'
    )
    // Second insert with same hash+origin should be silently ignored
    await expect(
      insertMirroredAttachment(
        store.attachmentMirror(), hash, 'gitlab',
        'https://gitlab.example/uploads/dup2/f.png', 'attachments://ref-dup2'
      )
    ).resolves.toBeUndefined()

    // Original entry remains
    const docs = await store.attachmentMirror().find({ contentHash: hash, origin: 'gitlab' }).toArray()
    expect(docs).toHaveLength(1)
    expect(docs[0].targetUrl).toBe('attachments://ref-dup')
  })

  it('unique index enforces (contentHash, origin) uniqueness at DB level', async () => {
    const hash = 'hash-unique-test'
    await insertMirroredAttachment(
      store.attachmentMirror(), hash, 'huly',
      'attachments://src', 'https://gitlab.example/uploads/q/f.png'
    )
    // Direct insert bypassing the helper should fail with duplicate key error
    await expect(
      store.attachmentMirror().insertOne({
        _id: new (require('mongodb').ObjectId)(),
        contentHash: hash,
        origin: 'huly',
        sourceUrl: 'attachments://src2',
        targetUrl: 'https://gitlab.example/uploads/r/f.png',
        createdAt: new Date()
      })
    ).rejects.toMatchObject({ code: 11000 })
  })
})
