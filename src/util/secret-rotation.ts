import { createHmac, timingSafeEqual } from 'node:crypto'

export interface SecretConfig {
  primary: string
  previous?: string
}

/** Compute HMAC-SHA256 hex with the primary secret. */
export function signHmac (payload: string, secrets: SecretConfig): string {
  return createHmac('sha256', secrets.primary).update(payload).digest('hex')
}

/**
 * Verify signature against primary OR previous secret (grace-period dual-verify).
 * Returns the matching secret kind ('primary' | 'previous') or null on no match.
 * Uses timingSafeEqual.
 */
export function verifyHmac (payload: string, providedSig: string, secrets: SecretConfig): 'primary' | 'previous' | null {
  if (!isHexLengthValid(providedSig)) return null
  const expectedPrimary = createHmac('sha256', secrets.primary).update(payload).digest('hex')
  const providedBuf = Buffer.from(providedSig, 'hex')
  const primaryBuf = Buffer.from(expectedPrimary, 'hex')
  if (providedBuf.length === primaryBuf.length && timingSafeEqual(providedBuf, primaryBuf)) return 'primary'
  if (secrets.previous !== undefined) {
    const expectedPrevious = createHmac('sha256', secrets.previous).update(payload).digest('hex')
    const previousBuf = Buffer.from(expectedPrevious, 'hex')
    if (providedBuf.length === previousBuf.length && timingSafeEqual(providedBuf, previousBuf)) return 'previous'
  }
  return null
}

function isHexLengthValid (sig: string): boolean {
  return sig.length > 0 && sig.length % 2 === 0 && /^[0-9a-f]+$/i.test(sig)
}
