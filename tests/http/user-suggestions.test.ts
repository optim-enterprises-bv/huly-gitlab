import request from 'supertest'
import express from 'express'
import bodyParser from 'body-parser'
import nock from 'nock'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { randomBytes } from 'node:crypto'
import { ObjectId } from 'mongodb'
import { createUserSuggestionsRouter } from '../../src/http/user-suggestions'
import { Store } from '../../src/state/store'
import { signCookie } from '../../src/http/cookie-auth'
import { putUserCredential } from '../../src/state/user-credentials'
import type { WorkspaceUuid, PersonUuid } from '@hcengineering/core'
import type { Logger } from '../../src/logging'
import type { Config } from '../../src/config'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger (): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
}

const GITLAB_BASE = 'http://gitlab.suggestions.test'
const SERVER_SECRET = 'suggestions-test-secret'
const ENCRYPTION_KEY_BYTES = randomBytes(32)
const ENCRYPTION_KEY_B64 = ENCRYPTION_KEY_BYTES.toString('base64')
const PUBLIC_BASE_URL = 'http://localhost:3602'

const WS = 'ws-suggestions-001' as WorkspaceUuid
const PERSON = 'person-suggestions-aaa' as PersonUuid

function makeConfig (): Config {
  return {
    Port: 3602,
    PublicBaseUrl: PUBLIC_BASE_URL,
    AccountsURL: 'http://accounts.test',
    ServerSecret: SERVER_SECRET,
    ServiceID: 'test-service',
    MongoUrl: '',
    MongoDb: 'test',
    GitLabBaseUrl: GITLAB_BASE,
    GitLabClientId: 'test-client-id',
    GitLabClientSecret: 'test-client-secret',
    CredentialEncryptionKey: ENCRYPTION_KEY_B64,
    WebhookSecretSeed: 'seed',
    AllowedWorkspaces: ['*'],
    BackfillIntervalMs: 300000,
    RateLimit: 25,
    LogLevel: 'error',
    BrandingPath: '',
    OAuthRedirectUri: `${PUBLIC_BASE_URL}/user/oauth/callback`,
    CorsAllowedOrigins: []
  }
}

function makeCookie (workspaceUuid: string = WS, hulyPersonUuid: string = PERSON): string {
  return signCookie(
    { workspaceUuid, hulyPersonUuid, expiresAt: Date.now() + 60 * 60 * 1000 },
    { primary: SERVER_SECRET }
  )
}

let mongod: MongoMemoryServer
let store: Store

beforeAll(async () => {
  mongod = await MongoMemoryServer.create()
  store = new Store(mongod.getUri(), 'test-suggestions-db')
  await store.connect()
})

afterAll(async () => {
  await store.disconnect()
  await mongod.stop()
})

beforeEach(async () => {
  await store.userCredentials().deleteMany({})
  await store.bindings().deleteMany({})
  await store.credentials().deleteMany({})
  await store.dismissedSuggestions().deleteMany({})
  nock.cleanAll()
})

function buildApp (): express.Express {
  const app = express()
  app.use(bodyParser.json())
  app.use('/user/api/v1/suggestions', createUserSuggestionsRouter({ config: makeConfig(), store, logger: makeLogger() }))
  return app
}

// ---------------------------------------------------------------------------
// Helper: insert a binding + credential doc that resolves to GITLAB_BASE
// ---------------------------------------------------------------------------

async function insertBindingWithCredential (): Promise<{ bindingId: string, credentialId: ObjectId }> {
  const credentialId = new ObjectId()
  await store.credentials().insertOne({
    _id: credentialId,
    ciphertext: '',
    iv: '',
    tag: '',
    gitlabBaseUrl: GITLAB_BASE,
    workspaceUuid: WS,
    webhookSecretRef: '',
    createdAt: new Date()
  } as any)

  const bindingResult = await store.bindings().insertOne({
    _id: new ObjectId(),
    workspaceUuid: WS,
    hulyProjectRef: 'huly-project-ref',
    gitlabProjectId: 42,
    gitlabProjectPath: 'group/project',
    credentialRef: credentialId.toHexString(),
    webhookSecretRef: 'secret-ref',
    webhookRegistered: false,
    createdAt: new Date(),
    disabled: false
  })

  return { bindingId: bindingResult.insertedId.toHexString(), credentialId }
}

async function insertUserCredential (): Promise<void> {
  await putUserCredential(store.userCredentials(), ENCRYPTION_KEY_BYTES, {
    workspaceUuid: WS,
    hulyPersonUuid: PERSON,
    gitlabBaseUrl: GITLAB_BASE,
    username: 'test-user',
    accessToken: 'gl-user-token',
    expiresAt: new Date(Date.now() + 60 * 60 * 1000)
  })
}

// ---------------------------------------------------------------------------
// Apply endpoint
// ---------------------------------------------------------------------------

describe('POST /:bindingId/:mrIid/:suggestionId/apply', () => {
  test('1. valid user bearer → 200, returns {applied: true, commitSha}', async () => {
    const { bindingId } = await insertBindingWithCredential()
    await insertUserCredential()

    nock(GITLAB_BASE)
      .put('/api/v4/suggestions/99/apply')
      .matchHeader('PRIVATE-TOKEN', 'gl-user-token')
      .reply(200, { id: 99, commit_id: 'abc1234567890abc' })

    const app = buildApp()
    const cookie = makeCookie()
    const res = await request(app)
      .post(`/user/api/v1/suggestions/${bindingId}/mr-42/99/apply`)
      .set('Cookie', `huly-user=${cookie}`)

    expect(res.status).toBe(200)
    expect(res.body.applied).toBe(true)
    expect(res.body.commitSha).toBe('abc1234567890abc')
  })

  test('2. without bearer cookie → 401', async () => {
    const { bindingId } = await insertBindingWithCredential()

    const app = buildApp()
    const res = await request(app)
      .post(`/user/api/v1/suggestions/${bindingId}/mr-42/99/apply`)

    expect(res.status).toBe(401)
  })

  test('3. GitLab returns 409 → endpoint returns 400 conflict', async () => {
    const { bindingId } = await insertBindingWithCredential()
    await insertUserCredential()

    nock(GITLAB_BASE)
      .put('/api/v4/suggestions/99/apply')
      .reply(409, 'Suggestion is outdated')

    const app = buildApp()
    const cookie = makeCookie()
    const res = await request(app)
      .post(`/user/api/v1/suggestions/${bindingId}/mr-42/99/apply`)
      .set('Cookie', `huly-user=${cookie}`)

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('conflict')
  })

  test('4. user has no GitLab credential → 401 not_linked', async () => {
    const { bindingId } = await insertBindingWithCredential()
    // No user credential inserted

    const app = buildApp()
    const cookie = makeCookie()
    const res = await request(app)
      .post(`/user/api/v1/suggestions/${bindingId}/mr-42/99/apply`)
      .set('Cookie', `huly-user=${cookie}`)

    expect(res.status).toBe(401)
    expect(res.body.error).toBe('not_linked')
  })

  test('5. invalid bindingId (non-ObjectId) → 400', async () => {
    const app = buildApp()
    const cookie = makeCookie()
    const res = await request(app)
      .post('/user/api/v1/suggestions/not-a-valid-id/mr-42/99/apply')
      .set('Cookie', `huly-user=${cookie}`)

    expect(res.status).toBe(400)
  })

  test('6. rate-limit kicks in after capacity', async () => {
    const { bindingId } = await insertBindingWithCredential()
    await insertUserCredential()

    const app = buildApp()
    const cookie = makeCookie()

    // The apply rate limiter has capacity 10 with a slow refill.
    // Send requests from the same IP until one hits 429.
    let gotRateLimit = false
    for (let i = 0; i < 12; i++) {
      nock(GITLAB_BASE)
        .put(`/api/v4/suggestions/${i + 1}/apply`)
        .reply(200, { id: i + 1, commit_id: `sha${i}` })

      const res = await request(app)
        .post(`/user/api/v1/suggestions/${bindingId}/mr-42/${i + 1}/apply`)
        .set('Cookie', `huly-user=${cookie}`)
        .set('x-forwarded-for', '198.51.100.50')

      if (res.status === 429) {
        gotRateLimit = true
        expect(res.body.error).toBe('rate limit exceeded')
        break
      }
    }
    expect(gotRateLimit).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Dismiss endpoint
// ---------------------------------------------------------------------------

describe('POST /:bindingId/:mrIid/:noteId/dismiss', () => {
  test('7. valid cookie → 200, marks suggestion dismissed', async () => {
    const app = buildApp()
    const cookie = makeCookie()
    const res = await request(app)
      .post('/user/api/v1/suggestions/binding-abc/mr-1/note-42/dismiss')
      .set('Cookie', `huly-user=${cookie}`)

    expect(res.status).toBe(200)
    expect(res.body.dismissed).toBe(true)

    const doc = await store.dismissedSuggestions().findOne({
      workspaceUuid: WS,
      hulyPersonUuid: PERSON,
      bindingId: 'binding-abc',
      mrIid: 'mr-1',
      noteId: 'note-42'
    })
    expect(doc).not.toBeNull()
    expect(doc?.dismissedAt).toBeInstanceOf(Date)
  })

  test('8. dismiss twice → idempotent (200 both times)', async () => {
    const app = buildApp()
    const cookie = makeCookie()

    const res1 = await request(app)
      .post('/user/api/v1/suggestions/binding-abc/mr-1/note-77/dismiss')
      .set('Cookie', `huly-user=${cookie}`)
    expect(res1.status).toBe(200)

    const res2 = await request(app)
      .post('/user/api/v1/suggestions/binding-abc/mr-1/note-77/dismiss')
      .set('Cookie', `huly-user=${cookie}`)
    expect(res2.status).toBe(200)

    // Only one doc in DB.
    const count = await store.dismissedSuggestions().countDocuments({
      workspaceUuid: WS,
      bindingId: 'binding-abc',
      noteId: 'note-77'
    })
    expect(count).toBe(1)
  })

  test('9. without cookie → 401', async () => {
    const app = buildApp()
    const res = await request(app)
      .post('/user/api/v1/suggestions/binding-abc/mr-1/note-42/dismiss')

    expect(res.status).toBe(401)
  })
})
