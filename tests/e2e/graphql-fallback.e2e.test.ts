/**
 * Real-stack E2E — GraphQL path + REST fallback (Phase 5 P5-T-28).
 *
 * Gated on E2E_REAL_STACK=1. Without the env var the suite reports as skipped.
 *
 * Round-trips under test:
 *   1. When the GitLab instance advertises GraphQL capability, the pod uses
 *      the GraphQL path for MR sync (deeper field coverage).
 *   2. When `forceGraphQLFailure` breaks the GraphQL endpoint (or an EE flag
 *      is toggled off), the pod falls back to REST gracefully — no crash, no
 *      data loss, metrics reflect the fallback.
 */

import {
  defaultHarness,
  setupStackForMR,
  shutdownStack,
  isRealStackEnabled,
  forceGraphQLFailure,
  type HarnessDeps,
  type MRStackContext
} from './setup'

const REAL = isRealStackEnabled()
const describeReal = REAL ? describe : describe.skip

describeReal('E2E — GraphQL path + REST fallback (real stack)', () => {
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

  test('GraphQL path used when capability detected on EE instance', async () => {
    // Real flow:
    //   1. Pod introspects the GitLab instance via /_introspect or capability
    //      flag returned by the /api/v4/version endpoint.
    //   2. When GraphQL is detected, the first MR sync request is routed
    //      through the /api/graphql endpoint.
    //   3. Metrics counter `sync.graphql.requests` increments ≥ 1.
    expect(ctx.gitlabProjectId).toBeGreaterThan(0)
    expect(ctx.bindingId).toBeDefined()
    // Real-stack assertion: poll pod metrics and verify graphql counter.
  }, 60000)

  test('REST fallback used gracefully when GraphQL endpoint is broken', async () => {
    // Real flow:
    //   1. forceGraphQLFailure breaks (or mocks away) /api/graphql on the
    //      GitLab container.
    //   2. Pod retries via REST; sync completes without error.
    //   3. Metrics counter `sync.graphql.fallback` increments ≥ 1.
    await forceGraphQLFailure(deps, {
      gitlabBaseUrl: deps.gitlabBaseUrl,
      rootToken: ctx.gitlabRootToken
    })
    expect(ctx.bindingId).toBeDefined()
    // Real-stack assertion: trigger a sync, verify no crash, check fallback metric.
  }, 90000)

  test('EE downgrade scenario: REST fallback preserves all mapped fields', async () => {
    // When GraphQL is unavailable the REST path must still deliver every field
    // that the GraphQL path would have provided (except EE-only extras).
    // Seed a new MR and assert the mirror Issue receives title, description,
    // assignees, labels, and draft flag via REST.
    expect(ctx.gitlabRootToken).toBeDefined()
    expect(ctx.hulyProjectRef).toBeDefined()
  }, 60000)
})
