# Implementation Plan — huly-gitlab Phase 3

**Status:** Draft v2 (autopilot Phase 3)
**Spec:** `.omc/specs/deep-interview-huly-gitlab-phase3.md`
**Target tree:** `/Users/dingo/huly-gitlab/`
**Phase 1+2 baseline:** 34 test suites / 408 tests passing; 70 TS files in `src/`; all reviewers approved.
**Phase 2 plan (structure reference):** `.omc/plans/autopilot-impl-phase2.md`

## Revision history
- v1: initial Phase 3 plan
- v2 (this revision): applied critic findings — resolved Q1 per-note storage, Q2 API-surface-only approvals, Q3 operator-pause migration, Q4 graceful 404 handling; added P3-T-01b mixin change-payload investigation + P3-T-12b metrics centralization; tightened `SyncMergeRequest` optional Phase 3 fields; corrected migration label-reading; tightened error class shape; restructured DAG (P3-T-09 to Wave C); added P3-R6 race + P3-R7 CE skew + Q5 mixin split trigger.

---

## 1. Overview

Phase 3 extends the shipped Phase 2 MR mirror with four new review primitives: (a) **review threads** stored as `chunter.class.ChatMessage` carrying a runtime `gitlab-review` mixin (`threadId`, `resolved`, `resolvedBy`, `resolvedAt`, `position`); (b) **line comments** routed through the existing `NotesSyncManager` when `payload.object_attributes.position` is set, fanning out to a NEW `ReviewThreadsSyncManager` (kind `'review'`); (c) **CE approvals** as additional fields (`reviewers`, `approvedBy`, `approvalsRequired`, `approvalStatus`) on the existing `gitlab-mr` mixin with two-way action handling in `MergeRequestsSyncManager.applyLocal` (Huly add → `approveMR`, Huly remove → `unapproveMR`, per-user OAuth preferred with service-account fallback); (d) **diff metadata** (`diffWebUrl`, `changedFiles`) on the same mixin populated from `GET /merge_requests/:iid/changes`. A one-shot bearer-protected `POST /api/v1/bindings/:id/migrate-reviewer-labels` admin route scans mirrored MRs (after an operator pause), converts Phase 2 synthetic `gitlab:reviewer:<u>` labels to the typed `reviewers` array, and strips them. `idmap.kind` widens with `'review_thread'`; `cursors.kind` widens with `'reviews'`; `MR_MIXIN`/`MRMixinDoc` extends with the six new fields; a NEW `MR_REVIEW_MIXIN`/`MRReviewMixinDoc` is introduced for `gitlab-review`. The sync engine, conflict resolver, OAuth, AES-256-GCM credentials, ObjectId validation, SSRF allowlist, helmet/CORS, asyncHandler, capability detection, PKCE OAuth, transient/permanent refresh classification, BindingLoader, UserIdentity, HulyClient, markdown round-trip, Docker compose, and CI/release workflows are reused verbatim. **No new webhook subscription** is required — approval state and reviewer updates arrive on `Merge Request Hook` (already subscribed in Phase 2); discussions arrive on `Note Hook` (already subscribed). The Phase 2 reviewer-label scope cut is closed via the migration endpoint; the Phase 2 `applyLocal`-cannot-create-MR scope cut **remains in place** (Phase 3 only extends `applyLocal` for approval actions). Pre-mortem and an ADR are out of scope (this plan executes in non-deliberate mode); the Phase 1+2 `MR_MIXIN` field-ownership rule from critic C2 (PipelineSyncManager exclusively owns `pipelineStatus`) is preserved and extended in this plan: `ReviewThreadsSyncManager` exclusively owns the `gitlab-review` mixin fields; `MergeRequestsSyncManager.applyRemote` exclusively owns the new approval/reviewers/diff fields on `gitlab-mr`; no manager writes a field another owns.

**v2 framing of resolved open questions (applied throughout):**
- **Q1 (per-note vs root-only mixin) — RESOLVED: per-note storage.** Every ChatMessage in a thread carries the `gitlab-review` mixin with its own `threadId`, `resolved`, `resolvedBy`, `resolvedAt`. `position` is set ONLY on the first note (the discussion root); replies have `position: undefined`. Thread STATE (resolved/resolvedBy/resolvedAt) is per-note replicated for read-after-write consistency. LWW reconciliation across notes uses `max(resolvedAt)` to derive the thread-level resolved state. See P3-T-06.
- **Q2 (per-user OAuth) — RESOLVED: API surface only in Phase 3.** Approve/unapprove call path ships with the `actorToken` parameter, but no Phase 3 UI exists for users to self-link credentials. All Phase 3 approvals fall back to service-account with a `warn` log and a visibility comment ("Approved via service account; per-user OAuth UI coming in Phase 4"). Documented as a Phase 3 limitation in README and the Phase 3 runbook.
- **Q3 (migration concurrency) — RESOLVED: operator-pauses binding convention.** Migration endpoint checks `binding.disabled !== true` and returns 409 Conflict with `{ error: 'binding active', message: 'Pause binding (PATCH /api/v1/bindings/:id with {disabled: true}) before running migration; re-enable after.' }`. Operator responsibility, no autonomous lock. Idempotent re-run on paused binding is safe. P3-T-10 adds the `PATCH /api/v1/bindings/:id` `{disabled}` toggle.
- **Q4 (CE /approvals 200 vs 404) — RESOLVED: both handled gracefully.** Adapter `getMRApprovals` treats 404 as `{ approvedBy: [], approvalsRequired: 0 }`; 5xx propagates as `GitLabApiError`. Same pattern for `getMRChanges` (404 → `{ changedFiles: [], diffWebUrl: ${webUrl}/diffs }`). Both increment `mr.composite.partial` on 404.

---

## 2. Dependency Graph / Phase Ordering

```
              P3-T-01 Adapter Types + Errors
              P3-T-01b Mixin change-payload shape investigation
              P3-T-02 vendor.d.ts spot-check (idempotent)
                           │
            ┌──────────────┼──────────────┐
            ▼              ▼              ▼
       P3-T-03         P3-T-04        P3-T-05
       Adapter REST    State enum     Mixin schema
       methods         widening       extensions
       (gitlab-client) (idmap +       (mr-mixin +
                       cursors)       mr-review-mixin)
            │              │              │
            └──────┬───────┴──────┬───────┘
                   ▼              ▼              ▼
            P3-T-06           P3-T-07         P3-T-09
            ReviewThreads     MergeRequests   Reviewer-label
            SyncManager       SyncManager     migration helper
            (new file         extensions      (reviewer-migration.ts)
            mr-review.ts)     (mr.ts)
                   │              │              │
                   └──────┬───────┴──────────────┘
                          ▼
                   P3-T-08 NotesSyncManager
                   line-position routing
                   (notes.ts extension)
                          │
                          ▼
                   P3-T-10 HTTP admin route + PATCH disable toggle
                   + Binding lifecycle wiring
                   (http/binding.ts +
                   binding-loader.ts +
                   binding-lifecycle.ts +
                   index.ts)
                          │
                          ▼
                   P3-T-11 E2E harness extensions
                   (synthetic webhooks for
                   discussion delivery)
                          │
                          ▼
                   P3-T-12 README + arch doc +
                   migration runbook
                   P3-T-12b Metrics centralization
                   (src/metrics.ts)
```

**Parallel waves (v2):**

- **Wave A (Day 1):** P3-T-01 AND P3-T-01b AND P3-T-02 in parallel. P3-T-01 (`src/adapter/types.ts` + `src/adapter/errors.ts`), P3-T-01b (verify mixin-update change-payload shape in `node_modules/@hcengineering/core/lib/operations.d.ts` + Phase 2 test), P3-T-02 (`src/huly/vendor.d.ts` reverification).
- **Wave B (after Wave A):** P3-T-03, P3-T-04, P3-T-05 in parallel. Disjoint files: `src/adapter/gitlab-client.ts` add-only; `src/state/idmap.ts` + `src/state/cursors.ts` enum widening + `src/state/store.test.ts`; `src/sync/mr-mixin.ts` field additions + new file `src/sync/mr-review-mixin.ts`.
- **Wave C (after Wave B):** P3-T-06, P3-T-07, P3-T-09 in parallel. Disjoint files: new `src/sync/mr-review.ts` (P3-T-06); `src/sync/mr.ts` extension (P3-T-07); new `src/sync/reviewer-migration.ts` (P3-T-09 — needs only P3-T-05 mixin schema + Phase 2 LabelCache; NOT P3-T-07 applyRemote behavior — DAG correction C8).
- **Wave D (after Wave C):** P3-T-08 alone. Extends `src/sync/notes.ts` and depends on the P3-T-06 manager being importable for the line-position routing branch.
- **Wave E (after Wave D):** P3-T-10 wiring (admin route + PATCH disable toggle + binding-loader + lifecycle + index).
- **Wave F (after Wave E):** P3-T-11 E2E and P3-T-12 docs and P3-T-12b metrics module in parallel.

**Parallelism width:** 3 (Waves A, B, C, F). Waves D, E serial.

**Gating contract (Wave A day-1 deliverable):**

- `src/adapter/types.ts` adds `SyncReviewThread`, `SyncReviewNote`, `SyncReviewPosition`, `SyncApproval`, `SyncChangedFile`, `SyncMRChanges`, and extends `SyncMergeRequest` with `reviewers?`, `approvedBy?`, `approvalsRequired?`, `approvalStatus?`, `diffWebUrl?`, `changedFiles?` (all OPTIONAL — see B2). The Phase 2 `reviewers` field becomes `reviewers?` (optional + interpretation change documented).
- `src/adapter/errors.ts` adds `ApprovalActionError` with the class-field shape (C5).
- `src/huly/vendor.d.ts` is verified (no code change expected — Phase 2 already added `createMixin`/`updateMixin`).
- P3-T-01b writes its verified mixin-change-payload shape into a code comment at the head of `src/sync/mr.ts` (and is referenced by P3-T-07).

---

## 3. Task List

### P3-T-01 — Adapter Types + Discriminators + Error Class

- **Owner:** Sonnet
- **Inputs:**
  - `/Users/dingo/huly-gitlab/.omc/specs/deep-interview-huly-gitlab-phase3.md` (§Scope, §Architecture)
  - `/Users/dingo/huly-gitlab/src/adapter/types.ts` (Phase 1+2 types — extend not rewrite; `SyncMergeRequest` already has `reviewers`)
  - `/Users/dingo/huly-gitlab/src/adapter/errors.ts` (Phase 1+2 error hierarchy — extend)
- **Outputs (modify `src/adapter/types.ts`):**
  - `SyncReviewPosition`:
    ```
    { filePath: string,
      oldLine: number | null,
      newLine: number | null,
      baseSha: string,
      headSha: string,
      startSha: string,
      positionType: 'text' }   // only 'text' supported in Phase 3
    ```
  - `SyncReviewNote`: same shape as `SyncNote` plus `discussionId: string`, `position: SyncReviewPosition | null` (null for general MR discussions that are not line-anchored — these still route through the existing notes path; only `position !== null` triggers review-thread routing).
  - `SyncReviewThread`: `{ discussionId: string, mergeRequestIid: number, projectId: number, resolved: boolean, resolvedBy: SyncUser | null, resolvedAt: string | null, notes: SyncReviewNote[] }`.
  - `SyncApproval`: `{ mergeRequestIid: number, approvedBy: SyncUser[], approvalsRequired: number }` — translation surface for `getMRApprovals` response.
  - `SyncChangedFile`: `{ path: string, oldPath: string | null, additions: number, deletions: number, status: 'added' | 'modified' | 'deleted' | 'renamed' }`.
  - `SyncMRChanges`: `{ diffWebUrl: string, changedFiles: SyncChangedFile[] }`.
  - **Extend `SyncMergeRequest` with OPTIONAL Phase 3 fields (B2 — critical shape decision):**
    ```ts
    export interface SyncMergeRequest {
      // ...Phase 1+2 fields (required) unchanged...
      reviewers?: SyncUser[]                          // optional: only populated by getMergeRequest, not listMergeRequests
      approvedBy?: SyncUser[]                         // optional: from getMRApprovals (composite call)
      approvalsRequired?: number                      // optional: from getMRApprovals
      approvalStatus?: 'pending' | 'approved' | 'changes_requested'  // optional: derived from approvedBy/approvalsRequired
      diffWebUrl?: string                             // optional: from getMRChanges or assembled from webUrl
      changedFiles?: SyncChangedFile[]                // optional: from getMRChanges
    }
    ```
  - **Phase 2 `reviewers` is widened to `reviewers?`** to match the new contract. Phase 2 call sites that read `reviewers` directly must treat `undefined` as "not yet fetched" (B2).
  - **JSDoc must document the optional-field contract:**
    - `listMergeRequests` returns `SyncMergeRequest` with the six Phase 3 fields **undefined** (do NOT default them).
    - `getMergeRequest` performs composite fetch and returns ALL fields populated when responses succeed; partial on any 404/5xx with `mr.composite.partial` metric increment.
    - `applyRemote` (P3-T-07) MUST treat `undefined` as "not yet fetched; do not write mixin field" — NOT as "clear the field." This is critical: backfill from `listMergeRequests` followed by per-MR `getMergeRequest` must not clobber typed reviewers with empty arrays during the intermediate state.
- **Outputs (modify `src/adapter/errors.ts`) — corrected shape (C5):**
  ```ts
  export class ApprovalActionError extends Error {
    readonly kind: 'approve' | 'unapprove'
    readonly bindingId: string
    readonly mrIid: number
    readonly actorUuid?: string
    constructor (
      kind: 'approve' | 'unapprove',
      bindingId: string,
      mrIid: number,
      message: string,
      actorUuid?: string
    ) {
      super(message)
      this.name = 'ApprovalActionError'
      this.kind = kind
      this.bindingId = bindingId
      this.mrIid = mrIid
      this.actorUuid = actorUuid
    }
  }
  ```
  Do NOT pass `cause` as a constructor arg. The HTTP status / upstream message goes into the `message` string (or a separate `readonly status?: number` class field if a discrete status is needed). Pattern-match the existing errors in `src/adapter/errors.ts`.
- **Acceptance criteria:**
  - `npm run build` exits 0.
  - `npm run lint -- src/adapter/types.ts src/adapter/errors.ts` exits 0.
  - `grep -q "SyncReviewThread" src/adapter/types.ts && grep -q "SyncReviewPosition" src/adapter/types.ts && grep -q "SyncMRChanges" src/adapter/types.ts && grep -q "approvalStatus" src/adapter/types.ts && grep -q "ApprovalActionError" src/adapter/errors.ts` exits 0.
  - Phase 2 type consumers (`SyncMergeRequest` readers) build cleanly after `reviewers` becomes optional (the existing default-from-undefined behavior in Phase 2 callers either continues to work or is fixed in the same PR).
  - No tests required — pure type additions.
- **Dependencies:** none.
- **Complexity:** S (~200 LOC type defs + JSDoc).

---

### P3-T-01b — Mixin change-payload shape investigation (NEW v2)

- **Owner:** Sonnet
- **Inputs:**
  - `/Users/dingo/huly-gitlab/node_modules/@hcengineering/core/lib/operations.d.ts` (authoritative typings for the change payload Huly emits via `client.updateMixin`).
  - `/Users/dingo/huly-gitlab/tests/sync/mr.test.ts` (Phase 2 — has `change.title` / `change.description` for base Issue fields; need a known mixin-update case to compare).
  - `/Users/dingo/huly-gitlab/src/sync/mr.ts` (Phase 2 — `applyLocal` consumes the existing `change` shape; reference for current parsing logic).
  - `/Users/dingo/huly-gitlab/src/sync/pipeline.ts` (Phase 2 — the only Phase 2 module that writes a mixin field, so its `applyLocal` consumer side or any related test is the closest current evidence on shape).
- **Investigation step:**
  - Peek `operations.d.ts` for the change-payload shape that fires when `client.updateMixin(docId, _class, space, mixinId, attributes)` is called. Document whether the change payload carries:
    - `change[MR_MIXIN][fieldName]` (string-prefixed access)
    - `change['gitlab-mr.approvedBy']` (flat dotted key)
    - `change.mixinUpdate?.attributes?.approvedBy` (nested under a discriminator)
    - or some other structure.
  - Verify the actual emitted shape via a small one-off test in `tests/sync/mr.test.ts` that calls `updateMixin` and inspects the captured change payload (use the existing mock client).
  - If `client.applyLocal` change payload is shape-incompatible with the planned approach (e.g., mixin updates don't fire `applyLocal` at all), document an alternative path explicitly: e.g., poll the Huly Doc state after each tx instead of consuming `change`.
- **Outputs:**
  - Write the verified key shape into a code comment at the head of `src/sync/mr.ts` (insert before existing imports):
    ```ts
    /**
     * Phase 3 mixin-change-payload shape (verified P3-T-01b 2026-06-06):
     *   When client.updateMixin(... MR_MIXIN, { approvedBy }) fires,
     *   applyLocal receives change = {<documented shape>}.
     * applyLocal accesses approvedBy via <verified expression>.
     */
    ```
  - Update P3-T-07 to use the verified key shape; remove the v1 ambiguous "BOTH `change['gitlab-mr.approvedBy']` and `change.approvedBy`" guidance.
  - If incompatible, document an alternative read path here and update P3-T-07 inputs to match.
- **Acceptance criteria:**
  - A `tests/sync/mr-mixin-change-shape.test.ts` (or an inline addition to `tests/sync/mr.test.ts`) asserts the documented shape.
  - The comment at the head of `src/sync/mr.ts` lands in the same PR as P3-T-07 (or earlier).
  - `npm run build` exits 0.
- **Dependencies:** none (runs in parallel with P3-T-01 and P3-T-02 in Wave A). Output blocks P3-T-07.
- **Complexity:** S (≤ 80 LOC investigation + 1 test).

---

### P3-T-02 — vendor.d.ts spot-check (idempotent)

- **Owner:** Haiku
- **Inputs:**
  - `/Users/dingo/huly-gitlab/src/huly/vendor.d.ts` (Phase 2 P2-T-01b widened with `createMixin`/`updateMixin`).
  - `/Users/dingo/huly-gitlab/node_modules/@hcengineering/core/lib/index.d.ts` (authoritative real signatures).
- **Investigation step:**
  - Re-verify that `createMixin` and `updateMixin` signatures on `TxOperations` in the vendor file match the real platform declaration. Phase 3 does NOT introduce new mixin API needs beyond what Phase 2 already widened.
  - If a drift is detected (e.g. platform upgraded `@hcengineering/core`), document and widen accordingly; otherwise this task is a no-op confirmation.
- **Outputs (`src/huly/vendor.d.ts` only if drift):**
  - Adjustment to JSDoc + signatures as needed.
- **Acceptance criteria:**
  - `npx tsc --noEmit` exits 0 across the repo.
  - `grep -q "createMixin" src/huly/vendor.d.ts && grep -q "updateMixin" src/huly/vendor.d.ts` exits 0.
  - No new tests.
- **Dependencies:** none. Runs in parallel with P3-T-01 and P3-T-01b.
- **Complexity:** S (≤ 30 LOC if any change at all; usually 0 LOC).

---

### P3-T-03 — GitLabClient Review/Approval/Diff REST methods

- **Owner:** Sonnet
- **Inputs:**
  - `/Users/dingo/huly-gitlab/src/adapter/gitlab-client.ts` (Phase 1+2 patterns — `listMergeRequests`, `getMergeRequest`, `listMRNotes` to mirror exactly; the class ends at line 849; the private request helper sits near lines 339/395/410; the Link-header pagination helper sits near lines 660-700).
  - P3-T-01 types.
  - Spec §Adapter additions.
- **Outputs (modify `src/adapter/gitlab-client.ts`):**
  - **Refactor the private request helper to accept an optional `tokenOverride?: string` (C6).** `approveMR(projectId, mrIid, actorToken?)` and `unapproveMR(...)` pass `actorToken` down through the helper. When `tokenOverride` is set, the helper uses it in the `PRIVATE-TOKEN` header instead of the binding's stored token. Document the refactor in the helper's JSDoc.
  - Private `RawDiscussion`, `RawDiscussionNote`, `RawApproval`, `RawChange` interfaces; `mapDiscussion`, `mapApproval`, `mapChanges` translators (parallel to existing `mapMergeRequest` / `mapNote`).
  - **No separate `mr-diff.ts` module (C2):** diff URL + file-list parsing helpers live inline in adapter (`mapChanges`) and in `mr.ts` (mixin write). Spec §Architecture line 74 carries a placeholder that was inlined.
  - `listDiscussions(projectId, mrIid, opts?: { updatedAfter?: Date }): Promise<SyncReviewThread[]>` — paginated GET `/api/v4/projects/:id/merge_requests/:mrIid/discussions`. **Pagination reuses the existing Link-header helper used by `listMergeRequests` (C17) — no new pagination logic.** Filters to text-position discussions only (drops `position_type !== 'text'` with a `discussion.position.unsupported` log on each filtered row). For each discussion that survives, all notes within it are mapped to `SyncReviewNote[]` with `discussionId` set; non-line-anchored discussions (no `position` on the first note) are still included if the discussion is marked `resolvable: true` — these are general MR review threads (e.g. "summary" reviews). The caller (P3-T-06) handles both shapes.
  - `createDiscussion(projectId, mrIid, body: { body: string, position?: { ... } }): Promise<SyncReviewThread>` — POST `/api/v4/projects/:id/merge_requests/:mrIid/discussions`. Phase 3 callers do not yet POST line-anchored discussions from Huly (deferred); the method lands and is exercised by tests only.
  - `resolveDiscussion(projectId, mrIid, discussionId, resolved: boolean): Promise<void>` — PUT `/api/v4/projects/:id/merge_requests/:mrIid/discussions/:discussionId` with body `{ resolved }`. Used by P3-T-06 `applyLocal`.
  - `getMRApprovals(projectId, mrIid): Promise<SyncApproval>` — GET `/api/v4/projects/:id/merge_requests/:mrIid/approvals`. Maps `approved_by[]` → `SyncUser[]` reusing the existing `mapUser` helper. Sets `approvalsRequired` from `approvals_required` (default 0 if missing). **Q4 + C11 application: on 404, returns `{ mergeRequestIid: mrIid, approvedBy: [], approvalsRequired: 0 }` and increments `mr.composite.partial`. 5xx propagates as `GitLabApiError`.** (Covers legacy CE projects with no approval rule configured.)
  - `approveMR(projectId, mrIid, actorToken?: string): Promise<void>` — POST `/api/v4/projects/:id/merge_requests/:mrIid/approve`. Accepts an optional per-call `actorToken` override; when provided, the request uses that token in the `PRIVATE-TOKEN` header instead of the binding's service-account token (Q2 attribution). When omitted, uses the binding's stored token (service account) and logs `approval.action.fallback.service_account` at warn level. On non-2xx, throws `ApprovalActionError({ kind: 'approve', bindingId, mrIid, message })`.
  - `unapproveMR(projectId, mrIid, actorToken?: string): Promise<void>` — POST `/api/v4/projects/:id/merge_requests/:mrIid/unapprove`. Same attribution rule and error wrapping as `approveMR`.
  - `getMRChanges(projectId, mrIid): Promise<SyncMRChanges>` — GET `/api/v4/projects/:id/merge_requests/:mrIid/changes`. Maps to `{ diffWebUrl, changedFiles }` from response fields `web_url + '/diffs'` and `changes[]` (mapping `new_file`/`deleted_file`/`renamed_file` flags → status enum). **Q4 application: on 404, returns `{ changedFiles: [], diffWebUrl: ${webUrl}/diffs }` (use the MR's existing webUrl from the parent SyncMergeRequest when available; else empty string) and increments `mr.composite.partial`. 5xx propagates.**
  - **`getMergeRequest` extension:** the existing method (line 712) MUST be widened to populate the six new optional `SyncMergeRequest` fields (`reviewers` + 5 Phase 3 additions). Implementation: a single MR fetch chains `getMRApprovals` + `getMRChanges` calls (2 extra HTTP requests per MR fetch; document the cost in the JSDoc and the risk register). Failures on either auxiliary call degrade gracefully — `approvedBy` becomes `[]`, `approvalsRequired` becomes 0, `diffWebUrl` becomes the assembled fallback, `changedFiles` becomes `[]` — with `mr.composite.partial` metric increment per missing source.
  - **`listMergeRequests` extension:** the six Phase 3 optional fields are LEFT UNDEFINED (do NOT populate defaults; per B2 the consumer's applyRemote treats undefined as "not yet fetched"). Document this asymmetry in JSDoc explicitly: list returns minimal MR, per-MR get populates the optional fields. (No N+1 fan-out from list.)
- **Outputs (tests):** `tests/adapter/gitlab-client-review.test.ts` — nock-backed, ≥ 16 cases:
  1. `listDiscussions` happy path with pagination + only text-position discussions returned.
  2. `listDiscussions` filters `position_type='image'` rows; log emitted.
  3. `listDiscussions` includes resolvable general discussions (no position) when those exist.
  4. `createDiscussion` round-trip; response maps to `SyncReviewThread`.
  5. `resolveDiscussion(true)` sends `{ resolved: true }`; 200 → success.
  6. `resolveDiscussion(false)` sends `{ resolved: false }`; 200 → success.
  7. `getMRApprovals` happy path; `approved_by[]` → `SyncUser[]`; `approvals_required` propagates.
  8. **`getMRApprovals` 404 → returns empty + `mr.composite.partial` increments (Q4, C11).**
  9. `approveMR` with `actorToken` uses the override token in the request header.
  10. `approveMR` without `actorToken` uses the service-account token AND emits `approval.action.fallback.service_account` warn log.
  11. `approveMR` on 403 throws `ApprovalActionError({ kind: 'approve', bindingId, mrIid, message: '... 403 ...' })`.
  12. `unapproveMR` analogous to (9)–(11).
  13. `getMRChanges` happy path maps `web_url` → `diffWebUrl` + `changes[]` → `changedFiles[]` with status enum mapping.
  14. **`getMRChanges` 404 → returns `{ changedFiles: [], diffWebUrl: '${webUrl}/diffs' }` + `mr.composite.partial` increments (Q4).**
  15. `getMergeRequest` (extended) composes `getMRApprovals` + `getMRChanges` results into `SyncMergeRequest`; one auxiliary failure (404) degrades gracefully + emits `mr.composite.partial`.
  16. `listMergeRequests` LEAVES new Phase 3 fields undefined and does NOT fire per-MR auxiliary requests (assert call count is 1; assert `result[0].approvedBy === undefined`).
- **Acceptance criteria:**
  - `npm test -- tests/adapter/gitlab-client-review.test.ts` passes all 16 cases.
  - `npm run lint -- src/adapter/gitlab-client.ts tests/adapter/gitlab-client-review.test.ts` exits 0.
  - No `any` introduced.
  - Existing `tests/adapter/gitlab-client-mr.test.ts` from Phase 2 continues to pass with the extended `SyncMergeRequest` shape (optional Phase 3 fields left undefined; existing assertions unchanged).
- **Dependencies:** P3-T-01.
- **Complexity:** L (~1200 LOC including fixtures and the existing-test fixup and helper refactor).

---

### P3-T-04 — State Enum Widening (idmap `'review_thread'`, cursors `'reviews'`)

- **Owner:** Haiku
- **Inputs:**
  - `/Users/dingo/huly-gitlab/src/state/idmap.ts` (Phase 1+2 — `GitlabKind` union now includes `'merge_request' | 'pipeline'`).
  - `/Users/dingo/huly-gitlab/src/state/cursors.ts` (Phase 1+2 — `CursorKind` includes `'merge_requests' | 'pipelines'`).
  - `/Users/dingo/huly-gitlab/src/state/store.test.ts` (existing combined state test file).
- **Outputs (modify):**
  - `src/state/idmap.ts` — widen `GitlabKind` to add `'review_thread'`. JSDoc: "Phase 3 widening. The `review_thread` kind stores `(workspaceUuid, 'review_thread', '${discussionId}:${noteId}') ↔ ('chunter.class.ChatMessage', noteRef)` — **per-note compound key (Q1 resolution).** Every note in a thread is its own idmap row, sharing `discussionId` but distinct `noteId`."
  - `src/state/cursors.ts` — widen `CursorKind` to add `'reviews'`.
  - Update the JSDoc kind contract at the top of `idmap.ts` to mention Wave C/D consumers (`P3-T-06`, `P3-T-08`).
- **Outputs (tests):** extend `src/state/store.test.ts`:
  - Upsert + lookup with `kind: 'review_thread'` and a `${discussionId}:${noteId}` compound `gitlabId`.
  - Cursor set + get for `'reviews'`.
  - Migration note test: explicit comment documenting enum-only widening; no data migration.
- **Acceptance criteria:**
  - `npm test -- src/state/store.test.ts` passes including the 2 new cases.
  - `npm run build` exits 0 across the whole repo.
  - `npm run lint -- src/state` exits 0.
- **Dependencies:** P3-T-01.
- **Complexity:** S (~60 LOC including new test cases).

---

### P3-T-05 — Mixin Schema Extensions (`mr-mixin.ts` + new `mr-review-mixin.ts`)

- **Owner:** Sonnet
- **Inputs:**
  - `/Users/dingo/huly-gitlab/src/sync/mr-mixin.ts` (Phase 2 — `MRMixinDoc` has `sourceBranch`, `targetBranch`, `draft`, `mergedAt`, `mergeStatus`, `webUrl`, `gitlabIid`, `gitlabProjectId`).
  - P3-T-01 types.
  - Spec §Architecture (mixin field deltas).
- **Outputs (modify `src/sync/mr-mixin.ts`):**
  - Extend `MRMixinDoc` with: `reviewers: PersonUuid[]`, `approvedBy: PersonUuid[]`, `approvalsRequired: number`, `approvalStatus: 'pending' | 'approved' | 'changes_requested'`, `diffWebUrl: string`, `changedFiles: SyncChangedFile[]`.
  - Add module-level JSDoc declaring the field-ownership partition:
    - `MergeRequestsSyncManager` (P3-T-07) writes: `sourceBranch | targetBranch | draft | mergedAt | mergeStatus | webUrl | reviewers | approvedBy | approvalsRequired | approvalStatus | diffWebUrl | changedFiles`.
    - `PipelineSyncManager` (Phase 2) writes ONLY: `pipelineStatus`.
    - `ReviewThreadsSyncManager` (P3-T-06) writes NONE of the `gitlab-mr` fields — it owns `gitlab-review`.
    - "If a future task needs to add a field touched by more than one manager, split it into a new mixin."
- **Outputs (new file `src/sync/mr-review-mixin.ts`):**
  ```ts
  import type { Mixin, PersonUuid, Ref } from '@hcengineering/core'
  import type { ChatMessage } from '@hcengineering/chunter'
  import type { SyncReviewPosition } from '../adapter/types'

  /**
   * Per-note mixin (Q1 resolution): every ChatMessage in a thread carries this mixin.
   *   - threadId / resolved / resolvedBy / resolvedAt are REPLICATED across all notes in a thread.
   *   - position is set ONLY on the first note (the discussion root); replies have position: null.
   * LWW reconciliation across notes uses max(resolvedAt) to derive thread-level state.
   * resolvedAt is stored as number (ms since epoch) to match Huly platform convention for modifiedOn (C7).
   */
  export interface MRReviewMixinDoc extends ChatMessage {
    threadId: string                       // GitLab discussion_id (replicated per note)
    resolved: boolean                      // replicated per note
    resolvedBy: PersonUuid | null          // replicated per note
    resolvedAt: number | null              // ms since epoch (Huly convention); replicated per note
    position: SyncReviewPosition | null    // null for general (non-line) review threads AND for non-root notes
  }

  /** Runtime mixin id carrying GitLab review-thread fields on a chunter.ChatMessage. */
  export const MR_REVIEW_MIXIN = 'gitlab-review' as unknown as Ref<Mixin<MRReviewMixinDoc>>
  ```
  Module JSDoc documents that the mixin is runtime-only (no model registration, mirrors the Phase 2 Path A approach) and that `ReviewThreadsSyncManager` owns all writes. The per-note storage shape and `resolvedAt: number` convention (C7) are called out.
- **Acceptance criteria:**
  - `npm run build` exits 0.
  - `npm run lint -- src/sync/mr-mixin.ts src/sync/mr-review-mixin.ts` exits 0.
  - `grep -q "MR_REVIEW_MIXIN" src/sync/mr-review-mixin.ts && grep -q "reviewers" src/sync/mr-mixin.ts && grep -q "approvalStatus" src/sync/mr-mixin.ts` exits 0.
  - No tests required — pure type additions.
- **Dependencies:** P3-T-01.
- **Complexity:** S (~140 LOC across both files + JSDoc).

---

### P3-T-06 — ReviewThreadsSyncManager (new file `src/sync/mr-review.ts`)

- **Owner:** Opus
- **Inputs:**
  - `/Users/dingo/huly-gitlab/src/sync/notes.ts` (Phase 1+2 reference — the closest analogue; `ChatMessage` write path, deferred parent resolution, author resolution).
  - `/Users/dingo/huly-gitlab/src/sync/mr.ts` (Phase 2 reference — mixin-write shape, idmap upsert flow, cursor set).
  - P3-T-01 types, P3-T-04 state widening, P3-T-05 mixin schema.
  - Spec §Sync managers (`ReviewThreadsSyncManager`).
- **Outputs (new file `src/sync/mr-review.ts`):**
  - `ReviewThreadsSyncManager implements SyncManager<SyncReviewThread>`:
    - `kind = 'review'`.
    - `resourceKey(record)`: returns `'review:${discussionId}'`. Accepts both flat `SyncReviewThread` shape and webhook envelopes carrying `record.discussionId` OR `record.object_attributes.discussion_id`.
    - `applyRemote(ctx, binding, syncThread)` — **Q1 per-note storage applied throughout:**
      1. Resolve parent MR via `findByGitlab(ctx.store.idmap(), bctx.workspaceUuid, 'merge_request', "${projectId}:${mrIid}")`. If missing → defer-retry-once pattern (mirrors NotesSyncManager); after retry expiry, drop with `review.parent.missing` metric. This is also the confidential-MR defense layer (carried forward from Phase 2 critic B3 — confidential MRs never enter idmap, so their review threads drop).
      2. Identify the discussion root: the first note in `syncThread.notes` ordered by `createdAt` (or `id` ascending as tiebreaker). Only this root note carries `position` (Q1).
      3. For each note in `syncThread.notes`:
         - Resolve author via `bctx.userIdentity.mapByGitlabUser` / `ensureStubGuest` (same path as NotesSyncManager).
         - Markdown round-trip the body via `gfmMarkdownToMarkup` with refUrl pointing to `/-/merge_requests` (NOT `/-/issues`).
         - Look up existing `chunter.class.ChatMessage` via `findByGitlab(ctx.store.idmap(), ws, 'review_thread', "${discussionId}:${noteId}")` — note the COMPOUND key (`discussionId:noteId`) so multiple notes share the thread but each is its own ChatMessage row in idmap.
         - If missing → `bctx.hulyClient.createDoc<ChatMessage>(...)` attached to the parent MR-mirror Huly Issue (resolved in step 1).
         - If present → `updateDoc` with per-field LWW on `message` vs `hulyMessage.modifiedOn`.
         - **Apply the `gitlab-review` mixin via `createMixin` (first encounter) or `updateMixin` (subsequent) on EVERY note (Q1).** Fields:
           - `threadId: syncThread.discussionId` (replicated across all notes)
           - `resolved: syncThread.resolved` (replicated across all notes)
           - `resolvedBy: resolvedByUuid` (replicated)
           - `resolvedAt: parsedDate?.getTime() ?? null` (replicated; **stored as number ms since epoch, C7**)
           - `position: isRoot ? (rootNote.position ?? null) : null` (set ONLY on root; replies have null)
         - Upsert idmap with kind `'review_thread'`, gitlabId `"${syncThread.discussionId}:${note.id}"`, hulyClass `'chunter.class.ChatMessage'`, hulyRef.
      4. **Bulk per-field LWW on the mixin's `resolved`/`resolvedBy`/`resolvedAt`:** when a thread's `resolved` flips on GitLab, the mixin update for ALL notes in the thread gets the new state (replicated). Compare `syncThread.resolvedAt` vs the existing mixin's `resolvedAt` on each note; remote wins when newer; equal-or-missing falls back to LWW-by-thread-updated-at vs `chatMessage.modifiedOn`. Cross-note reconciliation uses `max(resolvedAt)` to derive thread-level state in case of drift.
      5. Set cursor (`kind: 'reviews'`) to the latest `note.updatedAt` across the thread.
    - `applyLocal(ctx, binding, doc, change)`:
      1. Resolve mapping via `findByHuly(idmap, ws, 'chunter.class.ChatMessage', hulyRef)` with kind filter narrowed to `'review_thread'` (additional guard: if `mapping.gitlabKind !== 'review_thread'`, this is a non-review note — return and let the existing NotesSyncManager `applyLocal` handle it; this lets the same ChatMessage class be routed by kind).
      2. If `change[MR_REVIEW_MIXIN].resolved` (use the verified shape from P3-T-01b) flips true OR `change.resolved === true` → call `bctx.gitlabClient.resolveDiscussion(projectId, mrIid, discussionId, true)`.
      3. If flips false → `resolveDiscussion(..., false)`.
      4. Body edits are NOT re-routed here — the existing `NotesSyncManager.applyLocal` covers body changes on any ChatMessage (its lookup matches the ChatMessage class regardless of which mixin is applied; route disambiguation lives on the `change` payload, see P3-T-08).
      5. Set cursor (`kind: 'reviews'`) to `new Date()`.
    - `backfill(ctx, binding, since)`:
      1. List all mirrored MRs via `bctx.gitlabClient.listMergeRequests(projectId, { updatedAfter: since })`.
      2. For each MR, call `bctx.gitlabClient.listDiscussions(projectId, mr.iid, { updatedAfter: since })`.
      3. Enqueue each thread as a `'review'` envelope via `this.deps.backfillEnqueuer`.
      4. Document the 4→5-listings-per-binding-per-cycle cost (issues + notes + MRs + reviews; Phase 2 had 4). Add to risk register P3-R3.
  - Surface a `MRReviewBindingContext` similar to Phase 2's `MRBindingContext` exposing `gitlabClient` (typed to a NEW `MRReviewGitLabClient` interface with the 7 methods from P3-T-03), `hulyClient`, `userIdentity`, `workspaceUuid`, `gitlabProjectId`, `gitlabProjectPath`, `gitlabBaseUrl`, `hulyProjectRef`. **`MRReviewBindingContext` does NOT include `credentials` — only MR manager needs it (B4).**
- **Outputs (tests):** `tests/sync/mr-review.test.ts` — ≥ 15 cases:
  1. `applyRemote` creates a thread on a known MR — root ChatMessage + mixin populated with `threadId`, `resolved=false`, `position` set on root.
  2. **`applyRemote` adds a reply to an existing thread — second ChatMessage attached, BOTH have the mixin, both share `threadId`, ONLY root has `position` (Q1). Distinct idmap entries asserted: `findByGitlab(... 'review_thread', '${discussionId}:${noteId1}')` AND `... '${discussionId}:${noteId2}'` both resolve to separate ChatMessage refs.**
  3. **`applyRemote` on resolved thread bulk-updates mixin `resolved=true`, `resolvedBy`, `resolvedAt` across ALL notes (Q1 bulk update; verify both root + reply mixin fields). `resolvedAt` is a number, not a string (C7).**
  4. `applyRemote` on a thread for an unmapped MR → deferred retry; second attempt with parent present succeeds.
  5. `applyRemote` on a thread for an MR that never appears → drops after retry expiry; `review.parent.missing` metric increments.
  6. `applyRemote` skips notes with `position_type !== 'text'` (defense-in-depth — adapter already filters, this is belt-and-suspenders).
  7. LWW on `resolved`: remote `resolvedAt` newer than local mixin → remote wins (assert across all replicas in the thread).
  8. LWW on `resolved`: local `resolved=true` set later than remote `resolved=false` → local wins (manager skips the mixin update for that field).
  9. `applyLocal` with `change.resolved=true` calls `resolveDiscussion(..., true)` once.
  10. `applyLocal` with `change.resolved=false` calls `resolveDiscussion(..., false)` once.
  11. `applyLocal` on a non-review ChatMessage (different `gitlabKind`) returns without calling resolveDiscussion (route guard).
  12. `backfill` lists MRs then discussions; each thread enqueued; assert call shape.
  13. Markdown round-trip on review note body uses `/-/merge_requests` refUrl (NOT `/-/issues`).
  14. **3-note thread with mid-note resolution: resolving via 2nd note's mixin flip propagates LWW correctly across notes 1 + 3 (cross-note reconciliation).**
  15. **`resolvedAt` round-trip is number-not-string (C7 explicit).**
- **Acceptance criteria:**
  - `npm test -- tests/sync/mr-review.test.ts` passes all 15 cases.
  - `npm run lint -- src/sync/mr-review.ts` exits 0.
  - No regression in `tests/sync/notes.test.ts`, `tests/sync/mr.test.ts`.
- **Dependencies:** P3-T-01, P3-T-03, P3-T-04, P3-T-05.
- **Complexity:** L (~1400 LOC including tests and fakes).

---

### P3-T-07 — MergeRequestsSyncManager extensions (typed reviewers, approvals two-way, diff metadata)

- **Owner:** Opus
- **Inputs:**
  - `/Users/dingo/huly-gitlab/src/sync/mr.ts` (Phase 2 — the file being extended; `applyRemote` writes the mixin, `applyLocal` does NOT call `createMergeRequest`).
  - `/Users/dingo/huly-gitlab/src/sync/mr-mixin.ts` (P3-T-05 extended `MRMixinDoc`).
  - P3-T-03 adapter (extended `getMergeRequest`, `approveMR`, `unapproveMR`).
  - **P3-T-01b verified mixin-change-payload shape (BLOCKS this task).**
  - Spec §Architecture (MergeRequestsSyncManager extension).
- **Outputs (modify `src/sync/mr.ts`):**
  - **Typed reviewers in `applyRemote`:**
    - Remove the `resolveReviewerLabels` synthetic-label projection (lines ~520–531 in the current file). Drop the call site (lines ~200, `reviewerLabels`).
    - Add `resolveReviewers(syncMR.reviewers, bctx.userIdentity): Promise<PersonUuid[]>` — for each reviewer, call `userIdentity.mapByGitlabUser` (fall back to `ensureStubGuest` mirroring assignee resolution). Returns ordered array preserving GitLab's reviewer order (deterministic for tests). **Guard: if `syncMR.reviewers === undefined` (B2 — not yet fetched), skip writing the field; do NOT clear to `[]`.**
    - Add to `buildMixinCreateData` and `buildMixinUpdateData` the new fields: `reviewers`, `approvedBy`, `approvalsRequired`, `approvalStatus`, `diffWebUrl`, `changedFiles`. **Every Phase 3 field is conditionally written: `if (syncMR.fieldX !== undefined) data.fieldX = computed` — B2 contract.** Compute `approvalStatus` as: `approvedBy.length >= approvalsRequired && approvalsRequired > 0 ? 'approved' : 'pending'` (spec §Open Questions #2 default; document the `approvalsRequired === 0 → 'pending'` rule in JSDoc).
  - **`approvedBy` resolution:** `resolveApprovedBy(syncMR.approvedBy, bctx.userIdentity): Promise<PersonUuid[]>` — same pattern as `resolveReviewers`. Same undefined-guard.
  - **Per-field LWW on mixin-carried fields:** existing v2 code always overwrites the mixin (remote-wins). Phase 3 keeps that for GitLab-authoritative fields (`sourceBranch | targetBranch | draft | mergedAt | mergeStatus | webUrl | diffWebUrl | changedFiles | approvalsRequired`) BUT adds proper per-field LWW for `approvedBy` and `reviewers` (these can be edited from Huly via the approval action path; remote-wins-always would clobber a just-pressed Huly approval before the GitLab webhook returns):
    - Read existing mixin via `bctx.hulyClient.findOne(tracker.class.Issue, { _id: issueRef })` + the platform mixin accessor.
    - For `approvedBy`, compare the set against existing; if remote is a strict superset/subset OR `remoteTs > localMixinTs`, take remote.
    - **NEW (C10) — concurrent local approval / remote webhook race defense:** when `applyRemote` writes `approvedBy`, compare against current mixin value; if local has MORE entries than remote AND local entry presence is within a 30-second window of the current time (suspect race with an in-flight `approveMR` round-trip), KEEP local entries. See P3-R6.
    - For `reviewers`, take remote (GitLab-authoritative — users add reviewers on GitLab, not Huly).
  - **`applyLocal` extension — approval actions (NEW for Phase 3):**
    - After existing field translation (title, description, labels, milestone, assignees, status), check the verified-shape access key from P3-T-01b for `approvedBy`:
      - Build current set from existing mixin's `approvedBy` (read via `findOne` + mixin accessor).
      - Build incoming set from the verified change-payload access expression.
      - Added users → for each, call `bctx.gitlabClient.approveMR(projectId, iid, actorToken)` where `actorToken` is resolved via `bctx.credentials.resolveActorToken(workspaceUuid, addedUserUuid)` returning the user's per-user OAuth token if stored, else `undefined` (triggering the service-account fallback in the adapter with warn log).
      - Removed users → for each, call `bctx.gitlabClient.unapproveMR(projectId, iid, actorToken)`.
      - On `ApprovalActionError`: post a ChatMessage to the parent Issue with body `"approval failed: ${err.kind} — ${err.message}"` (spec §Error Handling). Use the existing `chunter.class.ChatMessage` pattern with author = the binding's bot user (resolved via `bctx.userIdentity.getBotUuid()`). Surface the error to the caller with `throw` AFTER posting the comment, so the engine's retry logic also fires.
    - Phase 2 scope cut (no `createMergeRequest` from `applyLocal`) **STILL HOLDS** in Phase 3. The new approval action handling DOES NOT extend to MR creation; the `if (mapping === null) return` guard remains.
  - **`MRBindingContext` extension (B4):** add `credentials: { resolveActorToken: (workspaceUuid: WorkspaceUuid, hulyPersonUuid: PersonUuid) => Promise<string | undefined> }`. Phase 3 stub returns `undefined` (no UI for users to self-link); all approvals fall back to service-account with warn log (Q2). Real stub implementation lands in P3-T-10's `BindingLoader.load{ForIssues,ForMergeRequests}` return. Document that `MRBindingContext.credentials` is NOT mirrored on `MRReviewBindingContext` (review manager doesn't need it).
  - **`MRGitLabClient` interface extension:** add `approveMR`, `unapproveMR`, `getMRApprovals`, `getMRChanges` from P3-T-03 to the interface (the real `GitLabClient` already implements them; the widening forces test fakes to implement them too).
- **Outputs (tests):** extend `tests/sync/mr.test.ts` — ≥ 12 new cases:
  1. `applyRemote` populates typed `reviewers` field (PersonUuid[]) — NO synthetic `gitlab:reviewer:*` labels created (regression vs Phase 2 case 16; the old assertion is INVERTED: expect zero such labels).
  2. `applyRemote` populates `approvedBy`, `approvalsRequired`, `approvalStatus='approved'` when approvedBy meets the threshold.
  3. `applyRemote` populates `approvalStatus='pending'` when `approvalsRequired=0` (spec §Open Questions #2).
  4. `applyRemote` populates `diffWebUrl` + `changedFiles` from the composite fetch.
  5. **`applyRemote` with `syncMR.reviewers === undefined` (B2 — from listMergeRequests intermediate state) DOES NOT clear the mixin's existing `reviewers`. Pre-seed mixin with 2 reviewers; run applyRemote with undefined; assert mixin still has 2.**
  6. `applyLocal` adds a user to `approvedBy` → calls `approveMR(projectId, iid, actorToken)` once with the per-user OAuth token when present.
  7. `applyLocal` adds a user with no stored OAuth → calls `approveMR(projectId, iid, undefined)` (service-account fallback path); adapter emits the fallback log (asserted via adapter spy).
  8. `applyLocal` removes a user from `approvedBy` → calls `unapproveMR` once.
  9. `applyLocal` on `ApprovalActionError` posts a ChatMessage with "approval failed" to the parent Issue AND throws to engine.
  10. **Field-ownership regression:** `applyRemote` does NOT touch `pipelineStatus` (Phase 2 critic C2 preserved); pre-seed mixin with `pipelineStatus='success'`, run `applyRemote`, assert unchanged.
  11. **`applyLocal` does NOT call `createMergeRequest`** (Phase 2 scope cut regression; explicit zero-call assertion).
  12. **Concurrent-approval race (C10, P3-R6):** local has 2 entries in `approvedBy` set within last 10s; remote arrives with 1 entry (stale state); applyRemote KEEPS local entries.
- **Acceptance criteria:**
  - `npm test -- tests/sync/mr.test.ts` passes all existing 16 cases + the 12 new ones.
  - The Phase 2 case 16 (reviewers → labels) is REPLACED by the new case 1 (typed reviewers); the line-count delta is documented in the PR description.
  - `npm run lint -- src/sync/mr.ts` exits 0.
- **Dependencies:** P3-T-01, P3-T-01b, P3-T-03, P3-T-05.
- **Complexity:** L (~1200 LOC including new code + extended tests).

---

### P3-T-08 — NotesSyncManager line-position routing extension

- **Owner:** Sonnet
- **Inputs:**
  - `/Users/dingo/huly-gitlab/src/sync/notes.ts` (Phase 1+2 — extending; `parseWebhookPayload` at line 39, `applyRemote` at line 261, `applyLocal` at line 392).
  - P3-T-06 `ReviewThreadsSyncManager` (line-position notes route to it via re-enqueue).
  - Spec §NotesSyncManager extension.
- **Outputs (modify `src/sync/notes.ts`):**
  - **Extend `parseWebhookPayload`:** detect `payload.object_attributes.position`:
    - If present AND `payload.object_attributes.noteable_type === 'MergeRequest'` → return a tagged envelope `{ noteableIid, note, isReview: true, position, discussionId: payload.object_attributes.discussion_id }`. Drop the note with `review.position.malformed` warn log + return undefined when ANY of `head_sha`, `base_sha`, `start_sha` is missing (spec §Error Handling: "Line comment with malformed position: log warn, drop the note, do NOT create the thread").
    - Otherwise existing behavior.
  - **Extend `applyRemote`:** at the top of the method, after `parsed = parseWebhookPayload(rawRecord)`, check `parsed.isReview === true`:
    - If true → re-enqueue the record with kind `'review'` via `this.deps.backfillEnqueuer` (or `enqueuer.enqueueBackfillRecord`), passing through a `SyncReviewThread`-shaped envelope: `{ discussionId, mergeRequestIid: noteableIid, projectId: bctx.gitlabProjectId, resolved: ${parsed.note.resolved ?? false}, resolvedBy: ..., resolvedAt: ..., notes: [parsed.note + position] }`. **Preserve the existing `_noteRetried` flag through the re-enqueue (C14) — if the original note had `_noteRetried = true` from a deferred parent lookup, propagate it onto the review envelope so the retried review processing doesn't re-defer indefinitely.** Return.
    - Otherwise existing behavior.
  - **Extend `applyLocal`:** when the change carries a `change.kind === 'review'` discriminator (set by the engine when dispatching review-thread changes) OR when the resolved idmap mapping has `gitlabKind === 'review_thread'`, return immediately so `ReviewThreadsSyncManager.applyLocal` handles it. **Special case for body+resolution flip simultaneously (C13): the existing notes path handles body update (since the change includes body delta), AND `ReviewThreadsSyncManager.applyLocal` handles resolution flip independently — both paths execute correctly when both deltas arrive in the same change.** Existing non-review note routing is unchanged.
  - **Engine wiring impact:** P3-T-10 registers `ReviewThreadsSyncManager` under kind `'review'`; this task only re-enqueues with the new kind. No engine internals change. **Document explicitly (C9): unit tests in P3-T-08 assert the enqueue CALL SHAPE only; live engine wiring (kind 'review' registration) lands in P3-T-10.**
  - **Suggestion comments passthrough (C3):** suggestion blocks (`<<<<<<< SUGGEST`) in line comments pass through as raw markdown. No interpretation, no UI affordance in Phase 3.
  - **(Important) `noteableType` defaulting (Phase 2 critic C1) remains:** review-routed records still carry `noteableType: 'MergeRequest'` for downstream sanity even though they fork off before the NotesSyncManager flow finishes.
- **Outputs (tests):** extend `tests/sync/notes.test.ts` — ≥ 7 new cases:
  1. `parseWebhookPayload` with `position` field set returns the tagged review envelope.
  2. `parseWebhookPayload` with `position` missing one of `head_sha`/`base_sha`/`start_sha` returns undefined; `review.position.malformed` warn log captured.
  3. `applyRemote` on a tagged review envelope re-enqueues with kind `'review'`; existing ChatMessage creation path is NOT triggered for that record.
  4. `applyRemote` on a non-position MR note still creates a flat ChatMessage (regression vs Phase 2).
  5. `applyLocal` on a change with `kind === 'review'` returns without calling any GitLab note API (route guard).
  6. **Body edit + resolved flip in same change (C13): both paths execute correctly — NotesSyncManager updates the body delta; ReviewThreadsSyncManager's applyLocal handles the resolution flip independently. Assert both side-effects.**
  7. **`_noteRetried` flag survival (C14): position-bearing note arrives BEFORE parent MR is in idmap → deferred via `_noteRetried` in NotesSyncManager → retried after MR sync → routed to review path with `_noteRetried` preserved (not re-deferred indefinitely).**
  8. **Suggestion comment passthrough (C3): position-bearing note with `<<<<<<< SUGGEST` markup → ChatMessage body matches verbatim.**
- **Acceptance criteria:**
  - `npm test -- tests/sync/notes.test.ts` passes all existing + new cases.
  - `npm run lint -- src/sync/notes.ts` exits 0.
  - All Phase 1+2 note tests (issue notes, general MR notes, system note skip) continue to pass.
- **Dependencies:** P3-T-06.
- **Complexity:** M (~520 LOC including new code + tests).

---

### P3-T-09 — Reviewer-label migration helper (`src/sync/reviewer-migration.ts`)

**v2 DAG change (C8): MOVED to Wave C, parallel with P3-T-07. Depends only on P3-T-05 mixin schema + Phase 2 LabelCache.**

- **Owner:** Sonnet
- **Inputs:**
  - `/Users/dingo/huly-gitlab/src/sync/mr-mixin.ts` (P3-T-05 extended — `MRMixinDoc.reviewers` field is now defined).
  - `/Users/dingo/huly-gitlab/src/sync/label-cache.ts` (Phase 1+2 — for the label lookup pattern).
  - `/Users/dingo/huly-gitlab/src/state/idmap.ts` (for `findAll('merge_request', ...)` enumeration).
  - `/Users/dingo/huly-gitlab/node_modules/@hcengineering/tracker/lib/index.d.ts` (authoritative for `Issue.labels: Array<Ref<TagElement>>`).
  - `/Users/dingo/huly-gitlab/node_modules/@hcengineering/tags/lib/index.d.ts` (authoritative for `TagElement` shape).
  - Spec §Reviewer migration endpoint.
- **Outputs (new file `src/sync/reviewer-migration.ts`):**
  - `interface MigrationResult { migratedAt: string, mrsScanned: number, labelsStripped: number, reviewersResolved: number, unresolvedCount: number }`.
  - `interface ReviewerMigrationDeps { hulyClient: TxOperations, userIdentity: UserIdentity, idmap: Collection<IdMapEntry>, workspaceUuid: WorkspaceUuid, hulyProjectRef: Ref<Space>, logger: Logger }`.
  - `async function migrateReviewerLabels(deps: ReviewerMigrationDeps, bindingProjectId: number): Promise<MigrationResult>`:
    1. Find all idmap entries with `workspaceUuid`, `gitlabKind === 'merge_request'` whose `gitlabId` starts with `"${bindingProjectId}:"` — these are the MRs mirrored under this binding. **C15: This filter is also the multi-tenant isolation guarantee — migration affects only the named binding by construction; no cross-binding leakage possible.**
    2. For each MR-mirror Issue ref, `findOne(tracker.class.Issue, { _id })` to fetch the current Issue.
    3. **Correctly read Issue's labels as refs (C4):**
       1. Read Issue's `labels` field — `Array<Ref<TagElement>>` (NOT pre-resolved docs).
       2. `findAll(tags.class.TagElement, { _id: { $in: hulyIssue.labels } })` to resolve the refs to label docs.
       3. Filter the resolved docs by `title.startsWith('gitlab:reviewer:')`.
       4. Compute `matchedRefs = Set<Ref<TagElement>>` from the filtered docs.
       5. New Issue `labels` value: `hulyIssue.labels.filter(r => !matchedRefs.has(r))`.
       6. Update mixin `reviewers: dedupedList` (dedup by PersonUuid).
    4. For each matching label resolved through the pipeline above:
       - Parse username = `label.title.slice('gitlab:reviewer:'.length)`.
       - Resolve PersonUuid via `userIdentity.mapByGitlabUser({ gitlabId: '', username })` (the GitLab user lookup falls back to username when gitlabId is empty — verify by reading `users.ts`; if not supported, use `lookupByUsername` directly).
       - If resolved → append PersonUuid to the dedupedList for this Issue.
       - If unresolved (no PersonUuid) → increment `unresolvedCount`, leave the label in place (NOT stripped — so `matchedRefs` excludes its ref), log `migration.reviewer.unresolved` with username.
    5. After resolving all labels for an Issue, write:
       - `updateMixin(issueRef, tracker.class.Issue, hulyProjectRef, MR_MIXIN, { reviewers: dedupedList })` — preserves existing typed reviewers (merge + dedup).
       - `updateDoc(tracker.class.Issue, hulyProjectRef, issueRef, { labels: newLabelsArray })` from step 3.5.
       - Increment `labelsStripped`, `reviewersResolved` counters.
    6. Per-MR failures are caught and logged; do not abort the migration. `mrsScanned` always increments.
    7. Idempotent: re-running over an already-migrated MR finds zero matching labels and processes nothing.
    8. Return `MigrationResult`.
- **Outputs (tests):** `tests/sync/reviewer-migration.test.ts` — ≥ 8 cases:
  1. Happy path: 2 MRs with 2 reviewer labels each → 4 labelsStripped, 4 reviewersResolved, 0 unresolvedCount.
  2. Mixed: 1 MR with 2 labels, 1 reviewer resolvable, 1 not → 1 stripped, 1 resolved, 1 unresolvedCount; the unresolvable label is preserved.
  3. Idempotency: run twice → second run reports `labelsStripped: 0, reviewersResolved: 0, mrsScanned: ${same as first}`.
  4. PersonUuid dedup: same reviewer label appearing twice on one Issue → dedup to a single entry in `reviewers`.
  5. Per-MR failure isolation: one MR throws on findOne → counted as scanned, others complete; error logged.
  6. Empty binding (no MRs) → returns `{ mrsScanned: 0, ... }` without throwing.
  7. Pre-existing `reviewers` field is preserved: an MR with 1 existing typed reviewer + 1 migrated label-derived reviewer → final list has both (dedupe respected).
  8. **Multi-binding isolation (C12): workspace with TWO bindings, each with mirrored MRs and `gitlab:reviewer:*` labels. Run `migrateReviewerLabels` for binding-1 ONLY → binding-2's MRs untouched (labels remain on binding-2's Issues; their mixin `reviewers` unchanged).**
- **Acceptance criteria:**
  - `npm test -- tests/sync/reviewer-migration.test.ts` passes all 8 cases.
  - `npm run lint -- src/sync/reviewer-migration.ts` exits 0.
  - The C4 label-as-refs handling is asserted in tests 1, 2, 4 (each test fixtures `Issue.labels: Ref<TagElement>[]` and the corresponding `TagElement` docs).
  - No regression in Phase 2 reviewer-label E2E (Phase 2 E2E case 8 — synthetic-label expectation — must be updated to assert the typed `reviewers` field after migration; the unmigrated path still produces labels via Phase 2 code at binding-bootstrap, but the bootstrap path goes away in P3-T-07).
- **Dependencies:** P3-T-05 (mixin schema only — DAG correction C8).
- **Complexity:** M (~580 LOC including tests).

---

### P3-T-10 — HTTP admin route + PATCH disable toggle + Binding loader + Lifecycle wiring + Engine registration

- **Owner:** Sonnet
- **Inputs:**
  - `/Users/dingo/huly-gitlab/src/http/binding.ts` (Phase 2 — already has `re-register-webhook` at line 197; new route + PATCH toggle land here).
  - `/Users/dingo/huly-gitlab/src/sync/binding-loader.ts` (Phase 2 — extend to wire credentials + ReviewThreadsSyncManager context).
  - `/Users/dingo/huly-gitlab/src/sync/binding-lifecycle.ts` (Phase 2 — no event-flag change required: MR Hook and Note Hook already subscribed).
  - `/Users/dingo/huly-gitlab/src/index.ts` (Phase 1+2 — register the new SyncManager under kind `'review'`).
  - Spec §Reviewer migration endpoint.
- **Outputs (modify):**
  - `src/http/binding.ts`:
    - **Add `PATCH /api/v1/bindings/:id` `{ disabled?: boolean }` (Q3 — operator-pause convention).** Bearer-protected, ObjectId-validated. Toggles `binding.disabled` in the store. Used as the operator pause for migration. Returns 200 with the updated binding.
    - Add `POST /api/v1/bindings/:id/migrate-reviewer-labels` (bearer-protected via existing `auth` middleware, ObjectId-validated):
      ```
      router.post('/api/v1/bindings/:id/migrate-reviewer-labels', auth, asyncHandler(async (req, res) => {
        const id = ObjectId.validate(req.params.id)
        const binding = await bindingsStore.findById(id)
        if (binding === null) return res.status(404).json({ error: 'binding not found' })
        if (binding.disabled !== true) {
          return res.status(409).json({
            error: 'binding active',
            message: 'Pause binding (PATCH /api/v1/bindings/:id with {disabled: true}) before running migration; re-enable after.'
          })
        }
        const ctx = await bindingLoader.load(binding)  // reuses cached loader
        const result = await migrateReviewerLabels({
          hulyClient: ctx.hulyClient,
          userIdentity: ctx.userIdentity,
          idmap: ctx.store.idmap(),
          workspaceUuid: ctx.workspaceUuid,
          hulyProjectRef: ctx.hulyProjectRef,
          logger
        }, binding.gitlabProjectId)
        logger.info('binding: reviewer label migration complete', { id, ...result })
        res.json(result)
      }))
      ```
    - Returns 401 without bearer (existing middleware), 404 unknown binding, 409 if `binding.disabled !== true`, 200 with `MigrationResult` body on success.
    - **ACL note (C15): The bearer is admin-global (matches Phase 2's `/re-register-webhook` ACL model). Migration affects only the named binding; no cross-binding leakage by construction (P3-T-09 step 1 filters idmap by `gitlabId.startsWith('${bindingProjectId}:')`). Multi-tenant ACL (per-workspace operator role) is Phase 4.**
  - `src/sync/binding-loader.ts`:
    - Extend `BindingContext` to include `credentials.resolveActorToken(workspaceUuid: WorkspaceUuid, hulyPersonUuid: PersonUuid): Promise<string | undefined>` (per Q2 — stub implementation that returns `undefined` until per-user OAuth tokens are stored).
    - Construct per-binding `gitlabClient` argument bundle that includes the new methods (`listDiscussions`, `createDiscussion`, `resolveDiscussion`, `getMRApprovals`, `approveMR`, `unapproveMR`, `getMRChanges`) — the real `GitLabClient` already implements them after P3-T-03; binding-loader's existing wiring passes the same instance to both `MergeRequestsSyncManager` and the new `ReviewThreadsSyncManager`.
    - **Wire `credentials.resolveActorToken` stub into `BindingLoader.loadForIssues` AND `BindingLoader.loadForMergeRequests` return values (B4). `MRBindingContext.credentials` is populated; `MRReviewBindingContext.credentials` is NOT (review manager doesn't need it).**
  - `src/sync/binding-lifecycle.ts`:
    - **No webhook subscription change** (spec §Webhook events confirms MR Hook and Note Hook already cover Phase 3 events). Add an explicit JSDoc note: "Phase 3 adds no new webhook events; approval state arrives on MR Hook; discussions arrive on Note Hook with `position` set."
    - Document in code comment that the existing `buildWebhookPayload` (Phase 2 shared helper) still hardcodes `confidential_*_events: false` — Phase 3 inherits without changes.
  - `src/index.ts`:
    - Register the new `ReviewThreadsSyncManager` under kind `'review'` in the engine's manager registry.
    - Mount the new admin route AND the PATCH toggle on the HTTP router.
- **Outputs (tests):**
  - Extend `tests/http/binding.test.ts` — ≥ 7 new cases:
    1. `POST /api/v1/bindings/:id/migrate-reviewer-labels` without bearer → 401.
    2. With unknown ObjectId → 404.
    3. With invalid id format → 400 (existing `ObjectId.validate` behavior).
    4. **With `binding.disabled !== true` → 409 with the operator-pause message (Q3).**
    5. **Happy path (binding paused first): `PATCH /api/v1/bindings/:id` with `{disabled: true}` returns 200; subsequent POST migrate returns 200 with `MigrationResult`.**
    6. **PATCH bearer rejection: without bearer → 401.**
    7. PATCH unknown ObjectId → 404.
  - Extend `tests/sync/binding-loader.test.ts` — ≥ 2 new cases:
    1. Loaded context exposes `credentials.resolveActorToken` (callable with workspaceUuid + PersonUuid; returns `undefined` for unmapped users — Phase 3 stub).
    2. The same `gitlabClient` instance is wired into both MR and review manager contexts (assert identity).
  - Extend `tests/sync/binding-lifecycle.test.ts` — ≥ 1 new case:
    1. New binding registration still includes exactly the 4 Phase 2 event flags (`issues_events, note_events, merge_requests_events, pipeline_events`) and confidentiality posture preserved — regression check.
- **Acceptance criteria:**
  - `npm test -- tests/http/binding.test.ts tests/sync/binding-loader.test.ts tests/sync/binding-lifecycle.test.ts` passes.
  - `npm run build` exits 0.
  - `npm run lint -- src/sync src/http src/index.ts` exits 0.
  - `grep -q "migrate-reviewer-labels" src/http/binding.ts && grep -q "ReviewThreadsSyncManager" src/index.ts && grep -q "PATCH.*bindings/:id" src/http/binding.ts` exits 0.
- **Dependencies:** P3-T-06, P3-T-07, P3-T-09.
- **Complexity:** M (~560 LOC including PATCH route + tests).

---

### P3-T-11 — E2E Harness Extension (synthetic-webhook for discussions)

- **Owner:** Opus
- **Inputs:**
  - `/Users/dingo/huly-gitlab/tests/e2e/setup.ts` (Phase 1+2 — extending).
  - `/Users/dingo/huly-gitlab/tests/e2e/mr.e2e.test.ts` (Phase 2 — pattern reference; case 8 reviewer-label assertion updated below).
  - P3-T-07/08/09/10 outputs.
- **Outputs:**
  - `tests/e2e/mr-review.e2e.test.ts` (new):
    1. Synthetic Note Hook payload with `position` set + valid SHAs → ChatMessage created on the MR-mirror Huly Issue within 30s; `gitlab-review` mixin present on the root note with `threadId`, `position`, `resolved=false`.
    2. Resolving the discussion via the GitLab REST API (real call) → Huly mixin's `resolved` flips true within 30s **across ALL notes in the thread (Q1 bulk update verification).**
    3. Resolving the thread from the Huly side (simulate via direct mixin update on the ChatMessage) → asserts `resolveDiscussion` was called on GitLab.
    4. Reply to a thread (synthetic Note Hook with the same `discussion_id`, different note id) → second ChatMessage created sharing the `threadId`; **reply note has `position: null` (Q1).**
    5. Malformed position (missing `head_sha`) → no ChatMessage; `review.position.malformed` metric increments.
  - `tests/e2e/mr-approvals.e2e.test.ts` (new):
    1. GitLab approve action by a known user → MR Hook fires → Huly mixin `approvedBy` includes that user's PersonUuid within 30s; `approvalStatus` recomputed.
    2. GitLab unapprove → mixin `approvedBy` removes the user.
    3. Huly user added to `approvedBy` via direct mixin update → adapter calls `approveMR(projectId, iid, actorToken|undefined)` once. With no stored OAuth token, fallback path is taken and `approval.action.fallback.service_account` warn captured **AND a visibility comment is posted (Q2: "Approved via service account; per-user OAuth UI coming in Phase 4").**
    4. Approval action failure (mock 403 from `approveMR`) → ChatMessage posted to the parent Issue with body "approval failed: approve — ... 403 ..."; engine retries.
  - `tests/e2e/mr-diff-metadata.e2e.test.ts` (new):
    1. MR with 3 changed files → `gitlab-mr` mixin's `changedFiles` has 3 entries with correct paths and status enums; `diffWebUrl` ends with `/diffs`.
    2. MR with a rename → `oldPath` is populated; `status: 'renamed'`.
    3. **MR on a legacy CE project with no approval rule (404 on /approvals): mixin's `approvedBy=[]`, `approvalsRequired=0`, `approvalStatus='pending'`; `mr.composite.partial` metric incremented (Q4 + P3-R7 verification).**
  - `tests/e2e/reviewer-migration.e2e.test.ts` (new):
    1. **Pre-Phase-3 state simulation: MR mirror Issue has 2 synthetic `gitlab:reviewer:<u>` labels (as `Ref<TagElement>` entries) and empty `reviewers` field. Binding starts in active state.**
    2. **Active-binding pre-flight: `POST /migrate-reviewer-labels` returns 409 with operator-pause message (Q3).**
    3. **Operator pause: `PATCH /api/v1/bindings/:id` with `{disabled: true}` returns 200.**
    4. **Migration: `POST /migrate-reviewer-labels` returns 200 with `mrsScanned=1, labelsStripped=2, reviewersResolved=2`.**
    5. Post-migration: Issue's labels no longer include `gitlab:reviewer:*`; mixin's `reviewers` has 2 PersonUuids.
    6. Re-run → idempotent (counts go to 0, mrsScanned unchanged).
    7. **Operator re-enable: `PATCH /api/v1/bindings/:id` with `{disabled: false}` returns 200; subsequent webhook delivery resumes.**
  - `tests/e2e/mr.e2e.test.ts` (modify):
    - Replace case 8 (synthetic `gitlab:reviewer:*` labels expectation) with a new assertion: MR with 2 reviewers → `gitlab-mr` mixin's `reviewers` field has 2 PersonUuids; NO synthetic labels created.
  - Extend `tests/e2e/setup.ts`:
    - Add helper `postSyntheticNoteHookWithPosition(eventHeader, payload, secret)` — signs and POSTs a Note Hook with `object_attributes.position` set; reuses the existing webhook receiver setup from Phase 2.
    - Add helper `approveMRAsUser(projectId, iid, userToken)` — calls `POST /merge_requests/:iid/approve` with a per-user PRIVATE-TOKEN for the reviewer to simulate the approver path.
    - Add helper `seedSyntheticReviewerLabel(issueRef, username)` — pre-populates the Phase 2-shaped synthetic label for migration tests (creates the `TagElement` doc + appends its ref to `Issue.labels`, matching the C4 corrected shape).
    - **Verify the E2E harness's `directMixinPatch` helper supports `ChatMessage` mixins (C18 — Phase 2 only tested Issue mixins). If not, extend the helper in this task as part of `setup.ts`. This is harness-test-only work — no production code change.**
- **Acceptance criteria:**
  - `npm run test:e2e` exits 0 with the new files included.
  - All MR-review / approvals / diff-metadata / reviewer-migration E2E pass against the compose stack (real GitLab CE + real Huly transactor).
  - Phase 1+2 E2E suite continues to pass except `mr.e2e.test.ts` case 8 which is replaced.
  - No GitLab CE runner needed for any Phase 3 E2E (synthetic-webhook strategy carries over from Phase 2 P2-T-11 C9 mitigation).
- **Dependencies:** P3-T-10.
- **Complexity:** L (~1500 LOC including new fixtures and setup helpers).

---

### P3-T-12 — README + Architecture doc + Migration runbook

- **Owner:** Haiku
- **Inputs:**
  - `/Users/dingo/huly-gitlab/README.md` (Phase 1+2).
  - `/Users/dingo/huly-gitlab/docs/architecture.md` (Phase 1+2).
  - `/Users/dingo/huly-gitlab/docs/api.md` (Phase 1+2).
  - `/Users/dingo/huly-gitlab/docs/runbooks/phase2-rereg.md` (pattern reference for new runbook).
  - Spec §Success Criteria.
- **Outputs (modify):**
  - `README.md`:
    - Add Phase 3 section listing: review threads, line comments, CE approvals, diff metadata, typed reviewers, migration endpoint.
    - Update "Phase 1 + Phase 2 limitations" → "Phase 1 + Phase 2 + Phase 3 limitations" with carryovers and resolutions:
      - **Resolved by Phase 3:** synthetic reviewer labels (now typed `reviewers` + migration); diff/changes metadata; review threads + line comments; CE approvals.
      - **Still deferred to Phase 4:** EE approval rules, image/file-level annotations, full diff body sync, custom field mapping, iterations, epics, multi-instance per workspace, pipeline detail (jobs/stages/logs), suggestion comments via Huly UI (markdown passes through verbatim in Phase 3), `applyLocal`-cannot-create-MR.
      - **Phase 3 known limitations:** **approval action attribution falls back to service-account in Phase 3 because no UI for users to self-link per-user OAuth exists yet — every Phase 3 approval surfaces a "Approved via service account; per-user OAuth UI coming in Phase 4" visibility comment (Q2);** line comments only support `position_type='text'`; `approvalStatus` defaults to `'pending'` when `approvalsRequired=0`; migration endpoint requires operator to pause binding via PATCH first (Q3).
  - `docs/architecture.md`:
    - Mermaid update showing `ReviewThreadsSyncManager` and the NotesSyncManager `position` discriminator branch routing to it.
    - Document the field-ownership partition extension: `MergeRequestsSyncManager` owns the 12 `gitlab-mr` fields (incl. Phase 3 additions); `PipelineSyncManager` owns `pipelineStatus`; `ReviewThreadsSyncManager` owns all `gitlab-review` fields. Explicit "no overlap" rule.
    - Document the cursor scheme extension: `reviews` cursor added per binding; idmap kind `'review_thread'` added; review-thread idmap key shape is `discussionId:noteId` (compound, per-note storage — Q1).
    - Document the approval-action attribution model: per-user OAuth preferred, service-account fallback with warn log + visibility comment; failure posts ChatMessage on parent Issue.
    - **Document the optional-field contract for `SyncMergeRequest`: list vs get asymmetry (B2).**
    - **Document the operator-pause convention for migration (Q3): PATCH disable → POST migrate → PATCH re-enable.**
  - `docs/api.md`:
    - Document `POST /api/v1/bindings/:id/migrate-reviewer-labels` with curl example and the `MigrationResult` response shape.
    - **Document `PATCH /api/v1/bindings/:id` with curl example showing `{disabled: true|false}` payload.**
    - **Document 409 response shape for active-binding migration attempts.**
  - `docs/runbooks/phase3-reviewer-migration.md` (new):
    - Step-by-step runbook with the operator-pause convention (Q3):
      1. Identify pre-Phase-3 bindings whose mirrored MRs still carry `gitlab:reviewer:*` labels.
      2. **Pause binding: `curl -X PATCH ... -d '{"disabled": true}'`.**
      3. Call the migration endpoint: `curl -X POST ... /migrate-reviewer-labels`.
      4. Verify by inspecting a sample MR-mirror Issue's labels (none starting `gitlab:reviewer:`) and mixin (`reviewers` populated).
      5. **Re-enable binding: `curl -X PATCH ... -d '{"disabled": false}'`.**
    - Note that the migration is idempotent and safe to re-run.
    - **Document the 409 response and what to do (operator pauses, retries).**
- **Acceptance criteria:**
  - `npx markdownlint-cli2 "**/*.md"` exits 0.
  - `docs/runbooks/phase3-reviewer-migration.md` exists and contains at least one `curl` example for both PATCH and POST.
  - Phase 3 limitations section in README lists the deferred items above + the Q2 service-account fallback callout.
  - `grep -q "POST /api/v1/bindings/:id/migrate-reviewer-labels" docs/api.md && grep -q "PATCH /api/v1/bindings/:id" docs/api.md` exits 0.
- **Dependencies:** P3-T-10, P3-T-11.
- **Complexity:** S (~360 lines markdown).

---

### P3-T-12b — Metrics centralization (`src/metrics.ts`) (NEW v2 — C1)

- **Owner:** Sonnet
- **Inputs:**
  - `/Users/dingo/huly-gitlab/src/sync/mr.ts` (Phase 2 — has module-level `mrSkippedCount`, `confidentialSkippedCount`).
  - `/Users/dingo/huly-gitlab/src/sync/pipeline.ts` (Phase 2 — has `unboundPipelineCount`, `pipelineLruDropCount`).
  - `/Users/dingo/huly-gitlab/src/sync/notes.ts` (Phase 2 — relevant counters).
  - P3-T-03, P3-T-06, P3-T-07, P3-T-08, P3-T-09 (consumers of the new metric names).
- **Outputs (new file `src/metrics.ts`):**
  - Module exporting:
    ```ts
    type MetricName =
      // Phase 2 carryover
      | 'confidential.skipped'
      | 'mr.skipped'
      | 'pipeline.unbound'
      | 'pipeline.lru.dropped'
      // Phase 3 additions
      | 'mr.composite.partial'
      | 'review.parent.missing'
      | 'review.position.malformed'
      | 'approval.action.fallback.service_account'
      | 'discussion.position.unsupported'
      | 'migration.reviewer.unresolved'

    export function increment (name: MetricName): void
    export function get (name: MetricName): number
    export function reset (): void  // tests-only
    ```
  - Internally a `Map<MetricName, number>`. No external metric backend wiring in Phase 3 (a Phase 4 task can plumb to Prometheus). Logger emits the same metric name as the warn-log key.
  - **Update Phase 2 modules (`mr.ts`, `pipeline.ts`, `notes.ts`) to call `metrics.increment('mr.skipped')` etc. instead of module-level counters. Delete the local counters.** This closes the Phase 2 carry-over item per spec §Phase 2 reviewer carry-over items (mark RESOLVED).
  - **Wire Phase 3 modules** (adapter `getMRApprovals`/`getMRChanges` 404 path; `mr-review.ts` parent-missing path; `notes.ts` malformed-position path; adapter `approveMR` fallback; adapter `listDiscussions` unsupported-type drop; `reviewer-migration.ts` unresolved username) to call `metrics.increment(...)`.
- **Outputs (tests):** `tests/metrics.test.ts` — ≥ 4 cases:
  1. `increment('mr.skipped')` then `get('mr.skipped')` returns 1.
  2. `increment` called twice on same name returns 2.
  3. `reset()` zeros all metrics.
  4. Unknown metric name fails TypeScript build (compile-time check; covered by `npm run build`).
- **Acceptance criteria:**
  - `npm test -- tests/metrics.test.ts` passes 4 cases.
  - `npm run lint -- src/metrics.ts tests/metrics.test.ts` exits 0.
  - Phase 2 module tests (`tests/sync/mr.test.ts`, `tests/sync/pipeline.test.ts`) updated to assert against `metrics.get(...)` instead of internal counters; still pass.
  - `grep -q "confidentialSkippedCount" src/sync/mr.ts` returns no match (counter removed; centralized).
- **Dependencies:** P3-T-08 (so all metric names are settled). Runs in Wave F parallel with P3-T-11 and P3-T-12.
- **Complexity:** S (~150 LOC + test updates).

---

## 4. Testing Plan

| Layer | Task | Command | Expected new tests |
|---|---|---|---|
| Adapter types | P3-T-01 | (build only — no test file) | 0 |
| Mixin change-shape probe | P3-T-01b | `npm test -- tests/sync/mr-mixin-change-shape.test.ts` (or inline) | ≥ 1 |
| Vendor mixin types | P3-T-02 | (build only — no test file) | 0 |
| Adapter REST | P3-T-03 | `npm test -- tests/adapter/gitlab-client-review.test.ts` | ≥ 16 |
| State enum widening | P3-T-04 | `npm test -- src/state/store.test.ts` | ≥ 2 new |
| Mixin schema | P3-T-05 | (build only — no test file) | 0 |
| ReviewThreadsSyncManager | P3-T-06 | `npm test -- tests/sync/mr-review.test.ts` | ≥ 15 |
| MR manager extensions | P3-T-07 | `npm test -- tests/sync/mr.test.ts` | ≥ 12 new |
| Notes line-position route | P3-T-08 | `npm test -- tests/sync/notes.test.ts` | ≥ 7 new |
| Reviewer migration helper | P3-T-09 | `npm test -- tests/sync/reviewer-migration.test.ts` | ≥ 8 |
| HTTP route + PATCH + loader + lifecycle | P3-T-10 | `npm test -- tests/http/binding.test.ts tests/sync/binding-loader.test.ts tests/sync/binding-lifecycle.test.ts` | ≥ 10 new |
| Metrics centralization | P3-T-12b | `npm test -- tests/metrics.test.ts` | ≥ 4 |
| E2E (compose) | P3-T-11 | `npm run test:e2e` | 18 new + 1 replaced (mr.e2e.test.ts case 8) |

**Expected total new tests:** ≥ 93 (target 100+, spec target ≥ 50 / 60+).
**Expected baseline delta:** 408 → ≥ 501 (unit + integration; E2E counted separately).

**Local developer loop (unchanged from Phase 1+2):**
- Unit: `npm test`.
- Integration: `npm run test:integration` (mongodb-memory-server + nock).
- E2E: `make compose-up && npm run test:e2e && make compose-down`. All Phase 3 E2E cases use synthetic webhooks for review-thread delivery — no real GitLab CE Note Hook with `position` field required to be emitted on a real branch push.

**Regression guarantee:** every task acceptance criterion includes whole-repo `npm test` exit 0 to catch Phase 1+2 regressions immediately. Phase 2 reviewer-label case (mr.test.ts case 16) is INVERTED to assert the new typed field — this is the only intentional regression and is documented in the PR description. Phase 2 module tests are updated by P3-T-12b to assert against centralized metrics; tests still pass.

---

## 5. Build & Verification Commands (Phase 3 QA)

Run from `/Users/dingo/huly-gitlab`:

```bash
# Install (no new deps in Phase 3)
npm ci

# Static checks
npm run lint
npm run format -- --check

# Build
npm run build                     # tsc -p .

# Unit + integration
npm test                          # expect ≥ 501 tests passing

# Coverage delta vs Phase 2
npm test -- --coverage
# expect ≥ 85% on src/sync/mr-review.ts, src/sync/mr-review-mixin.ts,
#                  src/sync/reviewer-migration.ts, src/metrics.ts,
#                  the new adapter methods

# Docker image (unchanged)
docker build -t huly-gitlab:local .

# Dev stack (unchanged compose)
docker compose -f docker/docker-compose.dev.yml up -d
curl http://localhost:3600/health

# End-to-end (full stack including Phase 3)
make e2e

# npm audit
npm audit --omit=dev --audit-level=high  # expect 0 high
```

Phase 3 acceptance (per spec §Success Criteria):

1. `npm test` exits 0 with ≥ 501 tests.
2. `npm audit --omit=dev --audit-level=high` shows 0 high.
3. `make e2e` exits 0 including all 18 new Phase 3 cases + 1 replaced.
4. Line comment created on GitLab MR appears in Huly within 30s with `position` JSON preserved on root note + replicated mixin state across notes (Q1; E2E mr-review case 1, 4).
5. Resolving discussion on either side propagates within 30s across ALL notes in the thread (Q1; E2E mr-review cases 2, 3).
6. Approval flow round-trips both ways (E2E mr-approvals cases 1–3); fallback path surfaces visibility comment (Q2).
7. Changed-files metadata populated within 30s (E2E mr-diff-metadata); CE 404 path degrades gracefully (Q4 + P3-R7).
8. `POST /migrate-reviewer-labels` strips synthetic labels + populates typed reviewers ONLY when binding is paused (Q3); 409 on active binding (E2E reviewer-migration).
9. Field-ownership rule asserted at unit layer: `applyRemote` (MR manager) never touches `pipelineStatus` (regression vs Phase 2 C2); never touches `gitlab-review` fields; never clears optional Phase 3 fields when source value is undefined (B2).
10. Approval-action visibility: failure posts a ChatMessage comment to the parent Issue and throws to engine retry (unit case + E2E mr-approvals case 4).

---

## 6. Risk Register (Phase 3-specific)

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| **P3-R1** | `getMergeRequest` per-call HTTP cost triples (3 calls vs 1 in Phase 2) because composite fetch chains `getMRApprovals` + `getMRChanges`. Busy projects with frequent MR Hook updates may hit rate limits faster. | Medium | Medium | P3-T-03 documents the cost in JSDoc + risk register; both auxiliary calls fail gracefully (safe defaults + `mr.composite.partial` metric). The 429 retry path from Phase 1 is reused. `listMergeRequests` deliberately does NOT fan out per-MR auxiliary fetches (asymmetry documented). Operators with high MR Hook volumes should monitor the metric and consider an in-memory short-TTL cache on `getMRApprovals` + `getMRChanges` (deferred to Phase 4 as `BiDirectionalCache` LRU work — spec §Phase 2 reviewer carry-over items). |
| **P3-R2** | Approval action attribution falls back to service-account when per-user OAuth tokens are not stored, so on-GitLab the approval appears as the bot user — not the real Huly user. Operationally confusing on audit logs. | High | Medium | `bctx.credentials.resolveActorToken` is the documented escape hatch; once per-user OAuth tokens are linked, attribution is correct. Q2 RESOLUTION: every Phase 3 fallback posts a visibility comment ("Approved via service account; per-user OAuth UI coming in Phase 4") in addition to the warn log. Phase 4 ticket (spec) will add the Huly UI for per-user OAuth linkage. README "Phase 3 known limitations" calls this out. |
| **P3-R3** | Backfill load increases ~25% per binding per cycle (4 listings → 5: issues + notes + MRs + MR-notes + reviews). High-MR projects with many threads may stress GitLab. | Medium | Low | Document the rate change in P3-T-06 backfill JSDoc + this risk register. The Phase 1 backfill scheduler already staggers; `listDiscussions` reuses the existing 429 retry. Operators tune `BACKFILL_INTERVAL_MS` if rate-limit metrics climb. Phase 4 will add adaptive spacing. |
| **P3-R4** | Field-ownership invariant on the `gitlab-mr` mixin is informally enforced (via reviewers reading the JSDoc partition note). A future regressing edit to `MergeRequestsSyncManager.applyRemote` could touch `pipelineStatus` again, breaking the Phase 2 C2 contract that prevented the stale-overwrite bug. | Medium | High | P3-T-07 test case 10 explicitly asserts `pipelineStatus` is untouched by `applyRemote` (pre-seed + readback). Phase 2's analogous case 15 also remains. Strongly consider extracting a `MRMixinFields` helper in Phase 4 that statically partitions which fields each manager may write (compile-time enforcement). Tracker ticket on spec §Phase 2 reviewer carry-over items. |
| **P3-R5** | Review-thread idmap key shape (`discussionId:noteId`) is compound and string-typed; reviewers of P3-T-04 may misinterpret the existing `'review_thread'` JSDoc as `gitlabId = discussionId` only, leading to dedup collisions across notes within the same thread. | Low | High | P3-T-04 JSDoc explicitly documents the compound key shape AND the rationale (Q1: per-note storage). P3-T-06 test case 2 (reply on existing thread) verifies the dedup behavior with two notes sharing the threadId but distinct idmap rows. P3-T-06 acceptance criterion #2 forces the test to assert two idmap entries on a 2-note thread. |
| **P3-R6** | **Concurrent local approval + remote MR webhook race (NEW v2 — C10).** Huly approve click sends `approveMR(actorToken)`; before GitLab confirms via webhook, an unrelated MR webhook (label change) arrives and applyRemote computes `approvedBy` from STALE GitLab state. Result: local entry clobbered until the next webhook cycle. User-visible flicker. | Medium | Medium | P3-T-07 mitigation: when `applyRemote` writes `approvedBy`, compare against current mixin value; if local has MORE entries than remote AND local entry presence is within a 30s window (suspect race), KEEP local entries. Documented in P3-T-07 step + tested in case 12. Future improvement: the credentials store could track an "in-flight approval round-trip" set with explicit fence semantics (Phase 4). |
| **P3-R7** | **GitLab CE /approvals 404 on legacy projects (NEW v2 — C11).** Older CE projects with no approval rule configured return 404 on `/merge_requests/:iid/approvals` (and sometimes `/changes`). | Medium | Low | Q4 RESOLUTION: adapter treats 404 as default state (empty arrays, 0 required) + increments `mr.composite.partial`. Tested in P3-T-03 cases 8 + 14 and E2E mr-diff-metadata case 3. 5xx still propagates as `GitLabApiError`. |

---

## 7. Open Questions (defaults assumed; flag during implementation if any need user override)

1. **Discussion delivery via Note Hook only.** Spec §Open Questions #1: GitLab Note Hook delivers discussion events with embedded discussion meta. Phase 3 default: use the existing Note Hook path. If discussion-only events (no note body change) are needed and Note Hook does not deliver them, fall back to polling via `listDiscussions` during backfill. **Resolved by default: Note Hook covers all cases observed.** Append to `.omc/plans/open-questions.md`.
2. **`approvalStatus='pending'` when `approvalsRequired=0`.** Spec §Open Questions #2: when GitLab MRs allow zero approvals, `approvedBy.length >= approvalsRequired` would be vacuously true. P3-T-07 explicitly maps the `approvalsRequired === 0` case to `'pending'` until first approval; documented in JSDoc and tested. **Resolved.**
3. **Multiple Issues sharing the same reviewer label.** Spec §Open Questions #3: defensive. P3-T-09 strips per-Issue independently; handled. **Resolved.**
4. **Approval action attribution.** Spec §Open Questions #4: per-user OAuth preferred; service-account fallback with warn log + visibility comment in Phase 3. **v2 RESOLUTION (Q2): API surface ships, but no Phase 3 UI for users to self-link. Every Phase 3 approval posts a visibility comment.** Append to `.omc/plans/open-questions.md` (track Phase 4 ticket).
5. **Q5 (NEW v2 — C16): Phase 4 mixin split commitment.** Current Phase 3 grows `gitlab-mr` to 14 fields. Hard split-trigger documented for Phase 4: **if Phase 4 would add ≥ 4 more fields to `gitlab-mr`, split into**:
   - `gitlab-mr-core` (sourceBranch, targetBranch, draft, mergedAt, mergeStatus, webUrl, gitlabIid, gitlabProjectId)
   - `gitlab-mr-review` (reviewers, approvedBy, approvalsRequired, approvalStatus, diffWebUrl, changedFiles)
   - keep `pipelineStatus` in its current pipeline-owned write path.

   Phase 3 leaves the mixin unified per CLAUDE.md "three similar lines is better than premature abstraction." Append to `.omc/plans/open-questions.md` as a Phase 4 conditional decision.
6. **Idempotency of approve/unapprove API calls.** GitLab returns 201 on first approve and 304 (or similar) on re-approve by same user. Default: do not treat 304 as error; the per-user diffing in P3-T-07 already prevents redundant calls. **Resolved.**

Executors must escalate items 1, 4, 5 if a stakeholder objects during implementation.

Append open questions 1, 4, 5 to `.omc/plans/open-questions.md` as Phase 3 / Phase 4 follow-ups.

---

## 8. Change log

- **v1 (initial):** initial Phase 3 plan derived from `.omc/specs/deep-interview-huly-gitlab-phase3.md`. Structure mirrors Phase 2 plan (`.omc/plans/autopilot-impl-phase2.md`) for task format, acceptance-criteria style, risk register format, and change log placement. Task count: 12. Parallelism width: 3 (Wave B). Total new tests: ≥ 74 (target 80+). Baseline delta: 408 → ≥ 482 unit/integration. Estimated new code: ~3,000 LOC (matching spec expectation of 2,500–3,500).
- **v2 (this revision):** applied critic findings — resolved Q1 per-note storage, Q2 API-surface-only approvals, Q3 operator-pause migration, Q4 graceful 404 handling; added P3-T-01b mixin change-payload investigation + P3-T-12b metrics centralization; tightened `SyncMergeRequest` optional Phase 3 fields; corrected migration label-reading; tightened error class shape; restructured DAG (P3-T-09 to Wave C); added P3-R6 race + P3-R7 CE skew + Q5 mixin split trigger.

### v2 delta detail

- **B1 (Q1 per-note storage):** P3-T-04 idmap key widened to `${discussionId}:${noteId}` compound; P3-T-05 `MRReviewMixinDoc.resolvedAt` becomes `number | null`; P3-T-06 mixin applied to EVERY note in a thread (root has `position`, replies have `position: null`); thread state replicated per-note; cross-note LWW uses `max(resolvedAt)`; new tests in P3-T-06 (cases 2, 3, 14, 15) assert distinct idmap entries per note + bulk update across notes + cross-note reconciliation + `resolvedAt: number` type.
- **B2 (`SyncMergeRequest` shape divergence):** Phase 3 fields on `SyncMergeRequest` are OPTIONAL in P3-T-01; `listMergeRequests` leaves them undefined; `getMergeRequest` populates them; `applyRemote` treats undefined as "not yet fetched" (NOT "clear field"); P3-T-07 case 5 asserts this no-clear semantics.
- **B3 (`change.approvedBy` payload shape):** new P3-T-01b investigates the actual mixin-change-payload key shape via `node_modules/@hcengineering/core/lib/operations.d.ts` + a probe test; verified shape lands as a code comment at the head of `src/sync/mr.ts`; P3-T-07 uses the verified expression.
- **B4 (credentials field threading):** `MRBindingContext.credentials.resolveActorToken(workspaceUuid, hulyPersonUuid)` defined in P3-T-07; stub returns undefined in Phase 3 (Q2); wired through `BindingLoader.load{ForIssues,ForMergeRequests}` in P3-T-10; `MRReviewBindingContext` does NOT include `credentials`.
- **C1 (metrics centralization):** new P3-T-12b creates `src/metrics.ts` with typed `MetricName` union, `increment` / `get` / `reset`; Phase 2 module counters migrated; Phase 3 metrics added; Phase 2 carry-over item marked RESOLVED.
- **C2 (`mr-diff.ts` clarification):** P3-T-03 §Outputs explicitly states no separate module — diff helpers inline in adapter + `mr.ts`.
- **C3 (suggestion comments passthrough):** P3-T-08 documents verbatim markdown passthrough + adds test case 8.
- **C4 (migration label-reading shape):** P3-T-09 correctly handles `Issue.labels` as `Array<Ref<TagElement>>` via `findAll(TagElement, { _id: { $in: hulyIssue.labels } })` + filter by title prefix; new step-by-step in P3-T-09 §Outputs.
- **C5 (`ApprovalActionError` constructor shape):** P3-T-01 errors revised to use class fields (`readonly kind`, `bindingId`, `mrIid`, `actorUuid?`); no `cause` constructor arg.
- **C6 (`actorToken` threading through request helper):** P3-T-03 refactors the private request helper to accept optional `tokenOverride?: string`.
- **C7 (Date serialization in mixin):** `MRReviewMixinDoc.resolvedAt` is `number | null` (ms since epoch); P3-T-06 test case 15 asserts round-trip as number-not-string.
- **C8 (DAG correction — P3-T-09 to Wave C):** P3-T-09 moved to Wave C, parallel with P3-T-07. Dependency reduced to P3-T-05 only.
- **C9 (DAG correction — P3-T-08 unit-test isolation):** P3-T-08 documents that unit tests assert enqueue CALL SHAPE only; engine wiring lands in P3-T-10.
- **C10 (concurrent local approval / remote webhook race):** P3-T-07 mitigation added (KEEP local entries within 30s race window); test case 12 added; risk P3-R6 documented.
- **C11 (CE version skew on /approvals):** Q4 resolution wired into P3-T-03 cases 8 + 14 + E2E mr-diff-metadata case 3; risk P3-R7 documented.
- **C12 (migration multi-binding isolation test):** P3-T-09 case 8 added.
- **C13 (body+resolution flip simultaneously):** P3-T-08 case 6 added.
- **C14 (`_noteRetried` flag survival through review re-enqueue):** P3-T-08 case 7 added; flag-key convention documented.
- **C15 (migration endpoint ACL note):** P3-T-09 + P3-T-10 document admin-global bearer + multi-tenant deferred to Phase 4.
- **C16 (mixin field count split trigger):** open question Q5 added with explicit Phase 4 split rule.
- **C17 (pagination cursor for listDiscussions):** P3-T-03 documents reuse of the existing Link-header helper — no new pagination logic.
- **C18 (ChatMessage mixin patch in E2E):** P3-T-11 verifies + extends `directMixinPatch` to support ChatMessage mixins (harness-only).
- **Q1 (per-note vs root-only mixin):** RESOLVED → per-note storage. Threaded through P3-T-04 (idmap key), P3-T-05 (mixin shape), P3-T-06 (apply + tests), P3-T-11 (E2E).
- **Q2 (per-user OAuth):** RESOLVED → API surface only. P3-T-07 stub credentials + visibility comment on every fallback approval; P3-T-12 README "Phase 3 known limitations".
- **Q3 (migration concurrency):** RESOLVED → operator-pauses convention. P3-T-09 + P3-T-10 add 409 pre-flight + PATCH disable toggle; P3-T-11 E2E covers the full pause/migrate/re-enable cycle; P3-T-12 runbook documents the operator workflow.
- **Q4 (CE /approvals 200 vs 404):** RESOLVED → both handled gracefully. P3-T-03 §Outputs documents 404 default-state mapping; tests in P3-T-03 + E2E cover.

**v2 task count:** 14 (+P3-T-01b, +P3-T-12b vs v1's 12).
**v2 parallelism width:** 3 (Waves A, B, C, F).
**v2 total new tests:** ≥ 93 (target 100+).
**v2 baseline delta:** 408 → ≥ 501 unit/integration.
**v2 estimated new code:** ~3,300 LOC (vs v1's ~3,000).
