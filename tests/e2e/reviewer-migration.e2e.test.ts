/**
 * Real-stack E2E — reviewer-label migration endpoint (Phase 3 P3-T-09/10).
 *
 * Gated on E2E_REAL_STACK=1. Without the env var the suite reports as skipped.
 *
 * Asserts the operator-pause convention (Q3 v2): a 409 pre-flight check
 * forces operators to PATCH the binding into `disabled: true` before the
 * `/migrate-reviewer-labels` endpoint will run. After migration the operator
 * re-enables the binding. Re-running the endpoint is a no-op.
 */

import {
  defaultHarness,
  setupStackForMR,
  shutdownStack,
  isRealStackEnabled,
  patchBindingDisabled,
  postMigrateReviewerLabels,
  type HarnessDeps,
  type MRStackContext
} from './setup'

const REAL = isRealStackEnabled()
const describeReal = REAL ? describe : describe.skip

interface MigrationOkBody {
  mrsScanned: number
  labelsStripped: number
  reviewersResolved: number
}

describeReal('E2E — reviewer-label migration endpoint (real stack)', () => {
  let deps: HarnessDeps
  let ctx: MRStackContext

  beforeAll(async () => {
    deps = defaultHarness()
    ctx = await setupStackForMR(deps)
  }, 900000)

  afterAll(async () => {
    if (deps !== undefined) {
      await shutdownStack(deps).catch(() => {})
    }
  }, 120000)

  test('POST /migrate-reviewer-labels with binding NOT disabled returns 409 + documented message', async () => {
    const res = await postMigrateReviewerLabels(deps, {
      podBaseUrl: deps.podBaseUrl,
      serverSecret: deps.serverSecret,
      bindingId: ctx.bindingId
    })
    expect(res.status).toBe(409)
    const body = res.body as { error?: string, message?: string }
    expect(body.error ?? body.message ?? '').toMatch(/pause|disabled|active/i)
  }, 60000)

  test('PATCH binding {disabled:true} then POST /migrate-reviewer-labels strips synthetic labels and resolves reviewers', async () => {
    const patchRes = await patchBindingDisabled(deps, {
      podBaseUrl: deps.podBaseUrl,
      serverSecret: deps.serverSecret,
      bindingId: ctx.bindingId,
      disabled: true
    })
    expect(patchRes.status).toBe(200)
    const res = await postMigrateReviewerLabels(deps, {
      podBaseUrl: deps.podBaseUrl,
      serverSecret: deps.serverSecret,
      bindingId: ctx.bindingId
    })
    expect(res.status).toBe(200)
    const body = res.body as MigrationOkBody
    expect(body.mrsScanned).toEqual(expect.any(Number))
    expect(body.labelsStripped).toEqual(expect.any(Number))
    expect(body.reviewersResolved).toEqual(expect.any(Number))
  }, 60000)

  test('idempotent re-run is a no-op (mrsScanned same, labelsStripped=0)', async () => {
    const first = await postMigrateReviewerLabels(deps, {
      podBaseUrl: deps.podBaseUrl,
      serverSecret: deps.serverSecret,
      bindingId: ctx.bindingId
    })
    const second = await postMigrateReviewerLabels(deps, {
      podBaseUrl: deps.podBaseUrl,
      serverSecret: deps.serverSecret,
      bindingId: ctx.bindingId
    })
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    const firstBody = first.body as MigrationOkBody
    const secondBody = second.body as MigrationOkBody
    expect(secondBody.mrsScanned).toBe(firstBody.mrsScanned)
    expect(secondBody.labelsStripped).toBe(0)
  }, 60000)
})
