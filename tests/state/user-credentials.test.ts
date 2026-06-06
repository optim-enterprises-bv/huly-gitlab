import { MongoMemoryServer } from 'mongodb-memory-server'
import { randomBytes } from 'node:crypto'
import type { WorkspaceUuid, PersonUuid } from '@hcengineering/core'
import { Store } from '../../src/state/store'
import {
  putUserCredential,
  getUserCredential,
  deleteUserCredential,
  rotateUserCredential
} from '../../src/state/user-credentials'

const KEY = randomBytes(32)

const WS = 'ws-test-001' as WorkspaceUuid
const PERSON = 'person-test-aaa' as PersonUuid
const BASE_URL = 'https://gitlab.example.com'
const BASE_URL_2 = 'https://gitlab2.example.com'

let mongod: MongoMemoryServer
let store: Store

beforeAll(async () => {
  mongod = await MongoMemoryServer.create()
  store = new Store(mongod.getUri(), 'test-user-credentials-db')
  await store.connect()
})

afterAll(async () => {
  await store.disconnect()
  await mongod.stop()
})

beforeEach(async () => {
  await store.userCredentials().deleteMany({})
})

// 1. putUserCredential round-trip — encrypt → decrypt yields original token
test('putUserCredential round-trip decrypts to original token', async () => {
  const token = 'original-access-token-abc'
  const { credentialRef } = await putUserCredential(store.userCredentials(), KEY, {
    workspaceUuid: WS,
    hulyPersonUuid: PERSON,
    gitlabBaseUrl: BASE_URL,
    username: 'alice',
    accessToken: token
  })
  expect(typeof credentialRef).toBe('string')
  expect(credentialRef.length).toBeGreaterThan(0)

  const result = await getUserCredential(store.userCredentials(), KEY, WS, PERSON, BASE_URL)
  expect(result).not.toBeNull()
  expect(result!.token).toBe(token)
})

// 2. putUserCredential with refresh token — both encrypted
test('putUserCredential stores refresh token encrypted', async () => {
  const token = 'access-with-refresh'
  const refresh = 'refresh-token-xyz'
  await putUserCredential(store.userCredentials(), KEY, {
    workspaceUuid: WS,
    hulyPersonUuid: PERSON,
    gitlabBaseUrl: BASE_URL,
    username: 'bob',
    accessToken: token,
    refreshToken: refresh
  })

  const doc = await store.userCredentials().findOne({ workspaceUuid: WS, hulyPersonUuid: PERSON })
  expect(doc).not.toBeNull()
  // Stored ciphertext must not equal plaintext
  expect(doc!.ciphertext).not.toBe(token)
  expect(doc!.refreshTokenCiphertext).toBeDefined()
  expect(doc!.refreshTokenCiphertext).not.toBe(refresh)
})

// 3. getUserCredential returns username + gitlabBaseUrl + token (decrypted)
test('getUserCredential returns username and gitlabBaseUrl', async () => {
  await putUserCredential(store.userCredentials(), KEY, {
    workspaceUuid: WS,
    hulyPersonUuid: PERSON,
    gitlabBaseUrl: BASE_URL,
    username: 'carol',
    accessToken: 'token-carol'
  })

  const result = await getUserCredential(store.userCredentials(), KEY, WS, PERSON, BASE_URL)
  expect(result).not.toBeNull()
  expect(result!.username).toBe('carol')
  expect(result!.gitlabBaseUrl).toBe(BASE_URL)
  expect(result!.token).toBe('token-carol')
})

// 4. getUserCredential for missing user → returns null
test('getUserCredential returns null for missing user', async () => {
  const result = await getUserCredential(
    store.userCredentials(),
    KEY,
    'ws-nonexistent' as WorkspaceUuid,
    'person-nonexistent' as PersonUuid,
    BASE_URL
  )
  expect(result).toBeNull()
})

// 5. Unique index: same workspace + person + baseUrl → second put updates (upsert)
test('second putUserCredential with same key updates existing row', async () => {
  await putUserCredential(store.userCredentials(), KEY, {
    workspaceUuid: WS,
    hulyPersonUuid: PERSON,
    gitlabBaseUrl: BASE_URL,
    username: 'dave-v1',
    accessToken: 'token-v1'
  })
  await putUserCredential(store.userCredentials(), KEY, {
    workspaceUuid: WS,
    hulyPersonUuid: PERSON,
    gitlabBaseUrl: BASE_URL,
    username: 'dave-v2',
    accessToken: 'token-v2'
  })

  const count = await store.userCredentials().countDocuments({ workspaceUuid: WS, hulyPersonUuid: PERSON })
  expect(count).toBe(1)

  const result = await getUserCredential(store.userCredentials(), KEY, WS, PERSON, BASE_URL)
  expect(result!.token).toBe('token-v2')
  expect(result!.username).toBe('dave-v2')
})

// 6. Multi-instance: same workspace + person + DIFFERENT baseUrls → both rows persist
test('different gitlabBaseUrls persist as separate rows', async () => {
  await putUserCredential(store.userCredentials(), KEY, {
    workspaceUuid: WS,
    hulyPersonUuid: PERSON,
    gitlabBaseUrl: BASE_URL,
    username: 'eve',
    accessToken: 'token-instance-1'
  })
  await putUserCredential(store.userCredentials(), KEY, {
    workspaceUuid: WS,
    hulyPersonUuid: PERSON,
    gitlabBaseUrl: BASE_URL_2,
    username: 'eve',
    accessToken: 'token-instance-2'
  })

  const count = await store.userCredentials().countDocuments({ workspaceUuid: WS, hulyPersonUuid: PERSON })
  expect(count).toBe(2)

  const r1 = await getUserCredential(store.userCredentials(), KEY, WS, PERSON, BASE_URL)
  const r2 = await getUserCredential(store.userCredentials(), KEY, WS, PERSON, BASE_URL_2)
  expect(r1!.token).toBe('token-instance-1')
  expect(r2!.token).toBe('token-instance-2')
})

// 7. deleteUserCredential removes the row; subsequent getUserCredential returns null
test('deleteUserCredential removes row', async () => {
  await putUserCredential(store.userCredentials(), KEY, {
    workspaceUuid: WS,
    hulyPersonUuid: PERSON,
    gitlabBaseUrl: BASE_URL,
    username: 'frank',
    accessToken: 'token-frank'
  })

  const deleted = await deleteUserCredential(store.userCredentials(), WS, PERSON, BASE_URL)
  expect(deleted).toBe(true)

  const result = await getUserCredential(store.userCredentials(), KEY, WS, PERSON, BASE_URL)
  expect(result).toBeNull()
})

// 8. rotateUserCredential updates ciphertext; decrypt yields new token
test('rotateUserCredential updates to new token', async () => {
  const { credentialRef } = await putUserCredential(store.userCredentials(), KEY, {
    workspaceUuid: WS,
    hulyPersonUuid: PERSON,
    gitlabBaseUrl: BASE_URL,
    username: 'grace',
    accessToken: 'old-token'
  })
  expect(typeof credentialRef).toBe('string')

  await rotateUserCredential(store.userCredentials(), KEY, WS, PERSON, BASE_URL, {
    accessToken: 'new-token',
    expiresAt: new Date(Date.now() + 3600 * 1000)
  })

  const result = await getUserCredential(store.userCredentials(), KEY, WS, PERSON, BASE_URL)
  expect(result!.token).toBe('new-token')
  expect(result!.expiresAt).toBeInstanceOf(Date)
})

// 9. Tampered ciphertext → decrypt throws (GCM auth failure)
test('tampered ciphertext throws on decryption', async () => {
  await putUserCredential(store.userCredentials(), KEY, {
    workspaceUuid: WS,
    hulyPersonUuid: PERSON,
    gitlabBaseUrl: BASE_URL,
    username: 'henry',
    accessToken: 'secret-token'
  })

  // Tamper the stored ciphertext
  await store.userCredentials().updateOne(
    { workspaceUuid: WS, hulyPersonUuid: PERSON, gitlabBaseUrl: BASE_URL },
    { $set: { ciphertext: Buffer.from('tampered-garbage-data').toString('base64') } }
  )

  await expect(
    getUserCredential(store.userCredentials(), KEY, WS, PERSON, BASE_URL)
  ).rejects.toThrow()
})
