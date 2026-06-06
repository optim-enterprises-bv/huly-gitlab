# Deep Interview Spec: Huly GitLab Integration — Phase 5 (Limitations Closure)

**Date:** 2026-06-06
**Status:** Approved through brainstorming with user
**Supersedes:** ADR-001 (Phase 4 was "FINAL"; user invoked Phase 5 to close all documented limitations)
**Prerequisites:** Phase 1+2+3+4 shipped to `main` (656 tests; PRs #6, #7, #8 merged)

## Problem

Phase 4 shipped with 7+ documented limitations + several DEFERRED Phase 4 reviewer findings. The user has elected to close them all in a Phase 5 cycle.

## Scope (Phase 5) — Close ALL documented limitations

### A. Service-account PersonId real resolution (Architect H-1 / Code-review L)
Replace the `systemAccountUuid as unknown as PersonId` sentinel cast in `src/index.ts` with a real platform lookup. Without this, the TxSubscriber MR-2 echo filter may silently no-op against production `Tx.modifiedBy` identities.

- Use `@hcengineering/account-client` `findPersonBySocialKey('system:account')` or analogous API to resolve the actual `PersonId` the platform stamps on system-account-authored txes.
- If resolution fails 3 times with exponential backoff: refuse to start TxSubscriber (fail fast) — do NOT silently degrade.
- Add metric `tx.subscription.service_account.resolved` (boolean as 0/1).
- Add a test that asserts a tx with `modifiedBy === <resolved PersonId>` is filtered AND a tx with a different PersonId is NOT filtered.

### B. Cookie ServerSecret grace-period rotation (Security carry-over)
Eliminate the downtime requirement for rotating `ServerSecret`. Today, rotating `ServerSecret` immediately invalidates every signed huly-user cookie and webhook secret.

- New env vars: `ServerSecret` (primary) AND `ServerSecretPrevious` (optional, used during rotation window).
- Verification accepts EITHER secret; signing always uses the primary.
- After rotation window elapses (operator removes `ServerSecretPrevious`), only primary remains valid.
- Apply to: cookie HMAC verify, OAuth state HMAC verify, webhook secret comparison.
- Add config docs in `docs/phase5-runbook.md` explaining the operator workflow.

### C. `_originated:'gitlab'` marker stamping (defense-in-depth restoration)
Restore the dual-layer MR-2 echo filter that Phase 4 fix removed as "dead code." Now we implement BOTH layers: service-account PersonId filter (layer 1) + transient marker (layer 2).

- Every `applyRemote` write path (issues, mr, mr-approvals, mr-review, notes, pipeline, epics) stamps `_originated: 'gitlab'` on the operation/attribute payload.
- `TxSubscriber` re-introduces the marker check (deleted in Phase 4 fix B3).
- Tests assert: a write made by EpicsSyncManager has the marker; the marker IS visible on the resulting tx; TxSubscriber drops it.

### D. Mixin split: `gitlab-mr` → `gitlab-mr-core` + `gitlab-mr-review`
Schema split + migration. The current 16-field `gitlab-mr` mixin partitions naturally:

- **`gitlab-mr-core`** (8 fields): `sourceBranch`, `targetBranch`, `draft`, `mergedAt`, `mergeStatus`, `webUrl`, `gitlabIid`, `gitlabProjectId`
- **`gitlab-mr-review`** (8 fields): `reviewers`, `approvedBy`, `approvalsRequired`, `approvalStatus`, `diffWebUrl`, `changedFiles`, `approvalRules`, `iteration`, `parentEpicIid` (note: 9 — recount; possibly fold one into core)

Reader/writer split:
- Phase 1+2 fields → core
- Phase 3+4 fields → review
- `pipelineStatus` continues on a third "view" path (PipelineSyncManager-only) — leave as-is

Migration:
- New admin endpoint `POST /api/v1/bindings/:id/migrate-mixin-split` (operator-paused per Phase 3 pattern).
- Scans every mirrored Issue under the binding; reads existing `gitlab-mr` mixin; creates `gitlab-mr-core` + `gitlab-mr-review` mixins; removes old `gitlab-mr` mixin.
- Idempotent.
- Reader compatibility: during migration window, code MUST read from BOTH old + new mixins (prefer new).

### E. GraphQL adapter
Add a GraphQL-preferred path alongside REST. Use cases where round-trips matter: composite `getMergeRequest` (currently 5 REST calls), `listMergeRequests` with embedded approvals/reviewers, epic-with-children fetch.

- `src/adapter/gitlab-graphql-client.ts` — new client using `graphql-request` (already a dep from Phase 1)
- Capability-detect GraphQL availability + schema version
- For each call site that has a multi-REST equivalent, gate on `capabilities.graphqlAvailable && capabilities.graphqlSchemaSupports(query)` to use GraphQL; fall back to REST otherwise
- Initial wave: `composite getMergeRequest` (collapse 5 REST → 1 GraphQL), `listEpics with children`, `listMergeRequestsWithApprovals`
- Test parity: every GraphQL-preferred path has a REST fallback test asserting equivalent shape

### F. Image/file-level discussion annotations
GitLab discussions support `position_type: 'image'` and `'file'` (currently filtered out). Sync them.

- Extend `SyncReviewPosition` with discriminated union: `{positionType: 'text', filePath, oldLine, newLine, baseSha, headSha, startSha} | {positionType: 'image', filePath, x, y, width, height, baseSha, headSha} | {positionType: 'file', filePath, baseSha, headSha}`
- Adapter `listDiscussions` no longer filters non-text positions; instead maps each to canonical shape
- `mr-review.ts` writes the full position to the mixin
- Huly UI surfacing is NOT this pod's responsibility (Huly platform PR); the pod just stores the data and surfaces it via the mixin field

### G. `mr.ts` further split (730 → ≤ 700)
Trivial cleanup. Extract:
- `mr-helpers.ts`: `resolveAssignee`, `resolveReviewerUuids`, `resolveLocalLabels`, `ensureRemoteLabels`, `parseIid`, `areEqual`, `stripDocPrefix`
- Keep `mr.ts` to manager + applyRemote + applyLocal + backfill orchestration

### H. Phase 4 reviewer DEFERRED items (LOW/MEDIUM rollup)
- Security M-1: 404 vs 401 consistency on unknown OAuth state — change user-oauth `/callback` to 404 for unknown state (match admin oauth)
- Security M-4: Cookie hex validation pre-check before timingSafeEqual
- Architect L-1 (Phase 3 carry): explicit `stale-on-unresolve` mixin field clear for review threads
- Code-reviewer L-1: BiDirectionalCache `invalidate(undefined)` doc + reload(key) method
- Code-reviewer L-3: postMessage origin validation in `app.js`
- Code-reviewer L-5: shared `readMRMixinAttributes` helper
- Code-reviewer L-6: cookie parser `=` handling (split on first `=`)

## Explicitly out of scope (true terminal state)
- Any other features requested by future users
- Huly platform UI integration (out of pod scope by design)
- Per-tenant ACL for admin routes (operator bearer remains admin-global)
- Multi-tenant deployment patterns

## Key Decisions (from brainstorming)

| # | Decision | Choice |
|---|---|---|
| 1 | Service-account PersonId | Real platform resolution with 3-retry exponential backoff |
| 2 | Cookie/state secret rotation | Grace-period dual-verify with optional `ServerSecretPrevious` |
| 3 | `_originated:'gitlab'` marker | Restore dual-defense layer with stamping on every write |
| 4 | Mixin split | Two mixins (core + review); pipelineStatus stays on a third |
| 5 | GraphQL | Selective use for round-trip-heavy paths only; REST stays as fallback |
| 6 | Image/file annotations | Sync canonically; UI affordance is Huly platform's concern |
| 7 | mr.ts split | Extract helpers to mr-helpers.ts |
| 8 | Phase 4 DEFERRED rollup | Address all LOW/MEDIUM items deferred from Phase 4 |

## Architecture (deltas from Phase 4)

### New modules
- `src/sync/mr-core-mixin.ts` — `MR_CORE_MIXIN` constant + `MRCoreMixinDoc` interface
- `src/sync/mr-review-mixin-doc.ts` — renamed/split from current `mr-mixin.ts` to host the review-side fields (rename current `mr-review-mixin.ts` → `mr-review-thread-mixin.ts` to avoid name collision)
- `src/sync/mr-helpers.ts` — extracted helpers
- `src/sync/mixin-migration.ts` — split migration logic
- `src/adapter/gitlab-graphql-client.ts` — GraphQL adapter
- `src/util/secret-rotation.ts` — primary+previous secret verify helper

### Existing modules extended
- `src/index.ts` — real service-account PersonId resolution
- `src/sync/tx-subscription.ts` — restore `_originated` marker check
- All `applyRemote` paths — stamp `_originated:'gitlab'` on writes
- All `gitlab-mr` mixin readers/writers — split into core + review
- `src/http/cookie-auth.ts` — use secret-rotation helper
- `src/http/oauth.ts`, `src/http/user-oauth.ts` — use secret-rotation helper
- `src/http/webhook.ts` — webhook secret with rotation (per-binding secrets unaffected; the binding's own secret remains its own credential)
- `src/sync/mr-review.ts` — image/file position handling
- `src/adapter/types.ts` — `SyncReviewPosition` discriminated union
- `src/sync/mr.ts` — split helpers out
- `src/http/binding.ts` — new `POST /api/v1/bindings/:id/migrate-mixin-split` endpoint

## Error Handling
- Service-account resolution failure: refuse to start TxSubscriber after 3 retries; emit critical alert; pod continues to handle webhooks but `applyLocal` paths effectively go dead (with warn log per attempted dispatch)
- Mixin migration failure mid-binding: idempotent re-run from scratch is safe; document
- Secret rotation: invalid current secret should never crash the pod; reject auth gracefully
- GraphQL fallback: if GraphQL call fails for any reason (capability mismatch, transport, parse), fall back to REST automatically with metric

## Testing Strategy
- Unit: real service-account resolution (≥ 5 cases with mocked account-client)
- Unit: secret-rotation helper (≥ 8 cases — primary verify, previous verify, both invalid, primary-only, previous-only)
- Unit: `_originated` marker stamped + filtered round-trip (≥ 4 cases per manager, applied across 7 managers = ~28)
- Unit: mixin split readers — read from old, new, both, neither (≥ 12 cases)
- Unit: mixin split migration helper (≥ 8 cases)
- Unit: GraphQL client + REST fallback (≥ 15 cases)
- Unit: image/file position parse/store (≥ 6 cases)
- Unit: helpers extraction (no new tests if behavior preserved)
- HTTP: `POST /api/v1/bindings/:id/migrate-mixin-split` (≥ 5 cases)
- E2E: gated tests for split migration round-trip + GraphQL parity

## Success Criteria (Phase 5 acceptance)
1. All Phase 1+2+3+4 tests continue to pass (regression)
2. ≥ 100 new tests added (target: 150+)
3. `npm run build`, `npm run lint`, `npm test` exit 0
4. `npm audit --omit=dev --audit-level=high` shows 0 high
5. Service-account PersonId resolved at startup (or pod fails fast)
6. ServerSecret rotation works without downtime (grace-period verification)
7. `_originated:'gitlab'` marker stamped by every applyRemote write; TxSubscriber drops txes carrying it
8. Mixin split migration moves data from `gitlab-mr` → `gitlab-mr-core` + `gitlab-mr-review`
9. Composite `getMergeRequest` uses GraphQL when available (single round-trip on EE)
10. Image/file discussion positions stored on review mixin without UI loss
11. `mr.ts` ≤ 700 LOC

## Phase 5 reviewer carry-over items (handled OR explicitly deferred)
- All Phase 4 DEFERRED LOW/MEDIUM items: handled in §H
- npm audit Phase 1 carry (transitive `@hcengineering/*` uuid CVE chain): retry `npm audit fix` for `fixAvailable: true`; remaining flagged with no upstream fix → documented

## Phasing (TRUE terminal state)
- ✅ Phase 1: Issues + foundation
- ✅ Phase 2: MRs + MR notes + pipeline status
- ✅ Phase 3: review threads + CE approvals + diff metadata + typed reviewers
- ✅ Phase 4: Path B + EE features + multi-instance + per-user OAuth + refactor
- → Phase 5 (this spec): close all known limitations
- No Phase 6 planned (genuinely terminal this time)

## Open Questions (defaults assumed; flag during execution if needed)
1. Account-client API surface for service-account PersonId resolution — verify in P5-T-01b investigation task before P5-T-02 starts
2. Mixin migration: in-place rewrite vs dual-write window — pick in-place + paused binding (matches Phase 3 reviewer-migration UX)
3. GraphQL: per-call capability detection vs single bootstrap probe — pick per-call cached for 1h
4. Image position binary data sourcing: GitLab returns coordinates; image itself is at `/uploads/...` URL (already documented in Phase 1 attachment link-through)
