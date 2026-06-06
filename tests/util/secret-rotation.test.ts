import { signHmac, verifyHmac } from '../../src/util/secret-rotation'
import type { SecretConfig } from '../../src/util/secret-rotation'

const PRIMARY = 'primary-secret-key'
const PREVIOUS = 'previous-secret-key'
const PAYLOAD = 'user:42|nonce:abc123'

describe('signHmac / verifyHmac', () => {
  test('signHmac round-trip with primary verifies as primary', () => {
    const cfg: SecretConfig = { primary: PRIMARY }
    const sig = signHmac(PAYLOAD, cfg)
    expect(verifyHmac(PAYLOAD, sig, cfg)).toBe('primary')
  })

  test('signed with primary, verified with primary-only config → primary', () => {
    const cfg: SecretConfig = { primary: PRIMARY }
    const sig = signHmac(PAYLOAD, cfg)
    expect(verifyHmac(PAYLOAD, sig, { primary: PRIMARY })).toBe('primary')
  })

  test('signed with old key, verified with old key as previous → previous', () => {
    const oldCfg: SecretConfig = { primary: PREVIOUS }
    const sig = signHmac(PAYLOAD, oldCfg)
    const newCfg: SecretConfig = { primary: PRIMARY, previous: PREVIOUS }
    expect(verifyHmac(PAYLOAD, sig, newCfg)).toBe('previous')
  })

  test('garbage signature → null', () => {
    const cfg: SecretConfig = { primary: PRIMARY }
    expect(verifyHmac(PAYLOAD, 'deadbeef', cfg)).toBeNull()
  })

  test('both primary and previous mismatched → null', () => {
    const cfg: SecretConfig = { primary: PRIMARY, previous: PREVIOUS }
    const wrongSig = signHmac(PAYLOAD, { primary: 'totally-different-secret' })
    expect(verifyHmac(PAYLOAD, wrongSig, cfg)).toBeNull()
  })

  test('sig with odd-length hex → null without exception', () => {
    const cfg: SecretConfig = { primary: PRIMARY }
    expect(() => verifyHmac(PAYLOAD, 'abc', cfg)).not.toThrow()
    expect(verifyHmac(PAYLOAD, 'abc', cfg)).toBeNull()
  })

  test('sig with non-hex chars → null', () => {
    const cfg: SecretConfig = { primary: PRIMARY }
    expect(verifyHmac(PAYLOAD, 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz', cfg)).toBeNull()
  })

  test('fuzz: many wrong same-length sigs all return null (timingSafeEqual path)', () => {
    const cfg: SecretConfig = { primary: PRIMARY, previous: PREVIOUS }
    const correctSig = signHmac(PAYLOAD, cfg)
    expect(correctSig).toHaveLength(64)
    let nullCount = 0
    for (let i = 0; i < 200; i++) {
      const fakeSig = Buffer.from(
        Array.from({ length: 32 }, () => Math.floor(Math.random() * 256))
      ).toString('hex')
      if (fakeSig !== correctSig && verifyHmac(PAYLOAD, fakeSig, cfg) === null) {
        nullCount++
      }
    }
    expect(nullCount).toBeGreaterThanOrEqual(195)
  })
})
