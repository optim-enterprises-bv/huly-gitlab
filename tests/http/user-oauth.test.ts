import request from 'supertest'
import express from 'express'
import bodyParser from 'body-parser'
import nock from 'nock'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { randomBytes } from 'node:crypto'
import { createUserOAuthRouter } from '../../src/http/user-oauth'
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

const GITLAB_BASE = 'http://gitlab.user-oauth.test'
const SERVER_SECRET = 'user-oauth-test-secret'
const ENCRYPTION_KEY_BYTES = randomBytes(32)
const ENCRYPTION_KEY_B64 = ENCRYPTION_KEY_BYTES.toString('base64')
const PUBLIC_BASE_URL = 'http://localhost:3601'
const OAUTH_REDIRECT_URI = `${PUBLIC_BASE_URL}/user/oauth/callback`
const GITLAB_CLIENT_ID = 'user-test-client-id'
const GITLAB_CLIENT_SECRET = 'user-test-client-secret'

const WS = 'ws-user-oauth-001' as WorkspaceUuid
const PERSON = 'person-user-oauth-aaa' as PersonUuid

function makeConfig (): Config {
  return {
    Port: 3601,
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
    CorsAllowedOrigins: []
  }
}

function makeCookie (workspaceUuid: string = WS, hulyPersonUuid: string = PERSON): string {
  return signCookie(
    { workspaceUuid, hulyPersonUuid, expiresAt: Date.now() + 60 * 60 * 1000 },
    SERVER_SECRET
  )
}

let mongod: MongoMemoryServer
let store: Store

beforeAll(async () => {
  mongod = await MongoMemoryServer.create()
  store = new Store(mongod.getUri(), 'test-user-oauth-db')
  await store.connect()
  process.env.GITLAB_ALLOWED_HOSTS = 'gitlab.user-oauth.test,gitlab.example.com'
})

afterAll(async () => {
  await store.disconnect()
  await mongod.stop()
  delete process.env.GITLAB_ALLOWED_HOSTS
})

beforeEach(async () => {
  await store.oauthStates().deleteMany({})
  await store.userCredentials().deleteMany({})
  nock.cleanAll()
})

function buildApp (): express.Express {
  const app = express()
  app.use(bodyParser.json())
  app.use('/user/oauth', createUserOAuthRouter({ config: makeConfig(), store, logger: makeLogger() }))
  return app
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /user/oauth/start', () => {
  test('1. without cookie → 401', async () => {
    const app = buildApp()
    const res = await request(app)
      .get('/user/oauth/start')
      .query({ gitlabBaseUrl: GITLAB_BASE })

    expect(res.status).toBe(401)
  })

  test('2. with valid cookie → 302 redirect with state + code_challenge', async () => {
    const app = buildApp()
    const cookie = makeCookie()
    const res = await request(app)
      .get('/user/oauth/start')
      .set('Cookie', `huly-user=${cookie}`)
      .query({ gitlabBaseUrl: GITLAB_BASE })

    expect(res.status).toBe(302)
    const location = res.headers.location as string
    expect(location).toBeDefined()

    const url = new URL(location)
    expect(url.origin + url.pathname).toBe(`${GITLAB_BASE}/oauth/authorize`)
    expect(url.searchParams.get('client_id')).toBe(GITLAB_CLIENT_ID)
    expect(url.searchParams.get('redirect_uri')).toBe(OAUTH_REDIRECT_URI)
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('scope')).toBe('api')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')

    const state = url.searchParams.get('state')
    expect(typeof state).toBe('string')
    expect((state as string).length).toBeGreaterThan(0)
    const codeChallenge = url.searchParams.get('code_challenge')
    expect(typeof codeChallenge).toBe('string')
    expect((codeChallenge as string).length).toBeGreaterThan(0)

    // State persisted with cookie-derived identity (SCG-3 source-of-truth).
    const doc: any = await store.oauthStates().findOne({ state: state as string })
    expect(doc).not.toBeNull()
    expect(doc.workspaceUuid).toBe(WS)
    expect(doc.hulyPersonUuid).toBe(PERSON)
    expect(doc.gitlabBaseUrl).toBe(GITLAB_BASE)
    expect(doc.kind).toBe('user')
    expect(typeof doc.codeVerifier).toBe('string')
  })

  test('3. invalid gitlabBaseUrl → 400', async () => {
    const app = buildApp()
    const cookie = makeCookie()
    const res = await request(app)
      .get('/user/oauth/start')
      .set('Cookie', `huly-user=${cookie}`)
      .query({ gitlabBaseUrl: 'http://evil.disallowed.host' })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid gitlabBaseUrl')
  })

  test('4. rate-limited after 10 requests → 429', async () => {
    const app = buildApp()
    const cookie = makeCookie()
    for (let i = 0; i < 10; i++) {
      const res = await request(app)
        .get('/user/oauth/start')
        .set('Cookie', `huly-user=${cookie}`)
        .set('x-forwarded-for', '198.51.100.7')
        .query({ gitlabBaseUrl: GITLAB_BASE })
      expect(res.status).toBe(302)
    }
    const blocked = await request(app)
      .get('/user/oauth/start')
      .set('Cookie', `huly-user=${cookie}`)
      .set('x-forwarded-for', '198.51.100.7')
      .query({ gitlabBaseUrl: GITLAB_BASE })
    expect(blocked.status).toBe(429)
    expect(blocked.body.error).toBe('rate limit exceeded')
  })
})

describe('GET /user/oauth/callback', () => {
  async function primeState (overrides: Partial<{ expiresAt: Date, returnTo: string }> = {}): Promise<{ state: string, codeVerifier: string }> {
    const app = buildApp()
    const cookie = makeCookie()
    const startQuery: Record<string, string> = { gitlabBaseUrl: GITLAB_BASE }
    if (overrides.returnTo !== undefined) {
      startQuery.returnTo = overrides.returnTo
    }
    const res = await request(app)
      .get('/user/oauth/start')
      .set('Cookie', `huly-user=${cookie}`)
      .query(startQuery)
    const location = res.headers.location as string
    const url = new URL(location)
    const state = url.searchParams.get('state') as string
    const doc: any = await store.oauthStates().findOne({ state })
    if (overrides.expiresAt !== undefined) {
      await store.oauthStates().updateOne({ state }, { $set: { expiresAt: overrides.expiresAt } })
    }
    return { state, codeVerifier: doc.codeVerifier }
  }

  test('5. valid state + GitLab returns tokens + user → credential stored, redirects to returnTo', async () => {
    const returnTo = `${PUBLIC_BASE_URL}/user/ui?status=linked`
    const { state } = await primeState({ returnTo })

    nock(GITLAB_BASE)
      .post('/oauth/token')
      .reply(200, { access_token: 'gl-access-xyz', refresh_token: 'gl-refresh-xyz', expires_in: 7200 })
    nock(GITLAB_BASE)
      .get('/api/v4/user')
      .matchHeader('authorization', 'Bearer gl-access-xyz')
      .reply(200, { id: 42, username: 'alice' })

    const app = buildApp()
    const res = await request(app)
      .get('/user/oauth/callback')
      .query({ code: 'auth-code-abc', state })

    expect(res.status).toBe(302)
    expect(res.headers.location).toBe(returnTo)

    const credDoc = await store.userCredentials().findOne({ workspaceUuid: WS, hulyPersonUuid: PERSON, gitlabBaseUrl: GITLAB_BASE })
    expect(credDoc).not.toBeNull()
    expect(credDoc?.username).toBe('alice')

    // State row consumed.
    const stale = await store.oauthStates().findOne({ state })
    expect(stale).toBeNull()
  })

  test('6. expired state → 410', async () => {
    const { state } = await primeState({ expiresAt: new Date(Date.now() - 60 * 1000) })

    const app = buildApp()
    const res = await request(app)
      .get('/user/oauth/callback')
      .query({ code: 'auth-code-abc', state })

    expect(res.status).toBe(410)
    expect(res.body.error).toBe('expired')
  })

  test('7. invalid (unknown) state → 401', async () => {
    const app = buildApp()
    const res = await request(app)
      .get('/user/oauth/callback')
      .query({ code: 'auth-code-abc', state: 'totally-unknown-state' })

    expect(res.status).toBe(401)
    expect(res.body.error).toBe('invalid_state')
  })

  test('8. username captured from GitLab /api/v4/user response', async () => {
    const { state } = await primeState()

    nock(GITLAB_BASE)
      .post('/oauth/token')
      .reply(200, { access_token: 'gl-access-uuu', expires_in: 7200 })
    nock(GITLAB_BASE)
      .get('/api/v4/user')
      .matchHeader('authorization', 'Bearer gl-access-uuu')
      .reply(200, { id: 99, username: 'bob-gitlab' })

    const app = buildApp()
    const res = await request(app)
      .get('/user/oauth/callback')
      .query({ code: 'auth-code-bob', state })

    // No returnTo configured → default success page (HTML default).
    expect([200, 302]).toContain(res.status)

    const credDoc = await store.userCredentials().findOne({ workspaceUuid: WS, hulyPersonUuid: PERSON, gitlabBaseUrl: GITLAB_BASE })
    expect(credDoc?.username).toBe('bob-gitlab')
  })

  test('SCG-3: callback identity comes from state row, not cookie', async () => {
    const { state } = await primeState()

    nock(GITLAB_BASE)
      .post('/oauth/token')
      .reply(200, { access_token: 'gl-access-scg3', expires_in: 7200 })
    nock(GITLAB_BASE)
      .get('/api/v4/user')
      .reply(200, { id: 7, username: 'state-identity-user' })

    const app = buildApp()
    // Pass a TOTALLY DIFFERENT cookie at callback time. Identity MUST still come from the state row.
    const wrongCookie = signCookie(
      { workspaceUuid: 'ws-different', hulyPersonUuid: 'person-different', expiresAt: Date.now() + 60_000 },
      SERVER_SECRET
    )
    const res = await request(app)
      .get('/user/oauth/callback')
      .set('Cookie', `huly-user=${wrongCookie}`)
      .query({ code: 'auth-code-scg3', state })

    // Should NOT 401 — callback ignores cookie entirely.
    expect([200, 302]).toContain(res.status)

    // Credential MUST be persisted under the ORIGINAL identity (from state row), not the cookie identity.
    const origDoc = await store.userCredentials().findOne({ workspaceUuid: WS, hulyPersonUuid: PERSON, gitlabBaseUrl: GITLAB_BASE })
    expect(origDoc?.username).toBe('state-identity-user')

    const wrongDoc = await store.userCredentials().findOne({ workspaceUuid: 'ws-different' })
    expect(wrongDoc).toBeNull()
  })
})

describe('GET /user/oauth/status', () => {
  test('9. with cookie + matching credential → {linked: true, username, expiresAt}', async () => {
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000)
    await putUserCredential(store.userCredentials(), ENCRYPTION_KEY_BYTES, {
      workspaceUuid: WS,
      hulyPersonUuid: PERSON,
      gitlabBaseUrl: GITLAB_BASE,
      username: 'alice',
      accessToken: 'stored-access-token',
      expiresAt
    })

    const app = buildApp()
    const cookie = makeCookie()
    const res = await request(app)
      .get('/user/oauth/status')
      .set('Cookie', `huly-user=${cookie}`)
      .query({ gitlabBaseUrl: GITLAB_BASE })

    expect(res.status).toBe(200)
    expect(res.body.linked).toBe(true)
    expect(res.body.username).toBe('alice')
    expect(res.body.gitlabBaseUrl).toBe(GITLAB_BASE)
    expect(typeof res.body.expiresAt).toBe('string')
  })

  test('10. with cookie but no credential → {linked: false}', async () => {
    const app = buildApp()
    const cookie = makeCookie()
    const res = await request(app)
      .get('/user/oauth/status')
      .set('Cookie', `huly-user=${cookie}`)
      .query({ gitlabBaseUrl: GITLAB_BASE })

    expect(res.status).toBe(200)
    expect(res.body.linked).toBe(false)
  })

  test('11. without cookie → 401', async () => {
    const app = buildApp()
    const res = await request(app)
      .get('/user/oauth/status')
      .query({ gitlabBaseUrl: GITLAB_BASE })

    expect(res.status).toBe(401)
  })
})

describe('DELETE /user/oauth/credential', () => {
  test('12. with cookie → 200 {deleted: true}; status afterwards → linked: false', async () => {
    await putUserCredential(store.userCredentials(), ENCRYPTION_KEY_BYTES, {
      workspaceUuid: WS,
      hulyPersonUuid: PERSON,
      gitlabBaseUrl: GITLAB_BASE,
      username: 'alice',
      accessToken: 'stored-access-token',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000)
    })

    const app = buildApp()
    const cookie = makeCookie()
    const delRes = await request(app)
      .delete('/user/oauth/credential')
      .set('Cookie', `huly-user=${cookie}`)
      .send({ gitlabBaseUrl: GITLAB_BASE })

    expect(delRes.status).toBe(200)
    expect(delRes.body.deleted).toBe(true)

    const statusRes = await request(app)
      .get('/user/oauth/status')
      .set('Cookie', `huly-user=${cookie}`)
      .query({ gitlabBaseUrl: GITLAB_BASE })

    expect(statusRes.status).toBe(200)
    expect(statusRes.body.linked).toBe(false)
  })

  test('13. without cookie → 401', async () => {
    const app = buildApp()
    const res = await request(app)
      .delete('/user/oauth/credential')
      .send({ gitlabBaseUrl: GITLAB_BASE })

    expect(res.status).toBe(401)
  })
})
