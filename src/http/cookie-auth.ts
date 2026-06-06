import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Request, Response, NextFunction } from 'express'

export interface HulyUserIdentity {
  workspaceUuid: string
  hulyPersonUuid: string
  expiresAt: number
}

export interface HulyUserAuthRequest extends Request {
  hulyUser?: HulyUserIdentity
}

export function signCookie (identity: HulyUserIdentity, serverSecret: string): string {
  const payload = { w: identity.workspaceUuid, p: identity.hulyPersonUuid, e: identity.expiresAt }
  const payloadJson = JSON.stringify(payload)
  const sig = createHmac('sha256', serverSecret).update(payloadJson).digest('hex')
  const envelope = JSON.stringify({ ...payload, sig })
  return Buffer.from(envelope, 'utf8').toString('base64url')
}

export function verifyCookie (cookie: string, serverSecret: string): HulyUserIdentity | null {
  try {
    const envelope = JSON.parse(Buffer.from(cookie, 'base64url').toString('utf8'))
    if (typeof envelope.w !== 'string' || typeof envelope.p !== 'string' ||
        typeof envelope.e !== 'number' || typeof envelope.sig !== 'string') return null
    const payload = { w: envelope.w, p: envelope.p, e: envelope.e }
    const expected = createHmac('sha256', serverSecret).update(JSON.stringify(payload)).digest('hex')
    const provided = Buffer.from(envelope.sig as string, 'hex')
    const computed = Buffer.from(expected, 'hex')
    if (provided.length !== computed.length || !timingSafeEqual(provided, computed)) return null
    if (envelope.e < Date.now()) return null
    return { workspaceUuid: envelope.w, hulyPersonUuid: envelope.p, expiresAt: envelope.e }
  } catch { return null }
}

export function requireHulyCookie (serverSecret: string, cookieName: string = 'huly-user') {
  return (req: HulyUserAuthRequest, res: Response, next: NextFunction): void => {
    const cookieHeader = req.headers.cookie ?? ''
    const cookies = parseCookieHeader(cookieHeader)
    const raw = cookies[cookieName]
    if (raw === undefined) { res.status(401).json({ error: 'huly-user cookie required' }); return }
    const identity = verifyCookie(raw, serverSecret)
    if (identity === null) { res.status(401).json({ error: 'invalid or expired huly-user cookie' }); return }
    req.hulyUser = identity
    next()
  }
}

function parseCookieHeader (header: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const pair of header.split(';')) {
    const [k, v] = pair.trim().split('=')
    if (k !== undefined && v !== undefined) out[k] = decodeURIComponent(v)
  }
  return out
}
