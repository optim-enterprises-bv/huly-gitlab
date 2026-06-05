import request from 'supertest'
import express from 'express'
import bodyParser from 'body-parser'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { randomBytes } from 'node:crypto'
import { CredentialResolver, createCredentialsRouter } from '../../src/auth'
import { putCredential } from '../../src/state/credentials'
import { Store } from '../../src/state/store'
import type { Logger } from '../../src/logging'
import type { Config } from '../../src/config'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger (): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
}

const SERVER_SECRET = 'cred-resolver-secret'
const ENCRYPTION_KEY_BYTES = randomBytes(32)
const ENCRYPTION_KEY_B64 = ENCRYPTION_KEY_BYTES.toString('base64')

function makeConfig (): Config {
  return {
    Port: 3600,
    PublicBaseUrl: 'http://localhost:3600',
    AccountsURL: 'http://accounts.test',
    ServerSecret: SERVER_SECRET,
    ServiceID: 'test-service',
    MongoUrl: '',
    MongoDb: 'test',
    GitLabBaseUrl: 'http://gitlab.test',
    GitLabClientId: 'cid',
    GitLabClientSecret: 'csec',
    CredentialEncryptionKey: ENCRYPTION_KEY_B64,
    WebhookSecretSeed: 'seed',
    AllowedWorkspaces: ['*'],
    BackfillIntervalMs: 300000,
    RateLimit: 25,
    LogLevel: 'error',
    BrandingPath: '',
    OAuthRedirectUri: 'http://localhost:3600/oauth/callback'
  }
}

let mongod: MongoMemoryServer
let store: Store

beforeAll(async () => {
  mongod = await MongoMemoryServer.create()
  store = new Store(mongod.getUri(), 'test-cred-resolver-db')
  await store.connect()
})

afterAll(async () => {
  await store.disconnect()
  await mongod.stop()
})

beforeEach(async () => {
  await store.credentials().deleteMany({})
})

function buildApp (): express.Express {
  const app = express()
  app.use(bodyParser.json())
  app.use('/api/v1/credentials', createCredentialsRouter({ config: makeConfig(), store, logger: makeLogger() }))
  return app
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CredentialResolver.list()', () => {
  test('returns sanitized records — no token field, no ciphertext', async () => {
    await putCredential(store.credentials(), ENCRYPTION_KEY_BYTES, {
      kind: 'oauth',
      plaintext: 'super-secret-token',
      refreshTokenPlaintext: 'super-secret-refresh',
      expiresAt: new Date(Date.now() + 3600 * 1000),
      gitlabBaseUrl: 'http://gitlab.test',
      workspaceUuid: 'ws-sanitize'
    })

    const resolver = new CredentialResolver({ store, encryptionKey: ENCRYPTION_KEY_BYTES })
    const list = await resolver.list()

    expect(list.length).toBe(1)
    const item = list[0]

    // Must have summary fields
    expect(typeof item.credentialRef).toBe('string')
    expect(item.kind).toBe('oauth')
    expect(item.createdAt).toBeInstanceOf(Date)
    expect(item.expiresAt).toBeInstanceOf(Date)
    expect(item.workspaceUuid).toBe('ws-sanitize')
    expect(item.gitlabBaseUrl).toBe('http://gitlab.test')

    // Must NOT expose any plaintext or ciphertext
    const raw = item as Record<string, unknown>
    expect(raw).not.toHaveProperty('token')
    expect(raw).not.toHaveProperty('plaintext')
    expect(raw).not.toHaveProperty('ciphertext')
    expect(raw).not.toHaveProperty('iv')
    expect(raw).not.toHaveProperty('tag')
    expect(raw).not.toHaveProperty('refreshTokenCiphertext')
    expect(raw).not.toHaveProperty('refreshTokenIv')
    expect(raw).not.toHaveProperty('refreshTokenTag')
  })

  test('filter by workspaceUuid returns only matching credentials', async () => {
    await putCredential(store.credentials(), ENCRYPTION_KEY_BYTES, {
      kind: 'access_token',
      plaintext: 'token-ws-a',
      workspaceUuid: 'ws-a'
    })
    await putCredential(store.credentials(), ENCRYPTION_KEY_BYTES, {
      kind: 'access_token',
      plaintext: 'token-ws-b',
      workspaceUuid: 'ws-b'
    })

    const resolver = new CredentialResolver({ store, encryptionKey: ENCRYPTION_KEY_BYTES })
    const list = await resolver.list({ workspaceUuid: 'ws-a' })

    expect(list.length).toBe(1)
    expect(list[0].workspaceUuid).toBe('ws-a')
  })

  test('list without filter returns all credentials', async () => {
    await putCredential(store.credentials(), ENCRYPTION_KEY_BYTES, { kind: 'access_token', plaintext: 'tok-1' })
    await putCredential(store.credentials(), ENCRYPTION_KEY_BYTES, { kind: 'access_token', plaintext: 'tok-2' })
    await putCredential(store.credentials(), ENCRYPTION_KEY_BYTES, { kind: 'oauth', plaintext: 'tok-3' })

    const resolver = new CredentialResolver({ store, encryptionKey: ENCRYPTION_KEY_BYTES })
    const list = await resolver.list()

    expect(list.length).toBe(3)
  })
})

describe('GET /api/v1/credentials', () => {
  test('missing bearer → 401', async () => {
    const app = buildApp()
    const res = await request(app).get('/api/v1/credentials')
    expect(res.status).toBe(401)
  })

  test('wrong bearer → 401', async () => {
    const app = buildApp()
    const res = await request(app)
      .get('/api/v1/credentials')
      .set('Authorization', 'Bearer wrong')
    expect(res.status).toBe(401)
  })

  test('valid bearer returns list with no ciphertext', async () => {
    await putCredential(store.credentials(), ENCRYPTION_KEY_BYTES, {
      kind: 'access_token',
      plaintext: 'sensitive-token',
      workspaceUuid: 'ws-list-test'
    })

    const app = buildApp()
    const res = await request(app)
      .get('/api/v1/credentials')
      .set('Authorization', `Bearer ${SERVER_SECRET}`)

    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)

    const items = res.body as Record<string, unknown>[]
    expect(items.length).toBeGreaterThanOrEqual(1)

    const item = items.find(i => i.workspaceUuid === 'ws-list-test')
    expect(item).toBeDefined()
    expect(item).not.toHaveProperty('ciphertext')
    expect(item).not.toHaveProperty('token')
    expect(item).not.toHaveProperty('plaintext')
  })
})
