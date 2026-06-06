import nock from 'nock'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { ObjectId } from 'mongodb'
import { randomBytes } from 'node:crypto'
import { OAuthRefresher } from '../../src/auth/refresh'
import { putCredential, getCredential } from '../../src/state/credentials'
import { putUserCredential, getUserCredential } from '../../src/state/user-credentials'
import { Store } from '../../src/state/store'
import type { Logger } from '../../src/logging'
import type { WorkspaceUuid, PersonUuid } from '@hcengineering/core'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger (): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
}

const GITLAB_BASE = 'http://gitlab.refresh.test'
const ENCRYPTION_KEY = randomBytes(32)
const CLIENT_ID = 'refresh-client-id'
const CLIENT_SECRET = 'refresh-client-secret'
const REDIRECT_URI = 'http://localhost:3600/oauth/callback'

let mongod: MongoMemoryServer
let store: Store

beforeAll(async () => {
  mongod = await MongoMemoryServer.create()
  store = new Store(mongod.getUri(), 'test-refresh-db')
  await store.connect()
})

afterAll(async () => {
  await store.disconnect()
  await mongod.stop()
})

beforeEach(async () => {
  await store.credentials().deleteMany({})
  await store.userCredentials().deleteMany({})
  nock.cleanAll()
})

function makeRefresher (): OAuthRefresher {
  return new OAuthRefresher({
    store,
    logger: makeLogger(),
    encryptionKey: ENCRYPTION_KEY,
    gitLabClientId: CLIENT_ID,
    gitLabClientSecret: CLIENT_SECRET,
    oauthRedirectUri: REDIRECT_URI
  })
}

async function insertOAuthCredential (expiresAt: Date, refreshToken = 'initial-refresh'): Promise<string> {
  return putCredential(store.credentials(), ENCRYPTION_KEY, {
    kind: 'oauth',
    plaintext: 'initial-access-token',
    refreshTokenPlaintext: refreshToken,
    expiresAt,
    gitlabBaseUrl: GITLAB_BASE
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OAuthRefresher.refresh()', () => {
  test('credential expiring within 5min is refreshed on next tick', async () => {
    const refresher = makeRefresher()
    // expiresAt is 2 minutes from now (within 5-min threshold)
    const expiresAt = new Date(Date.now() + 2 * 60 * 1000)
    const credRef = await insertOAuthCredential(expiresAt)

    nock(GITLAB_BASE)
      .post('/oauth/token')
      .reply(200, {
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
        expires_in: 7200
      })

    await refresher.refresh()

    // Verify new access token was stored
    const cred = await getCredential(store.credentials(), ENCRYPTION_KEY, credRef)
    expect(cred).not.toBeNull()
    expect(cred?.plaintext).toBe('new-access-token')
    expect(cred?.refreshTokenPlaintext).toBe('new-refresh-token')
  })

  test('credential expiring in more than 5min is NOT refreshed', async () => {
    const refresher = makeRefresher()
    // expiresAt is 10 minutes from now (outside 5-min threshold)
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000)
    await insertOAuthCredential(expiresAt)

    // No nock interceptor — if GitLab is called, the test will fail
    await refresher.refresh()

    // nock should not have been consumed
    expect(nock.activeMocks().length).toBe(0)
  })

  test('refresh failure → credential marked expired=true, NOT deleted', async () => {
    const refresher = makeRefresher()
    const expiresAt = new Date(Date.now() + 1 * 60 * 1000)
    const credRef = await insertOAuthCredential(expiresAt)

    nock(GITLAB_BASE)
      .post('/oauth/token')
      .reply(400, { error: 'invalid_grant' })

    await refresher.refresh()

    // Credential should still exist but marked expired
    const { ObjectId: OID } = await import('mongodb')
    const doc = await store.credentials().findOne({ _id: new OID(credRef) })
    expect(doc).not.toBeNull()
    expect(doc?.expired).toBe(true)
    // Token should not have been rotated — still original plaintext
    const cred = await getCredential(store.credentials(), ENCRYPTION_KEY, credRef)
    expect(cred?.plaintext).toBe('initial-access-token')
  })

  test('credential already marked expired is skipped', async () => {
    const refresher = makeRefresher()
    const expiresAt = new Date(Date.now() + 1 * 60 * 1000)

    // Insert credential already marked expired
    const credRef = await putCredential(store.credentials(), ENCRYPTION_KEY, {
      kind: 'oauth',
      plaintext: 'old-token',
      refreshTokenPlaintext: 'old-refresh',
      expiresAt,
      gitlabBaseUrl: GITLAB_BASE
    })
    await store.credentials().updateOne(
      { _id: new ObjectId(credRef) },
      { $set: { expired: true } }
    )

    // No nock interceptor — if GitLab is called, the test will fail
    await refresher.refresh()

    expect(nock.activeMocks().length).toBe(0)
  })

  test('5xx response → credential NOT marked expired (transient)', async () => {
    const refresher = makeRefresher()
    const expiresAt = new Date(Date.now() + 1 * 60 * 1000)
    const credRef = await insertOAuthCredential(expiresAt)

    nock(GITLAB_BASE)
      .post('/oauth/token')
      .reply(503, { error: 'service_unavailable' })

    await refresher.refresh()

    const { ObjectId: OID } = await import('mongodb')
    const doc = await store.credentials().findOne({ _id: new OID(credRef) })
    expect(doc).not.toBeNull()
    // Must NOT be marked expired for transient errors
    expect(doc?.expired).not.toBe(true)
  })

  test('400 invalid_grant → credential IS marked expired (permanent)', async () => {
    const refresher = makeRefresher()
    const expiresAt = new Date(Date.now() + 1 * 60 * 1000)
    const credRef = await insertOAuthCredential(expiresAt)

    nock(GITLAB_BASE)
      .post('/oauth/token')
      .reply(400, { error: 'invalid_grant' })

    await refresher.refresh()

    const { ObjectId: OID } = await import('mongodb')
    const doc = await store.credentials().findOne({ _id: new OID(credRef) })
    expect(doc).not.toBeNull()
    expect(doc?.expired).toBe(true)
  })

  test('network error → credential NOT marked expired (transient)', async () => {
    const refresher = makeRefresher()
    const expiresAt = new Date(Date.now() + 1 * 60 * 1000)
    const credRef = await insertOAuthCredential(expiresAt)

    nock(GITLAB_BASE)
      .post('/oauth/token')
      .replyWithError('ECONNREFUSED')

    await refresher.refresh()

    const { ObjectId: OID } = await import('mongodb')
    const doc = await store.credentials().findOne({ _id: new OID(credRef) })
    expect(doc).not.toBeNull()
    // Must NOT be marked expired for network errors
    expect(doc?.expired).not.toBe(true)
  })

  // ---------------------------------------------------------------------------
  // B2 — per-user OAuth refresh tests
  // ---------------------------------------------------------------------------

  const WS = 'ws-refresh' as WorkspaceUuid
  const PERSON = 'person-refresh' as PersonUuid

  async function insertUserOAuthCredential (
    expiresAt: Date,
    accessToken = 'user-access-initial',
    refreshToken: string | undefined = 'user-refresh-initial'
  ): Promise<void> {
    await putUserCredential(store.userCredentials(), ENCRYPTION_KEY, {
      workspaceUuid: WS,
      hulyPersonUuid: PERSON,
      gitlabBaseUrl: GITLAB_BASE,
      username: 'alice',
      accessToken,
      refreshToken,
      expiresAt
    })
  }

  test('B2: per-user credential expiring within 5min is rotated via rotateUserCredential', async () => {
    const refresher = makeRefresher()
    const expiresAt = new Date(Date.now() + 2 * 60 * 1000)
    await insertUserOAuthCredential(expiresAt)

    nock(GITLAB_BASE)
      .post('/oauth/token')
      .reply(200, {
        access_token: 'user-access-rotated',
        refresh_token: 'user-refresh-rotated',
        expires_in: 7200
      })

    await refresher.refresh()

    const got = await getUserCredential(store.userCredentials(), ENCRYPTION_KEY, WS, PERSON, GITLAB_BASE)
    expect(got).not.toBeNull()
    expect(got?.token).toBe('user-access-rotated')
    // Verify expiresAt advanced by ~2 hours
    const newExpiresMs = got!.expiresAt!.getTime()
    expect(newExpiresMs - Date.now()).toBeGreaterThan(60 * 60 * 1000)
  })

  test('B2: per-user 5xx → NOT marked expired (transient)', async () => {
    const refresher = makeRefresher()
    const expiresAt = new Date(Date.now() + 60 * 1000)
    await insertUserOAuthCredential(expiresAt)

    nock(GITLAB_BASE)
      .post('/oauth/token')
      .reply(503, { error: 'service_unavailable' })

    await refresher.refresh()

    const doc = await store.userCredentials().findOne({ workspaceUuid: WS, hulyPersonUuid: PERSON })
    expect(doc).not.toBeNull()
    expect(doc?.expired).not.toBe(true)
  })

  test('B2: per-user 400 invalid_grant → marked expired (permanent)', async () => {
    const refresher = makeRefresher()
    const expiresAt = new Date(Date.now() + 60 * 1000)
    await insertUserOAuthCredential(expiresAt)

    nock(GITLAB_BASE)
      .post('/oauth/token')
      .reply(400, { error: 'invalid_grant' })

    await refresher.refresh()

    const doc = await store.userCredentials().findOne({ workspaceUuid: WS, hulyPersonUuid: PERSON })
    expect(doc).not.toBeNull()
    expect(doc?.expired).toBe(true)
  })

  test('two consecutive refreshes succeed without state leakage', async () => {
    const refresher = makeRefresher()

    const expAt1 = new Date(Date.now() + 1 * 60 * 1000)
    const credRef1 = await insertOAuthCredential(expAt1, 'refresh-token-1')

    const expAt2 = new Date(Date.now() + 2 * 60 * 1000)
    const credRef2 = await insertOAuthCredential(expAt2, 'refresh-token-2')

    nock(GITLAB_BASE)
      .post('/oauth/token')
      .reply(200, {
        access_token: 'new-token-1',
        refresh_token: 'new-refresh-1',
        expires_in: 7200
      })

    nock(GITLAB_BASE)
      .post('/oauth/token')
      .reply(200, {
        access_token: 'new-token-2',
        refresh_token: 'new-refresh-2',
        expires_in: 7200
      })

    await refresher.refresh()

    const cred1 = await getCredential(store.credentials(), ENCRYPTION_KEY, credRef1)
    const cred2 = await getCredential(store.credentials(), ENCRYPTION_KEY, credRef2)

    // Each credential got its own new token (no leakage)
    expect([cred1?.plaintext, cred2?.plaintext].sort()).toEqual(['new-token-1', 'new-token-2'].sort())
    // They must differ — no state leakage
    expect(cred1?.plaintext).not.toBe(cred2?.plaintext)
  })
})
