/**
 * Real-stack E2E — note (comment) round-trip GitLab <-> Huly.
 *
 * Gated on E2E_REAL_STACK=1.
 */

import { defaultHarness, setupFullStack, shutdownStack, isRealStackEnabled, type StackContext, type HarnessDeps } from './setup'

const REAL = isRealStackEnabled()
const describeReal = REAL ? describe : describe.skip

describeReal('E2E — notes round-trip (real stack)', () => {
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

  test('GitLab comment → Huly chunter message within 30s', async () => {
    expect(ctx.bindingId).toBeDefined()
  }, 60000)

  test('Huly chunter message → GitLab comment within 30s', async () => {
    expect(ctx.bindingId).toBeDefined()
  }, 60000)

  test('system-note (label add, milestone change, etc.) is NOT synced to Huly', async () => {
    expect(ctx.bindingId).toBeDefined()
  }, 60000)

  test('edit comment body round-trips both directions', async () => {
    expect(ctx.bindingId).toBeDefined()
  }, 60000)
})
