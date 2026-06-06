/**
 * B5 tests for the `/user/session` cookie-mint endpoint.
 *
 * Confirms:
 *  - bearer-protected (401 without)
 *  - mints a Set-Cookie that round-trips via verifyCookie
 *  - rejects malformed bodies with 400
 */

import request from 'supertest'
import express from 'express'
import bodyParser from 'body-parser'
import { randomBytes } from 'node:crypto'
import { createUserSessionRouter } from '../../src/http/user-session'
import { verifyCookie } from '../../src/http/cookie-auth'
import type { Logger } from '../../src/logging'
import type { Config } from '../../src/config'

function makeLogger (): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
}

const SERVER_SECRET = 'b5-user-session-secret'
const ENCRYPTION_KEY_B64 = randomBytes(32).toString('base64')
const PUBLIC_BASE_URL = 'http://localhost:3601'

function makeConfig (publicBase: string = PUBLIC_BASE_URL): Config {
  return {
    Port: 3601,
    PublicBaseUrl: publicBase,
    AccountsURL: 'http://accounts.test',
    ServerSecret: SERVER_SECRET,
    ServiceID: 'test',
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
    OAuthRedirectUri: `${publicBase}/oauth/callback`,
    CorsAllowedOrigins: []
  }
}

function buildApp (config: Config = makeConfig()): express.Express {
  const app = express()
  app.use(bodyParser.json())
  app.use('/user', createUserSessionRouter({ config, logger: makeLogger() }))
  return app
}

describe('POST /user/session (B5)', () => {
  test('B5-1: without bearer → 401', async () => {
    const app = buildApp()
    const res = await request(app)
      .post('/user/session')
      .send({ workspaceUuid: 'ws-1', hulyPersonUuid: 'person-1' })
    expect(res.status).toBe(401)
  })

  test('B5-2: with bearer and valid body → 200 + Set-Cookie', async () => {
    const app = buildApp()
    const res = await request(app)
      .post('/user/session')
      .set('Authorization', `Bearer ${SERVER_SECRET}`)
      .send({ workspaceUuid: 'ws-b5', hulyPersonUuid: 'person-b5' })
    expect(res.status).toBe(200)
    const setCookie = res.headers['set-cookie']
    expect(setCookie).toBeDefined()
    const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie
    expect(cookieHeader).toContain('huly-user=')
    expect(cookieHeader).toContain('HttpOnly')
    expect(cookieHeader).toContain('SameSite=Strict')
    expect(cookieHeader).toContain('Path=/user')
    // Default HTTP base → no Secure flag.
    expect(cookieHeader).not.toContain('Secure')
  })

  test('B5-3: minted cookie round-trips via verifyCookie', async () => {
    const app = buildApp()
    const res = await request(app)
      .post('/user/session')
      .set('Authorization', `Bearer ${SERVER_SECRET}`)
      .send({ workspaceUuid: 'ws-rt', hulyPersonUuid: 'person-rt', ttlSeconds: 60 })
    expect(res.status).toBe(200)
    const setCookie = res.headers['set-cookie']
    const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : (setCookie as string)
    const m = cookieHeader.match(/huly-user=([^;]+);/)
    expect(m).not.toBeNull()
    const cookieVal = m![1]
    const identity = verifyCookie(cookieVal, SERVER_SECRET)
    expect(identity).not.toBeNull()
    expect(identity!.workspaceUuid).toBe('ws-rt')
    expect(identity!.hulyPersonUuid).toBe('person-rt')
  })

  test('B5-4: missing workspaceUuid → 400', async () => {
    const app = buildApp()
    const res = await request(app)
      .post('/user/session')
      .set('Authorization', `Bearer ${SERVER_SECRET}`)
      .send({ hulyPersonUuid: 'person-1' })
    expect(res.status).toBe(400)
  })

  test('B5-5: PublicBaseUrl https → Set-Cookie carries Secure flag', async () => {
    const app = buildApp(makeConfig('https://huly.example.com'))
    const res = await request(app)
      .post('/user/session')
      .set('Authorization', `Bearer ${SERVER_SECRET}`)
      .send({ workspaceUuid: 'ws-https', hulyPersonUuid: 'person-https' })
    expect(res.status).toBe(200)
    const setCookie = res.headers['set-cookie']
    const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : (setCookie as string)
    expect(cookieHeader).toContain('Secure')
  })
})
