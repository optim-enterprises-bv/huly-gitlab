# Implementation Plan — huly-gitlab Phase 5 (Limitations Closure)

**Status:** Draft v2 (autopilot Phase 5 — post-critic revision)
**Spec:** `.omc/specs/deep-interview-huly-gitlab-phase5.md` (authoritative)
**Companion P5-T-01b spec (will be written by P5-T-01b):** `.omc/specs/p5-t-01b-service-account-personid-api.md`
**Target tree:** `/Users/dingo/huly-gitlab/`
**Phase 1+2+3+4 baseline:** 656 tests passing; ~21,000 LOC; PRs #6, #7, #8 merged on `optim-enterprises-bv/huly-gitlab/main`.
**Phase 4 plan (structure reference):** `.omc/plans/autopilot-impl-phase4.md`
**ADR-001 (Phase 4 "FINAL"):** `docs/adr-phase4-final.md` — superseded by ADR-002 in Phase 5 (P5-T-29 / P5-T-30).

## Revision history

- **v1: initial Phase 5 plan** — closes all 7+ documented limitations from Phase 4 ADR-001 + the rolled-up DEFERRED LOW/MEDIUM findings. 31 tasks across 7 waves. Parallelism width 5 in Wave C (`_originated` marker stampers on disjoint manager files). Target test delta +150 (656 → ≥ 806).
- **v2: applied critic findings — fixed 8 blocking + 6 bugs** (mixin rename rationale, Wave E/C parallelism, P5-T-01b sandbox fallback, deleted P5-T-07 phantom webhook task, `_originated` TxRemoveDoc carve-out, mr.ts 756 baseline, rename sweep grep, `$set`/`$inc` TxUpdateDoc probe, cookie URL decode, backfill drain race, GraphQL cache bust).

---

## 1. Overview

Phase 5 closes the documented limitations in `docs/adr-phase4-final.md` (which itself acknowledged ADR-001 as the "final" terminal state of Phase 4 with explicit deferrals). Eight major scope areas, one per spec section:

(A) **Service-account PersonId real resolution** — replace the `systemAccountUuid as unknown as PersonId` sentinel cast in `src/index.ts:57` with a real platform lookup via `@hcengineering/account-client`. P5-T-01b investigation task verifies the API surface (`findPersonBySocialKey('system:account')` vs. analogous resolvers) BEFORE the real wiring lands; on resolution failure with 3-retry exponential backoff the pod refuses to start (no silent degradation per spec §A). Adds `tx.subscription.service_account.resolved` metric + tests asserting filter behavior against resolved vs. non-resolved PersonIds. **Critic finding (sandbox access):** if `node_modules/@hcengineering/account-client/lib/index.d.ts` is unreadable in the planner sandbox, P5-T-01b adds **Path D (fallback)** which documents the unresolved API and triggers the spec §A documented-degradation branch: pod logs a startup warning, falls back to the sentinel cast, and emits `tx.subscription.service_account.resolved=0` so operators can alert.

(B) **Cookie ServerSecret grace-period rotation** — eliminate the downtime requirement for rotating `ServerSecret`. New env var `ServerSecretPrevious` (optional) is accepted during verification; signing always uses the primary `ServerSecret`. New `src/util/secret-rotation.ts` helper centralises the dual-verify logic. Applied at TWO sites (per critic finding 4): cookie HMAC verify (`src/http/cookie-auth.ts`) and OAuth state HMAC verify (`src/http/oauth.ts` + `src/http/user-oauth.ts`). **Webhook secret rotation REMOVED from Phase 5** — the webhook secret is per-binding (`binding.webhookSecretRef`), not pod-wide; per-binding rotation is already covered by the existing `POST /api/v1/bindings/:id/rotate-secret` endpoint. Operator runbook `docs/phase5-runbook.md` documents the rotation procedure for cookie/OAuth and points to the existing rotate-secret endpoint for per-binding webhook secrets.

(C) **`_originated:'gitlab'` marker stamping (defense-in-depth restoration)** — Phase 4 fix B3 removed the marker check from TxSubscriber as "dead code" because no applyRemote write was stamping. Phase 5 implements BOTH layers per spec §C: service-account PersonId filter (layer 1, already in TxSubscriber) AND transient `_originated:'gitlab'` marker (layer 2). Every `applyRemote` write path stamps the marker on EVERY `createDoc`/`updateDoc`/`createMixin`/`updateMixin` attributes object; TxSubscriber re-introduces the marker check (it was scaffolded but unused at `src/sync/tx-subscription.ts:160-200`). Seven managers stamp: `IssuesSyncManager`, `MergeRequestsSyncManager`, `mr-approvals` (extracted in Phase 4), `mr-review.ts`, `notes.ts`, `pipeline.ts`, `epics.ts`. Each task adds the stamper + a per-manager test asserting "marker IS on every write attr object" + a round-trip test asserting "TxSubscriber drops txes carrying the marker." **TxRemoveDoc carve-out (critic finding 5):** TxRemoveDoc has NO attribute payload to stamp; the marker check is documented as N/A for removes. The service-account PersonId filter (layer 1) remains the SOLE defense for echo-storm prevention on TxRemoveDoc. Documented in spec §C and re-asserted in P5-T-15 JSDoc.

(D) **Mixin split: `gitlab-mr` → `gitlab-mr-core` + `gitlab-mr-review`** — the current 16-field `gitlab-mr` mixin (`src/sync/mr-mixin.ts`) partitions naturally: 8 core fields (sourceBranch, targetBranch, draft, mergedAt, mergeStatus, webUrl, gitlabIid, gitlabProjectId) → `gitlab-mr-core`; 8 review fields (reviewers, approvedBy, approvalsRequired, approvalStatus, diffWebUrl, changedFiles, approvalRules, iteration) → `gitlab-mr-review`; `parentEpicIid` stays on `gitlab-mr-review` (EpicsSyncManager remains sole writer per AC-1 from Phase 4); `pipelineStatus` continues to be exclusively owned by `PipelineSyncManager` on its own path (untouched). The existing `mr-review-mixin.ts` (review-thread mixin) is renamed to `mr-review-thread-mixin.ts`. **Critic finding 1 — rename rationale:** the runtime mixin IDs `gitlab-review` (existing review-thread, declared by `MR_REVIEW_MIXIN`) and `gitlab-mr-review` (new MR review-side, declared by `MR_REVIEW_MIXIN_DOC`) DO NOT collide at runtime (they're distinct platform strings). The rename is a **TypeScript-symbol-only** clarity refactor to prevent developer confusion when two symbol identifiers would otherwise be near-identical (`MR_REVIEW_MIXIN` vs `MR_REVIEW_MIXIN_DOC`). The exported constant becomes `MR_REVIEW_THREAD_MIXIN` (value unchanged: `'gitlab-review'`). Backward read-compat: the constant rename is sourcecode only; the platform-side mixin ID is preserved. New admin endpoint `POST /api/v1/bindings/:id/migrate-mixin-split` performs the split idempotently; operator MUST pause the binding first (matches Phase 3 reviewer-migration UX). During the migration window, ALL readers consult BOTH old + new mixins (prefer new); shared `readMRMixinAttributes` helper (P4 DEFERRED code-reviewer L-5) centralises this.

(E) **GraphQL adapter** — add `src/adapter/gitlab-graphql-client.ts` using `graphql-request` (already a Phase 1 dep). Capability-detect GraphQL availability + schema version. Three composite-heavy paths gate on GraphQL preference with REST fallback: `composite getMergeRequest` (collapses 5 REST calls on EE → 1 GraphQL query), `listEpicsWithChildren` (collapses listEpics + N×listEpicIssues), `listMergeRequestsWithApprovals` (replaces listMergeRequests + per-MR approvals fetch). Per-call cached capability detection (TTL 1h) **with bust-on-config-change (critic bug B5):** capability cache is invalidated on bind-time config change AND a new `POST /api/v1/admin/invalidate-graphql-cache` endpoint allows manual operator invalidation. Every GraphQL-preferred path has a REST fallback test asserting equivalent SyncMergeRequest/SyncEpic shape (the public adapter contract is identical regardless of transport).

(F) **Image/file-level discussion annotations** — GitLab discussions support `position_type: 'image'` and `'file'` (currently filtered out in `mr-review.ts` listDiscussions). Sync them. `SyncReviewPosition` becomes a discriminated union: `{positionType: 'text', filePath, oldLine, newLine, baseSha, headSha, startSha} | {positionType: 'image', filePath, x, y, width, height, baseSha, headSha} | {positionType: 'file', filePath, baseSha, headSha}`. Adapter no longer filters non-text positions; `mr-review.ts` writes the full position to the mixin. Huly UI surfacing is explicitly NOT this pod's responsibility (out of scope per spec).

(G) **`mr.ts` further split (756 → ≤ 700, with 730 allowance)** — trivial cleanup. Extract `mr-helpers.ts`: `resolveAssignee`, `resolveReviewerUuids`, `resolveLocalLabels`, `ensureRemoteLabels`, `parseIid`, `areEqual`, `stripDocPrefix`. Keep `mr.ts` to manager + applyRemote + applyLocal + backfill orchestration. **Critic finding 7 — 756 baseline reality:** Phase 4 P4-T-11 already extracted `mr-approvals.ts`; current actual size is 756 LOC (per `wc -l`) which exceeds the Phase 4 acceptance target of ≤700 due to P4-T-08 EE additions that landed concurrent with the extraction. Extraction must remove **≥ 56 LOC** to hit ≤700. **Allowance:** if extraction lands at ≤730 LOC, document as ACCEPTABLE in P5-T-26 — spec §Success Criteria #11 is already met at 756 (it was the Phase 4 target, not Phase 5; Phase 5 spec does not re-impose ≤700). Soft target ≤700, hard ceiling ≤730 with documented justification.

(H) **Phase 4 reviewer DEFERRED items (LOW/MEDIUM rollup)** — Security M-1 (404 vs 401 on unknown OAuth state in user-oauth `/callback`), Security M-4 (cookie hex validation pre-check before `timingSafeEqual`), Architect L-1 (explicit `stale-on-unresolve` mixin field clear for review threads), code-reviewer L-1 (BiDirectionalCache `invalidate(undefined)` doc + `reload(key)` method), code-reviewer L-3 (postMessage origin validation in `app.js`), code-reviewer L-5 (shared `readMRMixinAttributes` helper — folds into D), code-reviewer L-6 (cookie parser `=` handling — split on first `=`, AND URL-decode key per critic bug B3).

**Phase 5 is the genuinely terminal state** per spec §Phasing. No Phase 6 planned. Critical invariants preserved from Phases 2-4: field-ownership single-writer per mixin field (Phase 2 C2 + Phase 3 + AC-1); `EpicsSyncManager` SOLE writer of `parentEpicIid` (the field moves to `gitlab-mr-review` mixin but the writer is unchanged); `_originated:'gitlab'` marker now stamped by every applyRemote write (defense-in-depth layer 2, except TxRemoveDoc which is layer-1-only).

---

## 2. Dependency Graph / Phase Ordering

```
            ┌─────────────────────────────────────┐
            │ Wave A: Investigation + types       │
            │   P5-T-01  SyncReviewPosition union │
            │   P5-T-01b service-account API probe│
            │   P5-T-02  Mixin split schema (core,│
            │            review, helper)          │
            │   P5-T-03  secret-rotation helper   │
            └────────────────┬────────────────────┘
                             │
   ┌─────────────────────────┴─────────────────────────┐
   │ Wave B: Service-account + secret rotation (3-wide)│
   │  P5-T-04 service-account PersonId resolution      │
   │           (src/index.ts wiring + retry)           │
   │  P5-T-05 cookie-auth dual-verify adoption         │
   │           + Bug M-4 hex pre-check                 │
   │           + Bug L-6 cookie parser = + URL decode  │
   │  P5-T-06 oauth.ts + user-oauth.ts dual-verify     │
   │           + Sec M-1 404-on-unknown-state          │
   │  (P5-T-07 DELETED — see critic finding 4)         │
   └─────────────────────────┬─────────────────────────┘
                             │
   ┌─────────────────────────┴─────────────────────────┐
   │ Wave C: _originated marker stampers               │
   │   width 1 lead (P5-T-08 originated-marker.ts      │
   │   helper) + width 6 parallel stampers             │
   │  P5-T-08 originated-marker.ts helper + Issues     │
   │           stamper (LEAD; serial first)            │
   │  P5-T-09 MergeRequestsSyncManager stamper         │
   │  P5-T-10 mr-approvals stamper                     │
   │  P5-T-11 ReviewThreadsSyncManager stamper         │
   │  P5-T-12 NotesSyncManager stamper                 │
   │  P5-T-13 PipelineSyncManager stamper              │
   │  P5-T-14 EpicsSyncManager stamper                 │
   │  P5-T-15 TxSubscriber marker check restore        │
   │           (serial; consumes T-08..T-14)           │
   └─────────────────────────┬─────────────────────────┘
                             │
   ┌─────────────────────────┴─────────────────────────┐
   │ Wave D: Mixin split (4-wide)                      │
   │  P5-T-16 readMRMixinAttributes helper             │
   │           (shared reader; consumed by all writers)│
   │  P5-T-17 Writer split — MergeRequestsSyncManager  │
   │  P5-T-18 Writer split — mr-approvals + mr-review  │
   │  P5-T-19 mixin-migration.ts helper + endpoint     │
   │  P5-T-20 Reader-compat tests + L-1 stale clear    │
   └─────────────────────────┬─────────────────────────┘
                             │
   ┌─────────────────────────┴─────────────────────────┐
   │ Wave E: GraphQL adapter (FULLY SERIAL; width 1)   │
   │  P5-T-21 gitlab-graphql-client.ts core +          │
   │           capability detection + cache bust       │
   │  P5-T-22 composite getMergeRequest GraphQL path   │
   │  P5-T-23 listEpicsWithChildren GraphQL path       │
   │  P5-T-24 listMergeRequestsWithApprovals path      │
   └─────────────────────────┬─────────────────────────┘
                             │
   ┌─────────────────────────┴─────────────────────────┐
   │ Wave F: Image/file annotations + mr.ts split +    │
   │         remaining DEFERRED rollup (3-wide)        │
   │  P5-T-25 listDiscussions image/file mapping +     │
   │           mr-review.ts position write             │
   │  P5-T-26 mr-helpers.ts extraction (mr.ts → ≤700/  │
   │           ≤730 allowance)                         │
   │  P5-T-27 BiDirectionalCache L-1 invalidate doc +  │
   │           reload(key); app.js L-3 postMessage     │
   │           origin validation                       │
   └─────────────────────────┬─────────────────────────┘
                             │
   ┌─────────────────────────┴─────────────────────────┐
   │ Wave G: E2E + docs + final regression (2-wide)    │
   │  P5-T-28 E2E harness extensions                   │
   │  P5-T-29 ADR-002 + Phase 5 runbook (supersedes    │
   │           ADR-001) + README/architecture update   │
   │  P5-T-30 Phase 5 final regression sweep           │
   └───────────────────────────────────────────────────┘
```

**Parallel waves:**

- **Wave A (Day 1):** P5-T-01, P5-T-01b, P5-T-02, P5-T-03 in parallel. Disjoint files: `src/adapter/types.ts` (P5-T-01); investigation spec only (P5-T-01b); new mixin doc files (P5-T-02); new `src/util/secret-rotation.ts` (P5-T-03).
- **Wave B (after Wave A):** P5-T-04 serial-after-P5-T-01b; P5-T-05, P5-T-06 in parallel (both consume the same `secret-rotation` helper but edit disjoint files). **P5-T-07 deleted** per critic finding 4 — webhook is per-binding, not pod-wide.
- **Wave C (after Wave B):** **Width 1 lead → width 6 parallel → width 1 serial.** P5-T-08 lands FIRST and ALONE (creates `originated-marker.ts` helper AND wires the IssuesSyncManager stamper). Then P5-T-09, P5-T-10, P5-T-11, P5-T-12, P5-T-13, P5-T-14 run in parallel (width 6 — each edits one disjoint manager file, all consume the helper from P5-T-08). Then P5-T-15 serial after all stampers land (TxSubscriber marker check needs the stampers in place for the round-trip test). **Critic finding 6 — true parallelism width:** Wave C width is 6 in its parallel phase (not 7 — the lead task serialises first).
- **Wave D (after Wave C):** P5-T-16 first (shared reader helper); then P5-T-17, P5-T-18, P5-T-19 in parallel (writers + migration helper edit disjoint files); P5-T-20 serial after (reader-compat + L-1 stale clear).
- **Wave E (after Wave D):** **FULLY SERIAL; width 1.** Critic finding 2: P5-T-21 → P5-T-22 → P5-T-23 → P5-T-24, all serial. All four tasks modify `src/adapter/gitlab-client.ts` (T-22/T-23/T-24) or its capability struct (T-21); serial avoids merge conflicts and lets each task observe the previous task's GraphQL-preferred method shape before adding the next.
- **Wave F (after Wave E):** P5-T-25, P5-T-26, P5-T-27 in parallel (disjoint files: `mr-review.ts` + `listDiscussions` mapping; `mr-helpers.ts` extract + `mr.ts` trim; `bi-directional-cache.ts` + `public/user-ui/app.js`).
- **Wave G (after Wave F):** P5-T-28, P5-T-29 in parallel; P5-T-30 serial after.

**Parallelism width:** 6 (Wave C parallel phase, 6 disjoint manager stampers after the P5-T-08 lead). Width 4 in Waves A, D. Width 2 in Waves B, F, G. Width 1 in Wave E (fully serial per critic finding 2).

**DAG note (Wave E gitlab-client.ts contention):** Resolved by fully serializing Wave E. Each task adds a clearly-marked GraphQL-preferred method block; the serial ordering eliminates the previous v1 ambiguity.

**Gating contract (Wave A day-1 deliverable):**

- `src/adapter/types.ts` widens `SyncReviewPosition` from a single shape to a discriminated union: `'text' | 'image' | 'file'` (P5-T-01). The existing single-shape consumers in `mr-review.ts` need adjustment in P5-T-25; until then, P5-T-01's compile fix uses a temporary type narrowing that defaults to `'text'` shape — documented in JSDoc.
- New `src/sync/mr-core-mixin.ts` declares `MR_CORE_MIXIN = 'gitlab-mr-core'` + `MRCoreMixinDoc extends Issue { sourceBranch, targetBranch, draft, mergedAt, mergeStatus, webUrl, gitlabIid, gitlabProjectId }` (8 fields, all required).
- New `src/sync/mr-review-mixin-doc.ts` declares `MR_REVIEW_MIXIN_DOC = 'gitlab-mr-review'` + `MRReviewMixinDoc extends Issue { reviewers?, approvedBy?, approvalsRequired?, approvalStatus?, diffWebUrl?, changedFiles?, approvalRules?, iteration?, parentEpicIid? }` (9 fields all optional — they were optional on Phase 3+4 `gitlab-mr` too).
- Existing `src/sync/mr-review-mixin.ts` (review-thread mixin file) is RENAMED to `src/sync/mr-review-thread-mixin.ts` for TS-symbol clarity (the runtime mixin ID `gitlab-review` is unchanged — see critic finding 1 for rationale). All importers updated (P5-T-02). Note: this rename is part of P5-T-02; the new MR review-side mixin doc file is `mr-review-mixin-doc.ts` not `mr-review-mixin.ts`.
- Old `src/sync/mr-mixin.ts` (the 16-field merged mixin) is RETAINED throughout Phase 5 for backward read compatibility. Removal is documented in `docs/phase5-runbook.md` as an OPTIONAL post-migration step (operator runs the migrate endpoint, then removes the file in a separate cleanup PR). Phase 5 itself does NOT delete it.
- New `src/util/secret-rotation.ts` exports `verifyWithRotation(payload, sigHex, primary, previousOrNull): boolean`. (No `verifyWebhookSecretWithRotation` — webhook is per-binding; see critic finding 4.) Tests cover all 6 cases per spec §Testing Strategy (down from 8 — webhook cases removed).
- P5-T-01b writes findings to `/Users/dingo/huly-gitlab/.omc/specs/p5-t-01b-service-account-personid-api.md`. The chosen resolution path is **gating for P5-T-04**.

---

## 3. Task List

### P5-T-01 — `SyncReviewPosition` discriminated union (image/file/text)

- **Owner:** Sonnet
- **Inputs:**
  - `/Users/dingo/huly-gitlab/src/adapter/types.ts` (Phase 1-4 — `SyncReviewPosition` currently single text shape).
  - `/Users/dingo/huly-gitlab/.omc/specs/deep-interview-huly-gitlab-phase5.md` §F.
- **Outputs (modify `src/adapter/types.ts`):**
  - Replace `SyncReviewPosition` with a discriminated union:
    ```ts
    export type SyncReviewPosition =
      | { positionType: 'text', filePath: string, oldLine: number | null, newLine: number | null, baseSha: string, headSha: string, startSha: string }
      | { positionType: 'image', filePath: string, x: number, y: number, width: number, height: number, baseSha: string, headSha: string }
      | { positionType: 'file', filePath: string, baseSha: string, headSha: string }
    ```
  - JSDoc: GitLab discussions emit one of three `position_type` values. Phase 4 filtered the non-text variants; Phase 5 surfaces all three on the review mixin. UI affordance is Huly platform's concern.
- **Outputs (compile shim for downstream consumers):**
  - Any consumer of the old single-shape that does NOT yet discriminate becomes a TS error. P5-T-01 inserts a temporary helper `asTextPosition(p: SyncReviewPosition): Extract<SyncReviewPosition, {positionType: 'text'}> | null` that narrows the union for the 1-2 call sites in `mr-review.ts` that haven't been updated. The helper is REMOVED in P5-T-25.
- **Outputs (tests):** extend `tests/adapter/types.test.ts` (or create if absent) with 3 cases asserting each union arm narrows correctly.
- **Acceptance criteria:**
  - `npm run build` exits 0.
  - `npm run lint -- src/adapter/types.ts` exits 0.
  - `grep -q "positionType: 'image'" src/adapter/types.ts && grep -q "positionType: 'file'" src/adapter/types.ts && grep -q "positionType: 'text'" src/adapter/types.ts` exits 0.
- **Dependencies:** none (Wave A).
- **Complexity:** S (~140 LOC type defs + 3 test cases + temporary helper).

---

### P5-T-01b — Service-account PersonId resolution API probe (NEW; gates P5-T-04)

- **Owner:** Sonnet
- **Inputs:**
  - `/Users/dingo/huly-gitlab/node_modules/@hcengineering/account-client/lib/index.d.ts` (authoritative — verify exported methods).
  - `/Users/dingo/huly-gitlab/node_modules/@hcengineering/account-client/lib/types.d.ts` (Person types).
  - `/Users/dingo/huly-gitlab/node_modules/@hcengineering/core/lib/index.d.ts` (PersonId branded type).
  - `/Users/dingo/huly-gitlab/src/index.ts` (current sentinel cast at line 57; replace).
  - `/Users/dingo/huly-gitlab/src/sync/tx-subscription.ts:24-32` (SH-1 limitation note that this task closes).
- **Investigation step:**
  - Inspect `@hcengineering/account-client` for one of these patterns:
    - **Path A: `accountClient.findPersonBySocialKey('system:account')`** — returns the PersonId platform stamps on system-account txes. Verify the social-key shape (`'system:account'` vs `'system'` vs other) by reading the type definitions and any usage in the workspace.
    - **Path B: `accountClient.getSystemAccount()`** or `getServiceAccount()` — explicit helper. Verify presence.
    - **Path C: `accountClient.findPersonByEmail(systemAccountEmail)`** — fallback resolution via the platform's known system-account email constant.
    - **Path D (sandbox / no-API fallback, critic finding 3):** if `node_modules/@hcengineering/account-client/lib/*.d.ts` is unreadable in the planner sandbox OR none of Paths A/B/C resolves to a viable API, Path D is selected. Path D triggers the **documented degradation** branch in spec §A: pod retains the sentinel cast (`systemAccountUuid as unknown as PersonId`), emits a WARN log at startup ("service-account PersonId resolution unavailable: falling back to sentinel cast; echo-storm prevention relies SOLELY on the `_originated:'gitlab'` marker layer 2"), and sets `tx.subscription.service_account.resolved=0` gauge for operator alerting. The pod DOES start (does not refuse) under Path D; this is the only path where the §A "refuse to start" policy is relaxed and Phase 5 EXPLICITLY documents this as an acceptable degradation.
  - Build a minimal probe test (`tests/sync/service-account-resolution-probe.test.ts`) that:
    - Mocks the account-client with each candidate API surface.
    - Asserts the chosen resolution path returns a non-null `PersonId` (Paths A/B/C) OR documents the sentinel-cast fallback (Path D).
    - Documents the retry behavior on transient failures (network, 5xx).
  - Write findings to `/Users/dingo/huly-gitlab/.omc/specs/p5-t-01b-service-account-personid-api.md`:
    - Chosen path (A/B/C/D) with rationale + evidence (line refs into `@hcengineering/account-client` types OR a sandbox-restriction note for Path D).
    - Concrete code skeleton for the resolver in `src/util/service-account.ts` (NEW file landed in P5-T-04).
    - Retry policy: 3 attempts with exponential backoff (1s, 2s, 4s); permanent failure on 3rd 4xx; transient on 5xx/network. (Path D: no retry — degradation is immediate.)
    - Metric name: `tx.subscription.service_account.resolved` (gauge 0/1).
    - Test mock fixture for `tests/sync/service-account-resolution.test.ts`.
- **Outputs:**
  - `/Users/dingo/huly-gitlab/.omc/specs/p5-t-01b-service-account-personid-api.md` (~140 lines).
  - Code comment at head of `src/util/service-account.ts` placeholder (file created in P5-T-04) referencing the spec.
  - `tests/sync/service-account-resolution-probe.test.ts` (≥ 2 cases — happy path + transient failure recovery; +1 case for Path D fallback if selected).
- **Acceptance criteria:**
  - `cat /Users/dingo/huly-gitlab/.omc/specs/p5-t-01b-service-account-personid-api.md | grep -q "Chosen path"` exits 0.
  - `cat /Users/dingo/huly-gitlab/.omc/specs/p5-t-01b-service-account-personid-api.md | grep -q "Retry policy"` exits 0.
  - `npm test -- tests/sync/service-account-resolution-probe.test.ts` passes all cases.
  - `npm run build` exits 0.
- **Dependencies:** none (parallel with P5-T-01, P5-T-02, P5-T-03 in Wave A). Output **blocks P5-T-04.**
- **Complexity:** M (~340 LOC including probe tests + spec doc + Path D fallback branch).

---

### P5-T-02 — Mixin split schema (`mr-core-mixin.ts` + `mr-review-mixin-doc.ts` + rename)

- **Owner:** Sonnet
- **Inputs:**
  - `/Users/dingo/huly-gitlab/src/sync/mr-mixin.ts` (the 16-field source; KEPT for read-compat).
  - `/Users/dingo/huly-gitlab/src/sync/mr-review-mixin.ts` (review-thread mixin; RENAMED to `mr-review-thread-mixin.ts`).
  - `/Users/dingo/huly-gitlab/.omc/specs/deep-interview-huly-gitlab-phase5.md` §D + §Architecture.
- **Rename rationale (critic finding 1):** the runtime mixin IDs `gitlab-review` (existing) and `gitlab-mr-review` (new) DO NOT collide — they are distinct platform strings. The rename is **TypeScript-symbol-only**: `MR_REVIEW_MIXIN` (Phase 3 review-thread) → `MR_REVIEW_THREAD_MIXIN` (same value `'gitlab-review'`). This prevents developer confusion when reading code that imports both `MR_REVIEW_MIXIN` and `MR_REVIEW_MIXIN_DOC`. No platform-side migration required.
- **Outputs (new file `src/sync/mr-core-mixin.ts`):**
  ```ts
  import type { Mixin, Ref } from '@hcengineering/core'
  import type { Issue } from '@hcengineering/tracker'
  import type { MergeStatus } from '../adapter/types'

  /** Core (always-present) GitLab MR identity + branch fields. */
  export interface MRCoreMixinDoc extends Issue {
    sourceBranch: string
    targetBranch: string
    draft: boolean
    mergedAt: Date | null
    mergeStatus: MergeStatus
    webUrl: string
    gitlabIid: number
    gitlabProjectId: number
  }

  export const MR_CORE_MIXIN = 'gitlab-mr-core' as unknown as Ref<Mixin<MRCoreMixinDoc>>
  ```
- **Outputs (new file `src/sync/mr-review-mixin-doc.ts`):**
  ```ts
  import type { Mixin, PersonUuid, Ref } from '@hcengineering/core'
  import type { Issue } from '@hcengineering/tracker'
  import type { ApprovalStatus, SyncChangedFile, SyncIteration, SyncMRApprovalRule } from '../adapter/types'

  /**
   * Review-side GitLab MR fields. Split from `gitlab-mr` in Phase 5 (D).
   * EpicsSyncManager remains SOLE writer of `parentEpicIid` (Phase 4 AC-1 carries forward).
   */
  export interface MRReviewMixinDoc extends Issue {
    reviewers?: PersonUuid[]
    approvedBy?: PersonUuid[]
    approvalsRequired?: number
    approvalStatus?: ApprovalStatus
    diffWebUrl?: string
    changedFiles?: SyncChangedFile[]
    approvalRules?: SyncMRApprovalRule[]
    iteration?: SyncIteration | null
    parentEpicIid?: number
  }

  export const MR_REVIEW_MIXIN_DOC = 'gitlab-mr-review' as unknown as Ref<Mixin<MRReviewMixinDoc>>
  ```
- **Outputs (rename `src/sync/mr-review-mixin.ts` → `src/sync/mr-review-thread-mixin.ts`):**
  - All importers updated (grep + replace). Tests + manager files + binding-loader + index.ts all swept.
  - The exported constant rename: `MR_REVIEW_MIXIN` → `MR_REVIEW_THREAD_MIXIN`. The Phase 5 review-side MR mixin uses `MR_REVIEW_MIXIN_DOC` (distinct).
- **Outputs (modify `src/sync/mr-mixin.ts`):**
  - Add JSDoc preamble: "**SUPERSEDED in Phase 5:** this mixin is split into `gitlab-mr-core` (`MR_CORE_MIXIN`) + `gitlab-mr-review` (`MR_REVIEW_MIXIN_DOC`). This file is RETAINED for read-compat during the migration window. New code MUST write to the split mixins via `MergeRequestsSyncManager`. Removal is post-migration cleanup."
  - No structural change to `MRMixinDoc`/`MR_MIXIN`.
- **Outputs (tests):** none structural; cross-file rename is asserted by build + lint. Add 1 case to `tests/sync/mr-mixin.test.ts` (or create if absent) asserting `MR_CORE_MIXIN !== MR_REVIEW_MIXIN_DOC !== MR_MIXIN`.
- **Acceptance criteria:**
  - `npm run build` exits 0.
  - `npm run lint -- src/sync/mr-core-mixin.ts src/sync/mr-review-mixin-doc.ts src/sync/mr-review-thread-mixin.ts src/sync/mr-mixin.ts` exits 0.
  - `grep -rq "MR_CORE_MIXIN" src/sync/mr-core-mixin.ts && grep -rq "MR_REVIEW_MIXIN_DOC" src/sync/mr-review-mixin-doc.ts && grep -rq "MR_REVIEW_THREAD_MIXIN" src/sync/mr-review-thread-mixin.ts` exits 0.
  - `! ls src/sync/mr-review-mixin.ts` (file renamed away).
  - **Rename sweep check (critic finding 8):** `! grep -rq "MR_REVIEW_MIXIN[^_]" src/ tests/` — zero matches of the old symbol outside renamed file. The `[^_]` boundary excludes `MR_REVIEW_MIXIN_DOC` and `MR_REVIEW_THREAD_MIXIN`; any remaining hit is an unmigrated importer.
  - All existing imports compile (no orphaned `MR_REVIEW_MIXIN` references).
- **Dependencies:** none (Wave A).
- **Complexity:** S (~260 LOC across 3 new/modified files + rename sweep).

---

### P5-T-03 — `secret-rotation.ts` dual-verify helper

- **Owner:** Sonnet
- **Inputs:**
  - `/Users/dingo/huly-gitlab/src/http/cookie-auth.ts` (Phase 4 — single-secret verify; pattern reference).
  - `/Users/dingo/huly-gitlab/src/http/oauth.ts` (Phase 1 — state HMAC).
  - `/Users/dingo/huly-gitlab/.omc/specs/deep-interview-huly-gitlab-phase5.md` §B.
- **Note (critic finding 4):** webhook secret rotation is OUT OF SCOPE for this helper. The webhook secret is per-binding (`binding.webhookSecretRef`); per-binding rotation is already covered by the existing `POST /api/v1/bindings/:id/rotate-secret` endpoint. The helper exports only HMAC primitives for cookie + OAuth state.
- **Outputs (new file `src/util/secret-rotation.ts`):**
  - `verifyHmacWithRotation(payload: Buffer, providedSigHex: string, primary: Buffer, previous: Buffer | null): boolean`
    - Computes HMAC-SHA256 with primary; constant-time compare against provided sig.
    - If mismatch AND `previous !== null`: computes HMAC-SHA256 with previous; constant-time compare.
    - Returns true on EITHER match.
    - Pre-validates `providedSigHex` is hex via regex (Bug M-4 hex pre-check, integrated here for reuse by cookie-auth).
  - `signHmac(payload: Buffer, primary: Buffer): string` — always uses primary; helper for symmetric API.
  - Module JSDoc: documents the rotation workflow (operator sets `ServerSecretPrevious` to the OLD value before rotating `ServerSecret` to a new value; after the rotation window — default 24h, configurable via runbook — operator removes `ServerSecretPrevious`). Documents that webhook rotation is per-binding and uses the existing rotate-secret endpoint, NOT this helper.
- **Outputs (config):** modify `src/config.ts` to add `ServerSecretPrevious: Buffer | null` (parsed from optional env var; null when absent). Documented in `docs/phase5-runbook.md` (P5-T-29).
- **Outputs (tests):** `tests/util/secret-rotation.test.ts` (NEW; ≥ 6 cases per spec §Testing Strategy, reduced from 8 — webhook cases removed):
  1. Primary verify passes (no previous): valid sig → true.
  2. Primary verify fails (no previous): invalid sig → false.
  3. Primary fails, previous passes (rotation window): true.
  4. Both fail (rotation window): false.
  5. Primary passes, previous would also pass (defensive): true; primary used first.
  6. Hex pre-check: non-hex sig (`gg`, `??`) rejected before any `timingSafeEqual` call.
- **Acceptance criteria:**
  - `npm test -- tests/util/secret-rotation.test.ts` passes all 6 cases.
  - `npm run lint -- src/util/secret-rotation.ts src/config.ts` exits 0.
  - `grep -rq "verifyHmacWithRotation" src/util/secret-rotation.ts && ! grep -rq "verifyWebhookSecretWithRotation" src/util/secret-rotation.ts` exits 0 (negative check confirms webhook helper not present).
- **Dependencies:** none (Wave A).
- **Complexity:** S (~240 LOC including config + 6 tests; reduced from v1 ~280 LOC due to webhook removal).

---

### P5-T-04 — Service-account PersonId real resolution (consumes P5-T-01b)

- **Owner:** Opus
- **Inputs:**
  - `/Users/dingo/huly-gitlab/.omc/specs/p5-t-01b-service-account-personid-api.md` (BLOCKING — chosen API path; could be Path D fallback).
  - `/Users/dingo/huly-gitlab/src/index.ts:42-57` (current sentinel cast; replace OR retain under Path D).
  - `/Users/dingo/huly-gitlab/src/sync/tx-subscription.ts:24-32` (SH-1 limitation note to clear or refresh).
  - `/Users/dingo/huly-gitlab/src/metrics.ts` (METRIC_NAMES extension target).
- **Outputs (new file `src/util/service-account.ts`):**
  - `resolveServiceAccountPersonId(accountClient: AccountClient, logger: Logger): Promise<PersonId>`:
    - Implements the chosen path from P5-T-01b (A/B/C).
    - Retry policy: 3 attempts with exponential backoff (1s, 2s, 4s).
    - Transient (network, 5xx) → retry; permanent (4xx, malformed response) → fail immediately.
    - On final failure: throws `ServiceAccountResolutionError` with the last error chained.
    - On success: increments `tx.subscription.service_account.resolved` gauge (set to 1); logs at info level with the resolved PersonId hash (NEVER the full PersonId — privacy).
  - **Path D fallback (sentinel cast retain):** if P5-T-01b selected Path D, `src/util/service-account.ts` exports `resolveServiceAccountPersonIdOrFallback` which returns the sentinel `systemAccountUuid as unknown as PersonId` with a WARN log + `tx.subscription.service_account.resolved=0` gauge. `src/index.ts` uses this Path D variant when P5-T-01b indicates Path D.
- **Outputs (modify `src/index.ts`):**
  - Paths A/B/C — replace lines 42-57 sentinel block with:
    ```ts
    let serviceAccountPersonId: PersonId
    try {
      serviceAccountPersonId = await resolveServiceAccountPersonId(accountClient, logger)
    } catch (err) {
      logger.error('main: failed to resolve service-account PersonId; refusing to start TxSubscriber', { err })
      // Per spec §A: refuse to start; do NOT silently degrade.
      throw err
    }
    ```
  - Path D — replace with `resolveServiceAccountPersonIdOrFallback` (no throw; documented degradation).
  - Remove the sentinel comment block (Paths A/B/C); replace with degradation comment (Path D).
- **Outputs (modify `src/sync/tx-subscription.ts`):**
  - Remove SH-1 limitation note from header JSDoc (lines 24-32) under Paths A/B/C; replace with: "MR-2 (echo storm): drops tx events authored by the pod's real service-account PersonId, resolved at startup via `resolveServiceAccountPersonId` (Phase 5 P5-T-04). Layer 2 defense via `_originated:'gitlab'` marker check (Phase 5 P5-T-15)."
  - Under Path D: refresh SH-1 note to "Service-account resolution unavailable in current platform version; defense relies on layer 2 marker. See `.omc/specs/p5-t-01b-service-account-personid-api.md` Path D."
- **Outputs (modify `src/metrics.ts`):**
  - Add `METRIC_NAMES.TX_SUBSCRIPTION_SERVICE_ACCOUNT_RESOLVED = 'tx.subscription.service_account.resolved'`.
- **Outputs (tests):** `tests/util/service-account.test.ts` (NEW; ≥ 5 cases per spec §Testing Strategy):
  1. Happy path: account-client returns PersonId on first call; metric set to 1.
  2. Transient failure: 5xx, then success on retry; metric set to 1; 2 attempts logged.
  3. 3 transient failures: throws `ServiceAccountResolutionError`; metric NOT set.
  4. Permanent failure (4xx): throws immediately on first attempt; no retry.
  5. Filter behavior round-trip: TxSubscriber initialized with the resolved PersonId drops a tx with matching `modifiedBy` AND processes a tx with a different `modifiedBy`. (Integration-style — uses the existing TxSubscriber test fakes.)
  - Under Path D: cases 1-4 marked `.skip` with a runtime check; case 6 added asserting `resolveServiceAccountPersonIdOrFallback` returns sentinel + gauge=0.
- **Outputs (tests):** extend `tests/sync/tx-subscription.test.ts` with 1 case:
  - **Spec §A test assertion:** TxSubscriber receives 2 txes — one with `modifiedBy === <resolved PersonId>` (DROPPED, `echo.dropped` metric increments), one with `modifiedBy === <different PersonId>` (NOT dropped, enqueue happens).
- **Acceptance criteria:**
  - `npm test -- tests/util/service-account.test.ts tests/sync/tx-subscription.test.ts` passes all cases including the new ones.
  - `npm run lint -- src/util/service-account.ts src/index.ts src/sync/tx-subscription.ts src/metrics.ts` exits 0.
  - Paths A/B/C: `! grep -q "systemAccountUuid as unknown as PersonId" src/index.ts` (sentinel removed).
  - Path D: sentinel retained with degradation comment; metric gauge wired.
  - `grep -rq "resolveServiceAccountPersonId" src/index.ts && grep -rq "TX_SUBSCRIPTION_SERVICE_ACCOUNT_RESOLVED" src/metrics.ts` exits 0.
- **Dependencies:** P5-T-01b (BLOCKING — chosen API path; Path D admits sentinel retention).
- **Complexity:** M (~560 LOC including resolver + Path D fallback + tests + 3-retry helper + filter regression).

---

### P5-T-05 — Cookie-auth dual-verify + Bug M-4 hex pre-check + Bug L-6 cookie parser `=` + URL decode

- **Owner:** Sonnet
- **Inputs:**
  - `/Users/dingo/huly-gitlab/src/http/cookie-auth.ts` (Phase 4 — single-secret HMAC).
  - `/Users/dingo/huly-gitlab/src/util/secret-rotation.ts` (P5-T-03).
  - `/Users/dingo/huly-gitlab/tests/http/cookie-auth.test.ts` (Phase 4 — extend).
  - Phase 4 DEFERRED items M-4 (hex pre-check) + L-6 (cookie parser `=`).
- **Outputs (modify `src/http/cookie-auth.ts`):**
  - Replace single-secret `crypto.timingSafeEqual` call with `verifyHmacWithRotation(payload, sig, primary, previous)`.
  - Constructor / factory accepts `{ primary: Buffer, previous: Buffer | null }` instead of a single `serverSecret`.
  - **Bug M-4 (hex pre-check):** the existing pre-check inside `verifyHmacWithRotation` (P5-T-03) handles this for cookie-auth automatically; the call site still does an early-return on malformed cookie shape.
  - **Bug L-6 (cookie parser `=` + URL decode, critic bug B3):** modify the local cookie parser. Current bug is using `split('=')` which breaks on base64 padding. Fix EITHER:
    - **Option 1:** Replace with `cookie.indexOf('=')` + `cookie.slice(0, idx)` / `cookie.slice(idx+1)` (split on FIRST `=` only) AND `decodeURIComponent(key)` for the key portion (the key may be URL-encoded per RFC 6265).
    - **Option 2 (preferred):** Add `cookie` npm package as a dependency (small footprint, well-tested) and use `cookie.parse(header)`. Verify package.json existing deps to avoid re-adding.
  - Document the chosen option in the file header.
- **Outputs (tests):** extend `tests/http/cookie-auth.test.ts` — ≥ 7 new cases:
  1. Primary-only env: existing Phase 4 behavior preserved.
  2. Primary + previous env: cookie signed with primary → verified by primary path.
  3. Primary + previous env: cookie signed with previous (simulating mid-rotation) → verified by previous path.
  4. Primary + previous env: cookie signed with neither → 401.
  5. **Bug L-6 (split on first `=`):** cookie value containing `=` in the base64 padding (e.g., `huly-user=eyJ3IjoiX...=.eyJzaWciOiIuLi49In0=`) — parser splits on FIRST `=` only; verification succeeds.
  6. **Bug L-6 (URL-decoded key):** cookie key encoded as `huly%2Duser=value` decodes to `huly-user`; verification succeeds.
  7. **Bug M-4 regression:** cookie sig with non-hex characters (`gg`, `??`) → rejected at pre-check; no `timingSafeEqual` call ever made (verified via spy on `crypto.timingSafeEqual`).
- **Acceptance criteria:**
  - `npm test -- tests/http/cookie-auth.test.ts` passes all existing + 7 new cases.
  - `npm run lint -- src/http/cookie-auth.ts` exits 0.
  - `grep -rq "verifyHmacWithRotation" src/http/cookie-auth.ts` exits 0.
  - `! grep -n "split('=')" src/http/cookie-auth.ts` (legacy parser removed).
  - `grep -rq "decodeURIComponent\\|require('cookie')\\|from 'cookie'" src/http/cookie-auth.ts` exits 0 (URL decode OR cookie pkg in use).
- **Dependencies:** P5-T-03.
- **Complexity:** S (~220 LOC; +20 vs v1 due to URL decode + new test case).

---

### P5-T-06 — OAuth state dual-verify + Sec M-1 404-on-unknown-state (oauth.ts + user-oauth.ts)

- **Owner:** Sonnet
- **Inputs:**
  - `/Users/dingo/huly-gitlab/src/http/oauth.ts` (Phase 1+ — admin OAuth; state HMAC).
  - `/Users/dingo/huly-gitlab/src/http/user-oauth.ts` (Phase 4 — per-user OAuth).
  - `/Users/dingo/huly-gitlab/src/util/secret-rotation.ts` (P5-T-03).
  - Phase 4 DEFERRED item Sec M-1 (404 vs 401 consistency on unknown state).
- **Outputs (modify `src/http/oauth.ts` AND `src/http/user-oauth.ts`):**
  - Replace HMAC-state generation/verify with `signHmac` + `verifyHmacWithRotation` from `src/util/secret-rotation.ts`.
  - **Sec M-1:** `user-oauth.ts` `/callback` currently returns 401 on unknown state; change to **404** to match `admin oauth.ts /callback` (which already returns 404 per Phase 1). Update the redirect-on-error path: unknown state → 404 (no redirect; the redirect-on-error pattern is for KNOWN state with a downstream failure like `token_exchange_failed`).
- **Outputs (tests):** extend `tests/http/oauth.test.ts` AND `tests/http/user-oauth.test.ts` — ≥ 4 new cases each (8 total):
  1. (each file) Primary-only: existing behavior preserved.
  2. (each file) Primary + previous: state signed during rotation window verifies.
  3. (each file) **Sec M-1:** unknown state → 404 (was 401 in Phase 4 user-oauth).
  4. (each file) State signed by neither secret → 404 (admin oauth path matches user-oauth).
- **Acceptance criteria:**
  - `npm test -- tests/http/oauth.test.ts tests/http/user-oauth.test.ts` passes all existing + 8 new cases.
  - `npm run lint -- src/http/oauth.ts src/http/user-oauth.ts` exits 0.
  - `grep -rq "verifyHmacWithRotation" src/http/oauth.ts && grep -rq "verifyHmacWithRotation" src/http/user-oauth.ts` exits 0.
  - `grep -n "res.status(404)" src/http/user-oauth.ts` shows the unknown-state branch (Sec M-1).
- **Dependencies:** P5-T-03.
- **Complexity:** S (~240 LOC across both http files + tests).

---

### P5-T-07 — DELETED (was: Webhook secret dual-verify rotation)

**Status:** DELETED per critic finding 4.

**Reason:** Webhook secrets are per-binding (`binding.webhookSecretRef`), not pod-wide. There is no pod-wide webhook secret to rotate via `ServerSecretPrevious`. Per-binding rotation is already covered by the existing `POST /api/v1/bindings/:id/rotate-secret` endpoint.

**Out-of-scope documentation:** Phase 5 runbook (P5-T-29) MUST document this distinction clearly so operators understand:

- Cookie/OAuth state HMAC rotation: use `ServerSecretPrevious` env (Phase 5 §B).
- Per-binding webhook secret rotation: use existing `POST /api/v1/bindings/:id/rotate-secret` endpoint (Phase 1-3).

No tests, no code, no helper changes. Task count: 31 → 30.

---

### P5-T-08 — `originated-marker.ts` helper + IssuesSyncManager stamper (Wave C LEAD)

- **Owner:** Sonnet
- **Inputs:**
  - `/Users/dingo/huly-gitlab/src/sync/issues.ts` (Phase 1 — applyRemote write paths).
  - `/Users/dingo/huly-gitlab/.omc/specs/deep-interview-huly-gitlab-phase5.md` §C.
- **Critic finding 6 — LEAD task:** P5-T-08 runs FIRST and ALONE in Wave C. It creates the shared `originated-marker.ts` helper AND wires the first stamper (IssuesSyncManager). After P5-T-08 lands, the other 6 stampers (T-09..T-14) run in parallel (width 6).
- **Outputs (new file `src/sync/originated-marker.ts`):**
  - `withOriginatedMarker<T extends object>(attrs: T): T & { _originated: 'gitlab' }`:
    ```ts
    export function withOriginatedMarker<T extends object>(attrs: T): T & { _originated: 'gitlab' } {
      return { ...attrs, _originated: 'gitlab' as const }
    }
    ```
  - JSDoc: documents the marker shape, the locations TxSubscriber checks for it (TxMixin/TxCreateDoc/TxUpdateDoc attribute payloads; NOT TxRemoveDoc — critic finding 5), and the layer-2 defense rationale.
- **Outputs (modify `src/sync/issues.ts`):**
  - On EVERY `hulyClient.createDoc(...)` / `updateDoc(...)` / `createMixin(...)` / `updateMixin(...)` call inside `applyRemote`, stamp `_originated: 'gitlab'` on the attributes object via `withOriginatedMarker`.
- **Outputs (tests):** extend `tests/sync/issues.test.ts` — ≥ 4 new cases per spec §Testing Strategy:
  1. `applyRemote` createDoc carries `_originated: 'gitlab'` in attrs.
  2. `applyRemote` updateDoc carries the marker (including under `$set` and `$inc` operators per critic bug B2).
  3. `applyRemote` createMixin carries the marker on the mixin attrs object.
  4. `applyRemote` updateMixin carries the marker.
- **Outputs (tests for `originated-marker.ts`):** `tests/sync/originated-marker.test.ts` (NEW; ≥ 2 cases):
  1. Marker preserved through `withOriginatedMarker(obj)` shape.
  2. Marker visible at root level of the returned object (consumed by P5-T-15 probe; critic bug B2).
- **Acceptance criteria:**
  - `npm test -- tests/sync/issues.test.ts tests/sync/originated-marker.test.ts` passes new cases.
  - `npm run lint -- src/sync/issues.ts src/sync/originated-marker.ts` exits 0.
  - `grep -rq "withOriginatedMarker" src/sync/issues.ts && grep -rq "_originated.*gitlab" src/sync/originated-marker.ts` exits 0.
- **Dependencies:** none (Wave C LEAD).
- **Complexity:** S (~200 LOC including helper + 4 issues tests + 2 helper tests).

---

### P5-T-09 — MergeRequestsSyncManager stamper

- **Owner:** Sonnet
- **Inputs:**
  - `/Users/dingo/huly-gitlab/src/sync/mr.ts` (Phase 1-4; applyRemote write paths).
  - `/Users/dingo/huly-gitlab/src/sync/originated-marker.ts` (P5-T-08).
- **Outputs:** stamp marker on every createDoc/updateDoc/createMixin/updateMixin inside `mr.ts` `applyRemote`.
- **Outputs (tests):** extend `tests/sync/mr.test.ts` — ≥ 4 new cases (matching T-08 shape, including `$set`/`$inc` probe per critic bug B2).
- **Acceptance criteria:**
  - `npm test -- tests/sync/mr.test.ts` passes 4 new cases.
  - `grep -rq "withOriginatedMarker" src/sync/mr.ts` exits 0.
- **Dependencies:** P5-T-08 (helper file).
- **Complexity:** S (~120 LOC).

---

### P5-T-10 — mr-approvals stamper

- **Owner:** Sonnet
- **Inputs:**
  - `/Users/dingo/huly-gitlab/src/sync/mr-approvals.ts` (Phase 4 extraction).
- **Outputs:** stamp marker on every mixin-write inside `mr-approvals.ts`.
- **Outputs (tests):** extend `tests/sync/mr-approvals.test.ts` (or `tests/sync/mr.test.ts` if no dedicated file) — ≥ 4 new cases.
- **Acceptance criteria:**
  - `npm test -- tests/sync/mr-approvals.test.ts` (or merged with mr.test.ts) passes new cases.
  - `grep -rq "withOriginatedMarker" src/sync/mr-approvals.ts` exits 0.
- **Dependencies:** P5-T-08.
- **Complexity:** S (~80 LOC — mr-approvals is smaller surface).

---

### P5-T-11 — ReviewThreadsSyncManager stamper

- **Owner:** Sonnet
- **Inputs:**
  - `/Users/dingo/huly-gitlab/src/sync/mr-review.ts` (Phase 3+4).
- **Outputs:** stamp marker on every createDoc/createMixin/updateMixin.
- **Outputs (tests):** extend `tests/sync/mr-review.test.ts` — ≥ 4 new cases.
- **Acceptance criteria:**
  - `npm test -- tests/sync/mr-review.test.ts` passes new cases.
  - `grep -rq "withOriginatedMarker" src/sync/mr-review.ts` exits 0.
- **Dependencies:** P5-T-08.
- **Complexity:** S (~120 LOC).

---

### P5-T-12 — NotesSyncManager stamper

- **Owner:** Sonnet
- **Inputs:**
  - `/Users/dingo/huly-gitlab/src/sync/notes.ts` (Phase 1+2).
- **Outputs:** stamp marker.
- **Outputs (tests):** extend `tests/sync/notes.test.ts` — ≥ 4 new cases.
- **Acceptance criteria:**
  - `npm test -- tests/sync/notes.test.ts` passes new cases.
  - `grep -rq "withOriginatedMarker" src/sync/notes.ts` exits 0.
- **Dependencies:** P5-T-08.
- **Complexity:** S (~120 LOC).

---

### P5-T-13 — PipelineSyncManager stamper

- **Owner:** Sonnet
- **Inputs:**
  - `/Users/dingo/huly-gitlab/src/sync/pipeline.ts` (Phase 2).
- **Outputs:** stamp marker on the pipelineStatus mixin write path.
- **Outputs (tests):** extend `tests/sync/pipeline.test.ts` — ≥ 4 new cases.
- **Acceptance criteria:**
  - `npm test -- tests/sync/pipeline.test.ts` passes new cases.
  - `grep -rq "withOriginatedMarker" src/sync/pipeline.ts` exits 0.
- **Dependencies:** P5-T-08.
- **Complexity:** S (~100 LOC).

---

### P5-T-14 — EpicsSyncManager stamper

- **Owner:** Sonnet
- **Inputs:**
  - `/Users/dingo/huly-gitlab/src/sync/epics.ts` (Phase 4).
- **Outputs:** stamp marker (already noted as "MR-2 defense-in-depth" in P4-T-06 acceptance criteria #13; this task verifies the helper-based implementation lands and centralizes via `withOriginatedMarker`).
- **Outputs (tests):** extend `tests/sync/epics.test.ts` — ≥ 4 new cases (the existing P4-T-06 case #13 verified the marker but used a hand-rolled `_originated` literal; replace with helper-based).
- **Acceptance criteria:**
  - `npm test -- tests/sync/epics.test.ts` passes 4 new cases.
  - `grep -rq "withOriginatedMarker" src/sync/epics.ts` exits 0.
- **Dependencies:** P5-T-08.
- **Complexity:** S (~100 LOC; partial work already in Phase 4).

---

### P5-T-15 — TxSubscriber `_originated` marker check restoration + round-trip test

- **Owner:** Opus
- **Inputs:**
  - `/Users/dingo/huly-gitlab/src/sync/tx-subscription.ts:160-200` (Phase 4 — `onTx` currently has ONLY the service-account filter; marker check was removed in Phase 4 fix B3).
  - `/Users/dingo/huly-gitlab/.omc/specs/deep-interview-huly-gitlab-phase5.md` §C.
  - All Wave C stampers (P5-T-08..P5-T-14 must land first).
- **Critic finding 5 — TxRemoveDoc carve-out:** TxRemoveDoc has no `attributes` payload. The marker check is N/A for removes. The service-account PersonId filter (layer 1) is the SOLE defense for TxRemoveDoc echo-storm prevention. Document this explicitly in spec §C and in this task's JSDoc.
- **Outputs (modify `src/sync/tx-subscription.ts`):**
  - In `onTx`, AFTER the service-account `tx.modifiedBy` check, ALSO inspect the tx's attribute payload for `_originated: 'gitlab'`. The attribute payload location varies by tx class:
    - `TxMixin` → `tx.attributes._originated`
    - `TxCreateDoc` → `tx.attributes._originated`
    - `TxUpdateDoc` → `tx.operations._originated` AND/OR `tx.operations.$set?._originated` AND/OR `tx.operations.$inc?._originated` (critic bug B2: probe BOTH the root and the `$set`/`$inc` payload locations; if marker is not visible at root, stamper writes to both locations for resilience).
    - `TxRemoveDoc` → **carve-out (critic finding 5):** no attribute payload; marker check is N/A. Service-account filter is sole defense.
  - If marker found: DROP; increment `tx.subscription.marker.dropped` metric (distinct from service-account `echo.dropped` for observability).
  - Updated header JSDoc: clears the "MR-2 protection is single-layer" note from Phase 4 (which P5-T-04 already cleared SH-1; this task clears the marker portion). Adds note: "TxRemoveDoc relies on layer-1 service-account filter only; marker check is N/A for removes."
- **Outputs (modify stampers under TxUpdateDoc paths — back-stamp coordination with Wave C):**
  - For all stampers (T-08..T-14) where the manager emits TxUpdateDoc with `$set` or `$inc` operators, verify that `withOriginatedMarker` is applied AT THE ROOT of the operations object. If the platform serializes `$set`/`$inc` such that the root `_originated` is dropped, the stamper writes to BOTH the root AND the operator-nested location. P5-T-15 includes a probe test (case 3 below) that verifies the location TxSubscriber actually sees the marker; if the probe fails, the LEAD task P5-T-08 helper grows a second variant `withOriginatedMarkerForOperators(ops)` that handles operator nesting.
- **Outputs (modify `src/metrics.ts`):**
  - Add `METRIC_NAMES.TX_SUBSCRIPTION_MARKER_DROPPED = 'tx.subscription.marker.dropped'` (distinct from service-account `echo.dropped` for observability).
- **Outputs (tests):** extend `tests/sync/tx-subscription.test.ts` — ≥ 7 new cases:
  1. Tx with `_originated: 'gitlab'` in TxMixin attrs → DROPPED; `tx.subscription.marker.dropped` increments; enqueue NOT called.
  2. Tx with `_originated: 'gitlab'` in TxCreateDoc attrs → DROPPED.
  3. **Critic bug B2:** Tx with `_originated: 'gitlab'` in TxUpdateDoc operations under `$set` → DROPPED. Probe asserts marker visibility at expected location; if NOT visible at root, fallback path activates (assertion includes both root + `$set` location).
  4. **Critic bug B2:** Tx with `_originated: 'gitlab'` in TxUpdateDoc operations under `$inc` → DROPPED.
  5. **Critic finding 5:** Tx of class TxRemoveDoc with service-account `modifiedBy` → DROPPED via layer 1. Tx of class TxRemoveDoc with non-service-account `modifiedBy` → PROCESSED (marker check N/A, no second-layer fallback for removes).
  6. Tx WITHOUT marker AND modifiedBy !== service-account → PROCESSED (enqueue called once).
  7. Tx WITH marker AND modifiedBy !== service-account → DROPPED (defense-in-depth catches it even when service-account fails; covers Path D degradation scenario).
- **Outputs (round-trip tests):** extend EACH of `tests/sync/issues.test.ts`, `mr.test.ts`, `mr-approvals.test.ts`, `mr-review.test.ts`, `notes.test.ts`, `pipeline.test.ts`, `epics.test.ts` with 1 round-trip integration test:
  - `applyRemote` writes a doc; capture the synthesised tx; pipe through TxSubscriber.onTx; assert DROPPED (marker present). This validates the full echo-storm prevention loop. **Critic bug B1:** For `mr.test.ts` specifically, after P5-T-17 lands (writer split), the round-trip MUST assert that BOTH `buildCoreMixinData` + `buildReviewMixinData` mixin txes are dropped by TxSubscriber (quantifier over both mixin writes, not just one).
- **Acceptance criteria:**
  - `npm test -- tests/sync/tx-subscription.test.ts` passes all 7 new cases.
  - `npm test -- tests/sync/{issues,mr,mr-approvals,mr-review,notes,pipeline,epics}.test.ts` round-trip tests pass.
  - `grep -rq "TX_SUBSCRIPTION_MARKER_DROPPED" src/metrics.ts && grep -rq "_originated" src/sync/tx-subscription.ts && grep -rA2 "_originated" src/sync/tx-subscription.ts | grep -q "DROP\\|return"` exits 0.
  - `grep -rq "TxRemoveDoc" src/sync/tx-subscription.ts` (carve-out documented).
- **Dependencies:** P5-T-08, P5-T-09, P5-T-10, P5-T-11, P5-T-12, P5-T-13, P5-T-14 (ALL stampers must land for round-trip tests).
- **Complexity:** M (~520 LOC including marker check restoration + 7 unit tests + 7 round-trip integration tests + TxRemoveDoc carve-out + `$set`/`$inc` probe).

---

### P5-T-16 — `readMRMixinAttributes` shared reader (L-5 + mixin-split read-compat)

- **Owner:** Sonnet
- **Inputs:**
  - `/Users/dingo/huly-gitlab/src/sync/mr.ts` (current reader call sites — `hulyClient.findOne` with mixin filter).
  - `/Users/dingo/huly-gitlab/src/sync/mr-approvals.ts`.
  - `/Users/dingo/huly-gitlab/src/sync/mr-review.ts`.
  - Phase 4 DEFERRED item L-5.
- **Outputs (new file `src/sync/mr-mixin-reader.ts`):**
  - `readMRMixinAttributes(hulyClient, docRef): Promise<{core: MRCoreMixinDoc | null, review: MRReviewMixinDoc | null, legacy: MRMixinDoc | null}>`
    - Reads ALL three mixins in parallel.
    - During migration window: returns whichever are present.
    - Caller chooses precedence (typically: new core+review preferred, legacy fallback).
  - `mergeMRMixinView(reader: ReaderResult): MergedMRView` — combines the three into a flat view for backward-compatible call sites. Throws when contradiction detected (e.g., legacy `sourceBranch: 'A'` vs core `sourceBranch: 'B'`); the throw indicates a migration bug and is caught by `mr-review` write paths to surface as a metric `mixin.migration.contradiction`.
- **Outputs (tests):** `tests/sync/mr-mixin-reader.test.ts` (NEW; ≥ 6 cases):
  1. Only legacy mixin present (pre-migration): returns `legacy` populated.
  2. Only new core+review present (post-migration): returns those populated.
  3. Both present (mid-migration): both populated; merge prefers new.
  4. Neither present: all three null.
  5. Contradiction (legacy.sourceBranch !== core.sourceBranch): throws.
  6. `mergeMRMixinView` shape stable across all 3 modes (legacy-only / split-only / both).
- **Acceptance criteria:**
  - `npm test -- tests/sync/mr-mixin-reader.test.ts` passes all 6 cases.
  - `npm run lint -- src/sync/mr-mixin-reader.ts` exits 0.
- **Dependencies:** P5-T-02.
- **Complexity:** M (~360 LOC).

---

### P5-T-17 — Writer split: MergeRequestsSyncManager → write to core + review mixins

- **Owner:** Opus
- **Inputs:**
  - `/Users/dingo/huly-gitlab/src/sync/mr.ts` (applyRemote + mixin-write build helpers).
  - `/Users/dingo/huly-gitlab/src/sync/mr-mixin-reader.ts` (P5-T-16).
  - `/Users/dingo/huly-gitlab/src/sync/mr-core-mixin.ts` + `mr-review-mixin-doc.ts` (P5-T-02).
- **Outputs (modify `src/sync/mr.ts`):**
  - `buildMixinCreateData` splits into `buildCoreMixinData` + `buildReviewMixinData` (the latter populates the optional Phase 3/4 fields ONLY when present).
  - `applyRemote` mixin-write path: `createMixin(MR_CORE_MIXIN, coreData)` THEN `createMixin(MR_REVIEW_MIXIN_DOC, reviewData)` (or `updateMixin` for the update path).
  - Reads use `readMRMixinAttributes` from P5-T-16.
  - **AC-1 (Phase 4) preserved:** MergeRequestsSyncManager STILL does not write `parentEpicIid` (which now lives on `gitlab-mr-review`). EpicsSyncManager-side `updateMixin` calls `updateMixin(MR_REVIEW_MIXIN_DOC, { parentEpicIid })` — see P5-T-18 for the symmetric epic-side change.
  - **Both writes stamp `_originated:'gitlab'`** via `withOriginatedMarker` (P5-T-08 helper).
- **Outputs (tests):** extend `tests/sync/mr.test.ts` — ≥ 7 new cases:
  1. `applyRemote` creates both `gitlab-mr-core` AND `gitlab-mr-review` mixins on a fresh doc.
  2. `applyRemote` on an EE doc populates `approvalRules` + `iteration` on `gitlab-mr-review`.
  3. `applyRemote` on a CE doc leaves the EE fields undefined on `gitlab-mr-review` (B2 contract).
  4. `applyRemote` does NOT write `parentEpicIid` to `gitlab-mr-review` (AC-1 carries forward).
  5. `applyRemote` legacy-doc read path: reads via `readMRMixinAttributes` and writes ONLY to new mixins; legacy mixin is NOT updated (migration is one-way).
  6. **Critic bug B1:** Round-trip — `applyRemote` writes `buildCoreMixinData` AND `buildReviewMixinData`. Both synthesised txes pipe through TxSubscriber. ASSERT BOTH are DROPPED (quantifier: count of dropped txes from this write === 2). The marker check applies to BOTH mixin writes, not just the first one.
  7. **Critic bug B4 — backfill drain coordination:** if `binding.backfillInFlight === true`, P5-T-17 acceptance asserts that writer-split does NOT race against backfill (test injects a delay; verifies serialization).
- **Acceptance criteria:**
  - `npm test -- tests/sync/mr.test.ts` passes all new cases.
  - `npm run lint -- src/sync/mr.ts` exits 0.
  - `grep -rq "MR_CORE_MIXIN" src/sync/mr.ts && grep -rq "MR_REVIEW_MIXIN_DOC" src/sync/mr.ts` exits 0.
- **Dependencies:** P5-T-02, P5-T-09 (stamper), P5-T-16 (reader helper).
- **Complexity:** L (~940 LOC including refactor + 7 tests + backfill-drain coordination).

---

### P5-T-18 — Writer split: mr-approvals + mr-review (epic-side parentEpicIid)

- **Owner:** Opus
- **Inputs:**
  - `/Users/dingo/huly-gitlab/src/sync/mr-approvals.ts` (Phase 4 — extracted approval-status writes).
  - `/Users/dingo/huly-gitlab/src/sync/mr-review.ts` (Phase 3+4 — review-thread mixin; NOT to be confused with the new `gitlab-mr-review` mixin which is for MR review-side fields).
  - `/Users/dingo/huly-gitlab/src/sync/epics.ts` (Phase 4 — writes `parentEpicIid` to child MR mirrors; must update to target `MR_REVIEW_MIXIN_DOC`).
- **Outputs (modify all three managers):**
  - `mr-approvals.ts`: write `approvalStatus` + `approvedBy` to `MR_REVIEW_MIXIN_DOC` (not legacy `MR_MIXIN`).
  - `mr-review.ts`: write `changedFiles` / `diffWebUrl` / `reviewers` to `MR_REVIEW_MIXIN_DOC`. The review-thread mixin (now `MR_REVIEW_THREAD_MIXIN`) is unchanged.
  - `epics.ts`: write `parentEpicIid` to `MR_REVIEW_MIXIN_DOC` on MR-mirror children (and to `gitlab-issue` mixin on issue-mirror children, unchanged).
  - All writes use `withOriginatedMarker`.
  - The Phase 4 AC-1 SOLE-WRITER invariant for `parentEpicIid` is REASSERTED in JSDoc with the new mixin target.
- **Outputs (tests):** extend `tests/sync/mr-approvals.test.ts`, `tests/sync/mr-review.test.ts`, `tests/sync/epics.test.ts` — ≥ 9 cases total (3 per file):
  1. (mr-approvals) approvalStatus written to `gitlab-mr-review` mixin.
  2. (mr-approvals) AC-1 NOT writing core fields.
  3. (mr-review) changedFiles/diffWebUrl/reviewers written to `gitlab-mr-review`.
  4. (mr-review) review-thread mixin (`MR_REVIEW_THREAD_MIXIN`) writes unchanged.
  5. (epics) parentEpicIid written to `gitlab-mr-review` (MR mirror).
  6. (epics) parentEpicIid written to `gitlab-issue` (issue mirror; existing Phase 4 behavior).
  7. (epics) AC-1: EpicsSyncManager is sole writer (MR + mr-approvals + mr-review tests assert NONE of them touch parentEpicIid).
- **Acceptance criteria:**
  - `npm test -- tests/sync/mr-approvals.test.ts tests/sync/mr-review.test.ts tests/sync/epics.test.ts` passes new cases.
  - All existing regression tests pass.
- **Dependencies:** P5-T-02, P5-T-10, P5-T-11, P5-T-14, P5-T-16.
- **Complexity:** L (~800 LOC).

---

### P5-T-19 — `mixin-migration.ts` helper + admin endpoint

- **Owner:** Opus
- **Inputs:**
  - `/Users/dingo/huly-gitlab/src/http/binding.ts` (Phase 3 — operator-paused migration endpoint pattern from reviewer-migration).
  - `/Users/dingo/huly-gitlab/src/sync/mr-mixin-reader.ts` (P5-T-16).
  - `/Users/dingo/huly-gitlab/src/sync/binding-lifecycle.ts` (Phase 1-4 — pause/resume hooks).
  - Spec §D Migration.
- **Critic bug B4 — backfill drain coordination:** the migration endpoint MUST wait for in-flight backfill to drain before stripping the legacy mixin. Add a `binding.backfillInFlight` flag (boolean) that:
  - Set to `true` when backfill starts (binding-lifecycle hook).
  - Set to `false` when backfill completes / aborts.
  - The migration `run` method polls `binding.backfillInFlight` and waits (with timeout 5 minutes) until it is `false` before the strip step. On timeout, returns a partial report and does NOT strip; operator must retry.
  - Alternative: add a short pause delay (default 30s) after binding pause to allow in-flight events to drain.
- **Outputs (new file `src/sync/mixin-migration.ts`):**
  - `class MixinSplitMigration`:
    - `constructor(deps: { hulyClient, store, logger })`.
    - `async run(bindingRef: string, opts: { dryRun?: boolean, drainTimeoutMs?: number }): Promise<MigrationReport>`:
      1. Verify `binding.paused === true`; return 409 equivalent if not (caller handles HTTP).
      2. **Critic bug B4:** Poll `binding.backfillInFlight` until false OR drainTimeoutMs elapsed. On timeout: return partial report; do NOT proceed to step 3.
      3. Iterate every mirrored Issue under the binding (via idmap kind='mr' AND kind='issue').
      4. Read legacy `gitlab-mr` mixin via `findOne`.
      5. If no legacy mixin OR new mixins already present: skip (idempotent).
      6. Construct `coreData` from the 8 core fields.
      7. Construct `reviewData` from the 8 optional review fields (omit undefined).
      8. `createMixin(MR_CORE_MIXIN, coreData)` + `createMixin(MR_REVIEW_MIXIN_DOC, reviewData)` (both stamped with `_originated:'gitlab'`).
      9. Remove the legacy `gitlab-mr` mixin via `updateDoc({$unset: {[MR_MIXIN]: ''}})` — actual Huly platform API may differ; verify in P5-T-01b-style sub-investigation if time permits, otherwise document as a forward step in `docs/phase5-runbook.md` where the cleanup is done post-migration.
      10. Increment `mixin.migration.success` metric per doc; collect failures into report.
    - Idempotent: re-running on a migrated doc is a no-op.
- **Outputs (modify `src/sync/binding-lifecycle.ts`):**
  - Add `backfillInFlight: boolean` field to Binding state. Set true at backfill start; clear at backfill completion / abort.
- **Outputs (modify `src/http/binding.ts`):**
  - Add `POST /api/v1/bindings/:id/migrate-mixin-split` route. Body: `{ dryRun?: boolean, drainTimeoutMs?: number }`. Bearer-protected (admin).
  - REQUIRES the binding to be PAUSED first (matches Phase 3 reviewer-migration UX). If not paused: 409 Conflict with message `'binding must be paused before mixin-split migration'`.
  - Returns `MigrationReport` JSON: `{ totalDocs, migrated, skipped, failed, durationMs, drainWaitedMs }`.
- **Outputs (tests):** `tests/sync/mixin-migration.test.ts` + extend `tests/http/binding.test.ts` — ≥ 9 cases per spec §Testing Strategy (was 8; +1 for backfill drain):
  1. `run` on a binding with 3 legacy docs migrates all 3.
  2. `run` is idempotent: second invocation skips all.
  3. `run` with `dryRun: true` reports without writing.
  4. `run` on a doc missing legacy mixin: skipped.
  5. `run` on a doc with mixed state (legacy + new partially present): handled gracefully; new mixins replaced from legacy source-of-truth.
  6. `run` failure on one doc does NOT halt the migration; report includes the failure.
  7. (binding endpoint) Migration requires paused binding; 409 when active.
  8. (binding endpoint) Migration endpoint requires bearer; 401 without.
  9. **Critic bug B4:** `run` with `binding.backfillInFlight === true` blocks until flag clears; on flag clear, migration proceeds; on timeout, returns partial report.
- **Acceptance criteria:**
  - `npm test -- tests/sync/mixin-migration.test.ts tests/http/binding.test.ts` passes all 9 cases.
  - `npm run lint -- src/sync/mixin-migration.ts src/http/binding.ts src/sync/binding-lifecycle.ts` exits 0.
  - `grep -rq "POST.*/migrate-mixin-split" src/http/binding.ts && grep -rq "MixinSplitMigration" src/sync/mixin-migration.ts && grep -rq "backfillInFlight" src/sync/binding-lifecycle.ts` exits 0.
- **Dependencies:** P5-T-02, P5-T-16.
- **Complexity:** L (~960 LOC; +60 vs v1 due to backfill drain coordination).

---

### P5-T-20 — Reader-compat sweep + Architect L-1 stale-on-unresolve clear

- **Owner:** Sonnet
- **Inputs:**
  - All read sites in `src/sync/*.ts` that previously called `findOne(MR_MIXIN)` (P5-T-09..P5-T-14 stamper landings will have surfaced a list).
  - Phase 4 DEFERRED Architect L-1: review-thread `stale-on-unresolve` mixin field clear.
  - `/Users/dingo/huly-gitlab/src/sync/mr-review.ts` (stale clear site).
- **Outputs:**
  - Every reader that previously consumed the legacy mixin now goes through `readMRMixinAttributes` from P5-T-16 (which returns the merged view).
  - **L-1 fix:** in `mr-review.ts` review-thread resolution path, when a thread transitions from resolved → unresolved, explicitly clear the `staleOnUnresolve` mixin field (current Phase 3 path leaves stale data). Add a test asserting the clear.
- **Outputs (tests):** ≥ 6 new cases across `tests/sync/*.test.ts` covering: read-from-legacy-only (3 manager files), read-from-new-only (3 manager files), and L-1 stale-clear (1 case in mr-review).
- **Acceptance criteria:**
  - `npm test -- tests/sync/` passes all old + new cases.
  - `! grep -rn "findOne.*MR_MIXIN[^_]" src/sync/` (legacy direct-read sites all migrated; the `[^_]` rules out `MR_MIXIN_DOC` etc).
  - `grep -rq "L-1.*stale" src/sync/mr-review.ts` exits 0 (or equivalent stale-clear marker).
- **Dependencies:** P5-T-16, P5-T-17, P5-T-18, P5-T-19.
- **Complexity:** M (~480 LOC).

---

### P5-T-21 — GraphQL client core (`gitlab-graphql-client.ts`) + capability detection + cache bust

- **Owner:** Opus
- **Inputs:**
  - `/Users/dingo/huly-gitlab/src/adapter/gitlab-client.ts` (Phase 1-4 — REST client; pattern reference).
  - `/Users/dingo/huly-gitlab/src/adapter/capabilities.ts` (Phase 1 — capability cache extension target).
  - `/Users/dingo/huly-gitlab/package.json` — verify `graphql-request` already present from Phase 1 (per spec). If not: add.
  - Spec §E.
- **Critic bug B5 — cache invalidation:** the 1h capability cache MUST be bustable on bind-time config change AND via a manual admin endpoint. v1's "TTL 1h" alone is insufficient because operators may change baseUrl/token mid-flight and stale capability data would route them to a dead GraphQL endpoint.
- **Outputs (new file `src/adapter/gitlab-graphql-client.ts`):**
  - `class GitLabGraphQLClient`:
    - Constructor: `{ baseUrl, token, logger }`.
    - `async capability(): Promise<{ available: boolean, schemaVersion: string | null }>` — sends a probe query (`query { metadata { version } }`) and caches the result for 1h. On any error (4xx, 5xx, network) returns `{ available: false, schemaVersion: null }`.
    - `invalidateCapability(): void` — clears the cached capability result; next `capability()` call re-probes. Called by:
      - `BindingLifecycle.onConfigChange` (bind-time config change bust).
      - The new `POST /api/v1/admin/invalidate-graphql-cache` admin endpoint (manual operator bust).
    - `async getMergeRequestComposite(projectId, mrIid): Promise<SyncMergeRequest | null>` — single GraphQL query collapsing 5 REST calls.
    - `async listEpicsWithChildren(groupId, opts): Promise<SyncEpic[]>` — single query with nested issue IIDs.
    - `async listMergeRequestsWithApprovals(projectId, opts): Promise<SyncMergeRequest[]>` — single query with embedded approval data.
  - GraphQL query strings stored as const string templates at the top of the file with inline schema-version comments.
- **Outputs (modify `src/adapter/capabilities.ts`):**
  - Extend the capability struct with `graphqlAvailable: boolean` + `graphqlSchemaVersion: string | null`.
  - `detectCapabilities` probes GraphQL via the new client; cached for 1h with bust hooks per critic bug B5.
- **Outputs (modify `src/adapter/gitlab-client.ts`):**
  - Constructor optionally accepts a `graphqlClient: GitLabGraphQLClient | null` (null disables GraphQL preference). When non-null, `getMergeRequest` / `listEpics` / `listMergeRequests` gate on `capabilities.graphqlAvailable` to use GraphQL first; fall back to REST on GraphQL failure.
- **Outputs (modify `src/http/admin.ts` or `src/http/binding.ts`):**
  - Add `POST /api/v1/admin/invalidate-graphql-cache` (bearer-protected). Calls `gitlabClient.graphqlClient?.invalidateCapability()` for all active bindings; returns 200 with count of invalidations.
- **Outputs (modify `src/sync/binding-lifecycle.ts`):**
  - `onConfigChange(binding)` hook: if `binding.baseUrl` or `binding.token` changed, call `binding.gitlabClient.graphqlClient?.invalidateCapability()`.
- **Outputs (tests):** `tests/adapter/gitlab-graphql-client.test.ts` (NEW; ≥ 10 cases; +2 vs v1 for cache-bust):
  1. Capability probe returns `available: true` with version on EE GraphQL endpoint.
  2. Capability probe returns `available: false` on 404 (REST-only deployment).
  3. Capability probe returns `available: false` on network error.
  4. Capability result cached for 1h (second call within 1h does NOT re-probe).
  5. **Critic bug B5:** `invalidateCapability()` forces re-probe on next `capability()` call.
  6. **Critic bug B5:** `BindingLifecycle.onConfigChange` triggers `invalidateCapability()` when baseUrl changes.
  7. `getMergeRequestComposite` happy path maps to `SyncMergeRequest`.
  8. `getMergeRequestComposite` on GraphQL error returns null (caller falls back to REST).
  9. `listEpicsWithChildren` happy path returns SyncEpic[] with `childIssueIids` populated.
  10. `listMergeRequestsWithApprovals` happy path returns SyncMergeRequest[] with approvals embedded.
- **Acceptance criteria:**
  - `npm test -- tests/adapter/gitlab-graphql-client.test.ts` passes all 10 cases.
  - `npm run lint -- src/adapter/gitlab-graphql-client.ts src/adapter/capabilities.ts` exits 0.
  - `grep -rq "GitLabGraphQLClient" src/adapter/gitlab-graphql-client.ts && grep -rq "graphqlAvailable" src/adapter/capabilities.ts && grep -rq "invalidate-graphql-cache" src/http/` exits 0.
- **Dependencies:** none (Wave E lead task).
- **Complexity:** L (~1280 LOC including queries + fixtures + cache + bust hooks + admin endpoint).

---

### P5-T-22 — GraphQL-preferred composite `getMergeRequest`

- **Owner:** Sonnet
- **Inputs:**
  - `/Users/dingo/huly-gitlab/src/adapter/gitlab-client.ts` (`getMergeRequest` — 5-call composite on EE).
  - `/Users/dingo/huly-gitlab/src/adapter/gitlab-graphql-client.ts` (P5-T-21).
- **Outputs (modify `src/adapter/gitlab-client.ts`):**
  - `getMergeRequest`: if `capabilities.graphqlAvailable && this.graphqlClient !== null`, call `graphqlClient.getMergeRequestComposite(projectId, mrIid)` first; on null/error result, fall back to existing 5-call REST composite.
  - Metric: increment `mr.composite.path` with label `graphql` or `rest`.
- **Outputs (tests):** extend `tests/adapter/gitlab-client-ee.test.ts` — ≥ 3 new cases:
  1. GraphQL preference: when `graphqlAvailable === true`, GraphQL path used; REST endpoints NOT called.
  2. **Spec §E REST fallback:** GraphQL fails → REST composite runs; equivalent SyncMergeRequest shape returned (deep equality comparison).
  3. CE (no GraphQL): REST composite runs directly; no GraphQL probe attempted.
- **Acceptance criteria:**
  - `npm test -- tests/adapter/gitlab-client-ee.test.ts` passes new cases.
  - `grep -rq "graphqlClient.getMergeRequestComposite" src/adapter/gitlab-client.ts` exits 0.
- **Dependencies:** P5-T-21 (serial — Wave E fully serial per critic finding 2).
- **Complexity:** M (~400 LOC).

---

### P5-T-23 — GraphQL-preferred `listEpicsWithChildren`

- **Owner:** Sonnet
- **Inputs:**
  - `/Users/dingo/huly-gitlab/src/adapter/gitlab-client.ts` (`listEpics` + per-epic `listEpicIssues`).
  - `/Users/dingo/huly-gitlab/src/adapter/gitlab-graphql-client.ts` (P5-T-21).
- **Outputs:** in `gitlab-client.ts`, add `listEpicsWithChildren(groupId, opts)` that prefers GraphQL; REST fallback chains `listEpics` + N×`listEpicIssues`. Update `EpicsSyncManager.backfill` (P4) to call the new method.
- **Outputs (tests):** extend `tests/adapter/gitlab-client-ee.test.ts` + `tests/sync/epics.test.ts` — ≥ 3 cases:
  1. GraphQL preference: 1 call vs N+1 REST.
  2. REST fallback equivalent shape.
  3. EpicsSyncManager backfill uses the new method.
- **Acceptance criteria:**
  - `npm test -- tests/adapter/gitlab-client-ee.test.ts tests/sync/epics.test.ts` passes.
  - `grep -rq "listEpicsWithChildren" src/adapter/gitlab-client.ts && grep -rq "listEpicsWithChildren" src/sync/epics.ts` exits 0.
- **Dependencies:** P5-T-22 (serial).
- **Complexity:** M (~400 LOC).

---

### P5-T-24 — GraphQL-preferred `listMergeRequestsWithApprovals`

- **Owner:** Sonnet
- **Inputs:**
  - `/Users/dingo/huly-gitlab/src/adapter/gitlab-client.ts` (`listMergeRequests` + per-MR approvals fetch).
  - `/Users/dingo/huly-gitlab/src/adapter/gitlab-graphql-client.ts` (P5-T-21).
- **Outputs:** add `listMergeRequestsWithApprovals(projectId, opts)`. EE-only path; CE falls back to `listMergeRequests` with empty `approvalRules: []`.
- **Outputs (tests):** extend `tests/adapter/gitlab-client-ee.test.ts` — ≥ 3 cases (GraphQL pref, REST fallback, CE empty).
- **Acceptance criteria:**
  - `npm test -- tests/adapter/gitlab-client-ee.test.ts` passes.
  - `grep -rq "listMergeRequestsWithApprovals" src/adapter/gitlab-client.ts` exits 0.
- **Dependencies:** P5-T-23 (serial).
- **Complexity:** M (~400 LOC).

---

### P5-T-25 — Image/file position adapter mapping + mr-review.ts position write

- **Owner:** Sonnet
- **Inputs:**
  - `/Users/dingo/huly-gitlab/src/adapter/gitlab-client.ts` (`listDiscussions` — currently filters non-text positions).
  - `/Users/dingo/huly-gitlab/src/sync/mr-review.ts` (position write site).
  - `/Users/dingo/huly-gitlab/src/adapter/types.ts` (P5-T-01 discriminated union).
- **Outputs (modify `src/adapter/gitlab-client.ts`):**
  - Remove the `position_type === 'text'` filter in `listDiscussions`.
  - Map each position to the appropriate union arm:
    - `'text'`: existing shape (`oldLine`, `newLine`, `baseSha`, `headSha`, `startSha`).
    - `'image'`: `x`, `y`, `width`, `height`, `baseSha`, `headSha` (skip `oldLine`/`newLine` which are null for image positions).
    - `'file'`: `baseSha`, `headSha` only.
- **Outputs (modify `src/sync/mr-review.ts`):**
  - Write the full discriminated position to the review-thread mixin (the position field is on `MR_REVIEW_THREAD_MIXIN`, NOT the new `MR_REVIEW_MIXIN_DOC` — separate mixin per Phase 3).
  - Remove the `asTextPosition` compile shim from P5-T-01.
- **Outputs (tests):** `tests/adapter/discussions-positions.test.ts` (NEW or extend existing) + `tests/sync/mr-review.test.ts` — ≥ 6 cases:
  1. Adapter maps text position correctly (regression).
  2. Adapter maps image position: x/y/width/height present.
  3. Adapter maps file position: only baseSha/headSha.
  4. mr-review writes image position to mixin.
  5. mr-review writes file position to mixin.
  6. mr-review filters NO position types (all 3 round-trip).
- **Acceptance criteria:**
  - `npm test -- tests/adapter/discussions-positions.test.ts tests/sync/mr-review.test.ts` passes.
  - `! grep -q "position_type.*===.*'text'" src/adapter/gitlab-client.ts` (filter removed).
  - `! grep -rq "asTextPosition" src/` (shim removed).
- **Dependencies:** P5-T-01, P5-T-11 (stamper landed; this also stamps marker on the position write).
- **Complexity:** M (~500 LOC).

---

### P5-T-26 — `mr-helpers.ts` extraction (mr.ts 756 → ≤ 700, ≤730 allowance)

- **Owner:** Sonnet
- **Inputs:**
  - `/Users/dingo/huly-gitlab/src/sync/mr.ts` (756 LOC actual baseline; critic finding 7).
  - Spec §G.
- **Critic finding 7 — baseline reality:**
  - Actual `wc -l src/sync/mr.ts` = 756 LOC (verified at planning time).
  - Phase 4 spec §Success Criteria #11 target ≤700 was MET at Phase 4 close, but P4-T-08 EE additions landed concurrently and pushed it to 756.
  - Phase 5 §G goal: extraction MUST remove ≥ 56 LOC to hit ≤700.
  - **Allowance:** if extraction lands at ≤730 LOC, document as ACCEPTABLE — Phase 5 spec does NOT re-impose the Phase 4 ≤700 criterion. Soft target ≤700; hard ceiling ≤730. If final landing is in (700, 730], P5-T-26 acceptance includes a documented justification block in `docs/phase5-runbook.md` explaining the extracted-LOC vs target gap.
- **Outputs (new file `src/sync/mr-helpers.ts`):**
  - Extract: `resolveAssignee`, `resolveReviewerUuids`, `resolveLocalLabels`, `ensureRemoteLabels`, `parseIid`, `areEqual`, `stripDocPrefix`.
  - `mr.ts` imports + calls. No behavior change.
- **Acceptance criteria:**
  - `npm test -- tests/sync/mr.test.ts` passes (regression).
  - `wc -l src/sync/mr.ts | awk '{exit ($1<=730)?0:1}'` exits 0 (hard ceiling).
  - If `wc -l src/sync/mr.ts` returns value in (700, 730]: justification block present in `docs/phase5-runbook.md` (grep-checked).
  - `npm run lint -- src/sync/mr.ts src/sync/mr-helpers.ts` exits 0.
- **Dependencies:** P5-T-09 (stamper landed first to avoid extracting+re-stamping conflict), P5-T-17 (writer split done so helpers extracted reflect final shape).
- **Complexity:** S (~400 LOC moved; no net new code).

---

### P5-T-27 — DEFERRED rollup: BiDirectionalCache L-1 + app.js L-3 postMessage origin

- **Owner:** Sonnet
- **Inputs:**
  - `/Users/dingo/huly-gitlab/src/sync/bi-directional-cache.ts` (Phase 4 P4-T-12).
  - `/Users/dingo/huly-gitlab/public/user-ui/app.js` (Phase 4 P4-T-16).
  - Phase 4 DEFERRED L-1 (BiDirectionalCache `invalidate(undefined)` doc + `reload(key)` method).
  - Phase 4 DEFERRED L-3 (postMessage origin validation).
- **Outputs (modify `src/sync/bi-directional-cache.ts`):**
  - Add `reload(key: K, fetcher: () => Promise<V>): Promise<V>` method that re-fetches and re-inserts a single entry; documented as the surgical alternative to `clear()`.
  - Add JSDoc to `invalidate` clarifying that `invalidate(undefined)` is a NO-OP (NOT a "clear everything" alias).
- **Outputs (modify `public/user-ui/app.js`):**
  - The Phase 4 postMessage handler accepts any origin matching a hardcoded `expectedHulyOrigin`. L-3: TIGHTEN by:
    1. Validating `e.origin` is in an allowlist (`expectedHulyOrigin` constant initialized at page load from a `<meta name="huly-origin" content="...">` tag in `index.html`).
    2. Logging + ignoring any message from an origin NOT in the allowlist.
    3. Adding a test fixture in a new `public/user-ui/app.test.html` (vanilla browser-runnable) that mocks postMessage from a malicious origin and asserts the handler ignores.
- **Outputs (tests):** extend `tests/sync/bi-directional-cache.test.ts` — ≥ 3 new cases (reload happy path, reload error retains old value, invalidate(undefined) is no-op).
- **Acceptance criteria:**
  - `npm test -- tests/sync/bi-directional-cache.test.ts` passes new cases.
  - `grep -rq "reload" src/sync/bi-directional-cache.ts && grep -rq "L-1" src/sync/bi-directional-cache.ts` exits 0.
  - `grep -rq "expectedHulyOrigin" public/user-ui/app.js && grep -rq "huly-origin" public/user-ui/index.html` exits 0.
- **Dependencies:** none (Wave F parallel).
- **Complexity:** S (~280 LOC).

---

### P5-T-28 — E2E harness extensions

- **Owner:** Sonnet
- **Inputs:**
  - Existing E2E harness (`tests/e2e/`).
  - Spec §Testing Strategy E2E section.
- **Outputs:** E2E test additions (gated; skipped in CI unless `RUN_E2E=true`):
  - Mixin-split migration round-trip: create binding with legacy docs, run migration, assert split docs.
  - GraphQL parity: on an EE harness with GraphQL endpoint enabled, assert `getMergeRequest` returns identical SyncMergeRequest via GraphQL vs REST.
  - Service-account resolution: real account-client probe (gated by `HULY_REAL=true`). Path D variant: assert sentinel + WARN log + gauge=0.
  - Secret rotation: spin up pod with `ServerSecret` + `ServerSecretPrevious`; rotate; assert no downtime for in-flight cookies.
- **Outputs (tests):** ≥ 4 E2E cases gated by env vars.
- **Acceptance criteria:**
  - `RUN_E2E=true npm test -- tests/e2e/phase5/` passes (manual run).
  - CI: skipped by default; `npm test` exits 0 with skip annotations.
- **Dependencies:** P5-T-04, P5-T-17, P5-T-19, P5-T-21, P5-T-05, P5-T-06.
- **Complexity:** M (~600 LOC).

---

### P5-T-29 — ADR-002 + Phase 5 runbook + README/architecture docs (supersede ADR-001)

- **Owner:** Sonnet
- **Inputs:**
  - `/Users/dingo/huly-gitlab/docs/adr-phase4-final.md` (ADR-001; to be superseded).
  - `/Users/dingo/huly-gitlab/docs/architecture.md` (Phase 4 — extend).
  - `/Users/dingo/huly-gitlab/docs/api.md`.
  - `/Users/dingo/huly-gitlab/README.md`.
  - Phase 5 spec.
- **Outputs:**
  - `/Users/dingo/huly-gitlab/docs/adr-phase5-final.md` (NEW; ADR-002): documents Phase 5 decisions per spec §Key Decisions; explicitly supersedes ADR-001 in the header (`**Supersedes:** ADR-001 (docs/adr-phase4-final.md)`); lists each ADR-001 deferral and how Phase 5 closes it; new "**terminal state**" affirmation with no Phase 6 planned.
  - `/Users/dingo/huly-gitlab/docs/adr-phase4-final.md` — modify header to add `**Superseded by:** ADR-002 (docs/adr-phase5-final.md)` banner. Body unchanged (historical record).
  - `/Users/dingo/huly-gitlab/docs/phase5-runbook.md` (NEW): operator runbook documenting:
    - ServerSecret rotation workflow (the §B operator UX): set `ServerSecretPrevious`, rotate `ServerSecret`, wait 24h (or rotation window), remove `ServerSecretPrevious`. Applies to cookie + OAuth state ONLY.
    - **Per-binding webhook secret rotation (NOT pod-wide):** use existing `POST /api/v1/bindings/:id/rotate-secret` endpoint. NOT subject to `ServerSecretPrevious`. Critic finding 4 — explicit operator clarity.
    - Mixin-split migration: pause binding → wait for backfill drain → call endpoint → resume binding → optional: remove legacy `mr-mixin.ts` file in a follow-up PR.
    - GraphQL preference: gated automatically by capability detection; operator can disable via env `DISABLE_GRAPHQL=true` (P5-T-21 acknowledges this hook). Capability cache bust via `POST /api/v1/admin/invalidate-graphql-cache` (P5-T-21 bug B5).
    - Service-account resolution: failure modes + alerts (3 retries; pod refuses to start on failure UNLESS Path D was selected by P5-T-01b, in which case pod starts with sentinel + WARN log + gauge=0).
    - Image/file annotations: surfaced on the review mixin; Huly UI affordance is a separate platform PR (not this pod).
    - mr.ts LOC justification block (if final landed at >700, critic finding 7).
  - `/Users/dingo/huly-gitlab/docs/architecture.md`: update §Mixins to document the split + the legacy compat window; update §Adapter to document GraphQL preference; update §Echo-storm prevention to document the dual-layer defense AND the TxRemoveDoc carve-out (critic finding 5).
  - `/Users/dingo/huly-gitlab/docs/api.md`: document the new `POST /api/v1/bindings/:id/migrate-mixin-split` endpoint AND `POST /api/v1/admin/invalidate-graphql-cache`.
  - `/Users/dingo/huly-gitlab/README.md`: update "Phase status" section to "Phase 5 — terminal state."
- **Acceptance criteria:**
  - `grep -rq "Supersedes: ADR-001" docs/adr-phase5-final.md` exits 0.
  - `grep -rq "Superseded by: ADR-002" docs/adr-phase4-final.md` exits 0.
  - `grep -rq "ServerSecretPrevious" docs/phase5-runbook.md && grep -rq "migrate-mixin-split" docs/phase5-runbook.md && grep -rq "rotate-secret" docs/phase5-runbook.md && grep -rq "invalidate-graphql-cache" docs/phase5-runbook.md` exits 0.
  - `grep -rq "TxRemoveDoc" docs/architecture.md` exits 0 (carve-out documented).
  - `grep -rq "Phase 5" README.md` exits 0.
- **Dependencies:** none (Wave G parallel with P5-T-28).
- **Complexity:** M (~860 LOC documentation; +60 vs v1 due to webhook clarity + carve-out + cache-bust documentation).

---

### P5-T-30 — Phase 5 final regression sweep

- **Owner:** Opus
- **Inputs:** ALL Phase 5 tasks landed.
- **Outputs:**
  - `npm run build` exits 0.
  - `npm run lint` exits 0.
  - `npm test` exits 0; final test count ≥ 800 (target 806+ given 656 baseline + ~150 new).
  - `npm audit --omit=dev --audit-level=high` shows 0 high.
  - `wc -l src/sync/mr.ts` ≤ 730 (hard ceiling per critic finding 7; ≤ 700 soft target).
  - All Phase 1-4 tests pass (regression).
  - Spec acceptance criteria #1-#11 from §Success Criteria each verified by a documented test or grep.
- **Outputs:** PR description draft for Phase 5; references ADR-002.
- **Acceptance criteria:**
  - `npm run build && npm run lint && npm test` all exit 0.
  - `npm test 2>&1 | tail -3 | grep -E "passed.*[0-9]{3,}"` shows ≥ 800.
  - All grep-checkable spec criteria verified (including the new critic-finding greps: `-r` flags on directory greps per bug B6).
- **Dependencies:** P5-T-01..P5-T-29 (every prior task EXCEPT P5-T-07 which is deleted).
- **Complexity:** S (~100 LOC PR description; mostly verification — but Opus owner because critical failure here requires fan-out diagnosis).

---

## 4. Testing Plan

| Area | New tests | Cumulative target |
|---|---|---|
| Phase 4 baseline | — | 656 |
| P5-T-01 SyncReviewPosition union | 3 | 659 |
| P5-T-01b service-account probe | 2 (+1 if Path D) | 661-662 |
| P5-T-02 mixin split schema | 1 | 662-663 |
| P5-T-03 secret-rotation helper | 6 (reduced from 8; webhook cases removed) | 668-669 |
| P5-T-04 service-account resolution + filter regression | 6 | 674-675 |
| P5-T-05 cookie-auth dual-verify + M-4 + L-6 + URL decode | 7 (+1 vs v1) | 681-682 |
| P5-T-06 oauth state dual-verify + Sec M-1 | 8 | 689-690 |
| P5-T-07 DELETED (webhook is per-binding) | 0 | 689-690 |
| P5-T-08 originated-marker helper + Issues stamper | 6 (4 manager + 2 helper) | 695-696 |
| P5-T-09..P5-T-14 6 manager stampers @ 4 each | 24 | 719-720 |
| P5-T-15 marker-check restore + 7 round-trip + TxRemoveDoc carve-out + $set/$inc probe | 14 (+1 vs v1) | 733-734 |
| P5-T-16 readMRMixinAttributes | 6 | 739-740 |
| P5-T-17 MR writer split + B1 quantifier + B4 backfill drain | 7 (+1 vs v1) | 746-747 |
| P5-T-18 mr-approvals/mr-review/epics writer split | 9 | 755-756 |
| P5-T-19 mixin-migration helper + endpoint + B4 backfill drain | 9 (+1 vs v1) | 764-765 |
| P5-T-20 reader-compat sweep + L-1 stale | 6 | 770-771 |
| P5-T-21 GraphQL client + capability + B5 cache bust | 10 (+2 vs v1) | 780-781 |
| P5-T-22 GraphQL getMergeRequest | 3 | 783-784 |
| P5-T-23 GraphQL listEpicsWithChildren | 3 | 786-787 |
| P5-T-24 GraphQL listMRsWithApprovals | 3 | 789-790 |
| P5-T-25 image/file position | 6 | 795-796 |
| P5-T-26 mr-helpers extraction | 0 (regression) | 795-796 |
| P5-T-27 BiDirCache + app.js | 3 | 798-799 |
| P5-T-28 E2E (gated) | 4 | 802-803 |
| P5-T-29 docs (no tests) | 0 | 802-803 |
| P5-T-30 final regression | 0 | 802-803 |
| **Buffer / additional regression-discovery cases** | ~3-7 | **~806-810** |

**Target (final):** ≥ 800 tests (target 806). **Phase 5 spec acceptance criterion #2: ≥ 100 new (target: 150+).** Plan delivers ~147-154 new (within tolerance; P5-T-07 deletion offset by added bug-coverage tests).

**Regression preservation:** all 656 Phase 1+2+3+4 tests must continue to pass. P5-T-30 verifies this explicitly.

---

## 5. Build & Verification Commands

```bash
# Per-task (run from /Users/dingo/huly-gitlab):
npm run build
npm run lint
npm run lint -- <changed-files>
npm test -- <changed-test-files>

# Phase 5 final (P5-T-30):
cd /Users/dingo/huly-gitlab
npm run build
npm run lint
npm test
npm audit --omit=dev --audit-level=high
wc -l src/sync/mr.ts            # MUST be ≤ 730 (hard); ≤ 700 (soft target)
wc -l src/sync/mr-mixin.ts      # ≤ 100 (legacy carry)
wc -l src/sync/mr-core-mixin.ts # ≤ 50
wc -l src/sync/mr-review-mixin-doc.ts  # ≤ 60

# Spec acceptance grep batch (each line MUST exit 0; critic bug B6: -r on directory greps):
grep -rq "resolveServiceAccountPersonId" src/index.ts
grep -rq "TX_SUBSCRIPTION_SERVICE_ACCOUNT_RESOLVED" src/metrics.ts
grep -rq "verifyHmacWithRotation" src/util/secret-rotation.ts
grep -rq "ServerSecretPrevious" src/config.ts
grep -rq "withOriginatedMarker" src/sync/originated-marker.ts
grep -rq "MR_CORE_MIXIN" src/sync/mr-core-mixin.ts
grep -rq "MR_REVIEW_MIXIN_DOC" src/sync/mr-review-mixin-doc.ts
grep -rq "MR_REVIEW_THREAD_MIXIN" src/sync/mr-review-thread-mixin.ts
grep -rq "GitLabGraphQLClient" src/adapter/gitlab-graphql-client.ts
grep -rq "POST.*/migrate-mixin-split" src/http/binding.ts
grep -rq "invalidate-graphql-cache" src/http/
grep -rq "backfillInFlight" src/sync/binding-lifecycle.ts
grep -rq "TxRemoveDoc" src/sync/tx-subscription.ts
grep -rq "Supersedes: ADR-001" docs/adr-phase5-final.md
! grep -q "systemAccountUuid as unknown as PersonId" src/index.ts  # Paths A/B/C; allowed under Path D
! grep -q "SH-1" src/sync/tx-subscription.ts                        # Paths A/B/C; allowed under Path D
! grep -rq "asTextPosition" src/
! grep -rn "findOne.*MR_MIXIN[^_]" src/sync/
! grep -rq "MR_REVIEW_MIXIN[^_]" src/ tests/                        # rename sweep (critic finding 8)
! grep -rq "verifyWebhookSecretWithRotation" src/                   # confirms webhook helper not added (critic finding 4)
```

---

## 6. Risk Register

| # | Risk | Probability | Impact | Mitigation |
|---|---|---|---|---|
| R-1 | P5-T-01b investigation finds NO viable service-account resolution API (Path D) | LOW-MEDIUM | HIGH | Path D is the explicit fallback (critic finding 3): pod retains sentinel cast, emits WARN + gauge=0, layer-2 marker defense covers echo-storm. Spec §A "refuse to start" is relaxed ONLY under Path D. Operator alert on `tx.subscription.service_account.resolved == 0`. |
| R-2 | Mixin-split migration data loss on edge cases (mixed legacy+new mid-failure state) | LOW | HIGH | Idempotent migration design (P5-T-19 case #2); operator pauses binding first (matches Phase 3 reviewer-migration UX); dry-run mode (case #3); contradiction detection (P5-T-16 case #5); backfill drain coordination (critic bug B4). |
| R-3 | `_originated:'gitlab'` marker on every write breaks idempotence checks elsewhere (e.g., Huly diff comparisons that include the marker) | MEDIUM | MEDIUM | Marker is on attribute payload, NOT on Doc field; tests assert the marker does NOT persist on the resulting Doc (it's a tx-level attribute only). If diff comparisons surface false positives: add `_originated` to the diff exclusion list in `mr-mixin-reader.ts`. |
| R-4 | GraphQL schema version mismatch across GitLab editions (CE vs EE vs SaaS vs self-hosted) | MEDIUM | MEDIUM | Capability detection (P5-T-21) per-baseUrl cached for 1h WITH bust hooks (critic bug B5); on GraphQL failure → REST fallback (every preferred path has a fallback test); operator opt-out via `DISABLE_GRAPHQL=true` env; manual cache-bust via admin endpoint. |
| R-5 | ServerSecret rotation: in-flight HMAC during rotation window has a brief race where the new sig comes in but the verifier hasn't loaded `ServerSecretPrevious` yet | LOW | MEDIUM | `ServerSecretPrevious` loaded at startup; rotation is operator-driven (sequenced: set previous → restart → rotate primary → restart → wait → remove previous). Runbook (P5-T-29) documents the strict sequence. |
| R-6 | Image/file position adapter mapping diverges from GitLab API shape (e.g., x/y in CSS pixels vs image pixels) | LOW | LOW | Phase 5 stores raw GitLab values verbatim per spec §F; downstream UI conversion is Huly platform's responsibility. P5-T-25 test fixtures capture sample GitLab JSON for both image and file positions. |
| R-7 | DAG conflict in Wave E: P5-T-22/T-23/T-24 all modify `gitlab-client.ts` | LOW | LOW | Critic finding 2: Wave E is now FULLY SERIAL (width 1). Each task observes the previous task's GraphQL-preferred method shape; merge conflicts eliminated. |
| R-8 | Wave C 6-wide stamper parallelism: shared `originated-marker.ts` import races | LOW | LOW | Critic finding 6: P5-T-08 is LEAD task that creates the shared helper SERIALLY (Wave C width 1 for the lead phase); other 6 (T-09..T-14) wait on it as input dep then run width 6. |
| R-9 | TxUpdateDoc `$set`/`$inc` operator nesting: marker stamped at root but TxSubscriber probes operator payload | MEDIUM | MEDIUM | Critic bug B2: P5-T-15 probe test verifies the location TxSubscriber actually sees marker. If marker not visible at root for operator-nested txes, stamper writes to BOTH root AND operator location; helper `withOriginatedMarkerForOperators` added. |
| R-10 | Backfill drain race during mixin-split migration: in-flight backfill writes legacy mixin AFTER migration starts | MEDIUM | MEDIUM | Critic bug B4: `binding.backfillInFlight` flag + migration polls until clear; 5-minute timeout returns partial report; operator retries. |
| R-11 | GraphQL capability cache stale after operator changes binding config | LOW-MEDIUM | MEDIUM | Critic bug B5: bind-time config change triggers `invalidateCapability()` via lifecycle hook; manual operator bust via `POST /api/v1/admin/invalidate-graphql-cache`. |
| R-12 | TxRemoveDoc has no marker payload; layer-2 defense N/A | LOW | LOW | Critic finding 5: documented as N/A in spec §C and P5-T-15 JSDoc. Service-account filter (layer 1) is sole defense for removes. Operationally, the Path D fallback for service-account resolution is the only scenario where TxRemoveDoc echo-storm is undefended — under Path D, operator alert on `resolved == 0` gauge is the mitigation. |

**Top 5 risks (per scope):** R-1 (HIGH, low-medium prob — Path D fallback), R-2 (HIGH, low prob — migration idempotence), R-9 (MEDIUM, medium prob — operator nesting), R-10 (MEDIUM, medium prob — backfill race), R-4 (MEDIUM, medium prob — GraphQL schema).

---

## 7. Open Questions

(These will be appended to `/Users/dingo/huly-gitlab/.omc/plans/open-questions.md` per planner protocol.)

1. **Service-account API surface (R-1)** — confirmed in P5-T-01b investigation before P5-T-04 starts. If Path D, pod retains sentinel + WARN log + gauge=0. Documented degradation per critic finding 3.
2. **Legacy `mr-mixin.ts` deletion timing** — Phase 5 retains the file for read-compat; spec §D implies a post-migration cleanup PR (out of Phase 5 scope). Documented in P5-T-29 runbook.
3. **GraphQL transitive-dependency surface** — `graphql-request` per Phase 1 spec; verify package.json before P5-T-21 starts.
4. **`updateMixin` mixin removal API for migration (P5-T-19 step 9)** — Huly platform may not expose a direct "remove mixin" tx. If unavailable: document as a post-migration cleanup using a Huly platform admin tool. Investigation deferred to P5-T-19 implementation.
5. **Marker on attribute-only payloads vs Doc fields (R-3)** — verify TxMixin `attributes` is NOT persisted to the Doc; the marker should be tx-transient. If it persists: add to diff exclusion list.
6. **TxUpdateDoc `$set`/`$inc` marker visibility (critic bug B2)** — P5-T-15 probe test determines whether marker at root is sufficient OR stamper needs to write at both root and operator-nested location. Resolution lands during P5-T-15 implementation.
7. **Cookie pkg vs hand-rolled URL decode (critic bug B3)** — P5-T-05 chooses Option 1 (hand-rolled with `decodeURIComponent`) OR Option 2 (npm `cookie` pkg). Decision documented in file header at implementation time.

---

## 8. Change Log

- **v1 (2026-06-06):** initial Phase 5 plan; 31 tasks across 7 waves; parallelism width 5 claimed (Wave C); target +150 tests → ≥ 800 cumulative. Closes 7 ADR-001 limitations + 7 DEFERRED items.
- **v2 (2026-06-06):** applied critic findings — 8 blocking + 6 bugs.
  - Blocking 1: Mixin rename rationale clarified (TS-symbol-only; no runtime collision). Added rename sweep grep `! grep -rq "MR_REVIEW_MIXIN[^_]" src/ tests/` to P5-T-02.
  - Blocking 2: Wave E parallelism corrected (was 3-wide; now FULLY SERIAL width 1).
  - Blocking 3: P5-T-01b sandbox access — added explicit Path D fallback for unreadable node_modules.
  - Blocking 4: P5-T-07 DELETED — webhook is per-binding, not pod-wide. Task count: 31 → 30.
  - Blocking 5: TxRemoveDoc `_originated` carve-out documented — layer-1 only for removes.
  - Blocking 6: Wave C true width corrected (1 lead → 6 parallel; was 5 / 7 claimed).
  - Blocking 7: mr.ts 756 baseline acknowledged; allowance ≤730 documented.
  - Blocking 8: rename sweep grep acceptance in P5-T-02 (also re-asserted in §5 verification batch).
  - Bug B1: P5-T-17 round-trip test asserts BOTH `buildCoreMixinData` + `buildReviewMixinData` mixin txes dropped (quantifier).
  - Bug B2: P5-T-15 `_originated` shape probe on TxUpdateDoc `$set`/`$inc` operators added; helper grows operator-nested variant if needed.
  - Bug B3: P5-T-05 cookie parser also URL-decodes the key OR uses npm `cookie` pkg.
  - Bug B4: P5-T-19 migration waits for backfill drain via `binding.backfillInFlight` flag + 5-min timeout.
  - Bug B5: P5-T-21 GraphQL capability cache bust via lifecycle hook + admin endpoint.
  - Bug B6: All directory greps in acceptance criteria use `-r` flag.

