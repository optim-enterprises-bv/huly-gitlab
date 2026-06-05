import request from 'supertest'
import express from 'express'
import bodyParser from 'body-parser'
import nock from 'nock'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { randomBytes } from 'node:crypto'
import { createAccessTokenRouter } from '../../src/auth/access-token'
import { getCredential } from '../../src/state/credentials'
import { Store } from '../../src/state/store'
import type { Logger } from '../../src/logging'
import type { Config } from '../../src/config'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger (): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
}

const GITLAB_BASE = 'http://gitlab.at.test'
const SERVER_SECRET = 'at-test-secret'
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
    GitLabBaseUrl: GITLAB_BASE,
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
  store = new Store(mongod.getUri(), 'test-at-db')
  await store.connect()
})

afterAll(async () => {
  await store.disconnect()
  await mongod.stop()
})

beforeEach(async () => {
  await store.credentials().deleteMany({})
  nock.cleanAll()
})

function buildApp (): express.Express {
  const app = express()
  app.use(bodyParser.json())
  // Mount at the same path the credentials router would use
  app.use('/api/v1/credentials/access-token', createAccessTokenRouter(makeConfig(), store, makeLogger()))
  return app
}

const validBody = {
  gitlabBaseUrl: GITLAB_BASE,
  token: 'glpat-test-token',
  scope: 'project' as const,
  resourceId: '42'
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/v1/credentials/access-token', () => {
  test('missing bearer → 401', async () => {
    const app = buildApp()
    const res = await request(app)
      .post('/api/v1/credentials/access-token')
      .send(validBody)
    expect(res.status).toBe(401)
  })

  test('wrong bearer → 401', async () => {
    const app = buildApp()
    const res = await request(app)
      .post('/api/v1/credentials/access-token')
      .set('Authorization', 'Bearer wrong-secret')
      .send(validBody)
    expect(res.status).toBe(401)
  })

  test('valid token validates against GET /api/v4/user, stored encrypted, returns credentialRef', async () => {
    const app = buildApp()

    nock(GITLAB_BASE)
      .get('/api/v4/user')
      .matchHeader('PRIVATE-TOKEN', 'glpat-test-token')
      .reply(200, { id: 1, username: 'testuser' })

    const res = await request(app)
      .post('/api/v1/credentials/access-token')
      .set('Authorization', `Bearer ${SERVER_SECRET}`)
      .send(validBody)

    expect(res.status).toBe(201)
    expect(typeof res.body.credentialRef).toBe('string')

    // Verify stored encrypted and round-trips correctly
    const credentialRef = res.body.credentialRef as string
    const cred = await getCredential(store.credentials(), ENCRYPTION_KEY_BYTES, credentialRef)
    expect(cred).not.toBeNull()
    expect(cred?.plaintext).toBe('glpat-test-token')
    expect(cred?.kind).toBe('access_token')
  })

  test('GitLab returns 401 → 400 with error message', async () => {
    const app = buildApp()

    nock(GITLAB_BASE)
      .get('/api/v4/user')
      .reply(401, { message: '401 Unauthorized' })

    const res = await request(app)
      .post('/api/v1/credentials/access-token')
      .set('Authorization', `Bearer ${SERVER_SECRET}`)
      .send(validBody)

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_token')
  })

  test('GitLab returns 5xx → 502', async () => {
    const app = buildApp()

    nock(GITLAB_BASE)
      .get('/api/v4/user')
      .reply(500, { message: 'Internal Server Error' })

    const res = await request(app)
      .post('/api/v1/credentials/access-token')
      .set('Authorization', `Bearer ${SERVER_SECRET}`)
      .send(validBody)

    expect(res.status).toBe(502)
    expect(res.body.error).toBe('upstream_error')
  })

  test('missing token in body → 400', async () => {
    const app = buildApp()
    const res = await request(app)
      .post('/api/v1/credentials/access-token')
      .set('Authorization', `Bearer ${SERVER_SECRET}`)
      .send({ gitlabBaseUrl: GITLAB_BASE, scope: 'project', resourceId: '1' })
    expect(res.status).toBe(400)
  })

  test('missing gitlabBaseUrl → 400', async () => {
    const app = buildApp()
    const res = await request(app)
      .post('/api/v1/credentials/access-token')
      .set('Authorization', `Bearer ${SERVER_SECRET}`)
      .send({ token: 'tok', scope: 'project', resourceId: '1' })
    expect(res.status).toBe(400)
  })

  test('invalid gitlabBaseUrl (ftp scheme) → 400, fetch NOT called', async () => {
    const app = buildApp()
    const res = await request(app)
      .post('/api/v1/credentials/access-token')
      .set('Authorization', `Bearer ${SERVER_SECRET}`)
      .send({ ...validBody, gitlabBaseUrl: 'ftp://attacker.example.com' })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid gitlabBaseUrl')
    // No nock interceptors should have been consumed — GitLab was NOT called
    expect(nock.pendingMocks().length).toBe(0)
    expect(nock.activeMocks().length).toBe(0)
  })
})
