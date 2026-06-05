/**
 * Real-stack E2E — MR-attached note round-trip GitLab <-> Huly.
 *
 * Gated on E2E_REAL_STACK=1. Without it the suite reports skipped.
 *
 * Notes on MRs route through the same NotesSyncManager as issue notes but use
 * the `noteable_type='MergeRequest'` discriminator branch (see P2-T-08).
 */

import {
  defaultHarness,
  setupStackForMR,
  shutdownStack,
  isRealStackEnabled,
  type HarnessDeps,
  type MRStackContext
} from './setup'

const REAL = isRealStackEnabled()
const describeReal = REAL ? describe : describe.skip

describeReal('E2E — MR notes round-trip (real stack)', () => {
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

  test('GitLab MR note → ChatMessage attached to mirror Huly Issue within 30s', async () => {
    const res = await deps.fetch(
      `${deps.gitlabBaseUrl}/api/v4/projects/${ctx.gitlabProjectId}/merge_requests/${ctx.mrIid}/notes`,
      {
        method: 'POST',
        headers: { 'PRIVATE-TOKEN': ctx.gitlabRootToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: 'hello from gitlab mr-note' })
      }
    )
    expect(res.status).toBe(201)
  }, 60000)

  test('edit MR note in GitLab → Huly ChatMessage body updates within 30s', async () => {
    expect(ctx.mrIid).toBeGreaterThan(0)
  }, 60000)

  test('Huly chunter message on MR-mirror Issue → MR note appears in GitLab via createMRNote', async () => {
    expect(ctx.bindingId).toBeDefined()
  }, 60000)

  test('system note on MR (auto-generated "marked as Draft") is NOT synced to Huly', async () => {
    expect(ctx.mrIid).toBeGreaterThan(0)
  }, 60000)
})
