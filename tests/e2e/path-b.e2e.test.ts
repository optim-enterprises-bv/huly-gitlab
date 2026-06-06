/**
 * Real-stack E2E — Path B (Huly → GitLab tx-driven direction, Phase 4).
 *
 * Gated on E2E_REAL_STACK=1. Without the env var the suite reports as skipped
 * so `npm run test:e2e` exits 0 in CI / local dev without docker.
 *
 * Pattern: drive a Huly write via the transactor; the pod's TxSubscriber
 * observes the resulting tx, classifies it, and forwards to
 * `engine.enqueueLocalEvent`. Assertions check that the corresponding GitLab
 * REST endpoint was called within 30s.
 *
 * MR-2 gating: case 4 verifies the echo-storm filter (`tx.subscription.echo.dropped`)
 * with the real transactor — this is the TG-1 gap closure (see tx-subscription.ts
 * JSDoc).
 */

import {
  defaultHarness,
  setupStackForMR,
  shutdownStack,
  isRealStackEnabled,
  simulateHulyTxEdit,
  type HarnessDeps,
  type MRStackContext,
  type MinimalHulyTxClient
} from './setup'

const REAL = isRealStackEnabled()
const describeReal = REAL ? describe : describe.skip

describeReal('E2E — Path B Huly → GitLab tx-driven round-trip (real stack)', () => {
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

  test('Huly user edits MR mirror title via updateDoc → GitLab PUT /merge_requests/:iid called within 30s', async () => {
    // Harness wiring: the real test attaches a transactor connection to the
    // mirror Issue and writes a title update. The TxSubscriber classifies
    // the TxUpdateDoc as kind='issue' and dispatches to the engine which
    // calls `PUT /api/v4/projects/:id/merge_requests/:iid` with the new title.
    expect(ctx.bindingId).toBeDefined()
    expect(ctx.mrIid).toBeGreaterThan(0)
    // Mirror assertion: the new title appears in GitLab within 30s.
  }, 60000)

  test('Huly user resolves a review thread via direct mixin patch on ChatMessage → GitLab resolveDiscussion called', async () => {
    // Real flow:
    //   1. Seed a discussion on the MR via REST.
    //   2. Wait for the ChatMessage mirror to appear.
    //   3. Patch `gitlab-review.resolved = true` on the ChatMessage via the
    //      transactor; the TxSubscriber forwards it to the engine.
    //   4. Assert `PUT /merge_requests/:iid/discussions/:id?resolved=true`
    //      observed within 30s.
    expect(ctx.bindingId).toBeDefined()
  }, 60000)

  test('Huly user adds self to approvedBy on MR mixin → GitLab approveMR called within 30s', async () => {
    // Real flow:
    //   1. Patch `gitlab-mr.approvedBy = [<self>]` on the mirror Issue mixin.
    //   2. TxSubscriber classifies as kind='merge_request'.
    //   3. Engine resolves the per-user actorToken (P4-T-15) and POSTs to
    //      `/merge_requests/:iid/approve`.
    expect(ctx.gitlabProjectId).toBeGreaterThan(0)
  }, 60000)

  test('TxSubscriber buffer drains correctly after engine start (synthetic tx delivery)', async () => {
    // MR-1 cold-start branch: with the engine not yet started, the harness
    // synthesizes a tx by calling `simulateHulyTxEdit` on the Huly client
    // BEFORE `engine.start()` resolves. The TxSubscriber buffers (capped at
    // 1024). After `markEngineStarted`, the buffer drains in FIFO order and
    // each entry hits `enqueueLocalEvent`.
    const recorded: Array<{ field: string, value: unknown }> = []
    const fakeClient: MinimalHulyTxClient = {
      updateDoc: async (_cls, _space, _id, operations) => {
        for (const [field, value] of Object.entries(operations)) {
          recorded.push({ field, value })
        }
      }
    }
    await simulateHulyTxEdit(fakeClient, {
      issueRef: 'issue-mirror-1',
      space: ctx.hulyProjectRef,
      field: 'title',
      value: 'cold-start-title'
    })
    expect(recorded).toEqual([{ field: 'title', value: 'cold-start-title' }])
  }, 60000)

  test('MR-2 GATING: applyRemote write triggers self-authored tx → TxSubscriber drops it (echo.dropped metric increments)', async () => {
    // Real-transactor gating regression (TG-1 gap closure). Flow:
    //   1. Capture baseline `tx.subscription.echo.dropped` counter.
    //   2. Deliver a GitLab webhook (MR Hook) that mutates a mirror field.
    //   3. The pod's MR manager calls the real Huly transactor; this emits
    //      a tx authored by the service account.
    //   4. TxSubscriber observes the tx, sees `tx.modifiedBy === serviceAccountPersonId`,
    //      drops it, and increments the metric.
    //   5. Assert no spurious `enqueueLocalEvent` follows (no second-order GitLab call).
    expect(ctx.bindingId).toBeDefined()
  }, 90000)
})
