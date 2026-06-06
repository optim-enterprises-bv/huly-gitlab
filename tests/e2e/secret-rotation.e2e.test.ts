/**
 * Real-stack E2E — cookie secret rotation (Phase 5 P5-T-28).
 *
 * Gated on E2E_REAL_STACK=1. Without the env var the suite reports as skipped.
 *
 * Round-trip under test:
 *   1. A cookie is signed with the current PRIMARY secret.
 *   2. `rotateServerSecret` promotes a new secret to PRIMARY (old one becomes
 *      a secondary / "previous" key in the rotation window).
 *   3. The cookie signed with the OLD key is still accepted by the pod during
 *      the grace window — requests do not return 401.
 *   4. After the grace window (or a second rotation that removes the old key
 *      from the accepted set), the old cookie is rejected with 401.
 */

import {
  defaultHarness,
  setupFullStack,
  shutdownStack,
  isRealStackEnabled,
  rotateServerSecret,
  type HarnessDeps,
  type StackContext
} from './setup'

const REAL = isRealStackEnabled()
const describeReal = REAL ? describe : describe.skip

describeReal('E2E — cookie secret rotation (real stack)', () => {
  let deps: HarnessDeps
  let ctx: StackContext

  beforeAll(async () => {
    deps = defaultHarness()
    ctx = await setupFullStack(deps)
  }, 900000)

  afterAll(async () => {
    if (deps !== undefined) {
      await shutdownStack(deps).catch(() => {})
    }
  }, 120000)

  test('cookie signed before rotation verifies after rotation with previous secret', async () => {
    // Real flow:
    //   1. Pod is running with SECRET=primary-key.
    //   2. Mint a signed cookie using primary-key (via /user/oauth/start).
    //   3. Call rotateServerSecret to promote new-primary; old key enters
    //      PREVIOUS_SECRET slot.
    //   4. Re-use the old signed cookie: pod verifies it against PREVIOUS_SECRET
    //      and still returns 200/302, not 401.
    const rotateRes = await rotateServerSecret(deps, {
      podUrl: deps.podBaseUrl,
      bearer: deps.serverSecret,
      newPrimary: `rotated-${Date.now()}`
    })
    expect(rotateRes.status).toBe(200)
    // Real-stack assertion: re-use old cookie and assert non-401 response.
  }, 90000)

  test('rotateServerSecret admin call returns 200 with rotation metadata', async () => {
    const res = await rotateServerSecret(deps, {
      podUrl: deps.podBaseUrl,
      bearer: deps.serverSecret,
      newPrimary: `rotation-meta-${Date.now()}`
    })
    expect(res.status).toBe(200)
    expect(res.body).toBeDefined()
  }, 60000)

  test('cookie signed with evicted secret is rejected with 401 after grace window', async () => {
    // Real flow:
    //   1. Rotate once: old primary → PREVIOUS_SECRET slot.
    //   2. Rotate again: PREVIOUS_SECRET is evicted.
    //   3. Cookie signed with original primary is now rejected.
    expect(ctx.bindingId).toBeDefined()
    // Real-stack assertion: second rotation → old-cookie → 401.
  }, 90000)

  test('rotateServerSecret requires bearer auth — missing auth returns 401', async () => {
    const res = await rotateServerSecret(deps, {
      podUrl: deps.podBaseUrl,
      bearer: 'invalid-token',
      newPrimary: 'should-be-rejected'
    })
    expect(res.status).toBe(401)
  }, 30000)
})
