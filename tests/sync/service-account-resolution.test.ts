/**
 * Tests for Path F + G service-account PersonId resolution.
 *
 * Covers:
 *   - Path F: env provides ID → resolution returns that ID, resolved=true, path='F'
 *   - Path G success: probe returns a modifiedBy that is NOT the sentinel
 *   - Path G timeout: fake client hangs → falls back to Path D, resolved=false
 *   - Path G probe write error → falls back to Path D
 *   - Path D fallback: neither F nor G → sentinel returned, resolved=false
 */

import {
  tryPathF,
  tryPathG,
  resolveServiceAccountPersonId,
  PROBE_TIMEOUT_MS,
  type ProbeClient
} from '../../src/sync/service-account-resolution'
import type { Logger } from '../../src/logging'

function makeLogger (): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
}

const SENTINEL = 'system-account-uuid-sentinel'
const REAL_PERSON_ID = 'a1b2c3d4-0000-0000-0000-000000000001'
const PATH_F_ID = 'f1f1f1f1-1111-1111-1111-111111111111'

// ---------------------------------------------------------------------------
// tryPathF
// ---------------------------------------------------------------------------

describe('tryPathF', () => {
  it('returns the value when provided', () => {
    expect(tryPathF(PATH_F_ID)).toBe(PATH_F_ID)
  })

  it('returns undefined when undefined', () => {
    expect(tryPathF(undefined)).toBeUndefined()
  })

  it('returns undefined when empty string', () => {
    expect(tryPathF('')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// tryPathG
// ---------------------------------------------------------------------------

function makeSuccessProbe (personId: string): ProbeClient {
  return {
    createDoc: async () => 'probe-ref-1',
    findByRef: async () => ({ _id: 'probe-ref-1', modifiedBy: personId }),
    removeDoc: async () => {}
  }
}

function makeNotFoundProbe (): ProbeClient {
  return {
    createDoc: async () => 'probe-ref-2',
    findByRef: async () => undefined,
    removeDoc: async () => {}
  }
}

function makeWriteErrorProbe (): ProbeClient {
  return {
    createDoc: async () => { throw new Error('write failed') },
    findByRef: async () => undefined,
    removeDoc: async () => {}
  }
}

function makeHangingProbe (): ProbeClient {
  return {
    createDoc: async () => new Promise<string>(() => { /* never resolves */ }),
    findByRef: async () => undefined,
    removeDoc: async () => {}
  }
}

describe('tryPathG', () => {
  it('returns modifiedBy from the probe doc on success', async () => {
    const result = await tryPathG(makeSuccessProbe(REAL_PERSON_ID), makeLogger())
    expect(result).toBe(REAL_PERSON_ID)
  })

  it('returns undefined when probe doc is not found after create', async () => {
    const result = await tryPathG(makeNotFoundProbe(), makeLogger())
    expect(result).toBeUndefined()
  })

  it('returns undefined on write error', async () => {
    const result = await tryPathG(makeWriteErrorProbe(), makeLogger())
    expect(result).toBeUndefined()
  })

  it('returns undefined on timeout', async () => {
    jest.useFakeTimers()

    const probePromise = tryPathG(makeHangingProbe(), makeLogger())

    // Advance past the probe timeout
    jest.advanceTimersByTime(PROBE_TIMEOUT_MS + 100)

    const result = await probePromise
    expect(result).toBeUndefined()

    jest.useRealTimers()
  }, 15_000)
})

// ---------------------------------------------------------------------------
// resolveServiceAccountPersonId — full chain
// ---------------------------------------------------------------------------

describe('resolveServiceAccountPersonId', () => {
  it('Path F: operator-provided config wins, resolved=true, path=F', async () => {
    const result = await resolveServiceAccountPersonId(
      PATH_F_ID,
      makeSuccessProbe(REAL_PERSON_ID), // G would succeed but F takes priority
      SENTINEL,
      makeLogger()
    )
    expect(result.personId).toBe(PATH_F_ID)
    expect(result.resolved).toBe(true)
    expect(result.path).toBe('F')
  })

  it('Path G: probe succeeds when F not provided, resolved=true, path=G', async () => {
    const result = await resolveServiceAccountPersonId(
      undefined,
      makeSuccessProbe(REAL_PERSON_ID),
      SENTINEL,
      makeLogger()
    )
    expect(result.personId).toBe(REAL_PERSON_ID)
    expect(result.resolved).toBe(true)
    expect(result.path).toBe('G')
  })

  it('Path G timeout: falls back to Path D, resolved=false, path=D', async () => {
    jest.useFakeTimers()

    const resolutionPromise = resolveServiceAccountPersonId(
      undefined,
      makeHangingProbe(),
      SENTINEL,
      makeLogger()
    )

    jest.advanceTimersByTime(PROBE_TIMEOUT_MS + 100)

    const result = await resolutionPromise
    expect(result.personId).toBe(SENTINEL)
    expect(result.resolved).toBe(false)
    expect(result.path).toBe('D')

    jest.useRealTimers()
  }, 15_000)

  it('Path G write failure: falls back to Path D, resolved=false, path=D', async () => {
    const result = await resolveServiceAccountPersonId(
      undefined,
      makeWriteErrorProbe(),
      SENTINEL,
      makeLogger()
    )
    expect(result.personId).toBe(SENTINEL)
    expect(result.resolved).toBe(false)
    expect(result.path).toBe('D')
  })

  it('Path D fallback: no F, no G probe client → sentinel returned, resolved=false', async () => {
    const result = await resolveServiceAccountPersonId(
      undefined,
      undefined,
      SENTINEL,
      makeLogger()
    )
    expect(result.personId).toBe(SENTINEL)
    expect(result.resolved).toBe(false)
    expect(result.path).toBe('D')
  })

  it('Path G probe returns empty modifiedBy → falls back to Path D', async () => {
    const emptyModifiedByProbe: ProbeClient = {
      createDoc: async () => 'probe-ref-3',
      findByRef: async () => ({ _id: 'probe-ref-3', modifiedBy: '' }),
      removeDoc: async () => {}
    }
    const result = await resolveServiceAccountPersonId(
      undefined,
      emptyModifiedByProbe,
      SENTINEL,
      makeLogger()
    )
    expect(result.personId).toBe(SENTINEL)
    expect(result.resolved).toBe(false)
    expect(result.path).toBe('D')
  })
})
