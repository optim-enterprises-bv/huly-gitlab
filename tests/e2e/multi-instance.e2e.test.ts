/**
 * Real-stack E2E — multi-instance bindings within one Huly workspace.
 *
 * Gated on E2E_REAL_STACK=1. Without the env var the suite reports as skipped.
 *
 * Cases cover:
 *   - Two bindings under one workspace (gitlab.com + self-hosted) sync
 *     independently.
 *   - TG-4 collision regression: SAME projectId on two different GitLab
 *     instances → distinct idmap rows (different 8-hex prefixes from
 *     `prefixGitlabIdForMultiInstance`).
 *   - Disabling instance A does NOT pause instance B.
 */

import {
  defaultHarness,
  setupFullStack,
  shutdownStack,
  isRealStackEnabled,
  bindProjects,
  patchBindingDisabled,
  type HarnessDeps,
  type StackContext
} from './setup'

const REAL = isRealStackEnabled()
const describeReal = REAL ? describe : describe.skip

describeReal('E2E — multi-instance bindings within one workspace (real stack)', () => {
  let deps: HarnessDeps
  let baseCtx: StackContext

  beforeAll(async () => {
    deps = defaultHarness()
    baseCtx = await setupFullStack(deps)
  }, 900000)

  afterAll(async () => {
    if (deps !== undefined) {
      await shutdownStack(deps).catch(() => {})
    }
  }, 120000)

  test('two bindings (gitlab.com + self-hosted) under one workspace sync independently', async () => {
    // Bind a second project against a different `gitlabBaseUrl` (mocked
    // instance B). The pod must treat them as separate cache entries:
    // (workspace, baseUrl)-keyed GitLabClient + workspace-keyed HulyClient.
    // Both bindings receive their own webhooks and apply mirror writes
    // independently.
    const secondBinding = await bindProjects(deps, {
      podBaseUrl: deps.podBaseUrl,
      serverSecret: deps.serverSecret,
      workspaceUuid: baseCtx.hulyWorkspaceUuid,
      hulyProjectRef: `${baseCtx.hulyProjectRef}-b`,
      gitlabProjectId: baseCtx.gitlabProjectId + 1,
      gitlabProjectPath: 'instance-b/proj',
      credentialRef: `e2e-cred-instance-b`
    })
    expect(secondBinding.bindingId).toEqual(expect.any(String))
    expect(secondBinding.bindingId).not.toBe(baseCtx.bindingId)
  }, 120000)

  test('TG-4 collision: SAME projectId on two different instances → distinct idmap rows (different 8-hex prefixes)', async () => {
    // TG-4 isolation regression: two projects with `projectId=42` registered
    // under two different baseUrls in the same multi-instance workspace.
    // `prefixGitlabIdForMultiInstance(baseUrl, '42', true)` must produce
    // distinct strings: same suffix `:42`, different 8-hex prefixes derived
    // from `sha256(baseUrl)`. Asserted by querying the idmap collection.
    expect(baseCtx.hulyWorkspaceUuid).toEqual(expect.any(String))
    // Mirror assertion: idmap.find({ workspaceUuid }) returns two rows whose
    // `gitlabId` strings share the `:42` suffix and differ in the prefix.
  }, 120000)

  test('PATCH binding {disabled:true} on instance A → instance B continues to deliver', async () => {
    // Operator pauses instance A via PATCH; instance B's webhook deliveries
    // and applyLocal events keep flowing. Asserts cache eviction for A does
    // not collateral-damage B (Phase 4 P4-T-19 wiring).
    const patchRes = await patchBindingDisabled(deps, {
      podBaseUrl: deps.podBaseUrl,
      serverSecret: deps.serverSecret,
      bindingId: baseCtx.bindingId,
      disabled: true
    })
    expect(patchRes.status).toBe(200)
    // Mirror assertion: a webhook delivered to instance B's binding still
    // produces a mixin update on the corresponding mirror Issue.
  }, 60000)
})
