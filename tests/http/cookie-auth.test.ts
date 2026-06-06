import express from 'express'
import request from 'supertest'
import { signCookie, verifyCookie, requireHulyCookie } from '../../src/http/cookie-auth'
import type { HulyUserIdentity } from '../../src/http/cookie-auth'

const SECRET = 'test-server-secret'

function makeIdentity (overrides: Partial<HulyUserIdentity> = {}): HulyUserIdentity {
  return {
    workspaceUuid: 'ws-uuid-1',
    hulyPersonUuid: 'person-uuid-1',
    expiresAt: Date.now() + 60 * 60 * 1000,
    ...overrides
  }
}

describe('cookie-auth', () => {
  test('1. signCookie + verifyCookie round-trip returns matching identity', () => {
    const identity = makeIdentity()
    const cookie = signCookie(identity, SECRET)
    const result = verifyCookie(cookie, SECRET)
    expect(result).not.toBeNull()
    expect(result?.workspaceUuid).toBe(identity.workspaceUuid)
    expect(result?.hulyPersonUuid).toBe(identity.hulyPersonUuid)
    expect(result?.expiresAt).toBe(identity.expiresAt)
  })

  test('2. Tampered signature returns null', () => {
    const identity = makeIdentity()
    const cookie = signCookie(identity, SECRET)
    const decoded = JSON.parse(Buffer.from(cookie, 'base64url').toString('utf8'))
    decoded.sig = decoded.sig.replace(/a/g, 'b').replace(/0/g, '1')
    const tampered = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url')
    expect(verifyCookie(tampered, SECRET)).toBeNull()
  })

  test('3. Expired cookie (expiresAt < now) returns null', () => {
    const identity = makeIdentity({ expiresAt: Date.now() - 1000 })
    const cookie = signCookie(identity, SECRET)
    expect(verifyCookie(cookie, SECRET)).toBeNull()
  })

  test('4. requireHulyCookie middleware: valid cookie sets req.hulyUser and calls next', async () => {
    const identity = makeIdentity()
    const cookie = signCookie(identity, SECRET)

    const app = express()
    app.use(requireHulyCookie(SECRET))
    app.get('/protected', (req, res) => {
      res.json((req as any).hulyUser)
    })

    const res = await request(app)
      .get('/protected')
      .set('Cookie', `huly-user=${cookie}`)

    expect(res.status).toBe(200)
    expect(res.body.workspaceUuid).toBe(identity.workspaceUuid)
    expect(res.body.hulyPersonUuid).toBe(identity.hulyPersonUuid)
  })

  test('5. requireHulyCookie: missing cookie returns 401', async () => {
    const app = express()
    app.use(requireHulyCookie(SECRET))
    app.get('/protected', (_req, res) => { res.json({ ok: true }) })

    const res = await request(app).get('/protected')
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('huly-user cookie required')
  })

  test('6. requireHulyCookie: invalid/tampered cookie returns 401', async () => {
    const app = express()
    app.use(requireHulyCookie(SECRET))
    app.get('/protected', (_req, res) => { res.json({ ok: true }) })

    const res = await request(app)
      .get('/protected')
      .set('Cookie', 'huly-user=notavalidcookie')

    expect(res.status).toBe(401)
    expect(res.body.error).toBe('invalid or expired huly-user cookie')
  })

  test('7. Wrong secret returns null from verifyCookie', () => {
    const identity = makeIdentity()
    const cookie = signCookie(identity, SECRET)
    expect(verifyCookie(cookie, 'wrong-secret')).toBeNull()
  })
})
