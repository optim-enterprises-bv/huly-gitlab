import express from 'express'
import request from 'supertest'
import { signCookie, verifyCookie, requireHulyCookie } from '../../src/http/cookie-auth'
import type { HulyUserIdentity } from '../../src/http/cookie-auth'
import type { SecretConfig } from '../../src/util/secret-rotation'

const SECRET = 'test-server-secret'
const SECRETS: SecretConfig = { primary: SECRET }

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
    const cookie = signCookie(identity, SECRETS)
    const result = verifyCookie(cookie, SECRETS)
    expect(result).not.toBeNull()
    expect(result?.workspaceUuid).toBe(identity.workspaceUuid)
    expect(result?.hulyPersonUuid).toBe(identity.hulyPersonUuid)
    expect(result?.expiresAt).toBe(identity.expiresAt)
  })

  test('2. Tampered signature returns null', () => {
    const identity = makeIdentity()
    const cookie = signCookie(identity, SECRETS)
    const decoded = JSON.parse(Buffer.from(cookie, 'base64url').toString('utf8'))
    decoded.sig = decoded.sig.replace(/a/g, 'b').replace(/0/g, '1')
    const tampered = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url')
    expect(verifyCookie(tampered, SECRETS)).toBeNull()
  })

  test('3. Expired cookie (expiresAt < now) returns null', () => {
    const identity = makeIdentity({ expiresAt: Date.now() - 1000 })
    const cookie = signCookie(identity, SECRETS)
    expect(verifyCookie(cookie, SECRETS)).toBeNull()
  })

  test('4. requireHulyCookie middleware: valid cookie sets req.hulyUser and calls next', async () => {
    const identity = makeIdentity()
    const cookie = signCookie(identity, SECRETS)

    const app = express()
    app.use(requireHulyCookie(SECRETS))
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
    app.use(requireHulyCookie(SECRETS))
    app.get('/protected', (_req, res) => { res.json({ ok: true }) })

    const res = await request(app).get('/protected')
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('huly-user cookie required')
  })

  test('6. requireHulyCookie: invalid/tampered cookie returns 401', async () => {
    const app = express()
    app.use(requireHulyCookie(SECRETS))
    app.get('/protected', (_req, res) => { res.json({ ok: true }) })

    const res = await request(app)
      .get('/protected')
      .set('Cookie', 'huly-user=notavalidcookie')

    expect(res.status).toBe(401)
    expect(res.body.error).toBe('invalid or expired huly-user cookie')
  })

  test('7. Wrong secret returns null from verifyCookie', () => {
    const identity = makeIdentity()
    const cookie = signCookie(identity, SECRETS)
    expect(verifyCookie(cookie, { primary: 'wrong-secret' })).toBeNull()
  })

  // --- New cases for P5-T-05 ---

  test('8. Cookie signed with primary, verified with same primary → identity', () => {
    const identity = makeIdentity()
    const secrets: SecretConfig = { primary: 'primary-secret-abc' }
    const cookie = signCookie(identity, secrets)
    const result = verifyCookie(cookie, secrets)
    expect(result).not.toBeNull()
    expect(result?.workspaceUuid).toBe(identity.workspaceUuid)
    expect(result?.hulyPersonUuid).toBe(identity.hulyPersonUuid)
  })

  test('9. Cookie signed with old primary, verified after rotation (old=previous, new=primary) → identity', () => {
    const identity = makeIdentity()
    const oldSecrets: SecretConfig = { primary: 'old-primary-secret' }
    const cookie = signCookie(identity, oldSecrets)

    // After rotation: old becomes previous, new key is primary
    const newSecrets: SecretConfig = { primary: 'new-primary-secret', previous: 'old-primary-secret' }
    const result = verifyCookie(cookie, newSecrets)
    expect(result).not.toBeNull()
    expect(result?.workspaceUuid).toBe(identity.workspaceUuid)
    expect(result?.hulyPersonUuid).toBe(identity.hulyPersonUuid)
  })

  test('10. Cookie signed with primary, verified with completely different secrets → null', () => {
    const identity = makeIdentity()
    const signingSecrets: SecretConfig = { primary: 'secret-alpha' }
    const cookie = signCookie(identity, signingSecrets)

    const wrongSecrets: SecretConfig = { primary: 'secret-beta', previous: 'secret-gamma' }
    expect(verifyCookie(cookie, wrongSecrets)).toBeNull()
  })

  test('11. Cookie value containing = (base64 padding) → parsed correctly via first-= split', () => {
    // Craft a cookie header where the value contains '=' characters (base64 padding).
    // We directly test parseCookieHeader behavior via requireHulyCookie middleware.
    const identity = makeIdentity()
    const secrets: SecretConfig = { primary: 'padding-secret' }
    // signCookie uses base64url (no padding), but we simulate a value with = by
    // constructing a standard base64 value with padding chars in a test cookie.
    // Use a raw cookie string with = in the value to exercise the indexOf split.
    const cookieValue = signCookie(identity, secrets)
    // Append a fake extra cookie with = in its value to exercise the parser
    const cookieHeader = `other-key=val=ue==; huly-user=${cookieValue}`

    const app = express()
    app.use(requireHulyCookie(secrets))
    app.get('/protected', (req, res) => { res.json((req as any).hulyUser) })

    return request(app)
      .get('/protected')
      .set('Cookie', cookieHeader)
      .then((res) => {
        expect(res.status).toBe(200)
        expect(res.body.workspaceUuid).toBe(identity.workspaceUuid)
      })
  })

  test('12. Cookie key with URL-encoded characters → URL-decoded correctly', () => {
    // Test that a key with %20 (space) is decoded. Use a custom cookieName.
    const identity = makeIdentity()
    const secrets: SecretConfig = { primary: 'url-decode-secret' }
    const cookie = signCookie(identity, secrets)
    // Send cookie with encoded key: huly%2Duser (huly-user with encoded dash)
    // The middleware uses cookieName='huly-user', so the decoded key must match.
    const cookieHeader = `huly%2Duser=${cookie}`

    const app = express()
    app.use(requireHulyCookie(secrets))
    app.get('/protected', (req, res) => { res.json((req as any).hulyUser) })

    return request(app)
      .get('/protected')
      .set('Cookie', cookieHeader)
      .then((res) => {
        // huly%2Duser decodes to 'huly-user', so the cookie should be found
        expect(res.status).toBe(200)
        expect(res.body.workspaceUuid).toBe(identity.workspaceUuid)
      })
  })
})
