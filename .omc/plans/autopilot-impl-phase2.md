# Implementation Plan — huly-gitlab Phase 2

**Status:** Approved (autopilot Phase 2, v2 — critic findings applied)
**Spec:** `.omc/specs/deep-interview-huly-gitlab-phase2.md`
**Target tree:** `/Users/dingo/huly-gitlab/`
**Phase 1 baseline:** 27 test suites / 306 tests passing, all reviewers approved.
**Phase 1 plan (structure reference):** `.omc/plans/autopilot-impl.md`

## Revision history
- v1 (initial): created
- v2 (this revision): applied critic findings — added P2-T-01b for mixin types, widened MergeStatus, restructured B3 confidential MR-note guard, fixed B4 re-register confidentiality flags, corrected state test paths, added C1-C9 corrections, resolved open questions Q1-Q4.

---

## 1. Overview

Phase 2 extends the shipped Phase 1 Issues integration with GitLab Merge Requests, MR-attached notes, and pipeline summary status. All Phase 1 infrastructure (sync engine, conflict resolver, queue, breaker, dedup, inflight recovery, HulyClient, UserIdentity, BindingLoader, OAuth + access token, AES-256-GCM credentials, ObjectId validation, SSRF allowlist, helmet/CORS, asyncHandler, capability detection, PKCE OAuth, transient/permanent refresh classification, markdown round-trip, Docker compose, CI/release) is reused verbatim — no engine changes required. New surface area is a `MergeRequestsSyncManager` mirroring the Phase 1 `IssuesSyncManager` (`src/sync/issues.ts`) one-for-one against a runtime-only mixin `gitlab-mr` carried on `tracker.class.Issue`; a lightweight `PipelineSyncManager` that writes a single `pipelineStatus` field on the same Huly Issue; an extension to `NotesSyncManager` (`src/sync/notes.ts`) that routes notes via `noteable_type` to either the existing issue-resolver or a new MR-resolver; new REST methods on `GitLabClient` (`src/adapter/gitlab-client.ts`) for MR CRUD + MR notes + pipelines; webhook dispatch for `Merge Request Hook` and `Pipeline Hook` events in `src/http/webhook.ts` with confidential-MR defense-in-depth filtering; and webhook auto-registration extended to subscribe to `merge_requests_events` and `pipeline_events`. `applyLocal` for MRs **does not** call `createMergeRequest` in Phase 2 (deferred to Phase 3); the `createMergeRequest` REST method lands but is only callable from tests. `idmap.kind` and `cursors.kind` enums widen to add `merge_request` and `pipeline` — schema migration is documented as enum-only (no data migration). Existing webhook bindings need a one-time re-registration to pick up the new event flags; this is documented as a manual admin operation, NOT autonomous migration.

**v2 addition:** Phase 1 declared `TxOperations` in `src/huly/vendor.d.ts` with only `findOne|findAll|createDoc|updateDoc|close`. The Phase 2 mixin path requires `createMixin`/`updateMixin` (or `apply()` with a `TxMixin` builder). A new task **P2-T-01b** verifies the real API by reading `node_modules/@hcengineering/core/lib/index.d.ts` and widens the vendor declaration accordingly. Without this widening, P2-T-07 fails at compile on day 1.

---

## 2. Dependency Graph / Phase Ordering

```
                P2-T-01 Adapter Types + Errors
                P2-T-01b Vendor.d.ts Mixin Widening
                            │
            ┌───────────────┼───────────────┐
            ▼               ▼               ▼
       P2-T-02         P2-T-03         P2-T-04
       Adapter MR      State enum      MR Status Map
       REST methods    widening        (mirrors
       (gitlab-client) (idmap+cursors) status-map.ts)
            │               │               │
            └───────┬───────┴───────┬───────┘
                    ▼               ▼
            P2-T-05 MR Cache    P2-T-06 Webhook
            (mirrors            Dispatch (MR Hook +
            label-cache)        Pipeline Hook +
                                confidential filter)
                    │               │
                    ├───────┬───────┤
                    ▼       ▼       ▼
              P2-T-07   P2-T-08   P2-T-09
              MR Sync   Pipeline  Notes Manager
              Manager   Sync      MR-route ext.
              (mirrors  Manager   (extends notes.ts)
              issues.ts)
                    │       │       │
                    └───────┼───────┘
                            ▼
                  P2-T-10 Binding Loader
                  + Lifecycle (mrCache wiring,
                  events: merge_requests_events,
                  pipeline_events, re-register
                  preserves confidential_*=false)
                            │
                            ▼
                  P2-T-11 E2E Harness +
                  Compose env flag update
                  (pipeline E2E via synthetic
                  webhook — no runner dependency)
                            │
                            ▼
                  P2-T-12 README + arch deltas
                  + admin re-registration runbook
```

**Parallel waves:**

- **Wave A (immediately):** P2-T-01 AND P2-T-01b run in parallel. Disjoint files (`src/adapter/types.ts` + `src/adapter/errors.ts` vs `src/huly/vendor.d.ts`). Both deliver the frozen-day-1 contract for the rest of the plan.
- **Wave B (after Wave A):** P2-T-02, P2-T-03, P2-T-04 in parallel. Disjoint files (`src/adapter/gitlab-client.ts` add-only methods; `src/state/idmap.ts` + `src/state/cursors.ts` enum widening with tests added into existing `src/state/store.test.ts`; new file `src/sync/mr-status-map.ts`).
- **Wave C (after Wave B):** P2-T-05, P2-T-06 in parallel. P2-T-05 creates new file `src/sync/mr-cache.ts`; P2-T-06 modifies `src/http/webhook.ts` only.
- **Wave D (after Wave C):** P2-T-07, P2-T-08, P2-T-09 in parallel. P2-T-07 creates `src/sync/mr.ts` (new); P2-T-08 creates `src/sync/pipeline.ts` (new); P2-T-09 modifies `src/sync/notes.ts` (extension only). Disjoint files.
- **Wave E (after Wave D):** P2-T-10 wires it all together (`src/sync/binding-loader.ts` + `src/sync/binding-lifecycle.ts` + `src/index.ts` + `src/http/binding.ts`).
- **Wave F:** P2-T-11 E2E, P2-T-12 docs in parallel.

**Parallelism width:** up to 3 in Waves B/C/D; Wave A is 2-wide. (Width-4 parallelism is not exploitable because Wave D's three tasks each have substantial test surface and Wave B saturates the changeable-file budget.)

**Gating contract (Wave A day-1 deliverable):**
- `src/adapter/types.ts` adds `SyncMergeRequest`, `SyncPipeline`, `SyncPipelineStatus`, `MergeStatus` (including `'locked'`), `SyncMRNote` (alias for existing `SyncNote` with `noteableType: 'Issue'|'MergeRequest'` discriminator, default `'Issue'`).
- `src/state/idmap.ts` and `src/state/cursors.ts` kind enums widened (P2-T-03 lands the runtime change in Wave B but P2-T-01 declares the type-level extension day-1).
- `src/huly/vendor.d.ts` declares the real shape of `createMixin`/`updateMixin` (or `apply()` with `TxMixin` if the real platform exposes mixin transactions only via `apply`) on `TxOperations`. Verified against `node_modules/@hcengineering/core/lib/index.d.ts`.

---

## 3. Task List

### P2-T-01 — Adapter Types + Discriminators + Error Classes

- **Owner:** Sonnet
- **Inputs:**
  - `/Users/dingo/huly-gitlab/.omc/specs/deep-interview-huly-gitlab-phase2.md` (§Architecture, §Adapter additions, §State mapping `locked`)
  - `/Users/dingo/huly-gitlab/src/adapter/types.ts` (Phase 1 types — to extend not rewrite)
  - `/Users/dingo/huly-gitlab/src/adapter/errors.ts` (Phase 1 error hierarchy — to extend)
- **Outputs (modify `src/adapter/types.ts`):**
  - `SyncMergeRequest` per spec §Architecture, all fields including `confidential: boolean` (filtered at adapter, asserted in tests) AND `webUrl: string` (matches spec §Architecture line 120).
  - `SyncPipelineStatus = 'pending'|'running'|'success'|'failed'|'canceled'`.
  - `SyncPipeline = { id: number, projectId: number, mergeRequestIid: number | null, ref: string, sha: string, status: SyncPipelineStatus, webUrl: string, createdAt: string, updatedAt: string }`.
  - `MergeStatus = 'can_be_merged' | 'cannot_be_merged' | 'unchecked' | 'locked'` — **`'locked'` REQUIRED** per spec §State mapping (GitLab `locked` MRs write `mergeStatus='locked'` mixin field).
  - `SyncNote.noteableType?: 'Issue' | 'MergeRequest'` — optional discriminator (legacy notes default to `'Issue'`).
  - Widen JSDoc on `SyncNote` to document the new field and the default-`'Issue'` rule for constructor call sites.
- **Outputs (modify `src/adapter/errors.ts`):**
  - `ConfidentialMergeRequestError extends Error` (parallels existing `ConfidentialIssueError`).
- **Acceptance criteria:**
  - `npm run build` exits 0.
  - `npm run lint -- src/adapter/types.ts src/adapter/errors.ts` exits 0.
  - `grep -q "SyncMergeRequest" src/adapter/types.ts && grep -q "SyncPipelineStatus" src/adapter/types.ts && grep -q "ConfidentialMergeRequestError" src/adapter/errors.ts && grep -q "'locked'" src/adapter/types.ts` exits 0.
  - No tests required for this task — pure type additions.
- **Dependencies:** none.
- **Complexity:** S (~160 LOC type defs + JSDoc).

---

### P2-T-01b — TxOperations Mixin API Verification + vendor.d.ts Widening

- **Owner:** Sonnet
- **Inputs:**
  - `/Users/dingo/huly-gitlab/src/huly/vendor.d.ts` (Phase 1 declares `TxOperations` with only `findOne|findAll|createDoc|updateDoc|close`).
  - `/Users/dingo/huly-gitlab/node_modules/@hcengineering/core/lib/index.d.ts` (authoritative real signatures).
  - Spec §Decisions Q5 (runtime mixin — no model registration).
- **Investigation step:**
  - Read the real `@hcengineering/core` `TxOperations` declaration to confirm signatures of `createMixin`, `updateMixin`, and any related transaction APIs.
  - Record the verified signatures (parameter shapes, return types, exception conditions) inline in `vendor.d.ts` as JSDoc.
  - **If `createMixin`/`updateMixin` exist as direct methods on `TxOperations`:** widen the local declaration with those signatures and stop.
  - **If the real API requires `client.apply(tx)` with a `TxMixin` builder (not direct methods):** widen `vendor.d.ts` to declare `apply`, expose the mixin-tx builder type, AND add an explicit note that P2-T-07's `applyRemote` must use the `apply(TxMixin)` shape instead of `createMixin`/`updateMixin`. Update P2-T-07's outputs accordingly (cross-reference noted below in P2-T-07 deps).
- **Outputs (modify `src/huly/vendor.d.ts`):**
  - Widen the `TxOperations` interface with verified mixin signatures.
  - One-line JSDoc per added method documenting param shape and verified source line in `@hcengineering/core/lib/index.d.ts`.
- **Acceptance criteria:**
  - `npx tsc --noEmit` exits 0 across the repo after the widening (with no other code changes).
  - The added declarations match `@hcengineering/core/lib/index.d.ts` byte-for-byte at signature level (param names may differ; types and arity must match).
  - JSDoc on each added method names the upstream source line.
  - No tests required for this task — pure type additions.
- **Dependencies:** none. Runs in parallel with P2-T-01 in Wave A.
- **Complexity:** S (≤ 80 LOC including JSDoc).

---

### P2-T-02 — GitLabClient MR + Pipeline REST methods

- **Owner:** Sonnet
- **Inputs:**
  - `/Users/dingo/huly-gitlab/src/adapter/gitlab-client.ts` (Phase 1 pattern — `listIssues`, `getIssue`, `createIssue`, `updateIssue`, `listNotes` to mirror exactly).
  - P2-T-01 types.
  - Spec §Architecture (REST surface enumeration).
- **Outputs (modify `src/adapter/gitlab-client.ts`):**
  - Private `RawMergeRequest`, `RawPipeline` interfaces; `mapMergeRequest`, `mapPipeline` translators (parallel to existing `mapIssue` / `mapNote`).
  - `listMergeRequests(projectId, opts?: { updatedAfter?: string }): Promise<SyncMergeRequest[]>` — filters `confidential: true` analogous to `listIssues` (Q5 carryover). Sets `confidential=false` query param AND defense-in-depth filter in the response loop. Emits `gitlab.confidential.skipped` log on filtered rows with `kind: 'merge_request'`.
  - `getMergeRequest(projectId, iid): Promise<SyncMergeRequest>` — throws `ConfidentialMergeRequestError` if confidential (parallel to `getIssue`).
  - `createMergeRequest(projectId, body: { source_branch, target_branch, title, description?, labels?, milestone_id?, assignee_ids?, remove_source_branch?, draft? }): Promise<SyncMergeRequest>` — REST POST. Lands but NOT surfaced via `applyLocal` in Phase 2 (callable from tests only).
  - `updateMergeRequest(projectId, iid, body: { title?, description?, labels?, milestone_id?, assignee_ids?, state_event?: 'close'|'reopen', target_branch? }): Promise<SyncMergeRequest>`.
  - `listMRNotes(projectId, mrIid, opts?): Promise<SyncNote[]>` — REST `/api/v4/projects/:id/merge_requests/:mrIid/notes`; returns `SyncNote` with `noteableType: 'MergeRequest'` set on every item. Confidential note filter analogous to `listNotes`.
  - `createMRNote(projectId, mrIid, body: { body: string }): Promise<SyncNote>`.
  - `updateMRNote(projectId, mrIid, noteId, body: { body: string }): Promise<SyncNote>`.
  - `deleteMRNote(projectId, mrIid, noteId): Promise<void>`.
  - `getPipeline(projectId, pipelineId): Promise<SyncPipeline>` — used by P2-T-08 to enrich webhook-arriving pipeline events when payload lacks `merge_request.iid`.
- **Outputs (tests):** `tests/adapter/gitlab-client-mr.test.ts` — nock-backed, ≥ 11 cases:
  1. `listMergeRequests` happy path with pagination + `state=opened`.
  2. `listMergeRequests` filters confidential rows; metric incremented.
  3. `getMergeRequest` happy path returns full `SyncMergeRequest` with `draft`, `mergeStatus`, `pipelineStatus`, `webUrl`.
  4. `getMergeRequest` on confidential throws `ConfidentialMergeRequestError`.
  5. `getMergeRequest` on draft MR returns `draft: true`.
  6. `getMergeRequest` on locked MR returns `state: 'locked'` AND `mergeStatus: 'locked'` (round-trip).
  7. `updateMergeRequest` round-trip on title + description + state_event.
  8. `listMRNotes` returns notes with `noteableType: 'MergeRequest'`.
  9. `createMRNote`, `updateMRNote`, `deleteMRNote` happy paths.
  10. `getPipeline` returns `SyncPipeline` with mapped status.
  11. Rate-limit retry on 429 reuses Phase 1 retry path (no new code, but assert behaviour).
- **Acceptance criteria:**
  - `npm test -- tests/adapter/gitlab-client-mr.test.ts` passes all 11 cases.
  - `npm run lint -- src/adapter/gitlab-client.ts tests/adapter/gitlab-client-mr.test.ts` exits 0.
  - No `any` introduced in `gitlab-client.ts`.
- **Dependencies:** P2-T-01.
- **Complexity:** L (~950 LOC including fixtures).

---

### P2-T-03 — State Enum Widening (idmap + cursors)

- **Owner:** Haiku
- **Inputs:**
  - `/Users/dingo/huly-gitlab/src/state/idmap.ts` (Phase 1 — `kind` enum `'issue'|'note'|'user'|'label'|'milestone'|'project'`).
  - `/Users/dingo/huly-gitlab/src/state/cursors.ts` (Phase 1 — `kind` enum `'issues'|'notes'`).
  - `/Users/dingo/huly-gitlab/src/state/store.test.ts` (Phase 1 — single combined state test file; the existing convention).
- **Outputs (modify):**
  - `src/state/idmap.ts` — widen `IdMapKind` union to include `'merge_request' | 'pipeline'`. Add JSDoc note: "Phase 2 widening. The pipeline kind stores a single pipeline-id → null-Huly-ref placeholder for dedup; pipelines do not get their own Huly Doc."
  - `src/state/cursors.ts` — widen `CursorKind` to include `'merge_requests' | 'pipelines'`. Cursors collection unchanged structurally (index already `{bindingId:1, kind:1}` unique).
  - Update any `kind` switch/exhaustive checks in Phase 1 code if TS flags them (likely none — Phase 1 used string literals).
- **Outputs (tests):** extend `src/state/store.test.ts` (the existing Phase 1 state test file — NOT new `idmap.test.ts` or `cursors.test.ts`, which do not exist):
  - Upsert + lookup with `kind: 'merge_request'`.
  - Upsert + lookup with `kind: 'pipeline'`.
  - Cursor set + get for `'merge_requests'` and `'pipelines'`.
  - **Migration note test:** explicit comment in the new test block documenting that no data migration is needed (enum-only widening; existing rows untouched).
- **Acceptance criteria:**
  - `npm test -- src/state/store.test.ts` passes including the 4 new cases.
  - `npm run build` exits 0 across the whole repo.
  - `npm run lint -- src/state` exits 0.
- **Dependencies:** P2-T-01.
- **Complexity:** S (~80 LOC including new test cases).

---

### P2-T-04 — MR Status Map (mirrors status-map.ts)

- **Owner:** Sonnet
- **Inputs:**
  - `/Users/dingo/huly-gitlab/src/sync/status-map.ts` (Phase 1 pattern — to mirror).
  - Spec §Scope (state mapping rules).
- **Outputs (new file `src/sync/mr-status-map.ts`):**
  - `mapMRRemoteState(projectKey, mrState, draft, projectStatuses): Ref<Status> | undefined`:
    - `'opened' && !draft` → first Active status.
    - `'opened' && draft` → first Active status (the `draft=true` mixin field carries the marker; priority `Low` is set by P2-T-07, not here).
    - `'closed'` → first Cancelled status.
    - `'merged'` → first Done status.
    - `'locked'` → returns `undefined` (caller keeps current status — see spec §State mapping). `mergeStatus='locked'` mixin field is written by P2-T-07.
  - `mapMRHulyStatus(projectKey, statusRef, projectStatuses): 'close' | 'reopen' | undefined`:
    - Status category lookup mirrors Phase 1; merged is one-way (GitLab → Huly only; Huly users cannot "merge" from Huly side).
  - Deterministic; no I/O.
- **Outputs (tests):** `tests/sync/mr-status-map.test.ts` — ≥ 8 cases covering each state, draft, locked-noop, missing-status-fallback, and inverse-mapping symmetry.
- **Acceptance criteria:**
  - `npm test -- tests/sync/mr-status-map.test.ts` passes.
  - `npm run lint -- src/sync/mr-status-map.ts` exits 0.
- **Dependencies:** P2-T-01.
- **Complexity:** S (~200 LOC including tests).

---

### P2-T-05 — MR Cache (mirrors label-cache.ts)

- **Owner:** Haiku
- **Inputs:**
  - `/Users/dingo/huly-gitlab/src/sync/label-cache.ts` (Phase 1 pattern — to mirror).
  - `/Users/dingo/huly-gitlab/src/sync/milestone-cache.ts` (Phase 1 pattern).
- **Outputs (new file `src/sync/mr-cache.ts`):**
  - `MRCache` class:
    - Per-binding cache of (gitlabProjectId, mrIid) → `Ref<Issue>` (the Huly Issue that mirrors the MR).
    - `resolveMRRef(idmap, workspaceUuid, projectId, mrIid): Promise<Ref<Issue> | undefined>` — wraps `findByGitlab(idmap, ws, 'merge_request', "${projectId}:${mrIid}")`.
    - In-memory map with 5-min TTL (matches Phase 1 cache pattern in `BindingLoader`).
    - Used by P2-T-08 (Pipeline) and P2-T-09 (MR-notes) for parent lookups.
- **Outputs (tests):** `tests/sync/mr-cache.test.ts` — ≥ 4 cases: cache miss falls through to idmap, cache hit avoids second call, TTL expiry, eviction on `clear(bindingId)`.
- **Acceptance criteria:**
  - `npm test -- tests/sync/mr-cache.test.ts` passes.
  - `npm run lint -- src/sync/mr-cache.ts` exits 0.
- **Dependencies:** P2-T-03 (idmap `'merge_request'` kind must compile).
- **Complexity:** S (~180 LOC including tests).

---

### P2-T-06 — Webhook Dispatch: MR Hook + Pipeline Hook

- **Owner:** Sonnet
- **Inputs:**
  - `/Users/dingo/huly-gitlab/src/http/webhook.ts` (Phase 1 — extending in place).
  - Spec §Webhook dispatch.
  - P2-T-01 types.
- **Outputs (modify `src/http/webhook.ts`):**
  - Add `MR_HOOK_EVENTS = new Set(['Merge Request Hook', 'Pipeline Hook'])`.
  - On `eventHeader === 'Merge Request Hook'`:
    - If `payload.object_attributes?.confidential === true` → drop with `confidentialSkippedCount++`, 204, log `webhook: confidential MR — dropping`. (GitLab's MR-Hook payload DOES carry `object_attributes.confidential`.)
    - Else extract `version = payload.object_attributes?.updated_at`, dispatch `syncEngine.enqueueWebhookEvent(bindingId, 'merge_request', payload, eventUuid, version)`, 200.
  - On `eventHeader === 'Pipeline Hook'`:
    - Extract `mergeRequestIid = payload.merge_request?.iid` (nullable).
    - If `mergeRequestIid === undefined || mergeRequestIid === null` → drop silently with `unboundPipelineCount++` metric, 204, log `webhook: pipeline without MR — dropping`.
    - Else dispatch `syncEngine.enqueueWebhookEvent(bindingId, 'pipeline', payload, eventUuid, version)`, 200.
  - On `eventHeader === 'Note Hook'`:
    - **Extend the existing branch.** Determine `noteableType = payload.object_attributes?.noteable_type`.
    - If `'Issue'` (existing path, unchanged).
    - If `'MergeRequest'`:
      - **CRITICAL (B3 fix):** GitLab's Note Hook payload for MR notes does NOT include `confidential` on the embedded `merge_request` object — that field only appears on Issue Hook payloads. So no per-event confidential check is possible here.
      - Defense-in-depth model: confidential MRs are NEVER mapped into idmap (because adapter `listMergeRequests` filters them at backfill AND the MR-Hook branch above filters them at webhook receipt). Therefore an MR-note arriving with an unmapped parent MR iid is, by construction, either (a) not yet synced (race) or (b) confidential (defense in depth catches both).
      - Dispatch `enqueueWebhookEvent(bindingId, 'note', payload, ...)` — kind stays `'note'`; the NotesSyncManager extension (P2-T-09) reads `noteable_type`, looks up the parent MR in idmap, and on miss applies the existing deferred-retry-then-drop pattern from Phase 1. Confidential MR notes drop after the retry expires (parent never appears).
      - Two defense layers: (1) MR-Hook filter at adapter + webhook; (2) MR-note parent-resolution drop at NotesSyncManager. No per-event API fetch needed.
  - Add `getUnboundPipelineCount(): number` exported alongside `getConfidentialSkippedCount`.
  - Update the top-of-file `GitLabWebhookPayload` interface to include optional `merge_request`, `noteable_type` shape hints. Document explicitly in JSDoc that MR-note webhooks do NOT carry a usable `confidential` field on the embedded merge_request object.
- **Outputs (tests):** extend `tests/http/webhook.test.ts` — ≥ 8 new cases:
  1. `Merge Request Hook` non-confidential dispatches `kind: 'merge_request'`.
  2. `Merge Request Hook` with `confidential: true` → 204, metric incremented.
  3. `Pipeline Hook` with `merge_request.iid` dispatches `kind: 'pipeline'`.
  4. `Pipeline Hook` without `merge_request` field → 204, `unboundPipelineCount` incremented.
  5. `Note Hook` with `noteable_type: 'MergeRequest'` AND mapped parent dispatches `kind: 'note'` (NotesSyncManager extension handles routing).
  6. `Note Hook` with `noteable_type: 'MergeRequest'` AND unmapped parent dispatches `kind: 'note'`; NotesSyncManager then drops after retry (assertion deferred to P2-T-09). At the webhook layer the dispatch must still happen — the drop is downstream defense-in-depth.
  7. Unknown event type (`'Wiki Page Hook'`) → 200 silent (existing graceful path, regression check).
  8. Signature mismatch on MR Hook → 401 (existing path, regression check).
- **Acceptance criteria:**
  - `npm test -- tests/http/webhook.test.ts` passes all existing + new cases.
  - `npm run lint -- src/http/webhook.ts` exits 0.
  - No Phase 1 webhook tests regress.
- **Dependencies:** P2-T-01.
- **Complexity:** M (~420 LOC including tests).

---

### P2-T-07 — MergeRequestsSyncManager (mirrors IssuesSyncManager)

- **Owner:** Opus
- **Inputs:**
  - `/Users/dingo/huly-gitlab/src/sync/issues.ts` (Phase 1 reference — the EXACT mirror; do not deviate from its shape).
  - P2-T-01 types, P2-T-01b verified mixin API, P2-T-04 status map, P2-T-05 MR cache, P2-T-02 client surface.
  - Spec §Sync manager (MergeRequestsSyncManager section).
- **Outputs (new file `src/sync/mr.ts`):**
  - `MergeRequestsSyncManager implements SyncManager<SyncMergeRequest>`:
    - `kind = 'merge_request'`.
    - `resourceKey(record)`: returns `'mr:${iid}'`. Accept both flat (`record.iid`) and webhook-nested (`record.object_attributes.iid`) shapes, mirroring `IssuesSyncManager.resourceKey`.
    - `applyRemote(ctx, binding, syncMR)`:
      - Resolve via `idmap` kind `'merge_request'`, gitlabId `"${projectId}:${iid}"`.
      - Use the same markdown round-trip (`gfmMarkdownToMarkup`) for `description`.
      - Resolve assignee (first assignee) via `bctx.userIdentity` (R9 stub-guest dedup applies).
      - Resolve labels via the existing `LabelCache` from Phase 1 (no new cache needed for labels — MR labels share the project label namespace).
      - **Reviewers → synthetic labels (C4 fix, spec §Open Questions item):** for each `syncMR.reviewers[]` (when adapter exposes them — extend P2-T-02 `mapMergeRequest` to populate this from GitLab REST `reviewers[]`), emit a `gitlab:reviewer:<username>` synthetic label via the existing `LabelCache`. Document as Phase 2 limitation; Phase 3 replaces with typed reviewer field.
      - Resolve milestone via existing `MilestoneCache` (same namespace argument).
      - Resolve status via `mapMRRemoteState(projectKey, syncMR.state, syncMR.draft, bctx.statuses)`. If `locked`, skip status update but proceed with the rest of the fields AND set `mergeStatus='locked'` mixin field.
      - **Mixin application — runtime only, using the API verified by P2-T-01b:** after the Issue is created or updated, write a mixin with mixin id `'gitlab-mr'` (string literal — NO model registration, NO `huly.d.ts` typed mixin). The actual call shape (`bctx.hulyClient.createMixin(...)` vs `bctx.hulyClient.apply(TxMixin(...))`) is taken from P2-T-01b's verified declaration. Mixin field set:
        - `sourceBranch: string`
        - `targetBranch: string`
        - `draft: boolean`
        - `mergedAt: Date | null`
        - `mergeStatus: MergeStatus` (includes `'locked'`)
        - `webUrl: string` **(C3 fix)** — store the GitLab web URL for downstream UI deep-linking.
      - **`pipelineStatus` is OWNED BY PipelineSyncManager (C2 fix).** `MergeRequestsSyncManager.applyRemote` MUST NOT include `pipelineStatus` in the mixin update — otherwise a stale `getMergeRequest` response can overwrite a just-set value from a concurrent Pipeline Hook event. This is a hard rule; tests assert it.
      - On `state === 'merged'`, set `mergedAt` field; on `state === 'opened' && draft === true`, set `priority: IssuePriority.Low` (one-time autoset on first transition; subsequent edits respect LWW).
      - LWW per-field same as `IssuesSyncManager.applyRemote` for `title`, `description`, `status`, `assignee`, `milestone`, `labels`. For mixin-carried fields (`sourceBranch`, `targetBranch`, `draft`, `mergedAt`, `mergeStatus`, `webUrl`), apply remote-wins always (these are GitLab-authoritative; Huly users do not edit them).
      - Upsert idmap; set cursor (`kind: 'merge_requests'`).
    - `applyLocal(ctx, binding, doc, change)`:
      - Resolve mapping; if absent, **log warning and return** (Phase 2 scope cut — DOES NOT call `createMergeRequest`).
      - Translate title, description, labels, milestone, assignees, status (Huly status → `state_event` via `mapMRHulyStatus`), and call `bctx.gitlabClient.updateMergeRequest`.
      - Mixin-carried fields (`sourceBranch`, `targetBranch`) — only `targetBranch` is editable via Update MR API; `sourceBranch` is immutable post-create; ignore Huly edits to `sourceBranch`. Log `mr.sourceBranch.edit.ignored` when caller attempts it.
      - **Pipeline status is read-only from Huly — applyLocal MUST NOT include `pipelineStatus` in the GitLab payload.**
      - Set cursor.
    - `backfill(ctx, binding, since)`:
      - `bctx.gitlabClient.listMergeRequests(projectId, { updatedAfter: since })` paginated.
      - Enqueue each as `'merge_request'` via `this.deps.backfillEnqueuer`.
      - **Note (P2-R6 — see Risk Register):** this adds a 4th backfill listing call per binding per cycle (3→4× listing volume). Document in spec §Open Questions; acceptable for Phase 2.
- **Outputs (tests):** `tests/sync/mr.test.ts` — ≥ 16 cases (mirroring `issues.test.ts`):
  1. Create remote → local (with mixin field assertions including `webUrl`).
  2. Update title remote → local.
  3. Update description remote → local with markdown round-trip and `/uploads/...` link byte-identity assertion.
  4. State transition `opened → merged` writes `mergedAt` + applies Done status.
  5. State transition `opened → closed` applies Cancelled status.
  6. Draft true → priority Low autoset + draft mixin field set.
  7. Draft false on next event — priority NOT auto-changed (one-way autoset).
  8. Locked state — status untouched, `mergeStatus` mixin updated **to `'locked'`** AND other fields proceed.
  9. Label autocreate via shared LabelCache.
  10. Milestone autocreate.
  11. Assignee mapping with R9 stub-guest dedup.
  12. LWW: both sides edit title → newer wins.
  13. Confidential MR from `listMergeRequests` is never enqueued (adapter filters; asserted here).
  14. **`applyLocal` on a missing mapping (no existing Huly→GitLab link) logs warning and DOES NOT call `createMergeRequest`** — the Phase 2 scope-cut acceptance.
  15. **(C2/C8 fix) Mixin round-trip + `pipelineStatus` isolation:** `MergeRequestsSyncManager.applyRemote` writes the mixin; reading back via `fakeHulyClient.getMixin(issueRef, 'gitlab-mr').draft === true` (or whatever shape P2-T-01b reveals) asserts the mixin is queryable. AND `mr.applyRemote` does NOT touch the `pipelineStatus` mixin field — pre-seed the mixin with `pipelineStatus: 'success'`, run `applyRemote`, assert `pipelineStatus` is still `'success'` (the mixin update is a delta, not a replace).
  16. **(C4 fix) Reviewers → labels:** an MR with 2 reviewers produces 2 synthetic labels `gitlab:reviewer:<u>` via LabelCache.
- **Acceptance criteria:**
  - `npm test -- tests/sync/mr.test.ts` passes all 16 cases.
  - Round-trip attachment-link test byte-identical.
  - Test 14 asserts zero calls to `gitlabClient.createMergeRequest`.
  - Test 15 asserts zero adapter calls touching `pipelineStatus` AND a positive mixin readback.
  - `npm run lint -- src/sync/mr.ts` exits 0.
- **Dependencies:** P2-T-01, **P2-T-01b**, P2-T-02, P2-T-03, P2-T-04, P2-T-05.
- **Complexity:** L (~1500 LOC including tests).

---

### P2-T-08 — PipelineSyncManager

- **Owner:** Sonnet
- **Inputs:**
  - P2-T-01 types (`SyncPipeline`, `SyncPipelineStatus`).
  - P2-T-01b verified mixin API.
  - P2-T-05 MR cache.
  - Phase 1 `src/sync/types.ts` (`SyncManager` interface — frozen).
- **Outputs (new file `src/sync/pipeline.ts`):**
  - `PipelineSyncManager implements SyncManager<Record<string, unknown>>`:
    - `kind = 'pipeline'`.
    - `resourceKey(record)`: returns `'pipeline:${id}'` where id is extracted from `record.object_attributes.id` (webhook shape) or `record.id` (backfill shape).
    - `applyRemote(ctx, binding, payload)`:
      - Parse `mrIid = payload.merge_request?.iid` (asserted present at the webhook layer in P2-T-06; if absent here it's a defensive no-op with warning).
      - Parse `statusRaw = payload.object_attributes.status`; map via internal `mapPipelineStatus(statusRaw)` → `SyncPipelineStatus | null` (returns null for `'skipped'`, `'manual'`, `'scheduled'`, `'created'`, `'waiting_for_resource'`, `'preparing'` — all collapse to null because spec restricts the synced enum to 5 states; document the collapse).
      - If status is null after mapping → drop with `pipeline.status.unmapped` metric (count by raw status).
      - Use `bctx.mrCache.resolveMRRef(...)` to find the Huly Issue mirror. If absent → defer-retry once (mirrors NotesSyncManager retry pattern); if still absent on retry → drop with warning + `pipeline.parent.missing` metric.
      - **(C6 fix) LRU eviction visibility:** when the per-binding pipeline-event queue (Phase 1 `EventQueue`, capped at 1000 entries) evicts a pipeline event, increment `pipeline.dropped.lru` metric. Hook into the existing eviction callback in `EventQueue`; expose the counter via the same path as `confidentialSkippedCount`.
      - Write to the Huly Issue using the verified mixin API (P2-T-01b) with mixin id `'gitlab-mr'` and field set `{ pipelineStatus: mappedStatus }` — ONLY this field, never anything else.
      - Upsert idmap with `kind: 'pipeline'`, gitlabId `"${projectId}:${pipelineId}"`, hulyRef set to the parent Issue ref (used for dedup; the pipeline is not itself a Huly Doc).
      - Set cursor `kind: 'pipelines'`.
    - `applyLocal`: **no-op with debug log.** Pipeline status is GitLab-authoritative; Huly-side edits to `pipelineStatus` are ignored entirely.
    - `backfill`: **no-op for Phase 2.** Pipeline backfill is webhook-driven only because pipelines stream rapidly and a 5-min cursor is unreliable for CI events. Document this as a Phase 3 improvement (link from §7 Open Questions item 1).
- **Outputs (tests):** `tests/sync/pipeline.test.ts` — ≥ 8 cases:
  1. `Pipeline Hook` payload with mapped status writes mixin field.
  2. Status `'skipped'` → dropped with metric.
  3. Parent MR missing → deferred retry; second attempt with parent present succeeds.
  4. Parent MR still missing after retry → dropped with warning.
  5. Five-state map: each of `pending|running|success|failed|canceled` writes correctly.
  6. `applyLocal` is a no-op (assert zero adapter calls).
  7. **(C7 fix)** `backfill` is a no-op AND does NOT throw: `await expect(manager.backfill(ctx, binding, since)).resolves.toBeUndefined()` AND `expect(adapter.listX).toHaveBeenCalledTimes(0)`.
  8. **(C6 fix)** LRU eviction path: queue is filled past 1000 entries on a synthetic stream, assert `pipeline.dropped.lru` metric increments and the evicted events do not write to Huly.
- **Acceptance criteria:**
  - `npm test -- tests/sync/pipeline.test.ts` passes all 8 cases.
  - `npm run lint -- src/sync/pipeline.ts` exits 0.
- **Dependencies:** P2-T-01, **P2-T-01b**, P2-T-03, P2-T-05.
- **Complexity:** M (~530 LOC including tests).

---

### P2-T-09 — NotesSyncManager MR-route Extension

- **Owner:** Sonnet
- **Inputs:**
  - `/Users/dingo/huly-gitlab/src/sync/notes.ts` (Phase 1 — extending in place).
  - P2-T-05 MR cache (for parent resolution).
  - Spec §MR notes handling.
- **Outputs (modify `src/sync/notes.ts`):**
  - Extend `SyncNoteRecord` envelope to carry `noteableType: 'Issue' | 'MergeRequest'` (default `'Issue'` for backward compatibility with Phase 1 backfill paths).
  - **(C1 fix) Default `noteableType='Issue'` at every construction site:**
    - `notes.ts:parseWebhookPayload` — when `payload.object_attributes.noteable_type` is missing or `'Issue'`, set `record.noteableType = 'Issue'`; when `'MergeRequest'`, set `'MergeRequest'`.
    - `notes.ts:backfill` (legacy issue-note backfill path) — when `noteableIid` is set without an explicit `noteableType` field (Phase 1 callers), the record builder must set `noteableType = 'Issue'`. Add a single-call-site comment `// Phase 1 backfill compat: notes from listNotes are always issue-attached`.
    - When P2-T-09 adds the MR-note backfill arm (below), set `noteableType = 'MergeRequest'` on those records.
    - These three call sites MUST be enumerated as concrete line references in the PR description: `notes.ts:parseWebhookPayload`, `notes.ts:backfill` (issue arm), `notes.ts:backfill` (MR arm new).
  - Extend `parseWebhookPayload`:
    - Read `payload.object_attributes.noteable_type`; set `noteableType` on the envelope.
    - When `'MergeRequest'`, extract parent via `payload.merge_request.iid` instead of `payload.issue.iid`.
  - Extend `applyRemote`:
    - Branch on `noteableType`. For `'Issue'` keep the existing `resolveIssueRef(ctx, resolver, noteableIid)` path.
    - For `'MergeRequest'`, call a new local helper `resolveMRRef(ctx, resolver, noteableIid)` that wraps the MR-cache (P2-T-05). On miss, apply the same deferred-retry-then-drop pattern as the existing issue path (do NOT duplicate the retry block — refactor into one inner helper).
    - Both branches converge on the existing `chunter.class.ChatMessage` create/update path attached to the resolved Huly Issue (since both Issue and MR are the same `tracker.class.Issue` doc class after mixin).
    - **B3 defense-in-depth (confirm):** MR-note for a parent NOT in idmap (which is what confidential MRs look like since adapter never imports them) drops permanently after the existing deferred-retry exhausts. Document this in the helper's JSDoc.
  - Extend `applyLocal`:
    - Add `noteableType` to `change` payload (caller responsibility). When `'MergeRequest'`, route the `createNote`/`updateNote`/`deleteNote` calls to the new MR-note adapter methods (`createMRNote`, `updateMRNote`, `deleteMRNote` from P2-T-02).
    - When `noteableType` is absent on `change`, default to `'Issue'` to preserve Phase 1 behavior.
  - Extend `backfill`:
    - Iterate over BOTH issues (existing path) AND MRs (new path via `listMergeRequests` then `listMRNotes`). Cursors:
      - Issue-note cursor stays `kind: 'notes'` (Phase 1).
      - MR-note cursor: reuse the same `'notes'` cursor kind (notes are notes; the discriminator is on the envelope, not on the cursor). Document this choice as a Phase 3 split-point if performance dictates separate cursors.
  - Extend `NoteGitLabClient` interface to require `listMergeRequests`, `listMRNotes`, `createMRNote`, `updateMRNote`, `deleteMRNote` (the real `GitLabClient` already satisfies after P2-T-02; the interface widening forces test fakes to implement them too).
- **Outputs (tests):** extend `tests/sync/notes.test.ts` — ≥ 8 new cases (Phase 1 cases must continue to pass):
  1. Webhook Note Hook with `noteable_type: 'MergeRequest'` and known parent MR → ChatMessage created on the MR-mirror Huly Issue.
  2. Same, parent MR missing → deferred retry, then success on second attempt.
  3. System note on MR → skipped (existing `note.system` filter applies).
  4. **B3 defense:** MR-note whose parent MR is NEVER in idmap (simulating a confidential MR) → drops after deferred retry expires; no ChatMessage created; metric `mr.note.parent.missing` increments.
  5. `applyLocal` with `noteableType: 'MergeRequest'` calls `createMRNote` not `createNote`.
  6. Backfill iterates MRs and lists MR-notes; assert call count.
  7. Phase 1 issue-note path regression: a `noteable_type: 'Issue'` payload still works (existing tests cover this; explicitly run one as a sanity check).
  8. Mixed batch: backfill of 2 issues + 2 MRs produces 4 enqueues with correct envelopes (each envelope carries the right `noteableType`).
- **Acceptance criteria:**
  - `npm test -- tests/sync/notes.test.ts` passes all existing + new cases.
  - `npm run lint -- src/sync/notes.ts` exits 0.
  - Phase 1 note tests do not regress (assertion: pre-Phase-2 case count subset still passes).
  - PR description enumerates the three `noteableType` default call sites by line number.
- **Dependencies:** P2-T-02, P2-T-05.
- **Complexity:** M (~620 LOC including tests).

---

### P2-T-10 — Binding Loader + Lifecycle Wiring

- **Owner:** Sonnet
- **Inputs:**
  - `/Users/dingo/huly-gitlab/src/sync/binding-loader.ts` (Phase 1 — extending).
  - `/Users/dingo/huly-gitlab/src/sync/binding-lifecycle.ts` (Phase 1 — extending event subscription set).
  - `/Users/dingo/huly-gitlab/src/index.ts` (Phase 1 — wiring point).
  - `/Users/dingo/huly-gitlab/src/http/binding.ts` (Phase 1 — admin route additions).
  - Spec §Webhook auto-registration.
  - P2-T-05 MR cache, P2-T-07/08/09 managers.
- **Outputs (modify):**
  - `src/sync/binding-loader.ts`:
    - Add `mrCache: MRCache` to the `BindingContext` shape (both Issues and Notes-MR-path consume it).
    - Construct per-binding `MRCache` in `load(bindingRef)`, same lifecycle as `labelCache` / `milestoneCache`.
  - `src/sync/binding-lifecycle.ts`:
    - Extend the subscription set in `onBindingCreate` from `['issues_events', 'note_events']` to `['issues_events', 'note_events', 'merge_requests_events', 'pipeline_events']`.
    - **B4 fix — shared payload builder:** refactor `registerProjectWebhook` and `updateProjectWebhook` (the latter lives in `src/adapter/gitlab-client.ts`) to BOTH use a shared `buildWebhookPayload(eventFlags)` helper that ALWAYS injects `confidential_issues_events: false`, `confidential_note_events: false`, and any other GitLab `confidential_*_events` flag. The helper is the single source of truth for confidentiality posture on webhook registration. Lives in `src/adapter/webhook-payload.ts` (new tiny file).
    - **Existing-binding migration is NOT autonomous** (per task constraint). Document in code comment AND in P2-T-12 README that existing bindings registered under Phase 1 will receive issue + note events as before but will NOT receive MR/pipeline events until a one-time `POST /api/v1/bindings/:id/re-register-webhook` admin call.
    - Add `POST /api/v1/bindings/:id/re-register-webhook` admin route in `src/http/binding.ts` (bearer `ServerSecret`): calls `gitlabClient.updateProjectWebhook(projectId, webhookId, buildWebhookPayload({ issues_events: true, note_events: true, merge_requests_events: true, pipeline_events: true, token }))` — note the shared helper guarantees `confidential_*=false` is preserved in the PUT body. Returns `{bindingId, reRegisteredAt, eventFlags}`.
- **Outputs (tests):**
  - Extend `tests/sync/binding-lifecycle.test.ts` — ≥ 5 new cases:
    1. New binding registers webhook with all 4 event flags (`issues_events`, `note_events`, `merge_requests_events`, `pipeline_events`).
    2. **(B4 fix)** New binding registration includes `confidential_issues_events: false` and `confidential_note_events: false` in the POST body (assert via captured request body).
    3. `POST /api/v1/bindings/:id/re-register-webhook` updates the GitLab webhook via PUT with new event flags AND explicit `confidential_issues_events: false`, `confidential_note_events: false` in the PUT body — confidentiality posture preserved.
    4. Re-register requires bearer auth (401 without).
    5. Re-register on a binding with `webhookRegistered: false` returns 409 (cannot re-register what was never registered).
  - Extend `tests/sync/binding-loader.test.ts` — ≥ 2 new cases asserting `mrCache` is present on the loaded context.
  - New `tests/adapter/webhook-payload.test.ts` — ≥ 3 cases asserting `buildWebhookPayload` always sets `confidential_*=false` regardless of caller-supplied flags.
- **Acceptance criteria:**
  - `npm test -- tests/sync/binding-lifecycle.test.ts tests/sync/binding-loader.test.ts tests/adapter/webhook-payload.test.ts` passes.
  - `npm run build` exits 0.
  - `npm run lint -- src/sync src/http src/index.ts src/adapter/webhook-payload.ts` exits 0.
  - `grep -q "confidential_issues_events: false" src/adapter/webhook-payload.ts && grep -q "confidential_note_events: false" src/adapter/webhook-payload.ts` exits 0.
- **Dependencies:** P2-T-05, P2-T-07, P2-T-08, P2-T-09.
- **Complexity:** M (~500 LOC including tests).

---

### P2-T-11 — E2E Harness Extension

- **Owner:** Opus
- **Inputs:**
  - `/Users/dingo/huly-gitlab/tests/e2e/setup.ts` (Phase 1).
  - `/Users/dingo/huly-gitlab/tests/e2e/issues.e2e.test.ts` (Phase 1 — pattern reference).
  - P2-T-07/08/09/10 outputs.
- **Outputs:**
  - `tests/e2e/mr.e2e.test.ts`:
    1. Create MR in GitLab → assert appears as Huly Issue with `gitlab-mr` mixin within 30s via webhook.
    2. Edit MR title in GitLab → propagates to Huly within 30s.
    3. Edit MR title in Huly → propagates to GitLab via `updateMergeRequest`.
    4. `applyLocal` on a Huly-only "MR-like" issue (no idmap link) does NOT create a GitLab MR — explicit assertion no MR exists in GitLab post-operation.
    5. MR state transition `opened → merged` updates Huly status to Done + mixin `mergedAt`.
    6. Draft MR appears with priority Low + mixin `draft: true`.
    7. Confidential MR created in GitLab → does NOT appear in Huly; `gitlab.confidential.skipped` metric incremented.
    8. MR with reviewers → synthetic `gitlab:reviewer:<u>` labels appear on the mirror Huly Issue.
  - `tests/e2e/mr-notes.e2e.test.ts`:
    1. Comment on MR in GitLab → appears as ChatMessage attached to mirror Huly Issue within 30s.
    2. Edit comment from GitLab → updates Huly ChatMessage.
    3. Delete comment from GitLab → removes Huly ChatMessage.
    4. System note on MR (e.g. assignee change) → skipped.
  - `tests/e2e/pipeline.e2e.test.ts`:
    - **(C9 fix) Synthetic-webhook strategy — no GitLab runner dependency.** Instead of pushing a `.gitlab-ci.yml` and waiting for a real runner (which requires `RUNNERS_AVAILABLE=true` infra), each case constructs a Pipeline Hook payload manually and POSTs it to the webhook receiver with a valid signature. This exercises the full intake → manager → mixin write path without needing CI infrastructure.
    1. Synthetic Pipeline Hook payload with mapped status `'success'` and `merge_request.iid` set → mixin `pipelineStatus` updates within 5s.
    2. Synthetic Pipeline Hook payload with status `'skipped'` → no mixin update (dropped at PipelineSyncManager); `pipeline.status.unmapped` metric increments.
    3. Synthetic Pipeline Hook payload without `merge_request` field → 204 from webhook; no Huly write; `unboundPipelineCount` metric increments.
    4. Synthetic Pipeline Hook payload for an MR whose idmap entry doesn't yet exist → deferred retry path; eventual drop after retry expiry.
  - Extend `tests/e2e/setup.ts`:
    - Wait loops unchanged.
    - Bind via admin API now uses Phase 2 endpoint that registers all 4 event flags.
    - Add helper `createMR(projectId, sourceBranch, targetBranch, opts)` that pushes a source branch and opens an MR via GitLab REST.
    - Add helper `postSyntheticWebhook(eventHeader, payload, secret)` that signs and POSTs to the webhook receiver — used by `pipeline.e2e.test.ts`.
- **Acceptance criteria:**
  - `npm run test:e2e` exits 0 with the new files included (excluding soak by default).
  - All MR/pipeline/MR-note E2E tests pass against the live compose stack (real GitLab CE + real Huly transactor). Pipeline cases pass WITHOUT requiring `RUNNERS_AVAILABLE=true`.
  - Phase 1 E2E suite continues to pass unchanged.
- **Dependencies:** P2-T-10.
- **Complexity:** L (~1100 LOC including new fixtures and setup helpers).

---

### P2-T-12 — README + Architecture Doc Deltas + Re-registration Runbook

- **Owner:** Haiku
- **Inputs:**
  - `/Users/dingo/huly-gitlab/README.md` (Phase 1).
  - `/Users/dingo/huly-gitlab/docs/architecture.md` (Phase 1).
  - `/Users/dingo/huly-gitlab/docs/api.md` (Phase 1).
  - Spec §Success Criteria.
- **Outputs (modify):**
  - `README.md`:
    - Add Phase 2 section listing: MR sync, MR-attached notes, pipeline summary status, runtime mixin `gitlab-mr`.
    - Update "Phase 1 limitations" → "Phase 1 + Phase 2 limitations" with Phase 2 carryovers:
      - Confidential MRs not synced.
      - Approvals + review threads + line comments deferred to Phase 3.
      - Diff/changes metadata deferred to Phase 3.
      - Pipeline status is summary only (5 states); jobs/stages/logs deferred.
      - **MR creation from Huly is not yet supported** (Phase 3 will add intent capture); Huly-only "MR-like" Issues are not pushed to GitLab.
      - `sourceBranch` is read-only from Huly.
      - **`pipelineStatus` is read-only from Huly (PipelineSyncManager owns the field; MR sync never touches it).**
      - Existing Phase 1 bindings require one-time webhook re-registration to receive MR + pipeline events.
      - Reviewers map as synthetic labels `gitlab:reviewer:<username>` for Phase 2; typed reviewer field deferred to Phase 3.
  - `docs/architecture.md`:
    - Mermaid update showing the new managers (`MergeRequestsSyncManager`, `PipelineSyncManager`) and the NotesSyncManager `noteable_type` discriminator branch.
    - Document the runtime-only mixin `gitlab-mr` (NOT a model mixin) and why (out-of-tree model registration constraint — Phase 1 lesson Q5). Include a one-paragraph note that the mixin field set is partitioned: MR-sync owns `sourceBranch|targetBranch|draft|mergedAt|mergeStatus|webUrl`; Pipeline-sync owns `pipelineStatus`; never overlap.
    - Document the cursor scheme: `merge_requests`, `pipelines` added; notes cursor shared between issue-notes and MR-notes for Phase 2.
    - Document defense-in-depth confidentiality model: (1) adapter filter at `listMergeRequests` + `getMergeRequest`; (2) webhook filter at MR-Hook receipt; (3) MR-note parent-resolution drop at NotesSyncManager (because confidential MRs never enter idmap, MR-notes for them resolve to nothing and drop after deferred retry).
  - `docs/api.md`:
    - Document `POST /api/v1/bindings/:id/re-register-webhook` admin route with curl example. Note the response shape includes confirmed `confidential_*=false` flags.
  - `docs/runbooks/phase2-rereg.md` (new):
    - Step-by-step runbook for operators: list existing bindings, identify those with `webhookRegistered:true`, call the re-register endpoint, verify event flags via `GET /projects/:id/hooks/:hook_id` on GitLab — including verifying `confidential_issues_events: false` and `confidential_note_events: false` are preserved.
- **Acceptance criteria:**
  - `npx markdownlint-cli2 "**/*.md"` exits 0.
  - `docs/runbooks/phase2-rereg.md` exists and contains at least one `curl` example.
  - Phase 2 limitations section in README lists at least the 9 items above.
- **Dependencies:** P2-T-10, P2-T-11.
- **Complexity:** S (~380 lines markdown).

---

## 4. Testing Plan

| Layer | Task | Command | Expected new tests |
|---|---|---|---|
| Adapter types | P2-T-01 | (build only — no test file) | 0 |
| Vendor mixin types | P2-T-01b | (build only — no test file) | 0 |
| Adapter MR + Pipeline REST | P2-T-02 | `npm test -- tests/adapter/gitlab-client-mr.test.ts` | ≥ 11 |
| State enum widening | P2-T-03 | `npm test -- src/state/store.test.ts` | ≥ 4 new |
| MR status map | P2-T-04 | `npm test -- tests/sync/mr-status-map.test.ts` | ≥ 8 |
| MR cache | P2-T-05 | `npm test -- tests/sync/mr-cache.test.ts` | ≥ 4 |
| Webhook dispatch | P2-T-06 | `npm test -- tests/http/webhook.test.ts` | ≥ 8 new |
| MergeRequestsSyncManager | P2-T-07 | `npm test -- tests/sync/mr.test.ts` | ≥ 16 |
| PipelineSyncManager | P2-T-08 | `npm test -- tests/sync/pipeline.test.ts` | ≥ 8 |
| Notes MR-route | P2-T-09 | `npm test -- tests/sync/notes.test.ts` | ≥ 8 new |
| Webhook payload helper | P2-T-10 | `npm test -- tests/adapter/webhook-payload.test.ts` | ≥ 3 |
| Binding lifecycle + loader | P2-T-10 | `npm test -- tests/sync/binding-lifecycle.test.ts tests/sync/binding-loader.test.ts` | ≥ 7 new |
| E2E (compose) | P2-T-11 | `npm run test:e2e` | 16 new E2E |

**Expected total new tests:** ≥ 93 (target 100+).
**Expected baseline delta:** 306 → ≥ 399 (spec requires ≥ 25, plan targets 90+).

**Local developer loop (unchanged from Phase 1):**
- Unit: `npm test` (excludes e2e).
- Integration: `npm run test:integration` → `mongodb-memory-server` + nock.
- E2E: `make compose-up && npm run test:e2e && make compose-down` (45 min cold / 15 min warm). Pipeline E2E uses synthetic webhook posts — no GitLab CE runner required.

**Regression guarantee:** every task acceptance criterion includes `npm test` exits 0 across the whole repo (not just the new file) to catch Phase 1 regressions immediately.

---

## 5. Build & Verification Commands (Phase 3 QA reference)

Run from `/Users/dingo/huly-gitlab`:

```bash
# Install (no new deps in Phase 2)
npm ci

# Static checks
npm run lint
npm run format -- --check

# Build
npm run build                     # tsc -p .

# Unit + integration
npm test                          # expect ≥ 399 tests passing

# Coverage delta vs Phase 1
npm test -- --coverage
# expect coverage for src/sync/mr.ts, src/sync/pipeline.ts, src/sync/mr-status-map.ts,
#                    src/sync/mr-cache.ts, src/adapter/webhook-payload.ts ≥ 85%

# Docker image (unchanged)
docker build -t huly-gitlab:local .

# Dev stack (unchanged compose)
docker compose -f docker/docker-compose.dev.yml up -d
curl http://localhost:3600/health

# End-to-end (full stack, includes Phase 2 cases — pipeline cases use synthetic webhooks, no runners required)
make e2e

# npm audit
npm audit --omit=dev --audit-level=high  # expect 0 high
```

Phase 2 acceptance (per spec §Success Criteria):
1. `npm test` exits 0 with ≥ 399 tests.
2. `npm audit --omit=dev --audit-level=high` shows 0 high.
3. `make e2e` exits 0 including MR/pipeline/MR-note cases (no runner dependency).
4. Confidential MR / pipeline-without-MR / draft / merged / locked all assert at unit AND E2E layers.
5. Mixin round-trip (read-back) asserted at unit AND E2E layers (P2-R1 mitigation).
6. `pipelineStatus` field isolation asserted at unit layer (MR sync never overwrites it).

---

## 6. Risk Register (Phase 2-specific)

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| **P2-R1** | Runtime mixin `gitlab-mr` writes without model registration silently fail or fail at query time. The Phase 1 Q5 lesson warned against typed mixins; this risk is that even untyped mixin storage may have edge cases when the platform's mixin descriptor doesn't exist. | Medium | High | P2-T-01b verifies the real `TxOperations` mixin API against `@hcengineering/core/lib/index.d.ts` before any caller compiles. P2-T-07 test 15 round-trips a written mixin via `findOne` + `getMixin('gitlab-mr')` against the fake HulyClient AND an E2E test (P2-T-11) round-trips against the real Huly transactor. If the E2E mixin read fails, fall back to storing mixin fields in a JSON-string custom field on the Issue (Phase 2 contingency); document the contingency in the plan v3 changelog. |
| **P2-R2** | Existing Phase 1 bindings won't auto-update their webhook event subscriptions, leaving MR + pipeline events undelivered for production deployments. | High | Medium | Explicit admin endpoint `POST /api/v1/bindings/:id/re-register-webhook` (P2-T-10); runbook in `docs/runbooks/phase2-rereg.md` (P2-T-12); P2-T-12 README "Phase 2 limitations" calls this out explicitly. Operators must run the re-registration; no autonomous migration. Re-registration uses the shared `buildWebhookPayload` helper which guarantees `confidential_*=false` is preserved (B4 fix). |
| **P2-R3** | Pipeline event volume on busy projects (10+ pipelines/min) saturates the webhook intake queue. | Medium | Medium | The Phase 1 `EventQueue` keys on `(workspace, binding, resourceKey)` with `resourceKey = 'pipeline:<id>'`, so different pipelines parallelize and only same-pipeline events serialize. The 1000-entry LRU cap per binding still applies. **C6 fix:** P2-T-08 adds `pipeline.dropped.lru` metric so eviction is observable. Document that operators with > 10k pipelines/hour should consider scaling horizontally (Phase 3 work). |
| **P2-R4** | MR notes interleave with issue notes in the same `'notes'` cursor, causing one path to mask the other when one side is much busier. | Low | Medium | Cursor stores `max(updated_at)` across both types — both paths use it as a lower bound. Worst-case is one redundant fetch per backfill cycle, no data loss. Document as Phase 3 split-point in `docs/architecture.md` (P2-T-12). |
| **P2-R5** | `mergeStatus` field on the mixin gets out of sync if Phase 2 only updates it on `getMergeRequest` (not via the Update API which doesn't return current merge-status). | Low | Low | Treat `mergeStatus` as remote-authoritative from webhook payloads only; on missing field in webhook, do not overwrite. Drop a `mergeStatus.unknown` metric for visibility. Phase 3 may add a poll-on-update refresh. |
| **P2-R6** | **(C5 fix)** Backfill load increases ~33% per binding per cycle (3 listings → 4: issues + notes + MRs + MR-notes). Busy bindings with thousands of MRs per project may hit GitLab rate limits faster. | Medium | Low | Document the rate change explicitly. The Phase 1 backfill scheduler already staggers per binding; `listMergeRequests` reuses the existing 429 retry path. Phase 3 may add adaptive backfill spacing. Mitigation today: operators tune `BACKFILL_INTERVAL_MS` upward if rate-limit metrics climb. |

---

## 7. Open Questions (defaults assumed; flag during implementation if any need user override)

1. **Pipeline backfill omission.** Phase 2 PipelineSyncManager `backfill` is a no-op (webhook-driven only). **Resolved (Q3):** acceptable for Phase 2 because pipeline state churns rapidly and is non-critical (re-checking CI on demand from GitLab is trivial). Matches spec §Architecture (webhook-driven only). Promote to Phase 3 if operators report drift. **Append to `.omc/plans/open-questions.md`.**
2. **Shared `'notes'` cursor across issue-notes and MR-notes.** **Default assumption:** acceptable for Phase 2; split into `'issue_notes'` + `'mr_notes'` in Phase 3 only if performance metrics demand. **Append to `.omc/plans/open-questions.md`.**
3. **`reviewers` mapping to synthetic labels (`gitlab:reviewer:<username>`).** Spec §Open Questions documents this as a Phase 2 limitation. **Resolved (C4):** P2-T-07 emits the synthetic labels via LabelCache; Phase 3 will introduce a typed reviewer field. Documented in README.
4. **Mixin removal on type change.** Spec §Open Questions: if a Huly user changes an MR-mirror Issue's type to "not an MR," do we strip the mixin? **Default assumption:** no; mixin persists; only GitLab-side delete removes the mirror. **Append to `.omc/plans/open-questions.md`.**
5. **`createMergeRequest` callable from tests but not production.** Adapter method lands in P2-T-02 but `applyLocal` never calls it. **Default assumption:** acceptable scope cut; Phase 3 will add intent capture (Huly UI signals "ready to push to GitLab as MR").
6. **One-time re-registration migration.** **Resolved (Q4):** Documented as manual admin operation in P2-T-10/P2-T-12 with bearer-auth endpoint and runbook. No autonomous migration. Phase 2 limitation in README.
7. **Mixin API shape.** **Resolved (Q1):** P2-T-01b is the day-1 verification gate. The executor reads `@hcengineering/core/lib/index.d.ts` and widens `vendor.d.ts` with the verified signatures. P2-T-07's mixin call shape is derived from whatever P2-T-01b documents.
8. **`MergeStatus='locked'` widening.** **Resolved (Q2):** Added to the type union in P2-T-01. Required by spec §State mapping.

Executors must escalate any of items 2, 4, 5 if a stakeholder objects during implementation.

---

## 8. Change log

- **v1 (initial):** initial Phase 2 plan derived from `.omc/specs/deep-interview-huly-gitlab-phase2.md`. Structure mirrors Phase 1 plan (`.omc/plans/autopilot-impl.md`) for task format, acceptance-criteria style, risk register format, and change log placement.
- **v2 (this revision) — critic findings applied:**
  - **B1:** Added new task **P2-T-01b** (Wave A, parallel with P2-T-01) to verify the real `TxOperations` mixin API against `@hcengineering/core/lib/index.d.ts` and widen `src/huly/vendor.d.ts`. Day-1 gate; without this widening, P2-T-07 fails at compile.
  - **B2:** Widened `MergeStatus` union in P2-T-01 to include `'locked'` (spec §State mapping requires `mergeStatus='locked'` mixin write for GitLab `locked` MRs). Added round-trip case 6 to P2-T-02 and locked-state case 8 to P2-T-07 to assert.
  - **B3:** Restructured the confidential MR-note webhook guard. Removed the broken `payload.merge_request.confidential` check (GitLab Note Hook for MR notes does NOT carry this field). Replaced with two-layer defense-in-depth: (1) MR-Hook filter at adapter + webhook ensures confidential MRs never enter idmap; (2) MR-note parent-resolution drop at NotesSyncManager drops notes for unmapped parents after deferred retry. Updated P2-T-06 case 6 and added P2-T-09 case 4 to assert.
  - **B4:** Refactored `registerProjectWebhook` and `updateProjectWebhook` to share a `buildWebhookPayload(eventFlags)` helper in new file `src/adapter/webhook-payload.ts` that ALWAYS sets `confidential_*_events: false`. Re-register endpoint preserves confidentiality posture. Added P2-T-10 cases 2, 3 and new `tests/adapter/webhook-payload.test.ts` (≥ 3 cases) to assert.
  - **B5:** Corrected P2-T-03 acceptance to target `src/state/store.test.ts` (the actual Phase 1 file) instead of nonexistent `idmap.test.ts`/`cursors.test.ts`. New cases added to the existing combined test file.
  - **C1:** Required explicit `noteableType='Issue'` default at the three concrete call sites in `notes.ts` (`parseWebhookPayload`, backfill issue arm, backfill MR arm). PR description must enumerate the line references. Added to P2-T-09 outputs and acceptance.
  - **C2:** Dropped `pipelineStatus` from the field set written by `MergeRequestsSyncManager.applyRemote`. Only `PipelineSyncManager` writes that field. Prevents stale MR sync from overwriting a just-set pipeline-event status. Added P2-T-07 case 15 to assert isolation.
  - **C3:** Added `webUrl: string` to the mixin field list in P2-T-07.
  - **C4:** P2-T-07 emits `gitlab:reviewer:<username>` synthetic labels via LabelCache for MR reviewers. Added case 16 and an E2E case (`mr.e2e.test.ts` case 8).
  - **C5:** Documented the backfill scaling impact (3→4× listing calls per binding per cycle) as new Risk P2-R6 and an explicit note in P2-T-07's `backfill` description.
  - **C6:** Added `pipeline.dropped.lru` metric to P2-T-08 (5 LOC + test case 8) so operators can observe LRU eviction.
  - **C7:** Strengthened P2-T-08 case 7 to assert `backfill` resolves with `undefined` AND makes zero adapter calls (exception safety).
  - **C8:** Added a positive mixin readback assertion to P2-T-07 case 15 (`fakeHulyClient.getMixin(issueRef, 'gitlab-mr').draft === true` — actual shape adapted to whatever P2-T-01b reveals).
  - **C9:** P2-T-11 pipeline E2E switched from real-runner-dependent to synthetic-webhook strategy — POST signed Pipeline Hook payloads to the webhook receiver. No `RUNNERS_AVAILABLE=true` gate needed; works on any CI.
  - **Q1, Q2, Q3, Q4:** All four open questions from v1 resolved and documented in §7 with explicit linkages to the new tasks/acceptance criteria.
  - Task count: 12 → 13 (added P2-T-01b in Wave A).
  - Total new tests: ≥ 81 → ≥ 93.
  - Baseline delta: 306 → ≥ 387 → ≥ 399.
