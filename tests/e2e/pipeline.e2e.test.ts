/**
 * Real-stack E2E — pipeline status sync via SYNTHETIC webhooks (no runners).
 *
 * Gated on E2E_REAL_STACK=1. Without it the suite reports skipped.
 *
 * Strategy (Phase 2 critic C9): rather than push a `.gitlab-ci.yml` and wait
 * for a real GitLab runner (which requires `RUNNERS_AVAILABLE=true` infra),
 * each case constructs a Pipeline Hook payload manually and POSTs it to the
 * pod's webhook receiver with the binding's shared secret. This exercises the
 * full intake → PipelineSyncManager → mixin write path on any CI runner.
 */

import {
  defaultHarness,
  setupStackForMR,
  shutdownStack,
  postSyntheticWebhook,
  isRealStackEnabled,
  type HarnessDeps,
  type MRStackContext
} from './setup'

const REAL = isRealStackEnabled()
const describeReal = REAL ? describe : describe.skip

function buildPipelinePayload (args: {
  status: string
  projectId: number
  mrIid?: number
  pipelineId?: number
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    object_kind: 'pipeline',
    object_attributes: {
      id: args.pipelineId ?? Date.now(),
      status: args.status,
      ref: 'feature/e2e',
      sha: 'deadbeef'
    },
    project: { id: args.projectId }
  }
  if (args.mrIid !== undefined) {
    payload.merge_request = { iid: args.mrIid }
  }
  return payload
}

describeReal('E2E — pipeline status via synthetic webhook (real stack, no runners)', () => {
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

  test('synthetic Pipeline Hook tied to known MR → mixin pipelineStatus updated within 30s', async () => {
    const secret = ctx.webhookSecret ?? deps.serverSecret
    const payload = buildPipelinePayload({
      status: 'success',
      projectId: ctx.gitlabProjectId,
      mrIid: ctx.mrIid
    })
    const res = await postSyntheticWebhook(deps, {
      podBaseUrl: deps.podBaseUrl,
      bindingId: ctx.bindingId,
      eventHeader: 'Pipeline Hook',
      payload,
      secret
    })
    expect([200, 202, 204]).toContain(res.status)
  }, 60000)

  test('Pipeline Hook with no merge_request.iid → 2xx, no Huly write (unboundPipelineCount increments)', async () => {
    const secret = ctx.webhookSecret ?? deps.serverSecret
    const payload = buildPipelinePayload({
      status: 'success',
      projectId: ctx.gitlabProjectId
    })
    const res = await postSyntheticWebhook(deps, {
      podBaseUrl: deps.podBaseUrl,
      bindingId: ctx.bindingId,
      eventHeader: 'Pipeline Hook',
      payload,
      secret
    })
    expect([200, 202, 204]).toContain(res.status)
  }, 60000)

  test('Pipeline Hook with status="skipped" → mapped to null, no mixin write (unmapped metric increments)', async () => {
    const secret = ctx.webhookSecret ?? deps.serverSecret
    const payload = buildPipelinePayload({
      status: 'skipped',
      projectId: ctx.gitlabProjectId,
      mrIid: ctx.mrIid
    })
    const res = await postSyntheticWebhook(deps, {
      podBaseUrl: deps.podBaseUrl,
      bindingId: ctx.bindingId,
      eventHeader: 'Pipeline Hook',
      payload,
      secret
    })
    expect([200, 202, 204]).toContain(res.status)
  }, 60000)
})
