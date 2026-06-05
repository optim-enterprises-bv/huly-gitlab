import { randomBytes } from 'node:crypto'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { MongoClient, type Collection } from 'mongodb'
import {
  putCredential,
  getCredential,
  deleteCredential,
  rotateCredential
} from './credentials'
import type { CredentialDoc } from './credentials'

let mongod: MongoMemoryServer
let client: MongoClient
let col: Collection<CredentialDoc>

const TEST_KEY = randomBytes(32)
const WRONG_KEY = randomBytes(32)

beforeAll(async () => {
  mongod = await MongoMemoryServer.create()
  client = new MongoClient(mongod.getUri())
  await client.connect()
  col = client.db('test').collection<CredentialDoc>('credentials')
})

afterAll(async () => {
  await client.close()
  await mongod.stop()
})

beforeEach(async () => {
  await col.deleteMany({})
})

describe('credentials round-trip', () => {
  it('encrypts and decrypts a plaintext value correctly', async () => {
    const original = 'super-secret-token-value'
    const id = await putCredential(col, TEST_KEY, { kind: 'access_token', plaintext: original })
    const result = await getCredential(col, TEST_KEY, id)
    expect(result).not.toBeNull()
    expect(result?.plaintext).toBe(original)
    expect(result?.kind).toBe('access_token')
  })

  it('round-trips oauth credential with refresh token', async () => {
    const token = 'oauth-access-token'
    const refresh = 'oauth-refresh-token'
    const id = await putCredential(col, TEST_KEY, {
      kind: 'oauth',
      plaintext: token,
      refreshTokenPlaintext: refresh
    })
    const result = await getCredential(col, TEST_KEY, id)
    expect(result?.plaintext).toBe(token)
    expect(result?.refreshTokenPlaintext).toBe(refresh)
  })

  it('round-trips webhook_secret kind', async () => {
    const secret = randomBytes(32).toString('base64')
    const id = await putCredential(col, TEST_KEY, { kind: 'webhook_secret', plaintext: secret })
    const result = await getCredential(col, TEST_KEY, id)
    expect(result?.plaintext).toBe(secret)
    expect(result?.kind).toBe('webhook_secret')
  })

  it('stores expiresAt and returns it', async () => {
    const expiresAt = new Date(Date.now() + 3600 * 1000)
    const id = await putCredential(col, TEST_KEY, {
      kind: 'oauth',
      plaintext: 'tok',
      expiresAt
    })
    const result = await getCredential(col, TEST_KEY, id)
    expect(result?.expiresAt?.getTime()).toBe(expiresAt.getTime())
  })

  it('returns null for unknown id', async () => {
    const { ObjectId } = await import('mongodb')
    const result = await getCredential(col, TEST_KEY, new ObjectId().toHexString())
    expect(result).toBeNull()
  })
})

describe('wrong key fails', () => {
  it('throws when decrypting with the wrong key', async () => {
    const id = await putCredential(col, TEST_KEY, { kind: 'access_token', plaintext: 'secret' })
    await expect(getCredential(col, WRONG_KEY, id)).rejects.toThrow()
  })
})

describe('tampered ciphertext fails GCM auth', () => {
  it('throws when ciphertext is tampered', async () => {
    const id = await putCredential(col, TEST_KEY, { kind: 'access_token', plaintext: 'secret' })
    // Tamper: flip bits in the stored ciphertext
    const raw = await col.findOne({ _id: (await import('mongodb')).ObjectId.createFromHexString(id) })
    expect(raw).not.toBeNull()
    if (raw === null) return
    const buf = Buffer.from(raw.ciphertext, 'base64')
    buf[0] ^= 0xff
    await col.updateOne(
      { _id: raw._id },
      { $set: { ciphertext: buf.toString('base64') } }
    )
    await expect(getCredential(col, TEST_KEY, id)).rejects.toThrow()
  })

  it('throws when auth tag is tampered', async () => {
    const id = await putCredential(col, TEST_KEY, { kind: 'access_token', plaintext: 'secret' })
    const raw = await col.findOne({ _id: (await import('mongodb')).ObjectId.createFromHexString(id) })
    if (raw === null) return
    const tagBuf = Buffer.from(raw.tag, 'base64')
    tagBuf[0] ^= 0xff
    await col.updateOne(
      { _id: raw._id },
      { $set: { tag: tagBuf.toString('base64') } }
    )
    await expect(getCredential(col, TEST_KEY, id)).rejects.toThrow()
  })
})

describe('delete', () => {
  it('removes the credential', async () => {
    const id = await putCredential(col, TEST_KEY, { kind: 'access_token', plaintext: 'tok' })
    await deleteCredential(col, id)
    const result = await getCredential(col, TEST_KEY, id)
    expect(result).toBeNull()
  })
})

describe('rotate', () => {
  it('produces a different ciphertext after rotation', async () => {
    const id = await putCredential(col, TEST_KEY, { kind: 'webhook_secret', plaintext: 'old-secret' })
    const before = await col.findOne({ _id: (await import('mongodb')).ObjectId.createFromHexString(id) })
    await rotateCredential(col, TEST_KEY, id, 'new-secret')
    const after = await col.findOne({ _id: (await import('mongodb')).ObjectId.createFromHexString(id) })
    expect(after?.ciphertext).not.toBe(before?.ciphertext)
  })

  it('decrypts to new plaintext after rotation', async () => {
    const id = await putCredential(col, TEST_KEY, { kind: 'webhook_secret', plaintext: 'old-secret' })
    await rotateCredential(col, TEST_KEY, id, 'new-secret')
    const result = await getCredential(col, TEST_KEY, id)
    expect(result?.plaintext).toBe('new-secret')
  })

  it('old key ciphertext fails with wrong key after rotation', async () => {
    const id = await putCredential(col, TEST_KEY, { kind: 'access_token', plaintext: 'original' })
    await rotateCredential(col, TEST_KEY, id, 'rotated')
    await expect(getCredential(col, WRONG_KEY, id)).rejects.toThrow()
  })
})
