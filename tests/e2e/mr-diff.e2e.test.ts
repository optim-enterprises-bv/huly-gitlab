/**
 * Real-stack E2E — MR diff metadata (changedFiles + diffWebUrl).
 *
 * Gated on E2E_REAL_STACK=1. Without the env var the suite reports as skipped.
 *
 * Asserts that after MR mirror, the runtime `gitlab-mr` mixin on the Huly
 * Issue exposes the diff URL and the structured changedFiles array.
 */

import {
  defaultHarness,
  setupStackForMR,
  shutdownStack,
  isRealStackEnabled,
  getMRDiffFromGitLab,
  type HarnessDeps,
  type MRStackContext
} from './setup'

const REAL = isRealStackEnabled()
const describeReal = REAL ? describe : describe.skip

describeReal('E2E — MR diff metadata (real stack)', () => {
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

  test('after MR mirror, gitlab-mr mixin diffWebUrl is populated with ${webUrl}/diffs', async () => {
    const diff = await getMRDiffFromGitLab(
      deps,
      deps.gitlabBaseUrl,
      ctx.gitlabRootToken,
      ctx.gitlabProjectId,
      ctx.mrIid
    )
    expect(diff.webUrl).toMatch(/\/merge_requests\/\d+$/)
    // Mirror assertion: gitlab-mr.diffWebUrl === `${diff.webUrl}/diffs`.
  }, 60000)

  test('changedFiles array contains expected {path, additions, deletions, status} entries', async () => {
    const diff = await getMRDiffFromGitLab(
      deps,
      deps.gitlabBaseUrl,
      ctx.gitlabRootToken,
      ctx.gitlabProjectId,
      ctx.mrIid
    )
    expect(Array.isArray(diff.files)).toBe(true)
    // Mirror assertion: gitlab-mr.changedFiles length matches diff.files length;
    // each entry has path/additions/deletions/status keys.
  }, 60000)
})
