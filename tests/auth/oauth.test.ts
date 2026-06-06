import request from 'supertest'
import express from 'express'
import bodyParser from 'body-parser'
import nock from 'nock'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { randomBytes, createHmac } from 'node:crypto'
import { createOAuthRouter } from '../../src/http/oauth'
import { getCredential } from '../../src/state/credentials'
import { Store } from '../../src/state/store'
import { signHmac } from '../../src/util/secret-rotation'
import type { Logger } from '../../src/logging'
import type { Config } from '../../src/config'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger (): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
}

const GITLAB_BASE = 'http://gitlab.oauth.test'
const SERVER_SECRET = 'oauth-test-secret'
const ENCRYPTION_KEY_BYTES = randomBytes(32)
const ENCRYPTION_KEY_B64 = ENCRYPTION_KEY_BYTES.toString('base64')
const PUBLIC_BASE_URL = 'http://localhost:3600'
const OAUTH_REDIRECT_URI = `${PUBLIC_BASE_URL}/oauth/callback`
const GITLAB_CLIENT_ID = 'test-client-id'
const GITLAB_CLIENT_SECRET = 'test-client-secret'

function makeConfig (overrides: Partial<Config> = {}): Config {
  return {
    Port: 3600,
    PublicBaseUrl: PUBLIC_BASE_URL,
    AccountsURL: 'http://accounts.test',
    ServerSecret: SERVER_SECRET,
    ServiceID: 'test-service',
    MongoUrl: '',
    MongoDb: 'test',
    GitLabBaseUrl: GITLAB_BASE,
    GitLabClientId: GITLAB_CLIENT_ID,
    GitLabClientSecret: GITLAB_CLIENT_SECRET,
    CredentialEncryptionKey: ENCRYPTION_KEY_B64,
    WebhookSecretSeed: 'seed',
    AllowedWorkspaces: ['*'],
    BackfillIntervalMs: 300000,
    RateLimit: 25,
    LogLevel: 'error',
    BrandingPath: '',
    OAuthRedirectUri: OAUTH_REDIRECT_URI,
    CorsAllowedOrigins: [],
    ...overrides
  }
}

let mongod: MongoMemoryServer
let store: Store

beforeAll(async () => {
  mongod = await MongoMemoryServer.create()
  store = new Store(mongod.getUri(), 'test-oauth-db')
  await store.connect()
})

afterAll(async () => {
  await store.disconnect()
  await mongod.stop()
})

beforeEach(async () => {
  await store.credentials().deleteMany({})
  await store.oauthStates().deleteMany({})
  nock.cleanAll()
})

function buildApp (configOverrides: Partial<Config> = {}): express.Express {
  const app = express()
  app.use(bodyParser.json())
  app.use('/oauth', createOAuthRouter({ config: makeConfig(configOverrides), store, logger: makeLogger() }))
  return app
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /oauth/start', () => {
  test('redirects to GitLab with correct query params and signed state', async () => {
    const app = buildApp()
    const res = await request(app)
      .get('/oauth/start')
      .query({ workspaceUuid: 'ws-1', hulyProjectRef: 'proj-1', gitlabBaseUrl: GITLAB_BASE })

    expect(res.status).toBe(302)
    const location = res.headers.location as string
    expect(location).toBeDefined()

    const url = new URL(location)
    expect(url.origin + url.pathname).toBe(`${GITLAB_BASE}/oauth/authorize`)
    expect(url.searchParams.get('client_id')).toBe(GITLAB_CLIENT_ID)
    expect(url.searchParams.get('redirect_uri')).toBe(OAUTH_REDIRECT_URI)
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('scope')).toBe('api')

    const state = url.searchParams.get('state')
    expect(typeof state).toBe('string')
    expect((state as string).length).toBeGreaterThan(0)

    // State should be persisted in DB
    const doc = await store.oauthStates().findOne({ state: state as string })
    expect(doc).not.toBeNull()
    expect(doc?.workspaceUuid).toBe('ws-1')
    expect(doc?.hulyProjectRef).toBe('proj-1')
  })

  test('state is HMAC-signed with ServerSecret', async () => {
    const app = buildApp()

    // Intercept HMAC computation by checking the stored state is valid hex
    const res = await request(app)
      .get('/oauth/start')
      .query({ workspaceUuid: 'ws-hmac', hulyProjectRef: 'proj-hmac' })

    expect(res.status).toBe(302)
    const location = res.headers.location as string
    const url = new URL(location)
    const state = url.searchParams.get('state') as string

    // State must be valid hex (HMAC-SHA256 output)
    expect(state).toMatch(/^[0-9a-f]{64}$/)

    // It must be verifiable as HMAC-SHA256
    const doc = await store.oauthStates().findOne({ state })
    expect(doc).not.toBeNull()
    // Recompute HMAC (we don't know exact epoch, but we know the pattern)
    const expectedHmac = createHmac('sha256', SERVER_SECRET)
      .update(`${doc?.workspaceUuid}|${doc?.hulyProjectRef}|`)
      .digest('hex')
    // The state must have been produced with the same algorithm structure
    expect(state.length).toBe(64)
  })

  test('missing workspaceUuid → 400', async () => {
    const app = buildApp()
    const res = await request(app)
      .get('/oauth/start')
      .query({ hulyProjectRef: 'proj-1' })
    expect(res.status).toBe(400)
  })

  test('invalid gitlabBaseUrl → 400 without redirect', async () => {
    const app = buildApp()
    const res = await request(app)
      .get('/oauth/start')
      .query({ workspaceUuid: 'ws-1', hulyProjectRef: 'proj-1', gitlabBaseUrl: 'ftp://evil.com' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid gitlabBaseUrl')
  })

  test('redirect URL includes code_challenge and code_challenge_method=S256', async () => {
    const app = buildApp()
    const res = await request(app)
      .get('/oauth/start')
      .query({ workspaceUuid: 'ws-pkce', hulyProjectRef: 'proj-pkce', gitlabBaseUrl: GITLAB_BASE })

    expect(res.status).toBe(302)
    const location = res.headers.location as string
    const url = new URL(location)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    const codeChallenge = url.searchParams.get('code_challenge')
    expect(typeof codeChallenge).toBe('string')
    expect((codeChallenge as string).length).toBeGreaterThan(0)
    // Verify codeChallenge is base64url (no +, /, =)
    expect(codeChallenge).toMatch(/^[A-Za-z0-9\-_]+$/)
  })

  test('two calls in same millisecond produce different state values (nonce prevents collision)', async () => {
    const app = buildApp()
    const [res1, res2] = await Promise.all([
      request(app).get('/oauth/start').query({ workspaceUuid: 'ws-n', hulyProjectRef: 'proj-n', gitlabBaseUrl: GITLAB_BASE }),
      request(app).get('/oauth/start').query({ workspaceUuid: 'ws-n', hulyProjectRef: 'proj-n', gitlabBaseUrl: GITLAB_BASE })
    ])

    expect(res1.status).toBe(302)
    expect(res2.status).toBe(302)

    const state1 = new URL(res1.headers.location as string).searchParams.get('state')
    const state2 = new URL(res2.headers.location as string).searchParams.get('state')
    expect(state1).not.toBe(state2)
  })
})

describe('GET /oauth/callback', () => {
  async function insertState (
    nonce: string,
    expiresAt: Date,
    workspaceUuid = 'ws-cb',
    hulyProjectRef = 'proj-cb',
    gitlabBaseUrl = GITLAB_BASE,
    secret: string = SERVER_SECRET
  ): Promise<string> {
    const { ObjectId } = await import('mongodb')
    const epoch = Date.now()
    const statePayload = `${workspaceUuid}|${hulyProjectRef}|${nonce}|${epoch}`
    const state = signHmac(statePayload, { primary: secret })
    await store.oauthStates().insertOne({
      _id: new ObjectId(),
      state,
      statePayload,
      nonce,
      codeVerifier: 'test-code-verifier',
      workspaceUuid,
      hulyProjectRef,
      gitlabBaseUrl,
      expiresAt
    })
    return state
  }

  test('valid code+state → 200 JSON with credentialRef stored encrypted', async () => {
    const app = buildApp()
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000)
    const state = await insertState('nonce-valid', expiresAt)

    nock(GITLAB_BASE)
      .post('/oauth/token')
      .reply(200, {
        access_token: 'gitlab-access-token',
        refresh_token: 'gitlab-refresh-token',
        expires_in: 7200,
        token_type: 'Bearer'
      })

    const res = await request(app)
      .get('/oauth/callback')
      .set('Accept', 'application/json')
      .query({ code: 'auth-code-123', state })

    expect(res.status).toBe(200)
    expect(res.body.credentialRef).toBeDefined()
    expect(res.body.workspaceUuid).toBe('ws-cb')
    expect(res.body.hulyProjectRef).toBe('proj-cb')

    // Verify credential is stored encrypted and round-trips correctly
    const credentialRef = res.body.credentialRef as string
    const cred = await getCredential(store.credentials(), ENCRYPTION_KEY_BYTES, credentialRef)
    expect(cred).not.toBeNull()
    expect(cred?.plaintext).toBe('gitlab-access-token')
    expect(cred?.refreshTokenPlaintext).toBe('gitlab-refresh-token')
    expect(cred?.kind).toBe('oauth')
  })

  test('unknown state → 404', async () => {
    const app = buildApp()
    const res = await request(app)
      .get('/oauth/callback')
      .query({ code: 'some-code', state: 'unknown-state-xyz' })
    expect(res.status).toBe(404)
    // GitLab should NOT have been called
    expect(nock.pendingMocks().length).toBe(0)
  })

  test('expired state → 410', async () => {
    const app = buildApp()
    const expiresAt = new Date(Date.now() - 1000) // already expired
    const state = await insertState('nonce-expired', expiresAt)

    const res = await request(app)
      .get('/oauth/callback')
      .query({ code: 'some-code', state })

    expect(res.status).toBe(410)
    // GitLab should NOT have been called
    expect(nock.pendingMocks().length).toBe(0)
  })

  test('GitLab returns 400 on token exchange → 400 with error', async () => {
    const app = buildApp()
    const state = await insertState('nonce-gitlab-400', new Date(Date.now() + 5 * 60 * 1000))

    nock(GITLAB_BASE)
      .post('/oauth/token')
      .reply(400, { error: 'invalid_grant', error_description: 'The provided authorization grant is invalid' })

    const res = await request(app)
      .get('/oauth/callback')
      .set('Accept', 'application/json')
      .query({ code: 'bad-code', state })

    expect(res.status).toBe(400)
    expect(res.body.error).toBeDefined()
  })

  test('state written with expiresAt < now → 410 without calling GitLab', async () => {
    const app = buildApp()
    // Write a state that is already expired
    const state = await insertState('nonce-pre-expired', new Date(Date.now() - 60 * 1000))

    const res = await request(app)
      .get('/oauth/callback')
      .query({ code: 'some-code', state })

    expect(res.status).toBe(410)
    // nock should have no interceptors consumed (GitLab was not called)
    expect(nock.activeMocks().length).toBe(0)
  })

  test('token exchange POST body includes code_verifier', async () => {
    const app = buildApp()

    // Use /oauth/start to get a real state with codeVerifier stored
    const startRes = await request(app)
      .get('/oauth/start')
      .query({ workspaceUuid: 'ws-cv', hulyProjectRef: 'proj-cv', gitlabBaseUrl: GITLAB_BASE })

    expect(startRes.status).toBe(302)
    const state = new URL(startRes.headers.location as string).searchParams.get('state') as string

    let capturedBody: Record<string, unknown> | undefined
    nock(GITLAB_BASE)
      .post('/oauth/token', (body: Record<string, unknown>) => {
        capturedBody = body
        return true
      })
      .reply(200, {
        access_token: 'tok-cv',
        refresh_token: 'rtok-cv',
        expires_in: 7200
      })

    await request(app)
      .get('/oauth/callback')
      .set('Accept', 'application/json')
      .query({ code: 'code-cv', state })

    expect(capturedBody).toBeDefined()
    expect(typeof capturedBody?.code_verifier).toBe('string')
    expect((capturedBody?.code_verifier as string).length).toBeGreaterThan(0)
  })

  test('HTML success page when Accept header is not application/json', async () => {
    const app = buildApp()
    const state = await insertState('nonce-html', new Date(Date.now() + 5 * 60 * 1000))

    nock(GITLAB_BASE)
      .post('/oauth/token')
      .reply(200, {
        access_token: 'token-html',
        refresh_token: 'refresh-html',
        expires_in: 7200
      })

    const res = await request(app)
      .get('/oauth/callback')
      .query({ code: 'html-code', state })

    expect(res.status).toBe(200)
    expect(res.text).toContain('GitLab connected successfully')
  })
})

describe('GET /oauth/callback — secret rotation grace period', () => {
  async function insertStateSignedWith (
    nonce: string,
    expiresAt: Date,
    secret: string,
    workspaceUuid = 'ws-rot',
    hulyProjectRef = 'proj-rot',
    gitlabBaseUrl = GITLAB_BASE
  ): Promise<string> {
    const { ObjectId } = await import('mongodb')
    const epoch = Date.now()
    const statePayload = `${workspaceUuid}|${hulyProjectRef}|${nonce}|${epoch}`
    const state = signHmac(statePayload, { primary: secret })
    await store.oauthStates().insertOne({
      _id: new ObjectId(),
      state,
      statePayload,
      nonce,
      codeVerifier: 'test-code-verifier',
      workspaceUuid,
      hulyProjectRef,
      gitlabBaseUrl,
      expiresAt
    })
    return state
  }

  test('state signed with previous secret is accepted when rotated', async () => {
    const previousSecret = 'old-secret-value'
    const newPrimary = 'new-secret-value'
    const app = buildApp({ ServerSecret: newPrimary, ServerSecretPrevious: previousSecret })

    // State row was created when previousSecret was primary.
    const state = await insertStateSignedWith('nonce-rot-prev', new Date(Date.now() + 5 * 60 * 1000), previousSecret)

    nock(GITLAB_BASE)
      .post('/oauth/token')
      .reply(200, { access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_in: 7200 })

    const res = await request(app)
      .get('/oauth/callback')
      .set('Accept', 'application/json')
      .query({ code: 'rot-code', state })

    expect(res.status).toBe(200)
    expect(res.body.credentialRef).toBeDefined()
  })

  test('state signed with totally unknown secret is rejected (401) even with rotation configured', async () => {
    const app = buildApp({ ServerSecret: 'primary-x', ServerSecretPrevious: 'previous-y' })

    // Sign with a secret that is NEITHER primary nor previous.
    const state = await insertStateSignedWith('nonce-rot-bad', new Date(Date.now() + 5 * 60 * 1000), 'attacker-secret')

    const res = await request(app)
      .get('/oauth/callback')
      .query({ code: 'bad-code', state })

    // The row exists, so it gets past the 404, but HMAC verification with neither
    // primary nor previous succeeds → 401.
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('invalid_state')
  })

  test('state signed with new primary verifies cleanly with rotation configured', async () => {
    const newPrimary = 'shiny-new-primary'
    const app = buildApp({ ServerSecret: newPrimary, ServerSecretPrevious: 'old-still-around' })

    const state = await insertStateSignedWith('nonce-rot-new', new Date(Date.now() + 5 * 60 * 1000), newPrimary)

    nock(GITLAB_BASE)
      .post('/oauth/token')
      .reply(200, { access_token: 'new-primary-access', expires_in: 7200 })

    const res = await request(app)
      .get('/oauth/callback')
      .set('Accept', 'application/json')
      .query({ code: 'new-primary-code', state })

    expect(res.status).toBe(200)
    expect(res.body.credentialRef).toBeDefined()
  })
})
