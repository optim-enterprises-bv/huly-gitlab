import type { Request, Response, NextFunction } from 'express'
import { signHmac, verifyHmac } from '../util/secret-rotation'
import type { SecretConfig } from '../util/secret-rotation'

export type { SecretConfig }

export interface HulyUserIdentity {
  workspaceUuid: string
  hulyPersonUuid: string
  expiresAt: number
}

export interface HulyUserAuthRequest extends Request {
  hulyUser?: HulyUserIdentity
}

export function signCookie (identity: HulyUserIdentity, secrets: SecretConfig): string {
  const payload = { w: identity.workspaceUuid, p: identity.hulyPersonUuid, e: identity.expiresAt }
  const payloadJson = JSON.stringify(payload)
  const sig = signHmac(payloadJson, secrets)
  const envelope = JSON.stringify({ ...payload, sig })
  return Buffer.from(envelope, 'utf8').toString('base64url')
}

export function verifyCookie (cookie: string, secrets: SecretConfig): HulyUserIdentity | null {
  try {
    const envelope = JSON.parse(Buffer.from(cookie, 'base64url').toString('utf8'))
    if (typeof envelope.w !== 'string' || typeof envelope.p !== 'string' ||
        typeof envelope.e !== 'number' || typeof envelope.sig !== 'string') return null
    const payload = { w: envelope.w, p: envelope.p, e: envelope.e }
    const match = verifyHmac(JSON.stringify(payload), envelope.sig as string, secrets)
    if (match === null) return null
    if (envelope.e < Date.now()) return null
    return { workspaceUuid: envelope.w, hulyPersonUuid: envelope.p, expiresAt: envelope.e }
  } catch { return null }
}

export function requireHulyCookie (secrets: SecretConfig, cookieName: string = 'huly-user') {
  return (req: HulyUserAuthRequest, res: Response, next: NextFunction): void => {
    const cookieHeader = req.headers.cookie ?? ''
    const cookies = parseCookieHeader(cookieHeader)
    const raw = cookies[cookieName]
    if (raw === undefined) { res.status(401).json({ error: 'huly-user cookie required' }); return }
    const identity = verifyCookie(raw, secrets)
    if (identity === null) { res.status(401).json({ error: 'invalid or expired huly-user cookie' }); return }
    req.hulyUser = identity
    next()
  }
}

function parseCookieHeader (header: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const pair of header.split(';')) {
    const trimmed = pair.trim()
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const k = decodeURIComponent(trimmed.slice(0, eq))
    const v = decodeURIComponent(trimmed.slice(eq + 1))
    if (k.length > 0) out[k] = v
  }
  return out
}
