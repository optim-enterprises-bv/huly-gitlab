import request from 'supertest'
import express from 'express'
import bodyParser from 'body-parser'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { MongoClient } from 'mongodb'
import { createBindingRouter } from '../../src/http/binding'
import { getCredential } from '../../src/state/credentials'
import { Store } from '../../src/state/store'
import type { Logger } from '../../src/logging'
import type { BindingLifecycleService } from '../../src/sync/binding-lifecycle'
import { randomBytes } from 'node:crypto'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger (): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
}

const SERVER_SECRET = 'test-server-secret'
const ENCRYPTION_KEY = randomBytes(32)

let mongod: MongoMemoryServer
let client: MongoClient
let store: Store

beforeAll(async () => {
  mongod = await MongoMemoryServer.create()
  const uri = mongod.getUri()
  store = new Store(uri, 'test-binding-db')
  await store.connect()
  client = new MongoClient(uri)
  await client.connect()
})

afterAll(async () => {
  await store.disconnect()
  await client.close()
  await mongod.stop()
})

beforeEach(async () => {
  // Clear collections between tests
  await store.bindings().deleteMany({})
  await store.credentials().deleteMany({})
})

function buildApp (): express.Express {
  const app = express()
  app.use(bodyParser.json({ limit: '5mb' }))
  app.use(createBindingRouter(store, ENCRYPTION_KEY, SERVER_SECRET, makeLogger()))
  return app
}

const validBody = {
  workspaceUuid: 'ws-test-1',
  hulyProjectRef: 'proj-test-1',
  gitlabProjectId: 100,
  gitlabProjectPath: 'group/repo',
  credentialRef: '507f1f77bcf86cd799439011'
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('binding admin routes', () => {
  test('1. Missing bearer → 401', async () => {
    const app = buildApp()

    const res = await request(app)
      .post('/api/v1/bindings')
      .send(validBody)

    expect(res.status).toBe(401)
  })

  test('2. POST creates binding, returns {bindingId, webhookRegistered:false}', async () => {
    const app = buildApp()

    const res = await request(app)
      .post('/api/v1/bindings')
      .set('Authorization', `Bearer ${SERVER_SECRET}`)
      .send(validBody)

    expect(res.status).toBe(201)
    expect(res.body).toHaveProperty('bindingId')
    expect(res.body.webhookRegistered).toBe(false)
  })

  test('3. POST stores webhook secret ENCRYPTED — raw binding doc has no plaintext secret', async () => {
    const app = buildApp()

    const res = await request(app)
      .post('/api/v1/bindings')
      .set('Authorization', `Bearer ${SERVER_SECRET}`)
      .send(validBody)

    expect(res.status).toBe(201)
    const { bindingId } = res.body as { bindingId: string }

    // Raw binding document should not contain any plaintext secret field
    const { ObjectId } = await import('mongodb')
    const rawBinding = await store.bindings().findOne({ _id: new ObjectId(bindingId) })
    expect(rawBinding).not.toBeNull()
    expect(rawBinding).not.toHaveProperty('webhookSecret')
    expect(rawBinding).not.toHaveProperty('secret')

    // The credential document should exist and be decryptable
    const secretRef = rawBinding?.webhookSecretRef
    expect(typeof secretRef).toBe('string')
    const cred = await getCredential(store.credentials(), ENCRYPTION_KEY, secretRef as string)
    expect(cred).not.toBeNull()
    expect(typeof cred?.plaintext).toBe('string')
    expect(cred?.plaintext.length).toBeGreaterThan(0)
  })

  test('4. GET response does NOT include webhookSecretRef or webhookSecret', async () => {
    const app = buildApp()

    await request(app)
      .post('/api/v1/bindings')
      .set('Authorization', `Bearer ${SERVER_SECRET}`)
      .send(validBody)

    const res = await request(app)
      .get('/api/v1/bindings')
      .set('Authorization', `Bearer ${SERVER_SECRET}`)

    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
    const binding = (res.body as Record<string, unknown>[])[0]
    expect(binding).not.toHaveProperty('webhookSecretRef')
    expect(binding).not.toHaveProperty('webhookSecret')
  })

  test('5. GET — credential stores a 32-byte random secret (base64-decoded = 32 bytes)', async () => {
    const app = buildApp()

    const postRes = await request(app)
      .post('/api/v1/bindings')
      .set('Authorization', `Bearer ${SERVER_SECRET}`)
      .send(validBody)

    expect(postRes.status).toBe(201)
    const { bindingId } = postRes.body as { bindingId: string }

    const { ObjectId } = await import('mongodb')
    const rawBinding = await store.bindings().findOne({ _id: new ObjectId(bindingId) })
    const cred = await getCredential(store.credentials(), ENCRYPTION_KEY, rawBinding?.webhookSecretRef as string)

    // The plaintext is base64-encoded 32 random bytes
    const decoded = Buffer.from(cred?.plaintext ?? '', 'base64')
    expect(decoded.length).toBe(32)
  })

  test('6. DELETE removes both binding and credential', async () => {
    const app = buildApp()

    const postRes = await request(app)
      .post('/api/v1/bindings')
      .set('Authorization', `Bearer ${SERVER_SECRET}`)
      .send(validBody)

    expect(postRes.status).toBe(201)
    const { bindingId } = postRes.body as { bindingId: string }

    // Get the webhookSecretRef before deletion
    const { ObjectId } = await import('mongodb')
    const rawBinding = await store.bindings().findOne({ _id: new ObjectId(bindingId) })
    const secretRef = rawBinding?.webhookSecretRef as string

    const deleteRes = await request(app)
      .delete(`/api/v1/bindings/${bindingId}`)
      .set('Authorization', `Bearer ${SERVER_SECRET}`)

    expect(deleteRes.status).toBe(200)

    // Binding should be gone
    const afterBinding = await store.bindings().findOne({ _id: new ObjectId(bindingId) })
    expect(afterBinding).toBeNull()

    // Credential should be gone
    const afterCred = await getCredential(store.credentials(), ENCRYPTION_KEY, secretRef)
    expect(afterCred).toBeNull()
  })

  // --- rotate-secret endpoint ---

  test('11. POST with non-ObjectId credentialRef → 400', async () => {
    const app = buildApp()
    const res = await request(app)
      .post('/api/v1/bindings')
      .set('Authorization', `Bearer ${SERVER_SECRET}`)
      .send({ ...validBody, credentialRef: 'not-a-valid-object-id' })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid id format')
  })

  test('12. DELETE with malformed :id → 400 not 404', async () => {
    const app = buildApp()
    const res = await request(app)
      .delete('/api/v1/bindings/not-a-valid-id')
      .set('Authorization', `Bearer ${SERVER_SECRET}`)

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid id format')
  })

  test('7. rotate-secret: missing bearer → 401', async () => {
    const app = buildApp()
    const res = await request(app).post('/api/v1/bindings/someid/rotate-secret')
    expect(res.status).toBe(401)
  })

  test('8. rotate-secret: unknown binding ID → 404', async () => {
    const app = buildApp()
    const { ObjectId } = await import('mongodb')
    const fakeId = new ObjectId().toHexString()

    const res = await request(app)
      .post(`/api/v1/bindings/${fakeId}/rotate-secret`)
      .set('Authorization', `Bearer ${SERVER_SECRET}`)

    expect(res.status).toBe(404)
  })

  test('9. rotate-secret: binding with webhookRegistered:true — dereg+reg called; response has rotatedAt, webhookRegistered:true; secret not in response', async () => {
    const app = buildApp()
    // Create a binding first
    const postRes = await request(app)
      .post('/api/v1/bindings')
      .set('Authorization', `Bearer ${SERVER_SECRET}`)
      .send(validBody)

    expect(postRes.status).toBe(201)
    const { bindingId } = postRes.body as { bindingId: string }

    // Manually set webhookRegistered:true and webhookId on the binding doc
    const { ObjectId } = await import('mongodb')
    await store.bindings().updateOne(
      { _id: new ObjectId(bindingId) },
      { $set: { webhookRegistered: true, webhookId: 42 } }
    )

    const mockRotate = jest.fn(async () => ({ webhookRegistered: true as const }))
    const mockLifecycle = {
      rotateWebhookSecret: mockRotate
    } as unknown as BindingLifecycleService

    const appWithLifecycle = express()
    appWithLifecycle.use(bodyParser.json({ limit: '5mb' }))
    appWithLifecycle.use(
      createBindingRouter(store, ENCRYPTION_KEY, SERVER_SECRET, makeLogger(), mockLifecycle, 'https://huly.example.com')
    )

    const res = await request(appWithLifecycle)
      .post(`/api/v1/bindings/${bindingId}/rotate-secret`)
      .set('Authorization', `Bearer ${SERVER_SECRET}`)

    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('rotatedAt')
    expect(res.body.webhookRegistered).toBe(true)
    // Secret must NOT appear in response
    expect(res.body).not.toHaveProperty('newSecret')
    expect(res.body).not.toHaveProperty('secret')
    expect(res.body).not.toHaveProperty('plaintext')

    // rotateWebhookSecret was called
    expect(mockRotate).toHaveBeenCalledTimes(1)
  })

  // --- re-register-webhook endpoint ---

  test('13. re-register-webhook: missing bearer → 401', async () => {
    const app = buildApp()
    const res = await request(app).post('/api/v1/bindings/someid/re-register-webhook')
    expect(res.status).toBe(401)
  })

  test('14. re-register-webhook: valid → 200 with {rotatedAt, webhookRegistered}; no secret in response', async () => {
    const app = buildApp()
    const postRes = await request(app)
      .post('/api/v1/bindings')
      .set('Authorization', `Bearer ${SERVER_SECRET}`)
      .send(validBody)

    expect(postRes.status).toBe(201)
    const { bindingId } = postRes.body as { bindingId: string }

    // Manually mark binding as registered with a webhookId so the lifecycle PUT path is taken.
    const { ObjectId } = await import('mongodb')
    await store.bindings().updateOne(
      { _id: new ObjectId(bindingId) },
      { $set: { webhookRegistered: true, webhookId: 555 } }
    )

    const mockReRegister = jest.fn(async () => ({ webhookRegistered: true as const, webhookId: 555 }))
    const mockLifecycle = {
      reRegisterWebhook: mockReRegister
    } as unknown as BindingLifecycleService

    const appWithLifecycle = express()
    appWithLifecycle.use(bodyParser.json({ limit: '5mb' }))
    appWithLifecycle.use(
      createBindingRouter(store, ENCRYPTION_KEY, SERVER_SECRET, makeLogger(), mockLifecycle, 'https://huly.example.com')
    )

    const res = await request(appWithLifecycle)
      .post(`/api/v1/bindings/${bindingId}/re-register-webhook`)
      .set('Authorization', `Bearer ${SERVER_SECRET}`)

    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('rotatedAt')
    expect(res.body.webhookRegistered).toBe(true)
    expect(res.body.webhookId).toBe(555)

    // Secret must NOT appear in response under any common alias.
    expect(res.body).not.toHaveProperty('secret')
    expect(res.body).not.toHaveProperty('newSecret')
    expect(res.body).not.toHaveProperty('plaintext')
    expect(res.body).not.toHaveProperty('webhookSecret')
    expect(res.body).not.toHaveProperty('webhookSecretRef')

    expect(mockReRegister).toHaveBeenCalledTimes(1)
  })

  test('15. re-register-webhook: unknown binding ID → 404', async () => {
    const app = buildApp()
    const { ObjectId } = await import('mongodb')
    const fakeId = new ObjectId().toHexString()

    const res = await request(app)
      .post(`/api/v1/bindings/${fakeId}/re-register-webhook`)
      .set('Authorization', `Bearer ${SERVER_SECRET}`)

    expect(res.status).toBe(404)
  })

  test('10. rotate-secret: binding with webhookRegistered:false — no GitLab API call; response has rotatedAt, webhookRegistered:false', async () => {
    const app = buildApp()
    // Create a binding (webhookRegistered defaults to false)
    const postRes = await request(app)
      .post('/api/v1/bindings')
      .set('Authorization', `Bearer ${SERVER_SECRET}`)
      .send(validBody)

    expect(postRes.status).toBe(201)
    const { bindingId } = postRes.body as { bindingId: string }

    const mockRotate = jest.fn()
    const mockLifecycle = {
      rotateWebhookSecret: mockRotate
    } as unknown as BindingLifecycleService

    const appWithLifecycle = express()
    appWithLifecycle.use(bodyParser.json({ limit: '5mb' }))
    appWithLifecycle.use(
      createBindingRouter(store, ENCRYPTION_KEY, SERVER_SECRET, makeLogger(), mockLifecycle, 'https://huly.example.com')
    )

    const res = await request(appWithLifecycle)
      .post(`/api/v1/bindings/${bindingId}/rotate-secret`)
      .set('Authorization', `Bearer ${SERVER_SECRET}`)

    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('rotatedAt')
    expect(res.body.webhookRegistered).toBe(false)
    // Secret must NOT appear in response
    expect(res.body).not.toHaveProperty('newSecret')
    expect(res.body).not.toHaveProperty('secret')

    // rotateWebhookSecret was NOT called (no webhookId, webhookRegistered:false)
    expect(mockRotate).not.toHaveBeenCalled()
  })
})
