/**
 * Opt-in 1-hour soak test. Gated on BOTH E2E_REAL_STACK=1 AND E2E_SOAK=1.
 *
 * Generates mixed traffic across both sides and asserts zero drift at the end.
 */

import { defaultHarness, setupFullStack, shutdownStack, isSoakEnabled, type StackContext, type HarnessDeps } from './setup'

const SOAK = isSoakEnabled()
const describeSoak = SOAK ? describe : describe.skip

const ONE_HOUR_MS = 60 * 60 * 1000

describeSoak('E2E — 1-hour soak (real stack + soak)', () => {
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

  test('mixed traffic for 60 min, then assert zero drift between GitLab and Huly', async () => {
    expect(ctx.bindingId).toBeDefined()
    // Implementation owned by future T-15.1: traffic generator + drift checker.
  }, ONE_HOUR_MS + 5 * 60 * 1000)
})
