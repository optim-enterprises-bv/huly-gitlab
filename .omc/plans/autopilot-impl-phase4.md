# Implementation Plan — huly-gitlab Phase 4 (FINAL)

**Status:** Draft v2 (autopilot Phase 4)
**Spec:** `.omc/specs/deep-interview-huly-gitlab-phase4.md`
**Companion P4-T-01b spec (will be written by P4-T-01b):** `.omc/specs/p4-t-01b-tx-subscription-api.md`
**Target tree:** `/Users/dingo/huly-gitlab/`
**Phase 1+2+3 baseline:** 495 tests passing; ~13,200 LOC; PRs #6 (Phase 2) and #7 (Phase 3) merged on `optim-enterprises-bv/huly-gitlab`.
**Phase 3 plan (structure reference):** `.omc/plans/autopilot-impl-phase3.md`

## Revision history

- **v1: initial Phase 4 plan** — Path B closure + EE features (approval rules + iterations + epics) + multi-instance + per-user OAuth backend + minimal HTML UI + opportunistic refactor backlog. 22 tasks. Parallelism width 5 in Waves C/F. Target test delta +110 (495 → ≥ 605).
- **v2 (this revision): applied critic findings** — DAG-1 fix (moved TxSubscriber wiring from P4-T-09 into P4-T-19; Wave C now genuinely 4-wide on disjoint files); AC-1 field-ownership single-writer for `parentEpicIid` (EpicsSyncManager is sole writer; MR manager does NOT touch this field); OQ-2/Bug-1 sub-group epic top-level group resolution; MR-2 circular-tx storm prevention (service-account author filter + transient `_originated` marker as defense-in-depth); Bug-6 bearer-not-in-query (postMessage/sessionStorage only; CSP header on `/user/ui/*`); Bug-4 CE approvalStatus regression assertion; Bug-3 JSON+HMAC cookie format; Bug-7 iteration update SLA amended; SCG-1 `change.actorToken` provenance guard (legacy Phase 3 path removed; resolver-only); SCG-2 `username` field on `UserCredentialDoc` + status; SCG-3 callback identity source clarification (state-row, not cookie); TG-3 epic field-ownership symmetric test; TG-4 multi-instance idmap isolation test + `gitlabBaseUrl-hash` prefix on idmap `gitlabId`; MR-1 TxSubscriber cold-start buffering; TG-1 integration test path documented + gap acknowledgment; DAG-3 P4-T-17 explicit enqueueRemoteEvent assertion; P4-R3 short-TTL cache for `getMRApprovalRules`.

---

## 1. Overview

Phase 4 closes the four remaining gaps from Phases 1–3 in one cycle and ends the integration roadmap. (1) **Path B closure** — a new `TxSubscriber` (`src/sync/tx-subscription.ts`) hooks the per-workspace Huly `Client` returned by `BindingLoader.loadFor*` and translates `TxMixin`/`TxCUD`/`TxRemoveDoc` events touching `MR_MIXIN` / `MR_REVIEW_MIXIN` / mirror `tracker.class.Issue` docs into flat `change` envelopes that call the existing `SyncEngine.enqueueLocalEvent` API. The change-envelope shape is the flat-key contract verified by P3-T-01b; the new investigation P4-T-01b verifies the subscription API surface (Path A `client.notify(handler)`, Path B `addTxHandler`, or Path C polling fallback) BEFORE the subscriber lands. **Circular-tx storm prevention (MR-2):** TxSubscriber filters out tx events authored by the pod's own service-account `PersonUuid` (resolved at subscriber start); applyRemote writes also stamp a transient `_originated: 'gitlab'` marker as defense-in-depth. **TxSubscriber wiring (DAG-1):** the core `TxSubscriber` class + its tests land in P4-T-09; ALL lifecycle wiring (start/stop hooks in BindingLoader, src/index.ts SIGTERM iteration, cache-eviction triggers) moves to P4-T-19. (2) **EE features** — `getMRApprovalRules`, `listIterations`/`getIteration`, `listEpics`/`getEpic`/`listEpicIssues` added to the adapter behind `capabilities.edition === 'EE'` (CE returns `[]` silently); a new `EpicsSyncManager` (kind `'epic'`) writes a new `gitlab-epic` runtime mixin onto `tracker.class.Issue` mirrors; `MR_MIXIN` extends with `approvalRules?`, `iteration?` ONLY (parentEpicIid removed from MR manager's write set — AC-1 fix). `parentEpicIid` is also added to the mixin schema BUT is exclusively written by `EpicsSyncManager` from child-issue propagation; the field lives on `gitlab-mr` mixin AND on the issue-mirror's `gitlab-issue` mixin (whichever applies). Webhook router gains an `Epic Hook` branch; `BindingLifecycleService` event-flag set extends with `epic_events`. (3) **Multi-instance** — `BindingLoader` cache key widens from `workspaceUuid` to `(workspaceUuid, gitlabBaseUrl)`; per-binding `gitLabClient` is constructed from `credential.gitlabBaseUrl`; **idmap `gitlabId` strings are now prefixed with a stable 8-hex-char hash of `gitlabBaseUrl` ONLY when multi-instance is detected for a workspace** (TG-4 fix; defense-in-depth against duplicate project IDs across instances). (4) **Per-user OAuth backend + HTML UI** — `src/state/user-credentials.ts` adds an AES-256-GCM keyed-by-`(workspaceUuid, hulyPersonUuid)` store reusing the Phase 1 `CredentialEncryptionKey`; document now also stores `username: string` captured at OAuth callback via `GET /api/v4/user` (SCG-2); `MRCredentialResolver.resolveActorToken` (the Phase 3 stub) becomes real AND the legacy `change.actorToken` carry path in `mr-review.ts:333` is REMOVED (SCG-1 provenance guard — actor tokens only come from the workspace-scoped resolver); new HTTP routes `GET /user/oauth/{start,callback,status}` + `DELETE /user/oauth/credential` use a Phase 1-pattern PKCE exchange, a JSON+HMAC cookie verifier (`src/http/cookie-auth.ts` — Bug-3 fix), and a per-IP token-bucket rate limit (`src/http/rate-limit.ts`); a minimal vanilla HTML+CSS+JS UI under `public/user-ui/` (≤ 400 LOC total) lets a Huly user link/status/unlink without a build step. **Bearer transport (Bug-6):** bearer tokens MUST arrive via `postMessage` from the embedding Huly parent window OR `sessionStorage`; query-string bearer is REJECTED at the UI layer; CSP headers on `/user/ui/*` prevent inline-script bearer exfiltration. (5) **Opportunistic refactor backlog** — `mr.ts` (currently 991 LOC) splits with `mr-approvals.ts` extraction (target ≤ 700 LOC); `LabelCache` / `MRCache` / `MilestoneCache` adopt a shared `BiDirectionalCache<K,V>` base with bounded LRU (default 1000 entries per binding); `deferred-parent.ts` extracts the deferred-parent retry helper used by `NotesSyncManager` + `ReviewThreadsSyncManager`. All behavior-preserving refactors require no new test cases beyond regression. (6) **Integration** — engine registers `EpicsSyncManager` (and optionally `IterationsSyncManager`); `TxSubscriber` lifecycle is started by `BindingLoader.loadFor*` on first load per workspace and stopped on cache eviction or pod shutdown **but the wiring code lives entirely in P4-T-19**; E2E harness extends with synthetic-tx + EE-image-detection + multi-instance + per-user OAuth flows; README + architecture doc + Phase 4 runbook publish FINAL phase state.

**Path B closure is the single most consequential change** and gates production utility of every applyLocal path that has been dead since Phase 2. The change-payload SHAPE (flat keys) is already settled by P3-T-01b; only the SUBSCRIBER API surface is open and is the subject of P4-T-01b. **Field-ownership invariant** from Phase 2 critic C2 and Phase 3 extension is preserved and extended with AC-1 single-writer correction:

- `EpicsSyncManager` exclusively owns the `gitlab-epic` mixin AND is the SOLE writer of `parentEpicIid` (on whichever mixin the child Issue carries — `gitlab-mr` for MR mirrors, `gitlab-issue` for issue mirrors). The propagation happens when EpicsSyncManager applies an epic and iterates `syncEpic.childIssueIids` to `updateMixin` each child.
- `MergeRequestsSyncManager.applyRemote` owns `approvalRules` and `iteration` ONLY on `gitlab-mr`. It explicitly does NOT touch `parentEpicIid` (AC-1 contradiction resolution). It does NOT read or use the MR payload's `epic_iid` field either — that field is dead from this integration's perspective. **Test asserts the single-writer invariant.**
- `PipelineSyncManager` still exclusively owns `pipelineStatus`.
- `ReviewThreadsSyncManager` still exclusively owns `gitlab-review`.

---

## 2. Dependency Graph / Phase Ordering

```
            ┌─────────────────────────────────────┐
            │ Wave A: Investigation + types       │
            │   P4-T-01  Adapter EE types + idmap │
            │   P4-T-01b TxSubscriber API probe   │
            │   P4-T-02  Mixin schema extensions  │
            └────────────────┬────────────────────┘
                             │
            ┌────────────────┴────────────────────┐
            │ Wave B: Disjoint adapter + state    │
            │   P4-T-03 EE adapter methods        │
            │   P4-T-04 BindingLoader cache key   │
            │           (multi-instance scope)    │
            │   P4-T-05 user-credentials store    │
            └────────────────┬────────────────────┘
                             │
   ┌─────────────────────────┼─────────────────────────┐
   │ Wave C: Managers + Path B core (4-wide; DAG-1)    │
   │  P4-T-06 EpicsSyncManager (new src/sync/epics.ts) │
   │  P4-T-07 IterationsSyncManager OR mr.ts fold      │
   │  P4-T-08 mr.ts EE field extensions (approval      │
   │           rules + iteration; NOT parentEpicIid)   │
   │  P4-T-09 TxSubscriber CORE class + tests          │
   │           (no binding-loader wiring; that → T-19) │
   │  P4-T-10 MRCredentialResolver real impl           │
   └─────────────────────────┬─────────────────────────┘
                             │
   ┌─────────────────────────┴─────────────────────────┐
   │ Wave D: Refactor backlog (3-wide; behavior-pres.) │
   │  P4-T-11 mr-approvals.ts extraction               │
   │  P4-T-12 bi-directional-cache.ts base + adoption  │
   │  P4-T-13 deferred-parent.ts helper extraction     │
   └─────────────────────────┬─────────────────────────┘
                             │
   ┌─────────────────────────┴─────────────────────────┐
   │ Wave E: HTTP + UI (3-wide)                        │
   │  P4-T-14 cookie-auth + rate-limit middleware      │
   │  P4-T-15 user-oauth.ts routes                     │
   │  P4-T-16 public/user-ui/ vanilla HTML+CSS+JS      │
   └─────────────────────────┬─────────────────────────┘
                             │
   ┌─────────────────────────┴─────────────────────────┐
   │ Wave F: Wiring + multi-instance + lifecycle       │
   │  P4-T-17 Webhook router Epic Hook branch          │
   │  P4-T-18 BindingLifecycleService epic_events flag │
   │  P4-T-19 Engine reg + TxSubscriber lifecycle      │
   │           wiring + cache-eviction + index.ts      │
   │           SIGTERM + BindingLoader hooks (DAG-1)   │
   └─────────────────────────┬─────────────────────────┘
                             │
   ┌─────────────────────────┴─────────────────────────┐
   │ Wave G: E2E + docs (2-wide)                       │
   │  P4-T-20 E2E harness extensions                   │
   │  P4-T-21 README + architecture + Phase 4 runbook  │
   │  P4-T-22 Phase 4 final regression sweep           │
   └───────────────────────────────────────────────────┘
```

**Parallel waves:**

- **Wave A (Day 1):** P4-T-01 AND P4-T-01b AND P4-T-02 in parallel. P4-T-01 (`src/adapter/types.ts` + idmap kind union widening), P4-T-01b (subscription API probe against `node_modules/@hcengineering/core`), P4-T-02 (`src/sync/mr-mixin.ts` extension + new `src/sync/epic-mixin.ts`).
- **Wave B (after Wave A):** P4-T-03, P4-T-04, P4-T-05 in parallel. Disjoint files: `src/adapter/gitlab-client.ts` add-only EE methods (P4-T-03); `src/sync/binding-loader.ts` cache key widening (P4-T-04); new `src/state/user-credentials.ts` (P4-T-05).
- **Wave C (after Wave B):** P4-T-06, P4-T-07, P4-T-08, P4-T-09, P4-T-10 in parallel. **4-wide on disjoint files plus 1 serialized** (DAG-1 resolution): P4-T-06 (`src/sync/epics.ts`), P4-T-07 (`src/sync/iterations.ts`), P4-T-08 (`src/sync/mr.ts` EE additions — does NOT touch parentEpicIid), P4-T-09 (`src/sync/tx-subscription.ts` core class — does NOT modify `binding-loader.ts`). P4-T-10 also touches `binding-loader.ts` for credentials wiring but is serialized AFTER P4-T-04. P4-T-09 NO LONGER touches `binding-loader.ts`; all TxSubscriber lifecycle wiring moves to P4-T-19. **3-way conflict eliminated** — `binding-loader.ts` is only modified by P4-T-04 (Wave B) and P4-T-10 (Wave C, after P4-T-04) and P4-T-19 (Wave F).
- **Wave D (after Wave C):** P4-T-11, P4-T-12, P4-T-13 in parallel. All behavior-preserving extractions with disjoint target files.
- **Wave E (after Wave D):** P4-T-14, P4-T-15, P4-T-16 in parallel. New files only; HTTP routes (P4-T-15) consume middleware (P4-T-14) at registration time but not at definition time, so concurrent development is safe.
- **Wave F (after Wave E):** P4-T-17, P4-T-18 in parallel; P4-T-19 serial after them. `src/http/webhook.ts` (P4-T-17) and `src/sync/binding-lifecycle.ts` (P4-T-18) are disjoint; both feed `src/index.ts` wiring (P4-T-19) along with the deferred TxSubscriber lifecycle.
- **Wave G (after Wave F):** P4-T-20, P4-T-21 in parallel; P4-T-22 serial after.

**Parallelism width:** 4 (Wave C, disjoint) + 1 (serialized P4-T-10). Width 3 in Waves A, B, D, E. Width 2 in Waves F, G.

**Gating contract (Wave A day-1 deliverable):**

- `src/adapter/types.ts` adds `SyncEpic`, `SyncIteration`, `SyncMRApprovalRule`, `EpicHookPayload`, `EpicState` ('opened' | 'closed'), `IterationState` ('upcoming' | 'started' | 'closed'). Optional Phase 4 fields on `SyncMergeRequest`: `approvalRules?`, `iteration?`. **NOTE (AC-1):** `parentEpicIid?` is NOT added to `SyncMergeRequest`; it stays exclusively on the mixin schema (P4-T-02) and is written only by EpicsSyncManager.
- `src/state/idmap.ts` adds `'epic'`, `'iteration'`, `'approval_rule'` to `GitlabKind`. `src/state/cursors.ts` adds `'epics'` and `'iterations'` to `CursorKind`.
- `src/sync/mr-mixin.ts` extends `MRMixinDoc` with `approvalRules?`, `iteration?`, `parentEpicIid?` (all optional — same B2 contract from Phase 3; `parentEpicIid` is owned by EpicsSyncManager despite living on the MR mixin).
- New `src/sync/epic-mixin.ts` declares `EpicMixinDoc extends Issue` + `EPIC_MIXIN = 'gitlab-epic'` ref.
- P4-T-01b writes its verified subscription-API path into a code comment at the head of `src/sync/tx-subscription.ts` (and the spec file is referenced from P4-T-09 inputs). The subscription path decision is **gating for P4-T-09**.

---

## 3. Task List

### P4-T-01 — Adapter EE Types + Idmap/Cursor enum widening

- **Owner:** Sonnet
- **Inputs:**
  - `/Users/dingo/huly-gitlab/.omc/specs/deep-interview-huly-gitlab-phase4.md` (§Scope, §Architecture)
  - `/Users/dingo/huly-gitlab/src/adapter/types.ts` (Phase 1–3 types — extend not rewrite)
  - `/Users/dingo/huly-gitlab/src/adapter/errors.ts` (Phase 1–3 error hierarchy — extend)
  - `/Users/dingo/huly-gitlab/src/state/idmap.ts` (Phase 3 widened to `'review_thread'`)
  - `/Users/dingo/huly-gitlab/src/state/cursors.ts` (Phase 3 widened to `'reviews'`)
- **Outputs (modify `src/adapter/types.ts`):**
  - `SyncMRApprovalRule`: `{ id: string, name: string, ruleType: 'regular' | 'code_owner' | 'any_approver' | 'report_approver', eligibleApprovers: SyncUser[], approvalsRequired: number, approvedBy: SyncUser[] }`.
  - `SyncIteration`: `{ id: string, iid: number, title: string, description: string, state: IterationState, startDate: string | null, dueDate: string | null, webUrl: string }`. JSDoc: dates are GitLab ISO strings; the mixin converts to `Date | null` at write time (mirroring Phase 2 `mergedAt`).
  - `IterationState`: `'upcoming' | 'started' | 'closed'`.
  - `SyncEpic`: `{ groupId: number, epicIid: number, title: string, description: string, state: EpicState, webUrl: string, createdAt: string, updatedAt: string, parentEpicIid: number | null, childIssueIids: number[] }`.
  - `EpicState`: `'opened' | 'closed'`.
  - `EpicHookPayload`: shape used by webhook router (`object_attributes.iid`, `object_attributes.group_id`, `object_attributes.action`, `object_attributes.url`).
  - Extend `SyncMergeRequest` with OPTIONAL Phase 4 fields (AC-1 corrected list — `parentEpicIid` REMOVED):
    ```ts
    approvalRules?: SyncMRApprovalRule[]
    iteration?: SyncIteration | null
    ```
  - JSDoc on `SyncMergeRequest`: explicitly comment that `parentEpicIid` is NOT exposed on the adapter type because the integration does NOT use the MR payload's `epic_iid` field (AC-1 single-writer invariant). The mixin field `parentEpicIid` is populated solely by `EpicsSyncManager` via child-issue propagation. OQ-2 footnote: GitLab's standard MR REST response does not reliably include `epic_iid`; this is moot because the integration does not consume that field.
  - JSDoc: `listMergeRequests` leaves these undefined; `getMergeRequest` populates them when `capabilities.edition === 'EE'`; CE always leaves them undefined OR sets `approvalRules: []` (consistent with the spec "CE returns empty silently"). The MR manager's `applyRemote` MUST treat undefined as "not yet fetched" — NOT as "clear the field."
- **Outputs (modify `src/state/idmap.ts`):**
  - Widen `GitlabKind` to add `'epic'`, `'iteration'`, `'approval_rule'`.
  - **Multi-instance prefix helper (TG-4):** add a pure helper `prefixGitlabIdForMultiInstance(baseUrl: string, raw: string, isMultiInstanceWorkspace: boolean): string`. When `isMultiInstanceWorkspace === false`, returns `raw` unchanged (zero behavior change in single-instance workspaces — the dominant deployment). When `true`, returns `${sha256(baseUrl).slice(0, 8)}:${raw}`. Multi-instance detection is owned by `BindingLoader` (P4-T-04) which passes a per-workspace flag down to managers via `bctx.isMultiInstanceWorkspace`.
  - JSDoc: `'epic'` stores `(workspaceUuid, 'epic', '${groupId}:${epicIid}') ↔ ('tracker.class.Issue', issueRef)`. `'iteration'` stores `(workspaceUuid, 'iteration', iterationId) ↔ (no Huly doc — used for cursor-only state)`. `'approval_rule'` stores `(workspaceUuid, 'approval_rule', '${projectId}:${mrIid}:${ruleId}') ↔ (no Huly doc — used for idempotency only).`
- **Outputs (modify `src/state/cursors.ts`):**
  - Widen `CursorKind` to add `'epics'` and `'iterations'`.
- **Outputs (modify `src/adapter/errors.ts`):**
  - Add `EEFeatureUnavailableError extends GitLabApiError` with `readonly feature: 'approval_rules' | 'epics' | 'iterations'`. Used internally by the adapter when capability detection reports CE but the caller invoked an EE method directly. The adapter PUBLIC contract is to return `[]` silently on CE; the error class is for internal guard rails.
- **Outputs (tests):** extend `src/state/store.test.ts`:
  - Upsert + lookup with `kind: 'epic'` and `${groupId}:${epicIid}` compound `gitlabId`.
  - Upsert + lookup with `kind: 'iteration'`.
  - Upsert + lookup with `kind: 'approval_rule'`.
  - Cursor set + get for `'epics'` and `'iterations'`.
  - **TG-4 multi-instance prefix:** `prefixGitlabIdForMultiInstance('https://gitlab.example.com', '42:7', false)` returns `'42:7'`; with `true`, returns deterministic 8-hex prefix + `':42:7'`. Two distinct baseUrls produce distinct prefixes.
- **Acceptance criteria:**
  - `npm run build` exits 0.
  - `npm run lint -- src/adapter/types.ts src/adapter/errors.ts src/state/idmap.ts src/state/cursors.ts` exits 0.
  - `grep -q "SyncEpic" src/adapter/types.ts && grep -q "SyncIteration" src/adapter/types.ts && grep -q "SyncMRApprovalRule" src/adapter/types.ts && grep -q "'epic'" src/state/idmap.ts && grep -q "'epics'" src/state/cursors.ts && grep -q "'iterations'" src/state/cursors.ts && grep -q "prefixGitlabIdForMultiInstance" src/state/idmap.ts` exits 0.
  - `grep -qv "parentEpicIid" src/adapter/types.ts || ! grep -A2 "SyncMergeRequest" src/adapter/types.ts | grep -q "parentEpicIid"` — the field is absent from `SyncMergeRequest` (AC-1).
  - `npm test -- src/state/store.test.ts` passes new cases.
- **Dependencies:** none.
- **Complexity:** S (~260 LOC type defs + 5 test cases + JSDoc + prefix helper).

---

### P4-T-01b — TxSubscriber API probe (NEW v1; gates P4-T-09)

- **Owner:** Sonnet
- **Inputs:**
  - `/Users/dingo/huly-gitlab/node_modules/@hcengineering/core/lib/operations.d.ts` (authoritative — already referenced by P3-T-01b).
  - `/Users/dingo/huly-gitlab/node_modules/@hcengineering/core/lib/index.d.ts`.
  - `/Users/dingo/huly-gitlab/src/huly/vendor.d.ts` (current widened surface — extend if needed).
  - `/Users/dingo/huly-gitlab/src/huly/client.ts` (existing `HulyClient` wrapper).
  - `/Users/dingo/huly-gitlab/src/sync/engine.ts` (line 86 `enqueueLocalEvent` signature — the destination).
  - `/Users/dingo/huly-gitlab/.omc/specs/p3-t-01b-mixin-change-payload.md` (the flat-key shape — settled; this task only probes the SUBSCRIBER API).
- **Investigation step:**
  - Inspect `@hcengineering/core` for one of the three subscriber patterns:
    - **Path A: `client.notify(handler)`** — the `Client` interface exposes a notify hook that fires on every `Tx`. Verify the handler signature; assert it receives full `Tx` payloads (`TxCUD`, `TxMixin`, `TxRemoveDoc`).
    - **Path B: `client.addTxHandler(handler)`** — a separate registration method on the connected client. Verify the unregister handle.
    - **Path C: No subscription API** — must poll the transactor (`client.findAll` with a server-driven cursor or a `lastSeenTxId`).
  - Build a minimal probe test (`tests/sync/tx-subscription-probe.test.ts`) that:
    - Connects a fake `Client` and asserts the chosen subscription path fires when `client.updateMixin(...)` is invoked.
    - Documents the exact `Tx` shape for `TxMixin` (`objectId`, `mixin`, `attributes`).
    - Documents how to extract the doc ref + class from the tx.
    - **MR-2 prereq:** documents how to extract `tx.createdBy` / `tx.modifiedBy` so the subscriber can filter out self-authored tx events.
  - Write the findings to `/Users/dingo/huly-gitlab/.omc/specs/p4-t-01b-tx-subscription-api.md` (NEW spec file):
    - Chosen path (A/B/C) with rationale.
    - Concrete code skeleton for the subscriber.
    - Translation rules: `TxMixin{MR_MIXIN}` → `enqueueLocalEvent(binding, 'mr', docRef, flat)`; `TxMixin{MR_REVIEW_MIXIN}` → `enqueueLocalEvent(binding, 'review', docRef, flat)`; `TxCUD{tracker.Issue}` with `gitlab-mr` mixin applied → `enqueueLocalEvent(binding, 'mr', docRef, flat)`; `TxCUD{chunter.ChatMessage}` with `gitlab-review` mixin → `enqueueLocalEvent(binding, 'review', docRef, flat)`.
    - **Self-authored filter (MR-2):** documents the service-account PersonUuid resolution path and the `tx.createdBy === serviceAccountPersonUuid` short-circuit.
    - Dedup window: 5 seconds on `(workspaceUuid, docRef, txId)`.
    - **Cold-start buffering (MR-1):** documents that the subscriber buffers tx events received before `engine.start()` completes, then drains the buffer FIFO into `enqueueLocalEvent` after start. Bounded buffer (default 1024 events; overflow drops oldest + increments `tx.subscription.buffer.overflow` metric).
    - Lifecycle: subscriber started on first `BindingLoader.loadFor*` per workspace; cached for 30 min TTL (matching existing HulyClient cache); stopped on cache eviction or pod shutdown. **Wiring code lives in P4-T-19, NOT P4-T-09.**
    - If Path C, document poll cadence (default 5s) and `lastSeenTxId` persistence in a new state collection `tx_cursors` keyed by `workspaceUuid`.
  - If `vendor.d.ts` needs widening to accept the chosen API, document the delta. **If widening is needed, P4-T-01b lands the widening + the spec; P4-T-09 consumes it.**
- **Outputs:**
  - `/Users/dingo/huly-gitlab/.omc/specs/p4-t-01b-tx-subscription-api.md` (new spec file, ~140 lines).
  - Code comment at head of `src/sync/tx-subscription.ts` placeholder file (the file is actually created in P4-T-09) referencing the spec.
  - `tests/sync/tx-subscription-probe.test.ts` (1 case asserting the subscription fires + 1 case asserting `tx.createdBy` is accessible).
  - Optional: `src/huly/vendor.d.ts` widening if the chosen API requires it.
- **Acceptance criteria:**
  - `cat /Users/dingo/huly-gitlab/.omc/specs/p4-t-01b-tx-subscription-api.md | grep -q "Chosen path"` exits 0.
  - `cat /Users/dingo/huly-gitlab/.omc/specs/p4-t-01b-tx-subscription-api.md | grep -q "Self-authored filter"` exits 0.
  - `cat /Users/dingo/huly-gitlab/.omc/specs/p4-t-01b-tx-subscription-api.md | grep -q "Cold-start buffering"` exits 0.
  - `npm test -- tests/sync/tx-subscription-probe.test.ts` passes.
  - `npm run build` exits 0 (after any vendor.d.ts widening).
- **Dependencies:** none (parallel with P4-T-01 and P4-T-02 in Wave A). Output **blocks P4-T-09.**
- **Complexity:** M (~340 LOC including probe test + spec doc + possible vendor widening + cold-start design).

---

### P4-T-02 — Mixin Schema Extensions (`mr-mixin.ts` + new `epic-mixin.ts`)

- **Owner:** Sonnet
- **Inputs:**
  - `/Users/dingo/huly-gitlab/src/sync/mr-mixin.ts` (Phase 3 — fields documented; extend optional fields).
  - `/Users/dingo/huly-gitlab/src/sync/mr-review-mixin.ts` (Phase 3 — pattern reference).
  - P4-T-01 types (`SyncMRApprovalRule`, `SyncIteration`).
- **Outputs (modify `src/sync/mr-mixin.ts`):**
  - Extend `MRMixinDoc` with optional Phase 4 fields:
    ```ts
    /** EE approval rules. Written by MergeRequestsSyncManager.applyRemote when capabilities.edition === 'EE'. */
    approvalRules?: SyncMRApprovalRule[]
    /** GitLab iteration assigned to this MR. EE-only. Written by MergeRequestsSyncManager. */
    iteration?: SyncIteration | null
    /**
     * Parent epic IID if this MR is included in an epic.
     * AC-1 SOLE WRITER: EpicsSyncManager (via child-issue propagation when applying an epic).
     * MergeRequestsSyncManager MUST NOT touch this field — neither write nor read.
     */
    parentEpicIid?: number | null
    ```
  - Extend the field-ownership JSDoc partition note (AC-1 single-writer invariant):
    - `MergeRequestsSyncManager` owns `approvalRules`, `iteration` on `gitlab-mr`. EXCLUDES `parentEpicIid`.
    - `EpicsSyncManager` exclusively owns `gitlab-epic` mixin fields AND is the SOLE writer of `parentEpicIid` (the field lives on `gitlab-mr` for MR mirrors but EpicsSyncManager writes it during child-issue propagation, and on `gitlab-issue` mixin for plain-issue mirrors).
    - `PipelineSyncManager`, `ReviewThreadsSyncManager` ownership unchanged.
- **Outputs (modify `src/sync/issue-mixin.ts` if it exists; or document if it does NOT):**
  - If a `gitlab-issue` mixin exists (issue mirror): add `parentEpicIid?: number | null` field with the same AC-1 sole-writer note.
  - If no such mixin exists (Phase 1+2+3 may have used `gitlab-mr` for plain issue mirrors too): note that `parentEpicIid` lives on whichever mixin is applied to the issue mirror.
- **Outputs (new file `src/sync/epic-mixin.ts`):**
  ```ts
  import type { Mixin, Ref } from '@hcengineering/core'
  import type { Issue } from '@hcengineering/tracker'
  import type { EpicState } from '../adapter/types'

  /**
   * Shape of the runtime `gitlab-epic` mixin written onto a tracker.Issue
   * that mirrors a GitLab epic. Owned exclusively by EpicsSyncManager.
   */
  export interface EpicMixinDoc extends Issue {
    epicIid: number
    groupId: number
    state: EpicState
    webUrl: string
    childIssueIids: number[]
    parentEpicIid: number | null
  }

  /** Runtime mixin id carrying GitLab epic fields on a tracker.Issue. */
  export const EPIC_MIXIN = 'gitlab-epic' as unknown as Ref<Mixin<EpicMixinDoc>>
  ```
  - Module JSDoc: runtime-only mixin (no model registration); mirrors the Phase 2/3 `MR_MIXIN`/`MR_REVIEW_MIXIN` patterns. Field-ownership rule reiterated.
- **Acceptance criteria:**
  - `npm run build` exits 0.
  - `npm run lint -- src/sync/mr-mixin.ts src/sync/epic-mixin.ts` exits 0.
  - `grep -q "EPIC_MIXIN" src/sync/epic-mixin.ts && grep -q "approvalRules" src/sync/mr-mixin.ts && grep -q "parentEpicIid" src/sync/mr-mixin.ts && grep -q "iteration" src/sync/mr-mixin.ts && grep -q "SOLE WRITER: EpicsSyncManager" src/sync/mr-mixin.ts` exits 0.
  - No tests required — pure type additions.
- **Dependencies:** P4-T-01.
- **Complexity:** S (~140 LOC across both files + JSDoc).

---

### P4-T-03 — GitLabClient EE methods (approval rules + iterations + epics + top-level group resolution)

- **Owner:** Sonnet
- **Inputs:**
  - `/Users/dingo/huly-gitlab/src/adapter/gitlab-client.ts` (Phase 1–3 — extend not rewrite; refactored `request` helper from P3-T-03 with `tokenOverride` already present; capability detection cache from Phase 1 at the class boundary).
  - P4-T-01 types.
  - Spec §EE approval rules / §Iterations / §Epics / §Webhook subscription.
  - `/Users/dingo/huly-gitlab/src/adapter/capabilities.ts` (Phase 1 — `capabilities.edition === 'EE'` check; reuse verbatim).
- **Outputs (modify `src/adapter/gitlab-client.ts`):**
  - **Capability gate helper:** private `ensureEE(feature: 'approval_rules' | 'epics' | 'iterations'): Promise<boolean>` — reads cached capabilities; returns `true` on EE, `false` on CE. Caller invariant: when `false`, return `[]` / `null` silently from the public method, log `ee.feature.skipped` debug, increment `ee.feature.skipped` metric.
  - **Top-level group resolution helper (Bug-1):** private `resolveTopLevelGroupForProject(projectId: number): Promise<number>` — epics live at the top-level group, not the immediate sub-group. Implementation:
    1. `GET /api/v4/projects/:id` → reads `namespace.full_path` and `namespace.id`.
    2. If `namespace.kind === 'user'`, throws `EEFeatureUnavailableError('epics')` (epics require a group namespace).
    3. Otherwise walks upward via `GET /api/v4/groups/:groupId` reading `parent_id`; iterates until `parent_id === null`. Returns the top-level group id.
    4. Cache result for 1 hour keyed by `projectId` (epic group rarely changes).
  - **Short-TTL composite cache (P4-R3):** in-memory cache for `getMRApprovalRules` results, keyed by `(projectId, mrIid)`, TTL 10 seconds, bounded LRU (capacity 256 entries per `gitLabClient` instance). Mitigates the 5-call composite cost when a single MR is queried repeatedly within a short window (e.g., webhook delivery + composite reconciliation). Cache is invalidated on any `approveMR`/`unapproveMR` write originating from the same client. Reuses the `BiDirectionalCache` pattern from P4-T-12 ONLY for the LRU eviction; a small bespoke wrapper here is acceptable to avoid Wave C→D coupling.
  - **EE Approval Rules:**
    - `getMRApprovalRules(projectId, mrIid): Promise<SyncMRApprovalRule[]>` — GET `/api/v4/projects/:id/merge_requests/:mrIid/approval_rules`. On CE (`ensureEE === false`) returns `[]`. On EE 200 maps `rules[].eligible_approvers[]` → `SyncUser[]`. On 404 returns `[]` + `mr.composite.partial` (extends Phase 3 Q4 pattern). 5xx propagates as `GitLabApiError`. **Consults the 10s short-TTL cache first; populates on miss.**
  - **EE Iterations:**
    - `listIterations(groupId, opts?: { updatedAfter?: Date, projectId?: number }): Promise<SyncIteration[]>` — paginated GET `/api/v4/groups/:groupId/iterations`. Reuses the Link-header pagination helper. CE silently returns `[]`. **Caller passes the top-level group id resolved via `resolveTopLevelGroupForProject`.**
    - `getIteration(groupId, iterationId): Promise<SyncIteration | null>` — GET `/api/v4/groups/:groupId/iterations/:iterationId`. 404 → null; CE → null.
  - **EE Epics:**
    - `listEpics(groupId, opts?: { updatedAfter?: Date }): Promise<SyncEpic[]>` — paginated GET `/api/v4/groups/:groupId/epics`. CE silently returns `[]`. Maps `epic.parent_id` → `parentEpicIid: number | null`. **Caller passes top-level group id.**
    - `getEpic(groupId, epicIid): Promise<SyncEpic | null>` — GET `/api/v4/groups/:groupId/epics/:epicIid`. 404 → null; CE → null.
    - `listEpicIssues(groupId, epicIid): Promise<number[]>` — paginated GET `/api/v4/groups/:groupId/epics/:epicIid/issues`. Returns array of `issue.iid`. Used by `EpicsSyncManager` to compute `childIssueIids`.
  - **`getMergeRequest` extension:** when `ensureEE('approval_rules') === true`, the composite fetch chain (already adds `getMRApprovals` + `getMRChanges` from Phase 3) gains `getMRApprovalRules` + `getIteration` (if MR's `iteration_id` is set). Phase 4 thus extends Phase 3's composite from 3 calls to up to 5 on EE. **JSDoc must document the 5-call cost on EE.** **AC-1 update:** `parentEpicIid` is NOT populated from the MR payload's `epic_iid` field (AC-1 single-writer invariant — EpicsSyncManager handles all parentEpicIid writes via child-issue propagation). The MR payload's `epic_iid` field is IGNORED by the adapter mapping.
- **Outputs (tests):** `tests/adapter/gitlab-client-ee.test.ts` (NEW; ≥ 17 cases):
  1. `getMRApprovalRules` on EE happy path: maps 2 rules with eligible_approvers.
  2. `getMRApprovalRules` on CE: returns `[]` silently; no HTTP call made (capability cache hit).
  3. `getMRApprovalRules` on EE 404: returns `[]` + `mr.composite.partial` increments.
  4. `getMRApprovalRules` on EE 500: throws `GitLabApiError`.
  5. **P4-R3 cache:** two calls to `getMRApprovalRules(p,m)` within 10s → 1 HTTP call; `approveMR(p,m,...)` invalidates the cache; next read fires a fresh HTTP call.
  6. `listIterations` on EE happy path with pagination.
  7. `listIterations` on CE: returns `[]`; no HTTP call.
  8. `getIteration` on EE 404: returns null.
  9. `listEpics` on EE happy path with pagination; `parent_id` mapped to `parentEpicIid`.
  10. `listEpics` on CE: returns `[]`; no HTTP call.
  11. `getEpic` on EE: maps full epic object.
  12. `listEpicIssues` on EE happy path: returns array of IIDs.
  13. `listEpicIssues` on EE empty epic: returns `[]`.
  14. `getMergeRequest` on EE: composite fetch includes approval_rules + iteration calls; assert call count = 5 when iteration_id is set.
  15. `getMergeRequest` on CE: composite fetch DOES NOT call approval_rules/iteration endpoints; assert call count = 3 (Phase 3 unchanged).
  16. **AC-1 regression:** `getMergeRequest` on EE returns SyncMergeRequest with NO `parentEpicIid` field set, even when GitLab response includes `epic_iid: 42`.
  17. **Bug-1 sub-group resolution:** project under `top-group/mid-group/sub-group/project` → `resolveTopLevelGroupForProject` returns `top-group.id`; subsequent `listEpics(topGroupId)` succeeds. Cache hit on second call.
- **Acceptance criteria:**
  - `npm test -- tests/adapter/gitlab-client-ee.test.ts` passes all 17 cases.
  - `npm run lint -- src/adapter/gitlab-client.ts tests/adapter/gitlab-client-ee.test.ts` exits 0.
  - No `any` introduced.
  - Existing Phase 1–3 adapter tests continue to pass.
- **Dependencies:** P4-T-01.
- **Complexity:** L (~1600 LOC including nock fixtures + capability mocks + sub-group walk + short-TTL cache).

---

### P4-T-04 — BindingLoader cache key multi-instance widening + multi-instance flag

- **Owner:** Sonnet
- **Inputs:**
  - `/Users/dingo/huly-gitlab/src/sync/binding-loader.ts` (Phase 2+3 — cache keyed by `workspaceUuid`; constructors at lines 86–95; `loadForIssues`/`loadForMergeRequests` at lines 97/137; per-mode loader pattern).
  - Spec §Multi-instance support.
  - `/Users/dingo/huly-gitlab/src/state/credentials.ts` (line 18 — `CredentialDoc.gitlabBaseUrl` already exists; pattern reference).
- **Outputs (modify `src/sync/binding-loader.ts`):**
  - **Cache key extension:** internal cache `Map<string, CachedContext>` keyed by `${workspaceUuid}|${gitlabBaseUrl}`. **Note:** `HulyClient` is per workspace (so two bindings to different GitLab instances under the same workspace SHARE the same HulyClient). The cache value's `gitLabClient` is per-binding, constructed from `credential.gitlabBaseUrl` at load time.
  - **Refactor `loadForIssues` and `loadForMergeRequests`:** the cache lookup now uses the new compound key. The per-binding `gitLabClient` is constructed inside `loadFor*` from `credential.gitlabBaseUrl`. HulyClient creation is still per-workspace; the loader uses an inner workspace-only sub-cache to dedupe HulyClient construction.
  - **Multi-instance detection (TG-4 prereq):** on every `loadFor*` call, compute `isMultiInstanceWorkspace = countCachedBaseUrlsForWorkspace(workspaceUuid) >= 2 || existingBindingsForWorkspace > 1`. Surface this on the `BindingContext` (`bctx.isMultiInstanceWorkspace: boolean`). Managers consume this flag and pass to `prefixGitlabIdForMultiInstance` when forming idmap `gitlabId` strings. **Migration note (JSDoc):** existing single-instance workspaces NEVER transition to multi-instance retroactively (legacy idmap rows stay unprefixed); operators who genuinely add a second instance MUST run a one-time migration script (out of scope for Phase 4 — document as a maintenance ticket in `docs/runbooks/phase4-deployment.md`).
  - **Eviction:** on TTL expiry or cache eviction, close ONLY the gitLabClient for the evicted compound key; the HulyClient stays alive if any other binding under the same workspace still uses it (refcount the workspace key).
  - **Document explicitly (JSDoc):** the multi-instance design assumption is that two bindings under one workspace pointing to DIFFERENT GitLab instances both work concurrently; the `prefixGitlabIdForMultiInstance` helper provides defense-in-depth against duplicate project IDs across instances.
- **Outputs (tests):** extend `tests/sync/binding-loader.test.ts` — ≥ 5 new cases:
  1. Two bindings, same workspaceUuid, different gitlabBaseUrl → two distinct cache entries; two distinct gitLabClient instances; SAME HulyClient instance (refcount).
  2. Two bindings, different workspaceUuid, same gitlabBaseUrl → two distinct cache entries; two distinct HulyClient instances.
  3. Cache eviction of binding A under workspace W (pointing to instance X) does NOT close the shared HulyClient if binding B under workspace W (pointing to instance Y) still holds it.
  4. After all bindings under workspace W evict, the HulyClient IS closed.
  5. **TG-4:** binding A and binding B under the same workspace, different baseUrls → `bctx.isMultiInstanceWorkspace === true` on both. Single-binding workspace → `false`.
- **Acceptance criteria:**
  - `npm test -- tests/sync/binding-loader.test.ts` passes all 5 new cases.
  - `npm run lint -- src/sync/binding-loader.ts` exits 0.
  - All Phase 1–3 binding-loader regression cases pass.
- **Dependencies:** P4-T-01 (consumes `prefixGitlabIdForMultiInstance` from idmap).
- **Complexity:** M (~520 LOC including refactor + tests + multi-instance flag).

---

### P4-T-05 — User-credentials store (`src/state/user-credentials.ts`)

- **Owner:** Sonnet
- **Inputs:**
  - `/Users/dingo/huly-gitlab/src/state/credentials.ts` (Phase 1 — AES-256-GCM pattern to mirror; key derivation; CredentialDoc shape).
  - `/Users/dingo/huly-gitlab/src/auth/refresh.ts` (Phase 1 — `OAuthRefresher` extension target).
  - Spec §Per-user OAuth backend.
- **Outputs (new file `src/state/user-credentials.ts`):**
  - Schema (SCG-2 adds `username`):
    ```ts
    export interface UserCredentialDoc {
      _id: ObjectId
      workspaceUuid: string
      hulyPersonUuid: string
      gitlabBaseUrl: string
      /** GitLab username captured at OAuth callback time via GET /api/v4/user. Surfaced in /user/oauth/status. */
      username: string
      ciphertext: string
      iv: string
      tag: string
      createdAt: Date
      expiresAt?: Date
      refreshTokenCiphertext?: string
      refreshTokenIv?: string
      refreshTokenTag?: string
      expired?: boolean
    }
    ```
  - Functions (mirror Phase 1 `credentials.ts` API):
    - `putUserCredential(col, key, input: PutUserCredentialInput): Promise<string>` — upserts by `(workspaceUuid, hulyPersonUuid, gitlabBaseUrl)` compound key. Input MUST include `username`.
    - `getUserCredential(col, key, workspaceUuid, hulyPersonUuid, gitlabBaseUrl): Promise<CredentialResult | null>` — return value includes `username`.
    - `deleteUserCredential(col, workspaceUuid, hulyPersonUuid, gitlabBaseUrl): Promise<void>`.
    - `rotateUserCredential(col, key, workspaceUuid, hulyPersonUuid, gitlabBaseUrl, input): Promise<void>` — for refresh; preserves existing `username`.
  - **Compound unique index:** at startup, ensure index on `{workspaceUuid: 1, hulyPersonUuid: 1, gitlabBaseUrl: 1}` (unique: true). The Mongo init script (or runtime `ensureIndex` call from `src/index.ts`) creates it.
  - Reuses the Phase 1 `CredentialEncryptionKey` via the same env-derived buffer — no new key infrastructure.
- **Outputs (modify `src/auth/refresh.ts`):**
  - `OAuthRefresher.refreshUserCredentials(): Promise<void>` — iterates `user_credentials` where `expiresAt < now + 5 min` AND `expired !== true`, calls the GitLab token refresh endpoint with the per-user refresh token, and updates the doc via `rotateUserCredential`. Same transient/permanent classification as Phase 1.
  - Schedule: add to the existing refresh cron loop. Document JSDoc.
- **Outputs (tests):** `tests/state/user-credentials.test.ts` (NEW; ≥ 9 cases):
  1. `putUserCredential` + `getUserCredential` round-trip: plaintext recovered after AES-GCM round-trip; `username` is preserved.
  2. Compound key uniqueness: putting twice with same `(ws, person, gitlabBaseUrl)` replaces (upsert behavior). Putting with different baseUrl creates a second doc.
  3. `deleteUserCredential` removes the doc; subsequent get returns null.
  4. `rotateUserCredential` replaces ciphertext + expiresAt without changing `_id` or `username`.
  5. `refreshTokenPlaintext` round-trip when present.
  6. `expired: true` doc is NOT picked up by refresh.
  7. Refresh succeeds → expiresAt updated; `expired` stays false.
  8. Refresh permanent failure → `expired: true` is set.
  9. **SCG-2:** `getUserCredential` returns `{ plaintext, expiresAt, username }` shape; downstream consumers can read `username` without re-querying.
- **Acceptance criteria:**
  - `npm test -- tests/state/user-credentials.test.ts` passes all 9 cases.
  - `npm run lint -- src/state/user-credentials.ts src/auth/refresh.ts tests/state/user-credentials.test.ts` exits 0.
  - `grep -q "putUserCredential" src/state/user-credentials.ts && grep -q "refreshUserCredentials" src/auth/refresh.ts && grep -q "username" src/state/user-credentials.ts` exits 0.
  - All Phase 1–3 credential tests continue to pass.
- **Dependencies:** P4-T-01 (no direct dep; runs in Wave B).
- **Complexity:** M (~540 LOC including refresh wiring + tests + username field).

---

### P4-T-06 — EpicsSyncManager (new file `src/sync/epics.ts`)

- **Owner:** Opus
- **Inputs:**
  - `/Users/dingo/huly-gitlab/src/sync/issues.ts` (Phase 1 — closest analogue; status mapping, attachments, mixin write path).
  - `/Users/dingo/huly-gitlab/src/sync/mr.ts` (Phase 2/3 — mixin-write shape, idmap upsert flow, cursor set).
  - `/Users/dingo/huly-gitlab/src/sync/engine.ts` (`SyncManager` interface, `resourceKey`, `kind` threading).
  - P4-T-01 types, P4-T-02 `EPIC_MIXIN`, P4-T-03 `listEpics`/`getEpic`/`listEpicIssues` + `resolveTopLevelGroupForProject`.
  - Spec §Epics.
- **Outputs (new file `src/sync/epics.ts`):**
  - `EpicsSyncManager implements SyncManager<SyncEpic>`:
    - `kind = 'epic'`.
    - `resourceKey(record)` returns `epic:${groupId}:${epicIid}`.
    - **`applyRemote(ctx, binding, syncEpic)`:**
      1. **EE gate:** if `bctx.capabilities.edition !== 'EE'`, return silently (no Huly write); log `ee.feature.skipped` debug; increment metric.
      2. Resolve / create Huly Issue:
         - Compute idmap `gitlabId` via `prefixGitlabIdForMultiInstance(bctx.gitlabBaseUrl, '${groupId}:${epicIid}', bctx.isMultiInstanceWorkspace)` (TG-4).
         - `findByGitlab(idmap, ws, 'epic', gitlabId)` → existing ref or null.
         - If null: `hulyClient.createDoc<Issue>(tracker.class.Issue, { ... mapped fields: title=syncEpic.title, description=markdown round-trip via `gfmMarkdownToMarkup` with `/-/epics` refUrl, status='Backlog' (default), kind=Issue, identifier='EPIC-<n>')`. Attach to the binding's `hulyProjectRef`. Upsert idmap. **All write paths stamp transient `_originated: 'gitlab'` marker on the createDoc/updateMixin attributes for MR-2 defense-in-depth.**
         - If present: `updateDoc` with per-field LWW on `title`, `description`, `status`.
      3. Apply `gitlab-epic` mixin: `createMixin` first time, `updateMixin` subsequent. Fields: `epicIid`, `groupId`, `state`, `webUrl`, `childIssueIids`, `parentEpicIid`. The child IIDs come from the precomputed `syncEpic.childIssueIids` (the adapter populates via `listEpicIssues`).
      4. **AC-1 SOLE-WRITER parent-child propagation:** for each `childIid` in `syncEpic.childIssueIids`:
         - Find the mirror Issue via `findByGitlab(idmap, ws, 'issue', prefixGitlabIdForMultiInstance(baseUrl, '${projectId}:${childIid}', multiInst))` OR `'mr'` if the child is an MR mirror (the integration mirrors MRs as Issues too). (Project ID comes from the binding context's `bctx.gitlabProjectId` — Phase 4 limitation: epic child issues from OTHER projects are dropped with `epic.child.cross_project` warn log, since the integration is per-binding scoped to one project.)
         - If found, `updateMixin(childIssueRef, tracker.class.Issue, hulyProjectRef, <whichever-mixin-the-child-has>, { parentEpicIid: syncEpic.epicIid })`. **AC-1: EpicsSyncManager is the SOLE writer of `parentEpicIid` on child mirrors.** This is the only path that writes the field. MR mirrors do NOT get `parentEpicIid` from `MergeRequestsSyncManager.applyRemote`.
         - If not found: skip; will be retried next backfill cycle (no defer; epic membership is naturally eventually-consistent because children-by-IID lookup is cheap).
      5. Set cursor (`kind: 'epics'`) to `syncEpic.updatedAt`.
    - **`applyLocal(ctx, binding, doc, change)`:** Phase 4 scope cut — Epic mutations from Huly are **NOT propagated back** to GitLab. Reason: epics are read-only from this integration's perspective; managing GitLab epics from Huly is out of scope per the spec. Returns immediately. Log `epic.applyLocal.skipped` debug.
    - **`backfill(ctx, binding, since)`:**
      1. **Bug-1 top-level group resolution:** call `bctx.gitlabClient.resolveTopLevelGroupForProject(bctx.gitlabProjectId)` to obtain the group epics live on. NEVER assume `namespace.id` (which is the immediate sub-group).
      2. `bctx.gitlabClient.listEpics(topGroupId, { updatedAfter: since })`.
      3. For each epic, fetch child IIDs via `listEpicIssues(topGroupId, epic.epicIid)`.
      4. Enqueue each epic as an `'epic'` envelope via `this.deps.backfillEnqueuer`.
      5. Document the 6th listing call per binding per cycle (issues + notes + MRs + MR-notes + reviews + epics on EE).
  - Surface `EpicsBindingContext` exposing `gitlabClient`, `hulyClient`, `userIdentity`, `workspaceUuid`, `gitlabProjectId`, `gitlabBaseUrl`, `hulyProjectRef`, `capabilities`, `isMultiInstanceWorkspace`. NOT `credentials` (epics don't trigger applyLocal).
- **Outputs (tests):** `tests/sync/epics.test.ts` — ≥ 13 cases:
  1. `applyRemote` on EE creates mirror Issue + `gitlab-epic` mixin populated.
  2. `applyRemote` on CE returns silently; no Huly write; `ee.feature.skipped` metric increments.
  3. `applyRemote` updates existing Issue (LWW on title); mixin childIssueIids replaced atomically.
  4. `applyRemote` propagates `parentEpicIid` to child Issue mirrors via `updateMixin(<child-mixin>, { parentEpicIid })`.
  5. `applyRemote` with child IID not in idmap → skip silently; metric NOT incremented.
  6. `applyRemote` with `parentEpicIid` set (nested epic): mixin field populated; cross-group hierarchy emits warn log if cross-group access denied.
  7. `applyLocal` is a no-op (epic.applyLocal.skipped debug emitted; zero adapter calls).
  8. `backfill` calls `resolveTopLevelGroupForProject` THEN `listEpics(topGroupId)` THEN `listEpicIssues` per epic; enqueue shape asserted. **Bug-1 regression:** sub-group project → top-level group used.
  9. `resourceKey` returns the documented compound shape.
  10. `applyRemote` markdown round-trip uses `/-/epics` refUrl (NOT `/-/issues`).
  11. **AC-1 sole-writer assertion (TG-3):** when applying an epic with 1 MR-mirror child + 1 issue-mirror child, BOTH children get `parentEpicIid` written by EpicsSyncManager. Simultaneously, no `gitlab-mr` MR core fields (title/description/labels/etc.) are touched on those children — only `parentEpicIid`.
  12. **TG-4 multi-instance idmap prefix:** in a multi-instance workspace, `applyRemote` uses prefixed `gitlabId` (8-hex prefix + `:${groupId}:${epicIid}`). In single-instance, plain.
  13. **MR-2 defense-in-depth:** all `createDoc`/`updateMixin` calls include `_originated: 'gitlab'` in attributes (verified via spy on hulyClient).
- **Acceptance criteria:**
  - `npm test -- tests/sync/epics.test.ts` passes all 13 cases.
  - `npm run lint -- src/sync/epics.ts` exits 0.
  - No regression in `tests/sync/issues.test.ts`, `tests/sync/mr.test.ts`.
- **Dependencies:** P4-T-01, P4-T-02, P4-T-03, P4-T-04 (consumes `isMultiInstanceWorkspace`).
- **Complexity:** L (~1700 LOC including tests + fakes + AC-1 sole-writer assertions + Bug-1 top-level group walk + TG-4 prefix).

---

### P4-T-07 — IterationsSyncManager (new file `src/sync/iterations.ts`)

- **Owner:** Sonnet
- **Inputs:**
  - `/Users/dingo/huly-gitlab/src/sync/issues.ts` (Phase 1 — sync manager pattern).
  - `/Users/dingo/huly-gitlab/src/sync/engine.ts` (interface).
  - P4-T-01 types (`SyncIteration`, `'iteration'` kind, `'iterations'` cursor kind).
  - P4-T-03 `listIterations` / `getIteration` + `resolveTopLevelGroupForProject`.
  - Spec §Iterations.
- **Decision (planner): SEPARATE FILE.** Rationale: iterations have their own backfill loop (group-scoped vs MR-scoped) and need a dedicated cursor; folding into `mr.ts` would re-bloat the file we're trying to shrink in P4-T-11.
- **Outputs (new file `src/sync/iterations.ts`):**
  - `IterationsSyncManager implements SyncManager<SyncIteration>`:
    - `kind = 'iteration'`.
    - `resourceKey(record)` returns `iteration:${record.id}`.
    - **`applyRemote(ctx, binding, syncIteration)`:**
      1. EE gate (silent return on CE).
      2. Upsert idmap (`workspaceUuid`, `'iteration'`, `prefixGitlabIdForMultiInstance(baseUrl, syncIteration.id, multiInst)`) — the `hulyClass`/`hulyRef` are placeholder `iteration.placeholder` / `iteration:${id}` because iterations have NO Huly Doc representation in Phase 4; idmap is used purely for change-detection on the cursor.
      3. **Mixin write happens INDIRECTLY** via `MergeRequestsSyncManager.applyRemote` on MRs that reference this iteration (the MR composite fetch already pulls `getIteration`). `IterationsSyncManager` itself does not write a Huly Doc. **Therefore P4-T-07's primary responsibility is backfill + propagation triggering** — when an iteration's `updatedAt` advances, the manager re-enqueues all MRs in the group that reference this iteration so their `getMergeRequest` composite picks up the new iteration state.
      4. Set cursor (`kind: 'iterations'`) to `syncIteration.updatedAt`.
    - **`applyLocal`:** no-op (iterations not writable from Huly).
    - **`backfill`:** call `resolveTopLevelGroupForProject(bctx.gitlabProjectId)` first; then list iterations for the top-level group; for each updated since cursor, find MRs in the group referencing this iteration via `bctx.gitlabClient.listMergeRequests({ iteration_id: ... })` (a NEW filter — add to adapter as part of P4-T-03 OR document as optional and skip the MR re-enqueue for simplicity in Phase 4). **Planner default: skip the MR re-enqueue trigger; rely on the natural MR Hook arrival to refresh iteration state. Document as a Phase 5-style deferral.**
    - **Bug-7 SLA documentation:** iteration-only changes (no MR edit) propagate within the next backfill cycle (≤ 5 min default by binding-lifecycle config), NOT within 30s. The 30s SLA only applies when an MR Hook delivery occurs after the iteration change. Update spec criterion #9 amended to "30s on next MR Hook delivery OR 5min via backfill — whichever first." Documented in `docs/api.md` and JSDoc on `IterationsSyncManager.backfill`.
- **Outputs (tests):** `tests/sync/iterations.test.ts` — ≥ 7 cases:
  1. EE gate: CE returns silently; no idmap write.
  2. EE happy path: idmap upserted; cursor advanced.
  3. `applyLocal` is a no-op.
  4. `backfill` resolves top-level group THEN lists iterations and enqueues each (Bug-1 regression for iterations endpoint).
  5. Idempotent re-application: same iteration twice → idempotent idmap upsert.
  6. `resourceKey` returns the documented shape.
  7. **TG-4 multi-instance:** in multi-instance workspace, idmap `gitlabId` is prefixed.
- **Acceptance criteria:**
  - `npm test -- tests/sync/iterations.test.ts` passes all 7 cases.
  - `npm run lint -- src/sync/iterations.ts` exits 0.
- **Dependencies:** P4-T-01, P4-T-03, P4-T-04.
- **Complexity:** M (~560 LOC including tests + Bug-7 SLA docs).

---

### P4-T-08 — MergeRequestsSyncManager EE field extensions (AC-1 scope-corrected)

- **Owner:** Opus
- **Inputs:**
  - `/Users/dingo/huly-gitlab/src/sync/mr.ts` (Phase 3 — 991 LOC; this task extends; P4-T-11 will extract approvals AFTER this lands).
  - P4-T-01 types, P4-T-02 mixin schema (`approvalRules`, `iteration` — note `parentEpicIid` is NOT in this task's scope), P4-T-03 adapter EE methods.
  - Spec §EE approval rules / §Iterations / §Epics §parent-child.
- **Outputs (modify `src/sync/mr.ts`):**
  - **In `buildMixinCreateData` and `buildMixinUpdateData`:** conditionally write the 2 new optional Phase 4 fields ONLY (`approvalRules`, `iteration`) following the B2 contract. **AC-1: do NOT touch `parentEpicIid`:**
    - `if (syncMR.approvalRules !== undefined) data.approvalRules = syncMR.approvalRules`.
    - `if (syncMR.iteration !== undefined) data.iteration = syncMR.iteration`.
    - `// AC-1: parentEpicIid is owned exclusively by EpicsSyncManager. Do NOT read or write it here.`
  - **`approvalStatus` derivation extended:** when `approvalRules` is present, override the existing `approvedBy.length >= approvalsRequired` logic with rule-aware logic:
    - For each rule, compute `ruleSatisfied = rule.approvedBy.length >= rule.approvalsRequired`.
    - `approvalStatus = allRulesSatisfied ? 'approved' : 'pending'`.
    - CE path unchanged (rules undefined → fall back to Phase 3 logic).
  - **`iteration` source:** the adapter's `getMergeRequest` composite fetch pulls `getIteration` when MR has `iteration_id`. The MR manager writes the field directly.
  - **No changes to `applyLocal`:** approval action propagation from Phase 3 stays; EE rules don't introduce new applyLocal action types in Phase 4. Document JSDoc.
  - **SCG-1 actor-token provenance guard:** remove the legacy Phase 3 carry path in `mr-review.ts:333` that reads `change.actorToken` from the change payload. Replace with `bctx.credentials.resolveActorToken(workspaceUuid, change.modifiedBy)`. The resolver is workspace+person scoped; the change envelope must NOT carry a token field. Update the call signature accordingly. **Note:** this edit is to `mr-review.ts`, not `mr.ts`. P4-T-08 owns the edit because it's adjacent to the approval-actions extraction in P4-T-11.
  - **MR-2 defense-in-depth:** all `createMixin`/`updateMixin` calls stamp `_originated: 'gitlab'` on the attributes object (the TxSubscriber's primary filter is service-account author, but the marker is a belt-and-suspenders check).
- **Outputs (tests):** extend `tests/sync/mr.test.ts` — ≥ 11 new cases:
  1. `applyRemote` on EE populates `approvalRules` mixin field with 2 rules.
  2. `applyRemote` on CE leaves `approvalRules` undefined; existing mixin value (if any) NOT cleared.
  3. `applyRemote` populates `iteration` mixin field when MR has iteration_id.
  4. **AC-1 single-writer regression:** `applyRemote` does NOT write `parentEpicIid` mixin field, EVEN when the SyncMergeRequest object somehow includes one (synthetic test — pre-set `parentEpicIid: 7` on the mock input, run applyRemote, assert mixin `parentEpicIid` is NOT touched and EpicsSyncManager remains the sole writer path).
  5. `approvalStatus` derivation with rules: all rules satisfied → 'approved'.
  6. `approvalStatus` derivation with rules: 1 rule unsatisfied → 'pending'.
  7. **Bug-4 CE regression:** `approvalStatus` derivation with NO rules (CE path) → matches Phase 3 logic exactly (verified by re-running the Phase 3 case 5 fixture; new explicit regression test in `tests/sync/mr.test.ts` titled "CE approvalStatus derivation matches Phase 3").
  8. Field-ownership regression: `applyRemote` does NOT write `gitlab-epic` mixin fields.
  9. B2 regression: `syncMR.approvalRules === undefined` does NOT clear an existing mixin value (pre-seed with 1 rule, run applyRemote with undefined, assert mixin unchanged).
  10. **SCG-1 provenance:** approval applyLocal calls `bctx.credentials.resolveActorToken(workspaceUuid, change.modifiedBy)` — verified via spy. Change payloads with synthetic `actorToken: 'attacker'` are IGNORED (the field is not read; the token comes from the resolver).
  11. **MR-2 defense-in-depth:** `createMixin`/`updateMixin` attributes include `_originated: 'gitlab'`.
- **Acceptance criteria:**
  - `npm test -- tests/sync/mr.test.ts tests/sync/mr-review.test.ts` passes all existing + 11 new cases.
  - `npm run lint -- src/sync/mr.ts src/sync/mr-review.ts` exits 0.
  - `grep -q "AC-1" src/sync/mr.ts && grep -q "SCG-1" src/sync/mr-review.ts` exits 0.
  - `grep -q "change.actorToken" src/sync/mr-review.ts` returns NO match (legacy field reference removed).
- **Dependencies:** P4-T-01, P4-T-02, P4-T-03.
- **Complexity:** M (~580 LOC including new tests; net addition before P4-T-11 extraction; includes SCG-1 mr-review.ts cleanup).

---

### P4-T-09 — TxSubscriber core class + tests (DAG-1: core only; wiring → P4-T-19)

- **Owner:** Opus
- **Inputs:**
  - `/Users/dingo/huly-gitlab/src/sync/engine.ts` (line 86 `enqueueLocalEvent` — call site).
  - `/Users/dingo/huly-gitlab/src/huly/client.ts` (`HulyClient` wrapper — extend with the chosen subscription path from P4-T-01b).
  - P4-T-01b output spec `.omc/specs/p4-t-01b-tx-subscription-api.md` (BLOCKS this task).
  - `/Users/dingo/huly-gitlab/.omc/specs/p3-t-01b-mixin-change-payload.md` (flat-key shape — settled).
  - `/Users/dingo/huly-gitlab/src/sync/mr-mixin.ts` (`MR_MIXIN`).
  - `/Users/dingo/huly-gitlab/src/sync/mr-review-mixin.ts` (`MR_REVIEW_MIXIN`).
- **Outputs (new file `src/sync/tx-subscription.ts`):**
  - Module-level comment cross-references P3-T-01b (payload shape), P4-T-01b (subscription API), and MR-2 (echo-storm filter).
  - `TxSubscriber` class:
    - `constructor(deps: { hulyClient: HulyClient, syncEngine: SyncEngine, bindings: BindingRef[], workspaceUuid: WorkspaceUuid, serviceAccountPersonUuid: PersonUuid, logger: Logger })`. The `serviceAccountPersonUuid` is resolved by the binding-loader at subscriber instantiation time via the existing Phase 1 service-account discovery; passed in as a constant for the subscriber's lifetime.
    - `start(): Promise<void>` — registers the subscription using the chosen path from P4-T-01b. **MR-1 cold-start buffering:** if `syncEngine.isStarted === false`, buffers incoming tx into an internal bounded queue (capacity 1024); drains FIFO after `syncEngine.start()` resolves. Overflow drops oldest + increments `tx.subscription.buffer.overflow` metric.
    - `stop(): Promise<void>` — unregisters; idempotent.
    - **MR-2 echo-storm filter (PRIMARY):** for every incoming tx, check `tx.createdBy === this.deps.serviceAccountPersonUuid` OR `tx.modifiedBy === this.deps.serviceAccountPersonUuid`. If true, DROP the tx silently; increment `tx.subscription.echo.dropped` metric; do NOT enqueue. This is the primary defense against the applyRemote → tx → enqueueLocalEvent → applyRemote loop.
    - **MR-2 echo-storm filter (DEFENSE-IN-DEPTH):** also check the tx's attribute payload for `_originated: 'gitlab'`. If present, DROP (same metric increment). This catches cases where service-account author resolution fails or where a future code path forgets to use the service account.
    - **Translation rules (from P4-T-01b spec):**
      - `TxMixin{MR_MIXIN}.attributes` → for each binding in `bindings` matching the doc's space/project, `syncEngine.enqueueLocalEvent(binding, 'mr', docRef, flat)` where `flat = { approvedBy: tx.attributes.approvedBy, reviewers: tx.attributes.reviewers, title: undefined, ... }` — only the attributes actually present in the tx.
      - `TxMixin{MR_REVIEW_MIXIN}.attributes` → `enqueueLocalEvent(binding, 'review', docRef, { resolved, resolvedBy, resolvedAt })`.
      - `TxUpdateDoc{tracker.class.Issue}` where the Issue has `gitlab-mr` mixin → `enqueueLocalEvent(binding, 'mr', docRef, { title, description, status, labels, milestone, assigneeIds })`. **Filter by mixin presence** to avoid emitting on non-mirror issues.
      - `TxUpdateDoc{chunter.class.ChatMessage}` where the ChatMessage has `gitlab-review` mixin → `enqueueLocalEvent(binding, 'review', docRef, { message })`.
      - Other tx types ignored.
    - **Deduplication:** in-memory `Map<string, number>` keyed by `(workspaceUuid|docRef|txId)` with TTL 5 seconds; second tx within window is skipped. Map auto-prunes every 30s.
    - **Multi-binding fan-out:** the subscriber holds the `bindings: BindingRef[]` snapshot per workspace; on each tx, it determines which binding(s) the docRef belongs to via the existing project-ref → binding map (read from `BindingLoader`). For multi-binding workspaces (multi-instance), a single tx can fan out to multiple bindings — each gets its own enqueue.
    - **Reconnection:** if the subscription drops (e.g., HulyClient disconnect), the subscriber attempts up to 5 exponential-backoff retries (1s, 2s, 4s, 8s, 16s); each attempt logs `tx.subscription.reconnect.attempt`; success → `tx.subscription.reconnect.success`. Final failure → `tx.subscription.reconnect.failed` + the subscriber emits an `onTerminalFailure` callback hook (registered by P4-T-19) that the binding-loader uses to trigger cache eviction. **The subscriber itself does NOT call into the binding-loader directly** (DAG-1 fix — keeps `binding-loader.ts` out of P4-T-09's edit set).
  - Export `createTxSubscriber(deps): TxSubscriber` factory for the binding-loader to invoke (the factory is called from P4-T-19's wiring code, not here).
- **Outputs (DOES NOT modify `src/sync/binding-loader.ts`):** DAG-1 fix. All lifecycle wiring (start on first loadFor*, stop on cache eviction, onTerminalFailure handler registration) lives in P4-T-19. P4-T-09 produces only the core class + tests.
- **Outputs (tests):** `tests/sync/tx-subscription.test.ts` (NEW; ≥ 16 cases):
  1. Start/stop lifecycle: idempotent stop; idempotent start.
  2. `TxMixin{MR_MIXIN}` with `approvedBy` change → `enqueueLocalEvent('mr', flat)` called once with the right shape.
  3. `TxMixin{MR_REVIEW_MIXIN}` with `resolved` flip → `enqueueLocalEvent('review', { resolved })` called once.
  4. `TxUpdateDoc{Issue}` with `gitlab-mr` mixin present → `enqueueLocalEvent('mr', { title, ... })` called once.
  5. `TxUpdateDoc{Issue}` WITHOUT any gitlab mixin → no enqueue (mirror-only filter).
  6. `TxUpdateDoc{ChatMessage}` with `gitlab-review` mixin → `enqueueLocalEvent('review', { message })`.
  7. Deduplication: same `(workspaceUuid, docRef, txId)` arriving twice within 5s → second skipped.
  8. Deduplication: same docRef with different txId arriving twice → both processed.
  9. Multi-binding fan-out: 1 workspace with 2 bindings → 1 tx fans out to both bindings.
  10. Reconnect: subscription drops → reconnect succeeds within 1s → metric `tx.subscription.reconnect.success` increments.
  11. Reconnect exhaustion: 5 consecutive failures → `onTerminalFailure` callback invoked; metric `tx.subscription.reconnect.failed` increments.
  12. Batched txs: 100 txs delivered in tight loop → all enqueued (no drops); dedup map size bounded.
  13. **MR-2 echo-storm filter PRIMARY:** tx with `createdBy === serviceAccountPersonUuid` → DROPPED; `enqueueLocalEvent` NOT called; `tx.subscription.echo.dropped` metric increments. Then a follow-up tx with a different `createdBy` → processed normally.
  14. **MR-2 echo-storm filter DEFENSE-IN-DEPTH:** tx with `_originated: 'gitlab'` in attributes (but `createdBy` is some other Person) → also DROPPED; metric increments.
  15. **MR-1 cold-start:** subscriber `start()` called before `engine.start()`; 3 txs arrive; engine starts; assert all 3 are drained FIFO into `enqueueLocalEvent` after start. Buffer overflow case: 1025 txs queued before start → 1 oldest dropped; `tx.subscription.buffer.overflow` increments.
  16. **TG-1 (documented limit):** integration-style test using a minimal in-process Huly Client fake (NOT a real transactor). Verifies the chosen subscription API path (A/B/C) emits tx events when `client.updateMixin` is invoked from another thread of control. **If `@hcengineering/client` cannot be constructed in-process, this case asserts via the Phase 3 fake-but-strict wrapper AND the test JSDoc documents the gap: "real transactor subscription verified in P4-T-20 E2E."**
- **Acceptance criteria:**
  - `npm test -- tests/sync/tx-subscription.test.ts` passes all 16 cases.
  - `npm run lint -- src/sync/tx-subscription.ts` exits 0.
  - `grep -q "createTxSubscriber" src/sync/tx-subscription.ts` exits 0.
  - **DAG-1:** `git diff --stat src/sync/binding-loader.ts` shows ZERO changes from this task (binding-loader.ts not touched by P4-T-09).
  - `grep -q "serviceAccountPersonUuid" src/sync/tx-subscription.ts && grep -q "_originated" src/sync/tx-subscription.ts && grep -q "echo.dropped" src/sync/tx-subscription.ts` exits 0.
- **Dependencies:** P4-T-01b (BLOCKING — subscription API decision), P4-T-02 (mixin refs).
- **Complexity:** XL (~2400 LOC including subscriber + 16 unit tests + fakes + cold-start buffering + echo-storm filter).

---

### P4-T-10 — MRCredentialResolver real implementation

- **Owner:** Sonnet
- **Inputs:**
  - `/Users/dingo/huly-gitlab/src/sync/binding-loader.ts` (Phase 3 — Phase 3 stub `credentials.resolveActorToken` returns undefined; replace).
  - P4-T-05 `getUserCredential`.
  - Spec §Per-user OAuth backend §MRCredentialResolver.
- **Outputs (modify `src/sync/binding-loader.ts`):**
  - **SCG-1 provenance guard:** replace the Phase 3 stub with a tightly-scoped resolver that ONLY accepts `(workspaceUuid, hulyPersonUuid)` — no other args, no token-passthrough escape hatch. The resolver is exposed on `bctx.credentials.resolveActorToken` and is the SOLE source of actor tokens for applyLocal paths. The change envelope NEVER carries an actorToken (P4-T-08 removes the legacy `change.actorToken` path).
    ```ts
    credentials: {
      resolveActorToken: async (workspaceUuid: WorkspaceUuid, hulyPersonUuid: PersonUuid): Promise<string | undefined> => {
        const result = await getUserCredential(
          this.deps.userCredentialsCol,
          this.deps.credentialEncryptionKey,
          workspaceUuid,
          hulyPersonUuid,
          credential.gitlabBaseUrl  // the binding's GitLab instance
        )
        if (result === null) return undefined
        if (result.expiresAt !== undefined && result.expiresAt < new Date()) {
          // Trigger refresh on demand if not already in-flight; for Phase 4 the cron-based refresh is authoritative,
          // so an expired token returns undefined here (fall back to service-account).
          return undefined
        }
        return result.plaintext
      }
    }
    ```
  - Extend `BindingLoaderDeps` with `userCredentialsCol: Collection<UserCredentialDoc>` and `credentialEncryptionKey: Buffer`.
- **Outputs (tests):** extend `tests/sync/binding-loader.test.ts` — ≥ 4 new cases:
  1. `resolveActorToken` returns the stored token when the user has linked their account for this binding's gitlabBaseUrl.
  2. `resolveActorToken` returns undefined when the user has no stored credential.
  3. `resolveActorToken` returns undefined when the stored credential is expired (cron refresh hasn't run yet).
  4. **SCG-1 type-level guard:** resolver signature is `(workspaceUuid, hulyPersonUuid) => Promise<string | undefined>` — no other arg shapes accepted. Verified via TS compile + a runtime check that calling with extra args throws or is ignored.
- **Outputs (modify `tests/sync/mr.test.ts` and `tests/sync/mr-review.test.ts`):**
  - Update the Phase 3 approval-action tests (Phase 3 cases 6, 7) to optionally provide a real per-user token via the resolver — the existing assertions about `actorToken` being passed to `approveMR` now have a non-undefined branch tested too.
  - **SCG-1 regression:** any test that previously seeded `change.actorToken` must be updated to seed `getUserCredential` instead. Verify the legacy field is gone from fixtures.
- **Acceptance criteria:**
  - `npm test -- tests/sync/binding-loader.test.ts tests/sync/mr.test.ts tests/sync/mr-review.test.ts` passes.
  - `npm run lint -- src/sync/binding-loader.ts` exits 0.
  - `grep -q "getUserCredential" src/sync/binding-loader.ts` exits 0.
  - `! grep -rn "change.actorToken" src/sync tests/sync` (legacy path removed everywhere).
- **Dependencies:** P4-T-04 (cache key widening lands first), P4-T-05 (user credentials store), P4-T-08 (SCG-1 mr-review.ts cleanup precedes this task's verification). **Sequenced after P4-T-08 to avoid mr.ts/mr-review.ts merge conflicts.**
- **Complexity:** S (~200 LOC including extended tests + SCG-1 verification).

---

### P4-T-11 — Extract `mr-approvals.ts` from `mr.ts`

- **Owner:** Sonnet
- **Inputs:**
  - `/Users/dingo/huly-gitlab/src/sync/mr.ts` (after P4-T-08 extension; expected ~1100 LOC; target ≤ 700 after extraction).
  - Spec §Code refactor backlog.
- **Outputs (new file `src/sync/mr-approvals.ts`):**
  - Extract all approval-related code:
    - `resolveApprovedBy`, `resolveReviewers`, `deriveApprovalStatus` helpers.
    - `applyApprovalActions` (the applyLocal branch that calls `approveMR`/`unapproveMR`).
    - The Phase 4 `deriveApprovalStatusFromRules` helper.
  - Module exports clean functions; `mr.ts` imports + calls.
- **Outputs (modify `src/sync/mr.ts`):**
  - Remove the extracted blocks; replace with imports + calls.
  - Verify line count: `wc -l src/sync/mr.ts` ≤ 700.
- **Acceptance criteria:**
  - `npm test -- tests/sync/mr.test.ts` passes (regression — behavior preserved).
  - `npm run lint -- src/sync/mr.ts src/sync/mr-approvals.ts` exits 0.
  - `wc -l src/sync/mr.ts | awk '{exit ($1<=700)?0:1}'` exits 0.
  - **No new tests required** — behavior preserved; the existing approval tests now cover both files together.
- **Dependencies:** P4-T-08 (don't extract until EE additions land).
- **Complexity:** M (~600 LOC moved; no net new code).

---

### P4-T-12 — Extract `BiDirectionalCache<K,V>` base + adopt in LabelCache/MRCache/MilestoneCache

- **Owner:** Sonnet
- **Inputs:**
  - `/Users/dingo/huly-gitlab/src/sync/label-cache.ts` (Phase 1 — bidirectional Map<GitLabId, HulyRef> + Map<HulyRef, GitLabId>).
  - `/Users/dingo/huly-gitlab/src/sync/mr-cache.ts` (Phase 2).
  - `/Users/dingo/huly-gitlab/src/sync/milestone-cache.ts` (Phase 1).
  - Spec §Code refactor backlog.
- **Outputs (new file `src/sync/bi-directional-cache.ts`):**
  - Generic `BiDirectionalCache<K, V>` with:
    - `set(k: K, v: V): void` — bidirectional insert; evict LRU when size exceeds capacity (default 1000).
    - `getByKey(k: K): V | undefined`.
    - `getByValue(v: V): K | undefined`.
    - `delete(k: K): void` — bidirectional delete.
    - `clear(): void`.
    - `size: number` getter.
  - Implement bounded LRU via Map ordering (Map preserves insertion order; on hit, delete + re-insert to refresh recency). Capacity configurable per binding.
- **Outputs (modify `src/sync/label-cache.ts`, `src/sync/mr-cache.ts`, `src/sync/milestone-cache.ts`):**
  - Each cache class adopts the base. Constructors accept `capacity?: number = 1000`. Existing public API preserved verbatim (same method names, same return types).
- **Outputs (tests):**
  - New `tests/sync/bi-directional-cache.test.ts` — ≥ 5 cases:
    1. Round-trip insert + getByKey + getByValue.
    2. LRU eviction at capacity boundary.
    3. Recency refresh on `getByKey` hit.
    4. Delete is bidirectional.
    5. `clear` zeros size.
  - Phase 1+2+3 cache tests continue to pass unchanged (regression).
- **Acceptance criteria:**
  - `npm test -- tests/sync/bi-directional-cache.test.ts tests/sync/label-cache.test.ts tests/sync/mr-cache.test.ts tests/sync/milestone-cache.test.ts` passes.
  - `npm run lint -- src/sync/bi-directional-cache.ts src/sync/label-cache.ts src/sync/mr-cache.ts src/sync/milestone-cache.ts` exits 0.
- **Dependencies:** none (Wave D parallel).
- **Complexity:** M (~520 LOC including refactor + new tests).

---

### P4-T-13 — Extract `deferred-parent.ts` retry helper

- **Owner:** Haiku
- **Inputs:**
  - `/Users/dingo/huly-gitlab/src/sync/notes.ts` (Phase 1+2 — `_noteRetried` flag pattern).
  - `/Users/dingo/huly-gitlab/src/sync/mr-review.ts` (Phase 3 — deferred-parent for review threads).
  - Spec §Code refactor backlog.
- **Outputs (new file `src/sync/deferred-parent.ts`):**
  - Generic `class DeferredParent<TRecord>`:
    - `constructor(deps: { backfillEnqueuer, retryFlagKey, logger, metricName })`.
    - `markAndRetry(record: TRecord): boolean` — if `record[retryFlagKey] === true`, return `false` (already retried, drop); else set `record[retryFlagKey] = true`, re-enqueue, return `true`.
  - Module JSDoc documents the convention: `_noteRetried` for notes, `_reviewRetried` for reviews.
- **Outputs (modify `src/sync/notes.ts` + `src/sync/mr-review.ts`):**
  - Replace inline retry logic with calls to `DeferredParent`.
- **Acceptance criteria:**
  - `npm test -- tests/sync/notes.test.ts tests/sync/mr-review.test.ts` passes.
  - `npm run lint -- src/sync/deferred-parent.ts src/sync/notes.ts src/sync/mr-review.ts` exits 0.
- **Dependencies:** none (Wave D parallel).
- **Complexity:** S (~180 LOC moved + 1-2 trivial unit tests for the new helper).

---

### P4-T-14 — Cookie-auth + rate-limit middleware (Bug-3 JSON+HMAC format)

- **Owner:** Sonnet
- **Inputs:**
  - `/Users/dingo/huly-gitlab/src/http/auth-middleware.ts` (Phase 1 — bearer middleware; pattern reference).
  - `/Users/dingo/huly-gitlab/src/http/async-handler.ts` (Phase 1 — error-wrapping; reuse).
  - Spec §Per-user OAuth backend §Security.
- **Outputs (new file `src/http/cookie-auth.ts`):**
  - **Bug-3 fix: JSON+HMAC cookie format** (no separator collisions; explicit field types). Cookie payload shape:
    ```json
    { "w": "<workspaceUuid>", "p": "<hulyPersonUuid>", "e": 1234567890, "sig": "<base64url-hmac-sha256>" }
    ```
    The cookie value is the base64url-encoded JSON of `{w, p, e}` plus a separate `sig` field over `{w, p, e}` using `crypto.createHmac('sha256', serverSecret)`. Transport: single cookie value `${base64url(json({w,p,e}))}.${base64url(sig)}` (dot-separator, both segments are base64url which never contains `.`).
  - `verifyHulyUserCookie(cookieValue: string, serverSecret: Buffer): { workspaceUuid: string, hulyPersonUuid: string, expiresAt: number } | null`:
    - Split on `.`. Decode payload + sig. Recompute HMAC over payload. `crypto.timingSafeEqual` comparison.
    - Check `expiresAt > Date.now()`.
    - Reject + return null on tamper, expiry, malformed JSON, missing fields, or wrong field types.
  - `requireHulyUserCookie(serverSecret: Buffer): RequestHandler` — Express middleware that reads `req.cookies['huly-user']` (requires `cookie-parser` middleware mounted at the app level — verify in P4-T-19), calls `verifyHulyUserCookie`, attaches result to `req.hulyUser`, or returns 401 with sanitized error (no detail).
- **Outputs (new file `src/http/rate-limit.ts`):**
  - `tokenBucket(limitPerWindow: number, windowMs: number): { take(key: string): boolean }`:
    - In-memory Map<key, { tokens, lastRefill }>; refill rate `limitPerWindow / windowMs` tokens/ms.
    - `take(key)` decrements; returns false when bucket empty.
    - Prune cold entries every 60s (sweep).
  - `rateLimit(opts: { limitPerWindow: number, windowMs: number, keyExtractor: (req) => string }): RequestHandler` — Express middleware; returns 429 with `Retry-After` header when bucket empty.
  - Default for `/user/oauth/start`: 10 per minute keyed by `req.ip` (per spec).
- **Outputs (tests):** `tests/http/cookie-auth.test.ts` (NEW; ≥ 7 cases):
  1. Valid cookie → resolves `{ workspaceUuid, hulyPersonUuid, expiresAt }`.
  2. Tampered signature → null.
  3. Tampered payload (mutated `w`) → null (HMAC mismatch).
  4. Expired cookie → null.
  5. Malformed cookie (missing dot, malformed base64, malformed JSON, missing fields) → null for each variant.
  6. Middleware 401 on missing cookie.
  7. **Bug-3 collision-safety:** payload containing odd characters (`|`, `:`, embedded JSON) round-trips correctly without breaking the parser (proves JSON+HMAC avoids the pipe-separator collision risk that the v1 format had).
  `tests/http/rate-limit.test.ts` (NEW; ≥ 4 cases):
  1. Under limit → all pass.
  2. Over limit → 429 with `Retry-After` header.
  3. Refill: after window passes, new requests pass.
  4. Distinct keys are independent.
- **Acceptance criteria:**
  - `npm test -- tests/http/cookie-auth.test.ts tests/http/rate-limit.test.ts` passes all 11 cases.
  - `npm run lint -- src/http/cookie-auth.ts src/http/rate-limit.ts` exits 0.
- **Dependencies:** none.
- **Complexity:** M (~500 LOC including tests + JSON+HMAC format).

---

### P4-T-15 — User OAuth routes (`src/http/user-oauth.ts`)

- **Owner:** Sonnet
- **Inputs:**
  - `/Users/dingo/huly-gitlab/src/http/oauth.ts` (Phase 1 — PKCE generation, state cookie, callback exchange; mirror).
  - `/Users/dingo/huly-gitlab/src/state/oauth-state.ts` (Phase 1 — PKCE state storage; reuse).
  - `/Users/dingo/huly-gitlab/src/state/credentials.ts` (Phase 1 — credentials pattern; reuse).
  - P4-T-05 `putUserCredential` / `getUserCredential` / `deleteUserCredential` (now with `username`).
  - P4-T-14 cookie-auth + rate-limit.
  - Spec §HTTP endpoints.
- **Outputs (new file `src/http/user-oauth.ts`):**
  - `GET /user/oauth/start?workspaceUuid=...&hulyPersonUuid=...&gitlabBaseUrl=...&returnTo=...`:
    - NOT bearer-protected; reads workspaceUuid/hulyPersonUuid from query string AND verifies the signed `huly-user` cookie matches (defense-in-depth — query string is convenience, cookie is authority).
    - Rate-limit middleware applied (10 per minute per IP).
    - Validates `gitlabBaseUrl` against the SSRF allowlist (existing helper from Phase 1).
    - Generates PKCE state via existing `oauth-state` store; persists `{ kind: 'user', workspaceUuid, hulyPersonUuid, gitlabBaseUrl, returnTo, pkceVerifier }` in the oauth-state row (workspaceUuid/hulyPersonUuid come from the COOKIE, not the query string — defense-in-depth).
    - Redirects to GitLab `/oauth/authorize` with `code_challenge`.
  - `GET /user/oauth/callback?code&state`:
    - NOT bearer-protected.
    - **SCG-3 callback identity source (CRITICAL):** identity (`workspaceUuid`, `hulyPersonUuid`) comes from the persisted `oauth-state` row matched by `state`. The callback DOES NOT re-verify the `huly-user` cookie — cookie auth is enforced only at `/start`. By the time the callback fires, the user may have lost their cookie (cleared cookies, different browser session); the state row is the authoritative identity carrier for the OAuth flow. This is explicitly documented in the file's JSDoc and in `docs/api.md`.
    - Exchanges code for token via GitLab `/oauth/token` (mirror Phase 1 oauth.ts:140 pattern).
    - **SCG-2 username capture:** immediately after token exchange, calls `GET /api/v4/user` (Bearer access_token) to fetch `username`. Persists `username` alongside the encrypted token via `putUserCredential`.
    - Persists via `putUserCredential` using the cookie-verified identity stored in the OAuth state alongside the PKCE verifier.
    - Redirects to `returnTo` from state or default success page (`/user/ui?status=linked`).
    - On error → redirects to `?error=<short_code>` (e.g., `state_mismatch`, `token_exchange_failed`, `user_lookup_failed`).
  - `GET /user/oauth/status?workspaceUuid=...&hulyPersonUuid=...&gitlabBaseUrl=...`:
    - Bearer-protected (existing auth middleware).
    - **SCG-2 response shape:** returns `{ linked: boolean, gitlabBaseUrl?: string, username?: string, expiresAt?: string }`. `username` is present when `linked === true`, captured at link time and persisted in `UserCredentialDoc`.
  - `DELETE /user/oauth/credential`:
    - Bearer-protected.
    - Body `{ workspaceUuid, hulyPersonUuid, gitlabBaseUrl }`. Calls `deleteUserCredential`. Returns 204.
  - **State extension:** `oauth-state` rows for per-user OAuth carry `{ kind: 'user', workspaceUuid, hulyPersonUuid, gitlabBaseUrl, returnTo, pkceVerifier }`. Existing kind `'binding'` for Phase 1 OAuth unchanged.
- **Outputs (tests):** `tests/http/user-oauth.test.ts` (NEW; ≥ 13 cases):
  1. `GET /start` with valid cookie + valid baseUrl → redirect to GitLab with PKCE challenge.
  2. `GET /start` with missing cookie → 401.
  3. `GET /start` with mismatched cookie vs query workspaceUuid → 401.
  4. `GET /start` with disallowed baseUrl (SSRF block) → 400.
  5. `GET /start` rate-limited → 429 after 11 hits in 60s from same IP.
  6. `GET /callback` happy path: state matches, code exchange succeeds, `GET /api/v4/user` succeeds → credential persisted WITH username; redirect to returnTo.
  7. `GET /callback` state mismatch → redirect to `?error=state_mismatch`.
  8. `GET /callback` token exchange failure → redirect to `?error=token_exchange_failed`.
  9. **SCG-2 user lookup failure:** `GET /callback` succeeds at token exchange but `GET /api/v4/user` returns 500 → redirect to `?error=user_lookup_failed`; credential NOT persisted (atomicity).
  10. **SCG-3 callback identity:** `GET /callback` ignores any `huly-user` cookie present at callback time; identity comes from state row. Verified by sending a callback with a DIFFERENT cookie than the original `/start` — callback succeeds (state row is authoritative).
  11. `GET /status` (bearer) returns `{linked: true, username, expiresAt}` when credential exists; `username` field present.
  12. `DELETE /credential` (bearer) removes credential; subsequent status returns `{linked: false}`.
  13. **Bug-6 bearer transport:** `GET /status` REJECTS bearer in query string (the existing bearer middleware reads `Authorization` header only; if query-string bearer is somehow accepted, this test FAILS).
- **Acceptance criteria:**
  - `npm test -- tests/http/user-oauth.test.ts` passes all 13 cases.
  - `npm run lint -- src/http/user-oauth.ts` exits 0.
  - `grep -q "/user/oauth/start" src/http/user-oauth.ts && grep -q "/user/oauth/callback" src/http/user-oauth.ts && grep -q "/user/oauth/status" src/http/user-oauth.ts && grep -q "GET /api/v4/user" src/http/user-oauth.ts && grep -q "SCG-3" src/http/user-oauth.ts` exits 0.
- **Dependencies:** P4-T-05 (credentials store with username), P4-T-14 (middleware).
- **Complexity:** L (~1300 LOC including tests + nock fixtures for GitLab OAuth + user-lookup endpoints).

---

### P4-T-16 — Public HTML UI (`public/user-ui/`) (Bug-6 bearer hardening + CSP)

- **Owner:** Sonnet
- **Inputs:**
  - Spec §HTML UI (vanilla; ≤ 400 LOC total).
- **Outputs (new files):**
  - `public/user-ui/index.html` (≤ 100 LOC): single-page UI with a workspace + gitlabBaseUrl input, status panel, and Link/Unlink buttons. No build step; no framework. Includes `<script src="./app.js">` and `<link rel="stylesheet" href="./style.css">`.
    - **Bug-6 CSP meta tag (defense-in-depth; the server-side header in P4-T-19 is authoritative):** `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self'; frame-ancestors 'self' <huly-origin>;">`. The `<huly-origin>` token is templated at deploy time by the operator (e.g., via a startup substitution); fallback is `'self'` only.
  - `public/user-ui/app.js` (≤ 200 LOC vanilla ES2020):
    - **Bug-6 bearer acquisition:** bearer token is acquired via:
      1. **PRIMARY: `postMessage` from parent window** — page listens for `window.addEventListener('message', e => { if (e.origin === expectedHulyOrigin && e.data.type === 'huly-bearer') bearer = e.data.token; })`. On load, posts a `huly-ui-ready` message to `window.parent`.
      2. **SECONDARY: `sessionStorage`** — `bearer ||= sessionStorage.getItem('huly-bearer')`.
      3. **EXPLICITLY REJECTED:** query-string bearer. Any `?bearer=...` URL param is IGNORED and a warn-level console message is emitted. (Plus the spec rule: never pass bearer in URL.)
    - `loadStatus()`: GET `/user/oauth/status?...` (with `Authorization: Bearer ${bearer}` header); renders linked state including `username`.
    - `startLink()`: navigates to `/user/oauth/start?workspaceUuid&hulyPersonUuid&gitlabBaseUrl&returnTo`.
    - `unlink()`: DELETE `/user/oauth/credential` with the form's values; reloads status.
    - URL parsing helper to read `?status=linked` or `?error=<code>` after callback redirect.
    - If `bearer === null` after both acquisition paths fail, render an explanatory UI message: "This page must be opened from within Huly (or have `huly-bearer` set in sessionStorage)."
  - `public/user-ui/style.css` (≤ 100 LOC): minimal styling; system fonts; no external assets.
- **Outputs (server-side static mount):** documented in P4-T-19 (added to `src/index.ts` — also serves the CSP header as an HTTP response header for redundancy with the meta tag).
- **Acceptance criteria:**
  - `wc -l public/user-ui/index.html public/user-ui/app.js public/user-ui/style.css | tail -1 | awk '{exit ($1<=400)?0:1}'` exits 0.
  - `cat public/user-ui/index.html | grep -q "Link"` exits 0.
  - `grep -q "Content-Security-Policy" public/user-ui/index.html` exits 0.
  - `grep -q "postMessage" public/user-ui/app.js && grep -q "sessionStorage" public/user-ui/app.js` exits 0.
  - `! grep -q "URLSearchParams.*bearer\\|getQueryParam.*bearer\\|\\?bearer=" public/user-ui/app.js` (no query-string bearer code path).
  - **No tests required** (UI is exercised by E2E in P4-T-20).
- **Dependencies:** P4-T-15 (knowledge of route shapes).
- **Complexity:** S (~400 LOC HTML+CSS+JS combined; no tests).

---

### P4-T-17 — Webhook router Epic Hook branch (DAG-3 explicit enqueueRemoteEvent)

- **Owner:** Sonnet
- **Inputs:**
  - `/Users/dingo/huly-gitlab/src/http/webhook.ts` (Phase 1+2+3 — MR Hook / Note Hook / Pipeline Hook branches; mirror).
  - P4-T-01 `EpicHookPayload`.
  - Spec §Webhook subscription extension.
- **Outputs (modify `src/http/webhook.ts`):**
  - Add `Epic Hook` event name to the discriminator switch.
  - Validate payload shape: `object_attributes.iid`, `object_attributes.group_id`, `object_attributes.action`.
  - On EE binding (capabilities), dispatch to `EpicsSyncManager` via `engine.enqueueRemoteEvent(binding, 'epic', envelope)`.
  - On CE binding, log `epic_hook.ce_skipped` debug and drop.
  - **Confidentiality filter:** `Confidential Epic Hook` (if it exists in GitLab) is HARDCODED FALSE in subscription (P4-T-18). Defense-in-depth: webhook router drops any payload with `object_attributes.confidential === true` regardless of subscription posture.
- **Outputs (tests):** extend `tests/http/webhook.test.ts` — ≥ 4 new cases:
  1. **DAG-3 explicit assertion:** Valid Epic Hook on EE binding → mocked engine's `enqueueRemoteEvent` was called EXACTLY ONCE with arguments `(binding, 'epic', { iid: N, groupId: G, action: 'create' | 'update' | 'close', ... })`. The mock engine asserts call count + argument shape via vitest spy.
  2. Epic Hook on CE binding → `enqueueRemoteEvent` NOT called; `epic_hook.ce_skipped` metric increments.
  3. Confidential epic payload (any binding edition) → `enqueueRemoteEvent` NOT called; defense-in-depth metric increment.
  4. Malformed payload (missing `object_attributes.iid`) → 400 response; no enqueue; `webhook.payload.invalid` metric increment.
- **Acceptance criteria:**
  - `npm test -- tests/http/webhook.test.ts` passes all 4 new cases.
  - `npm run lint -- src/http/webhook.ts` exits 0.
  - `grep -q "enqueueRemoteEvent.*'epic'" src/http/webhook.ts` exits 0.
- **Dependencies:** P4-T-01, P4-T-06 (knowledge of manager).
- **Complexity:** S (~320 LOC including tests + explicit DAG-3 assertion).

---

### P4-T-18 — BindingLifecycleService `epic_events` flag

- **Owner:** Haiku
- **Inputs:**
  - `/Users/dingo/huly-gitlab/src/sync/binding-lifecycle.ts` (Phase 1+2+3 — event flag set construction).
  - Spec §Webhook subscription extension.
- **Outputs (modify `src/sync/binding-lifecycle.ts`):**
  - On binding registration (when `capabilities.edition === 'EE'`), include `epic_events: true` in the webhook subscription payload. CE bindings still send only the 4 Phase 3 flags.
  - Confidential events remain HARDCODED FALSE.
- **Outputs (tests):** extend `tests/sync/binding-lifecycle.test.ts` — ≥ 2 new cases:
  1. EE binding registration includes `epic_events: true`; 5 flags total.
  2. CE binding registration includes the 4 Phase 3 flags only (no `epic_events`).
- **Acceptance criteria:**
  - `npm test -- tests/sync/binding-lifecycle.test.ts` passes.
  - `npm run lint -- src/sync/binding-lifecycle.ts` exits 0.
- **Dependencies:** P4-T-01.
- **Complexity:** S (~140 LOC).

---

### P4-T-19 — Engine registration + TxSubscriber lifecycle wiring + index.ts mounts + CSP headers (DAG-1 ABSORBS TxSubscriber wiring)

- **Owner:** Sonnet
- **Inputs:**
  - `/Users/dingo/huly-gitlab/src/index.ts` (Phase 1+2+3 — engine bootstrap, route mount, manager registry).
  - `/Users/dingo/huly-gitlab/src/sync/binding-loader.ts` (modified by P4-T-04 and P4-T-10; this task adds TxSubscriber lifecycle hooks — DAG-1 absorption).
  - All Phase 4 task outputs.
- **Outputs (modify `src/index.ts`):**
  - Register `EpicsSyncManager` under kind `'epic'`.
  - Register `IterationsSyncManager` under kind `'iteration'`.
  - Mount user-oauth routes from `src/http/user-oauth.ts`.
  - Mount Express static middleware: `app.use('/user/ui', express.static('public/user-ui'))`.
  - **Bug-6 CSP header middleware:** for all `/user/ui/*` responses, set `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self'; frame-ancestors 'self' ${HULY_ORIGIN};` (env var `HULY_ORIGIN`, defaults to `'self'` only).
  - Mount `cookie-parser` middleware globally (required by `requireHulyUserCookie`).
  - Wire `BindingLoaderDeps` to include `userCredentialsCol` + `credentialEncryptionKey`.
  - **DAG-1 absorbed TxSubscriber lifecycle wiring** (moved from P4-T-09):
    - Resolve the pod's service-account `PersonUuid` once at startup (existing Phase 1 helper).
    - Add a per-workspace `Map<WorkspaceUuid, TxSubscriber>` cache, keyed on workspaceUuid (NOT compound `(ws, baseUrl)` — a single TxSubscriber covers all bindings under a workspace, observing the shared HulyClient's tx stream and fanning out to bindings).
    - Hook into `BindingLoader`: extend its existing per-workspace HulyClient lifecycle so that on first HulyClient construction, this code path instantiates `createTxSubscriber({ hulyClient, syncEngine: engine, bindings: this.bindingsFor(workspaceUuid), workspaceUuid, serviceAccountPersonUuid, logger })` and calls `start()`. On HulyClient eviction (refcount reaches 0), call `await subscriber.stop()` first.
    - Register `subscriber.onTerminalFailure(() => bindingLoader.evictWorkspace(workspaceUuid))` to wire the reconnect-exhaustion → cache-eviction loop (the subscriber itself doesn't import binding-loader, satisfying DAG-1).
    - **BindingLoader cache-eviction hook (also TxSubscriber):** widen the BindingLoader's cache-eviction callback registry to invoke `subscriber.stop()` before the gitLabClient is closed. Add a small registration API on BindingLoader (`registerEvictionListener(workspaceUuid, listener)`) — this is the ONLY edit to `binding-loader.ts` from this task.
    - On pod shutdown (SIGTERM handler), iterate all cached subscribers and call `await Promise.all(subscribers.map(s => s.stop()))`. Then close all HulyClients.
  - Ensure the `user_credentials` collection's compound unique index is ensured at startup.
- **Outputs (tests):** extend `tests/index.test.ts` (or new `tests/index-wiring.test.ts`) — ≥ 7 new cases:
  1. Manager registry contains `'epic'` and `'iteration'` keys after bootstrap.
  2. `/user/ui` serves `index.html` (static mount works).
  3. `/user/ui` response includes the `Content-Security-Policy` header with `frame-ancestors`.
  4. SIGTERM handler iterates cached subscribers and calls stop (mocked).
  5. `user_credentials` index is ensured on startup.
  6. **DAG-1 TxSubscriber wiring:** on first `loadForMergeRequests(workspace)`, a TxSubscriber is created and started; on workspace eviction, `subscriber.stop()` is called BEFORE the HulyClient is closed (verified via call-order spy).
  7. **DAG-1 onTerminalFailure:** simulated reconnect exhaustion in the subscriber → `bindingLoader.evictWorkspace(ws)` is invoked.
- **Acceptance criteria:**
  - `npm test` passes whole-repo (regression).
  - `npm run build` exits 0.
  - `npm run lint -- src/index.ts` exits 0.
  - `curl -s http://localhost:3600/user/ui/ | grep -q "Link"` exits 0 (verified via local dev or harness).
  - `curl -sI http://localhost:3600/user/ui/ | grep -q "Content-Security-Policy"` exits 0.
  - `grep -q "createTxSubscriber" src/index.ts && grep -q "subscriber.stop" src/index.ts && grep -q "registerEvictionListener" src/sync/binding-loader.ts` exits 0.
- **Dependencies:** P4-T-06, P4-T-07, P4-T-09, P4-T-10, P4-T-15, P4-T-16, P4-T-17, P4-T-18.
- **Complexity:** L (~700 LOC including wiring + DAG-1 absorbed TxSubscriber lifecycle + CSP header + tests). Upgraded from M.

---

### P4-T-20 — E2E harness extensions (Path B + EE + multi-instance + per-user OAuth)

- **Owner:** Opus
- **Inputs:**
  - `/Users/dingo/huly-gitlab/tests/e2e/setup.ts` (Phase 1+2+3 — extending).
  - P4-T-09 (subscriber core), P4-T-15 (user OAuth routes), P4-T-04 (multi-instance loader), P4-T-08 (EE mixin), P4-T-19 (TxSubscriber wiring).
  - Spec §Testing Strategy.
- **Outputs:**
  - `tests/e2e/path-b.e2e.test.ts` (new): synthetic Huly tx delivery via `client.notify` (or whichever path P4-T-01b chose) → applyLocal fires → GitLab REST endpoint called within 30s. Cases:
    1. Huly user "approves" via direct mixin update on the mirror Issue → `POST /merge_requests/:iid/approve` observed within 30s with the user's actorToken (per-user OAuth path, when linked).
    2. Huly user marks ChatMessage's review-mixin `resolved: true` → `PUT /merge_requests/:iid/discussions/:id` observed within 30s.
    3. Huly user edits a mirror Issue title → `PUT /issues/:iid` observed within 30s.
    4. **MR-2 GATING TEST (real transactor):** trigger an applyRemote write end-to-end (a GitLab webhook delivers an MR update; the pod's MergeRequestsSyncManager applies it via the real Huly Client). The TxSubscriber observes the resulting tx. Assert the tx is DROPPED (`tx.subscription.echo.dropped` metric increments; no spurious `enqueueLocalEvent` follows). This is the gating evidence for MR-2 with the real transactor — TG-1 gap closure.
  - `tests/e2e/ee-features.e2e.test.ts` (new; auto-skipped if not running against GitLab EE image, detected via `capabilities.edition !== 'EE'`):
    1. GitLab approval rule attached to MR → `gitlab-mr` mixin's `approvalRules` populated within 30s.
    2. GitLab iteration assigned to MR → `gitlab-mr` mixin's `iteration` populated within 30s.
    3. GitLab epic with 2 child issues → mirror epic Issue created; both children get `parentEpicIid` mixin field (sole-writer EpicsSyncManager).
    4. Epic Hook payload → enqueued + EpicsSyncManager applies.
    5. **Bug-1 sub-group epic:** GitLab project under `top/mid/sub/project` with epics on `top` group → `EpicsSyncManager.backfill` succeeds (walks namespace upward).
    6. **Bug-7 iteration SLA:** GitLab iteration update with NO subsequent MR Hook delivery → mixin update arrives within 5 min (NOT 30s). MR Hook then arrives → mixin update arrives within 30s of that hook. Both SLA branches verified.
  - `tests/e2e/multi-instance.e2e.test.ts` (new): two bindings under one workspace, one pointing to GitLab instance A (the compose stack's CE), one to a mock instance B (nock-stubbed). Both work concurrently; idmap rows are workspace-scoped but project-IDs disjoint. **TG-4 isolation case 5:** two projects with SAME `projectId` on two different GitLab instances under one workspace → `prefixGitlabIdForMultiInstance` produces distinct idmap rows; cross-instance collision impossible. Verified by querying the idmap collection and asserting two distinct `gitlabId` strings with the same suffix but different 8-hex prefixes.
  - `tests/e2e/user-oauth.e2e.test.ts` (new):
    1. `GET /user/oauth/start` with valid signed cookie → redirect to mock GitLab OAuth endpoint; PKCE challenge in URL.
    2. `GET /user/oauth/callback` with valid state → credential persisted WITH username; `GET /user/oauth/status` returns `{linked: true, username}`.
    3. `DELETE /user/oauth/credential` → status returns `{linked: false}`.
    4. After linking, an approval action triggered from Huly uses the per-user token (verified via the actorToken header in the captured `POST /merge_requests/:iid/approve` request).
    5. Rate limit: 11 hits to `/user/oauth/start` in 60s from same IP → 11th gets 429.
    6. **SCG-3 callback identity:** simulate a user whose cookie has expired between `/start` and `/callback` → callback succeeds (identity from state row), credential persists. The status endpoint (bearer-protected) requires a valid bearer to read.
    7. **Bug-6 bearer transport:** the UI page (loaded headlessly) does NOT extract `?bearer=...` from the URL; postMessage delivery succeeds; sessionStorage fallback succeeds.
  - Extend `tests/e2e/setup.ts`:
    - `enqueueSyntheticTx(client, tx)` helper — drives the chosen subscription path.
    - `signHulyUserCookie(workspaceUuid, hulyPersonUuid, ttlMs, secret)` — builds the JSON+HMAC cookie (Bug-3 format).
    - `mockGitLabOAuthServer()` — nock-based fake OAuth server for callback flow (now includes `GET /api/v4/user` stub for username capture).
    - `detectEEImage()` — checks `capabilities.edition` at boot; sets a global flag E2E uses to skip EE tests when running against CE compose stack.
    - `postMessageToUI(uiPageHandle, bearer)` — helper for headless browser test: posts the bearer to the UI window.
- **Acceptance criteria:**
  - `npm run test:e2e` exits 0 with new files included.
  - EE tests auto-skip when CE-detected; non-skip when EE-detected (verified by running compose-up against an EE image variant locally OR via the test's explicit `it.skipIf` predicate).
  - Phase 1+2+3 E2E suite continues to pass.
- **Dependencies:** P4-T-19.
- **Complexity:** XL (~2700 LOC including all 4 new E2E files + setup helpers + EE-image detection + MR-2 real-transactor gating case + Bug-1/Bug-7/SCG-3/Bug-6/TG-4 coverage).

---

### P4-T-21 — README + architecture doc + Phase 4 runbook + ADR

- **Owner:** Sonnet
- **Inputs:**
  - `/Users/dingo/huly-gitlab/README.md` (Phase 1+2+3).
  - `/Users/dingo/huly-gitlab/docs/architecture.md` (Phase 1+2+3).
  - `/Users/dingo/huly-gitlab/docs/api.md` (Phase 1+2+3).
  - `/Users/dingo/huly-gitlab/docs/runbooks/phase3-reviewer-migration.md` (pattern reference).
  - Spec §Success Criteria.
- **Outputs (modify + new):**
  - `README.md` (modify):
    - **FINAL** Phase 4 section listing Path B + EE features + multi-instance + per-user OAuth + HTML UI.
    - Update "limitations" → "Phase 1+2+3+4 limitations" with the FINAL state: nothing deferred to Phase 5 (no Phase 5 exists). Items NOT supported (out of scope, not roadmap): full diff body sync, image annotations, suggestion-via-Huly, GraphQL adapter, per-tenant ACL for admin routes, React/Vue UI.
    - Document the per-user OAuth UI URL (`/user/ui`) and the operator-side cookie-signing requirement (Huly platform must mint the `huly-user` cookie out of band — pod only verifies). Note the JSON+HMAC cookie format (Bug-3).
    - **Bug-6 deployment note:** the Huly platform must `postMessage` the bearer into the `/user/ui` iframe (or set `sessionStorage.huly-bearer` if embedded server-side). Never pass the bearer via URL.
  - `docs/architecture.md` (modify):
    - Mermaid updated to show `TxSubscriber → engine.enqueueLocalEvent` arrow closing Path B.
    - Mermaid extended with `EpicsSyncManager`, `IterationsSyncManager`.
    - **MR-2 echo-storm filter** documented with diagram arrow (TxSubscriber filters out `tx.createdBy === serviceAccountPersonUuid`).
    - **AC-1 field-ownership partition** restated for the FINAL state:
      - EpicsSyncManager: SOLE writer of `parentEpicIid` (on child issue/MR mirrors) + `gitlab-epic` mixin.
      - MergeRequestsSyncManager: `gitlab-mr` core fields + `approvalRules` + `iteration` (NOT `parentEpicIid`).
      - PipelineSyncManager: `pipelineStatus`.
      - ReviewThreadsSyncManager: `gitlab-review`.
    - Multi-instance cache topology documented (workspace-keyed HulyClient + (workspace, baseUrl)-keyed gitLabClient + `prefixGitlabIdForMultiInstance` for idmap).
    - **Bug-3** Cookie JSON+HMAC format documented (replacing the v1 pipe-separator design).
    - **SCG-3** callback identity-source clarification: identity comes from state row, not cookie.
    - **Bug-1** Top-level group resolution for epics (sub-group projects walk upward to find the group hosting epics).
  - `docs/api.md` (modify):
    - Document `GET /user/oauth/{start,callback,status}` + `DELETE /user/oauth/credential` with curl examples.
    - Document `PATCH /api/v1/bindings/:id` re-emphasized.
    - Document the `huly-user` cookie format (Bug-3 JSON+HMAC).
    - **SCG-2** Document the `username` field in `/user/oauth/status` response.
    - **Bug-6** Document the bearer-transport contract for `/user/ui` (postMessage from parent + sessionStorage fallback; query-string REJECTED).
    - **Bug-7** Document the iteration SLA: 30s on MR Hook OR 5min via backfill (whichever first).
    - Note that `/user/ui` is served from `public/user-ui/` static dir.
  - `docs/runbooks/phase4-deployment.md` (new):
    - FINAL deployment checklist: pod env vars (CredentialEncryptionKey, ServerSecret for cookies, HULY_ORIGIN for CSP frame-ancestors), MongoDB indexes (idmap, cursors, credentials, user_credentials), webhook URL, per-instance binding workflow for multi-instance.
    - Operator steps to roll out Path B (verify TxSubscriber lifecycle metrics: `tx.subscription.reconnect.attempt`, `tx.subscription.reconnect.success`, `tx.subscription.reconnect.failed`, `tx.subscription.echo.dropped`, `tx.subscription.buffer.overflow`).
    - Operator steps to enable EE features (toggle is automatic via capability detection; no manual switch).
    - Operator steps to issue Huly user cookies (Huly platform integration responsibility; pod verifies only) — includes JSON+HMAC payload shape.
    - **Bug-6** Operator steps to deliver the bearer via postMessage (Huly platform integration).
    - **TG-4** Multi-instance migration note: existing single-instance workspaces NEVER auto-transition to multi-instance idmap prefixes. Operators who genuinely add a second instance to an existing workspace MUST run a one-time migration script (template provided in runbook appendix) to prefix existing rows.
    - Runbook for Path B failure: TxSubscriber drops, reconnect exhausted, manual cache eviction via PATCH binding `{disabled: true}` then `{disabled: false}`.
  - `docs/adrs/phase4-final.md` (new ADR):
    - **Decision:** Phase 4 closes Path B + ships EE features + per-user OAuth + HTML UI as the FINAL phase.
    - **Drivers:** complete the integration roadmap; close the dead-applyLocal-path; unlock EE customers; resolve service-account attribution; enforce field-ownership single-writer invariants.
    - **Alternatives considered:** (a) Phase 4 + Phase 5 split with Path B in 4 and EE in 5 — rejected for delivery efficiency; (b) GraphQL adapter migration in Phase 4 — rejected as scope creep; (c) React UI — rejected per spec "vanilla ≤ 400 LOC"; (d) `parentEpicIid` dual-writer (MR + Epic managers) — REJECTED in v2 per AC-1, EpicsSyncManager is sole writer.
    - **Why chosen:** scope is bounded; parallelism width 4 in Wave C allows the largest single phase to ship in roughly the same calendar time as Phase 3. Single-writer invariants make code review and incident debugging tractable.
    - **Consequences:** `mr.ts` shrinks after P4-T-11 extraction; gitlab-mr mixin grows to 14+2=16 fields (Phase 3 Q5 split trigger reached — see Open Questions for FOLLOW-UP); multi-instance scope assumes operators run a one-time migration when retro-converting workspaces.
    - **Follow-ups:** none planned (no Phase 5). The mixin split (Q5 from Phase 3) becomes a maintenance ticket, not a phase. Per-user OAuth UI styling improvements are optional cosmetic work. ServerSecret rotation grace-period dual-verification is tracked as maintenance.
- **Acceptance criteria:**
  - `npx markdownlint-cli2 "**/*.md"` exits 0.
  - `docs/runbooks/phase4-deployment.md` exists; contains at least one `curl` example AND the TG-4 migration note.
  - `docs/adrs/phase4-final.md` exists with all required ADR fields including the AC-1 rejection of dual-writer parentEpicIid.
  - `grep -q "/user/oauth/start" docs/api.md && grep -q "TxSubscriber" docs/architecture.md && grep -q "Phase 4" README.md && grep -q "JSON+HMAC" docs/architecture.md && grep -q "echo-storm" docs/architecture.md && grep -q "sole writer" docs/architecture.md` exits 0.
- **Dependencies:** P4-T-20.
- **Complexity:** M (~640 lines markdown).

---

### P4-T-22 — Phase 4 final regression sweep + metrics audit

- **Owner:** Sonnet
- **Inputs:**
  - All Phase 4 outputs.
  - `/Users/dingo/huly-gitlab/src/metrics.ts` (Phase 3 — centralized metrics; extend with Phase 4 names).
- **Outputs (modify `src/metrics.ts`):**
  - Extend `MetricName` union with Phase 4 additions (now includes v2 additions):
    ```ts
    | 'ee.feature.skipped'
    | 'epic.child.cross_project'
    | 'tx.subscription.reconnect.attempt'
    | 'tx.subscription.reconnect.success'
    | 'tx.subscription.reconnect.failed'
    | 'tx.subscription.echo.dropped'      // MR-2
    | 'tx.subscription.buffer.overflow'   // MR-1
    | 'epic.applyLocal.skipped'
    | 'epic_hook.ce_skipped'
    | 'user_oauth.callback.error'
    | 'user_oauth.rate_limit.hit'
    | 'webhook.payload.invalid'           // DAG-3
    ```
- **Outputs (regression sweep — no new files, verification only):**
  - Run the full test suite end-to-end; document baseline delta (495 → ≥ 615 expected after v2 additions).
  - Run `npm audit --omit=dev --audit-level=high` → 0 high.
  - Run `npm run build && npm run lint`.
  - Run `make e2e` against the compose stack.
  - Run a manual smoke against `/user/ui` to verify the static page loads, the Link button initiates OAuth, and the status panel reflects post-link state INCLUDING the username field.
  - Run a manual smoke against Path B: edit a mirror Issue title in Huly via the test harness → verify GitLab MR title updates within 30s.
  - **MR-2 smoke:** run an end-to-end applyRemote sequence (webhook delivers MR update) → confirm `tx.subscription.echo.dropped` metric increments by at least the expected count; no spurious GitLab REST calls follow.
- **Acceptance criteria:**
  - `npm test` exits 0 with ≥ 615 tests passing (target — v2 added ~10 new tests across the suite vs v1's 605 target).
  - `npm audit --omit=dev --audit-level=high` shows 0 high.
  - `make e2e` exits 0.
  - All Phase 4 metrics emit during their respective tests (verified via `metrics.get(name) > 0` assertions in the affected unit/E2E tests). Specifically the v2 new metrics (`echo.dropped`, `buffer.overflow`, `webhook.payload.invalid`) all show at least 1 increment during the test run.
  - Final test count documented in the PR description with delta vs Phase 3 baseline.
- **Dependencies:** P4-T-20, P4-T-21.
- **Complexity:** S (~140 LOC metrics extension + verification runs).

---

## 4. Testing Plan

| Layer | Task | Command | Expected new tests |
|---|---|---|---|
| Adapter types + state widening | P4-T-01 | `npm test -- src/state/store.test.ts` | ≥ 5 |
| TxSubscriber API probe | P4-T-01b | `npm test -- tests/sync/tx-subscription-probe.test.ts` | ≥ 2 |
| Mixin schema | P4-T-02 | (build only) | 0 |
| Adapter EE methods | P4-T-03 | `npm test -- tests/adapter/gitlab-client-ee.test.ts` | ≥ 17 |
| Binding-loader multi-instance | P4-T-04 | `npm test -- tests/sync/binding-loader.test.ts` | ≥ 5 |
| User-credentials store | P4-T-05 | `npm test -- tests/state/user-credentials.test.ts` | ≥ 9 |
| EpicsSyncManager | P4-T-06 | `npm test -- tests/sync/epics.test.ts` | ≥ 13 |
| IterationsSyncManager | P4-T-07 | `npm test -- tests/sync/iterations.test.ts` | ≥ 7 |
| MR manager EE extensions | P4-T-08 | `npm test -- tests/sync/mr.test.ts tests/sync/mr-review.test.ts` | ≥ 11 new |
| TxSubscriber core | P4-T-09 | `npm test -- tests/sync/tx-subscription.test.ts` | ≥ 16 |
| Credential resolver real impl | P4-T-10 | `npm test -- tests/sync/binding-loader.test.ts` | ≥ 4 new |
| `mr-approvals.ts` extraction | P4-T-11 | (regression — existing mr.test.ts) | 0 net new |
| `BiDirectionalCache` base | P4-T-12 | `npm test -- tests/sync/bi-directional-cache.test.ts` | ≥ 5 |
| `deferred-parent.ts` helper | P4-T-13 | (regression — existing notes/mr-review tests) | 0–2 |
| Cookie-auth + rate-limit | P4-T-14 | `npm test -- tests/http/cookie-auth.test.ts tests/http/rate-limit.test.ts` | ≥ 11 |
| User OAuth routes | P4-T-15 | `npm test -- tests/http/user-oauth.test.ts` | ≥ 13 |
| HTML UI | P4-T-16 | (no unit tests — covered by E2E in P4-T-20) | 0 |
| Webhook Epic Hook | P4-T-17 | `npm test -- tests/http/webhook.test.ts` | ≥ 4 |
| Lifecycle `epic_events` | P4-T-18 | `npm test -- tests/sync/binding-lifecycle.test.ts` | ≥ 2 |
| Engine + index wiring | P4-T-19 | `npm test -- tests/index*.test.ts` | ≥ 7 |
| E2E (compose) | P4-T-20 | `npm run test:e2e` | ≥ 23 new across 4 files |
| Metrics audit + regression | P4-T-22 | `npm test && make e2e` | 0 (verification) |

**Expected total new tests:** ≥ 130 (target: 140+). v2 delta vs v1: +10 to +20 across tasks (mostly AC-1, MR-2, MR-1, Bug-1/3/4/6/7, SCG-1/2/3, TG-3/4 regressions).
**Expected baseline delta:** 495 → ≥ 615 (unit + integration; E2E counted separately at +23 new).
**Spec target:** ≥ 80 (Phase 4 spec §Success Criteria #2). Comfortably exceeded.

**Local developer loop (unchanged from Phase 1+2+3):**

- Unit: `npm test`.
- Integration: `npm run test:integration` (mongodb-memory-server + nock).
- E2E: `make compose-up && npm run test:e2e && make compose-down`. EE tests auto-skip on CE compose stack; require an EE compose variant for full coverage.

**Regression guarantee:** every task acceptance criterion includes whole-repo `npm test` exit 0. Phase 2 case 16 (Phase 2 reviewer-labels) was already replaced in Phase 3; no further INVERSIONS in Phase 4. **AC-1 field-ownership invariants** (Phase 2 C2 + Phase 3 §3 + Phase 4 §3) tested in P4-T-06 case 11 (epic sole-writer of `parentEpicIid` on both MR and Issue mirrors) and P4-T-08 case 4 (MR explicitly NOT touching `parentEpicIid`) and case 8 (MR not touching `gitlab-epic`).

---

## 5. Build & Verification Commands (Phase 4 QA — cumulative)

Run from `/Users/dingo/huly-gitlab`:

```bash
# Install (Phase 4 may add cookie-parser to deps)
npm ci

# Static checks
npm run lint
npm run format -- --check

# Build
npm run build                     # tsc -p .

# Unit + integration
npm test                          # expect ≥ 615 tests passing

# Coverage delta vs Phase 3
npm test -- --coverage
# expect ≥ 85% on src/sync/tx-subscription.ts, src/sync/epics.ts,
#                  src/sync/iterations.ts, src/sync/epic-mixin.ts,
#                  src/state/user-credentials.ts, src/http/user-oauth.ts,
#                  src/http/cookie-auth.ts, src/http/rate-limit.ts,
#                  src/sync/bi-directional-cache.ts, src/sync/mr-approvals.ts,
#                  the new EE adapter methods

# Docker image
docker build -t huly-gitlab:local .

# Dev stack
docker compose -f docker/docker-compose.dev.yml up -d
curl http://localhost:3600/health
curl http://localhost:3600/user/ui   # expect HTML page
curl -I http://localhost:3600/user/ui/ | grep Content-Security-Policy   # expect CSP header (Bug-6)

# End-to-end (full stack including Phase 4)
make e2e

# npm audit
npm audit --omit=dev --audit-level=high  # expect 0 high

# Manual smoke: Path B
# - Open the test harness UI; edit a mirror Issue title.
# - Observe GitLab MR title updates within 30s (compose-up logs show enqueueLocalEvent).
# - Observe NO echo-storm: tx.subscription.echo.dropped increments on the applyRemote path; no spurious second update.
```

**Phase 4 acceptance** (per spec §Success Criteria — items 1–14):

1. All Phase 1+2+3 tests continue to pass (regression).
2. ≥ 130 new tests (target 140+; spec ≥ 80; v2 raised the floor).
3. `npm run build && npm run lint && npm test` exit 0.
4. `npm audit --omit=dev --audit-level=high` shows 0 high.
5. **Huly user approves a mirror MR → GitLab `approveMR` called with real user's actorToken within 30s** (E2E `path-b` case 1 + `user-oauth` case 4).
6. **Huly user resolves a discussion → GitLab `resolveDiscussion` called** (E2E `path-b` case 2).
7. **Huly user edits a mirror Issue title → GitLab `updateIssue` called** (E2E `path-b` case 3).
8. EE approval rules synced + respected (E2E `ee-features` case 1).
9. **GitLab iteration → Huly mixin within 30s on MR Hook OR 5min via backfill** (Bug-7 amended SLA; E2E `ee-features` case 6).
10. GitLab epic with child issues → mirror epic + `parentEpicIid` populated on children VIA EPICSSYNCMANAGER (AC-1 sole-writer; E2E `ee-features` case 3).
11. User opens `/user/ui`, clicks Link → OAuth dance → credential persisted with PKCE + username (E2E `user-oauth` cases 1–3, 6).
12. Two bindings under one workspace pointing to different GitLab instances both work without idmap collision (E2E `multi-instance`; TG-4 isolation case).
13. `mr.ts` line count ≤ 700 after P4-T-11 extraction (verified by `wc -l`).
14. `LabelCache`/`MRCache`/`MilestoneCache` share `BiDirectionalCache` base with bounded LRU (P4-T-12).
15. **(v2 NEW)** TxSubscriber does NOT cause echo-storm on applyRemote writes (E2E `path-b` case 4 — MR-2 gating).

---

## 6. Risk Register (Phase 4-specific; top 8)

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| **P4-R1** | **Huly TxProcessor subscriber API surface is uncertain.** P4-T-01b investigation may find that none of Path A / Path B / Path C are clean — e.g., the `Client` exposes a subscription method but the tx events don't carry enough data to reconstruct flat-change envelopes (need `findOne` round-trip per tx). | Medium | High | P4-T-01b runs FIRST in Wave A; produces a spec doc + probe test BEFORE P4-T-09 begins. If all three paths are blocked, P4-T-01b documents fallback: a polling design with 5s cadence + `lastSeenTxId` cursor persisted in a new `tx_cursors` collection. P4-T-09 designs around the chosen path with no surprises. |
| **P4-R2** | **TxSubscriber fan-out floods the engine** on multi-binding workspaces (multi-instance) where a single Huly tx touches a doc visible to 2+ bindings. Each binding gets its own enqueue; engine dedup is event-id based and may not collapse fanout fully. | Medium | Medium | TxSubscriber's 5s in-memory dedup window keys on `(workspaceUuid, docRef, txId)` — same docRef across bindings shares one tx → enqueue happens N times per binding but only once per binding's queue. The engine's existing per-binding dedup absorbs the rest. If fanout is still excessive, add per-binding rate-limit on `enqueueLocalEvent` (Phase 5-style; deferred). Tested in P4-T-09 case 9. |
| **P4-R3** | **EE composite fetch cost balloons to 5 HTTP calls per MR fetch** (was 3 in Phase 3). High-MR EE projects with frequent webhook updates may hit rate limits 67% faster than Phase 3. | Medium | Medium | **v2 mitigation:** P4-T-03 adds an in-memory short-TTL cache for `getMRApprovalRules` (10s TTL, LRU 256 entries) keyed on `(projectId, mrIid)`. This collapses repeat composite fetches within the dedup window into one HTTP call. JSDoc documents the 5-call cost. All EE auxiliary calls fail gracefully (`mr.composite.partial` metric increments on each missing source). 429 retry path from Phase 1 reused. |
| **P4-R4** | **Per-user OAuth attribution mismatch on multi-instance**: a Huly user may have linked accounts on instance A but not B; an approval action on an MR mirrored from B falls back to service-account silently. User-visible confusion ("why didn't my approval show as me?"). | Medium | Medium | Phase 4 documents the per-instance scoping in `docs/architecture.md` and the user UI's status panel surfaces "Linked: Instance A (username `alice`); NOT linked: Instance B" using the SCG-2 `username` field so users can see the gap. Service-account fallback continues to post a visibility comment (Phase 3 Q2 carryover) so on-GitLab evidence is unambiguous. |
| **P4-R5** | **Cookie HMAC verification depends on Huly platform issuing the cookie out-of-band.** If the Huly platform integration is not yet built or misconfigures the secret, ALL `/user/oauth/start` calls fail 401. Pod cannot recover autonomously. | High | Medium | P4-T-21 runbook documents the ServerSecret env var contract explicitly. P4-T-14 cookie-auth.ts emits 401 with a sanitized error message; pod logs the cookie-missing case at info level (not error) so operators can distinguish "Huly hasn't issued cookies yet" from "tampering." The `/user/ui` HTML page detects this case (status panel says "Huly platform integration required: contact your admin"). |
| **P4-R6** | **Path B applyLocal dispatched to a manager that wasn't expecting Huly-side mutation** (e.g., an unrelated mixin change that happens to share the same docRef). Could result in spurious GitLab REST calls. | Medium | Medium | TxSubscriber's translation rules (P4-T-09) explicitly filter by mixin presence (only tx touching `gitlab-mr` / `gitlab-review` mixin on already-mirrored docs trigger enqueue). Tested in P4-T-09 case 5 (Issue without gitlab mixin → no enqueue). Each manager's `applyLocal` is already idempotent for the relevant fields. **MR-2 echo-storm filter** further defends against the more common case: applyRemote → tx → echo (P4-T-09 cases 13–14). |
| **P4-R7** | **EE auto-detection drift**: if GitLab instance upgrades from CE→EE at runtime (rare but possible), the 1-hour capability cache means EE features won't activate for up to 60 min. Symmetric on EE→CE (unlikely but possible if license expires). | Low | Low | Document the 1-hour cache TTL in the EE runbook (P4-T-21). Add an operator-facing endpoint reuse: `POST /api/v1/bindings/:id/refresh-capabilities` (PIGGYBACK on existing PATCH binding endpoint by accepting `{refreshCapabilities: true}`). Tracked as opportunistic; not blocking. |
| **P4-R8** | **`gitlab-mr` mixin reaches 16 fields**, surpassing Phase 3 Q5 split trigger (≥ 4 more fields = split). Future maintenance gets harder; field-ownership invariant becomes harder to enforce by JSDoc convention alone. | Medium | Medium | Document in P4-T-21 ADR as a follow-up maintenance ticket. Phase 4 leaves the mixin unified per CLAUDE.md "three similar lines is better than premature abstraction" + the spec's "no Phase 5" stance. **v2 reduction:** AC-1 removes `parentEpicIid` from the MR manager's write set (still on the mixin schema, but written by EpicsSyncManager only), keeping the cognitive load on `mr.ts` lower than v1 estimated. A future maintenance window can split into `gitlab-mr-core` + `gitlab-mr-review` + `gitlab-mr-ee` without re-doing Phase 4 work (the split is mechanical). |

---

## 7. Open Questions (defaults assumed; flag during implementation if any need user override)

1. **TxSubscriber subscription path (A / B / C).** P4-T-01b owns the decision; spec doc lands as `.omc/specs/p4-t-01b-tx-subscription-api.md`. **Default assumed:** Path A (`client.notify(handler)`) per spec §Open Questions #1. Escalate if P4-T-01b finds the path requires significantly more vendor.d.ts widening than expected.
2. **Epic hierarchy depth.** Spec §Open Questions #3: Phase 4 mirrors ONE level (epic + direct child issues); deeper hierarchies stored as flat `parentEpicIid` only. **Default:** one level. Tested in P4-T-06 case 6.
3. **Iteration ↔ Huly milestone mapping.** Spec §Open Questions #4: iterations are SEPARATE from milestones; no auto-mapping. **Default:** separate. P4-T-07 documents this in JSDoc.
4. **Cross-project epic children.** Phase 4 limitation: when an epic includes issues from another GitLab project not covered by this binding, the child is dropped with `epic.child.cross_project` warn log. **Default:** drop silently. Operators with multi-project epics should create one binding per project; the integration handles each independently.
5. **Cookie ServerSecret rotation.** Cookies HMAC'd with one secret stop verifying after rotation. **Default:** maintain a `ServerSecretPrev` env var for grace-period dual-verification (verify with current; if invalid, verify with prev). Document in P4-T-21 runbook. NOT implemented in Phase 4 unless P4-T-14 reviewer flags it; track as maintenance.
6. **`/user/ui` styling.** Spec says "vanilla ≤ 400 LOC." **Default:** functional, accessible (semantic HTML, label-for inputs, keyboard nav). No CSS framework. Operators may replace via static file substitution post-deploy.
7. **TxSubscriber polling fallback (Path C).** If Path A/B unavailable, polling cadence default 5s + `tx_cursors` state collection. **Default:** documented in P4-T-01b spec; implementation lands in P4-T-09. If used, Phase 4 adds a `tx_cursors` collection with workspace-scoped rows.
8. **EE compose stack for E2E.** P4-T-20 EE tests auto-skip on CE. **Default:** maintainers run EE tests against a local EE image periodically; CI runs CE-only. Document in P4-T-21.
9. **`mr.ts` Phase 5-style mixin split (Phase 3 Q5).** With Phase 4 adding 2 fields (approvalRules, iteration; AC-1 removed parentEpicIid from MR write set), the Phase 3 split trigger is reached at 16 fields. **Default:** DO NOT split in Phase 4 (would balloon the diff); track as maintenance ticket. Documented in P4-T-21 ADR.
10. **(v2 NEW) Multi-instance retro-migration.** Existing single-instance workspaces' idmap rows have unprefixed `gitlabId` strings. If an operator adds a second instance to an existing workspace, prefixed and unprefixed rows would coexist. **Default:** require operators to run a one-time migration script (template in `docs/runbooks/phase4-deployment.md`). Document in TG-4 acceptance.
11. **(v2 NEW) Service-account author resolution failure.** If the pod cannot resolve its own service-account `PersonUuid` at TxSubscriber start (e.g., bootstrap race), the MR-2 echo-storm filter has only the `_originated` marker as defense. **Default:** TxSubscriber refuses to `start()` until the service-account Person is resolved (3 retries × 1s); on terminal failure, the binding's workspace eviction triggers. Document in P4-T-09 JSDoc.

Executors must escalate items 1 (if Path C required), 5 (if reviewer pushes for rotation in Phase 4), 7 (if Path C is the only option), 10 (if a workspace genuinely needs retro-migration during Phase 4 rollout) — all others have safe defaults.

Append open questions 1, 5, 7, 9, 10, 11 to `.omc/plans/open-questions.md` as Phase 4 / post-Phase-4 maintenance follow-ups.

---

## 8. Change log

- **v1 (initial):** initial Phase 4 plan derived from `.omc/specs/deep-interview-huly-gitlab-phase4.md`. Structure mirrors Phase 3 plan (`.omc/plans/autopilot-impl-phase3.md`) for task format, acceptance-criteria style, risk register format, and change log placement. Task count: 22. Parallelism width: 5 (Wave C). Total new tests: ≥ 110 (target 120+). Baseline delta: 495 → ≥ 605 unit/integration; E2E +17. Estimated new code: ~10,500 LOC (matching spec expectation of 9,000–12,000).

- **v2 (this revision): applied critic findings.** Task count remains 22 (no additions; some scope redistribution). Parallelism width: 4 disjoint + 1 serialized in Wave C (DAG-1 resolution). Total new tests: ≥ 130 (target 140+). Baseline delta: 495 → ≥ 615 unit/integration; E2E +23. Estimated new code: ~11,200 LOC.

  Bullet list of critic items applied:
  - **DAG-1 (3-way file conflict on `binding-loader.ts`):** Moved TxSubscriber lifecycle wiring OUT of P4-T-09 and INTO P4-T-19. P4-T-09 now produces only the core `TxSubscriber` class + 16 unit tests; it does NOT modify `binding-loader.ts`. P4-T-19 absorbs the BindingLoader hook (`registerEvictionListener`), the per-workspace subscriber cache, the `onTerminalFailure` → `evictWorkspace` wiring, and SIGTERM iteration. Wave C is now 4-wide on disjoint files (P4-T-06 epics, P4-T-07 iterations, P4-T-08 mr.ts EE additions, P4-T-09 tx-subscription.ts) plus P4-T-10 serialized after P4-T-04.
  - **AC-1 (`parentEpicIid` ownership contradiction):** EpicsSyncManager is now the SOLE writer of `parentEpicIid`. MR manager (P4-T-08) explicitly does NOT touch this field; the adapter type `SyncMergeRequest` does NOT expose `parentEpicIid`; the adapter does NOT consume the MR payload's `epic_iid` field. P4-T-06 case 11 asserts EpicsSyncManager writes `parentEpicIid` on BOTH MR-mirror and Issue-mirror child mixins. P4-T-08 case 4 asserts MR manager does NOT touch `parentEpicIid` even with synthetic input. ADR alternative (d) added.
  - **OQ-2 / Bug-1 (Epic API path corrections):** P4-T-03 adds `resolveTopLevelGroupForProject(projectId)` helper that walks `namespace.full_path` upward via `GET /api/v4/groups/:id` recursion. EpicsSyncManager and IterationsSyncManager backfill paths call this helper instead of assuming `namespace.id` is the epic group. Bug-1 sub-group case 17 in P4-T-03 and case 8 in P4-T-06 and E2E case 5 in P4-T-20 cover the path. OQ-2 (`epic_iid` not on standard MR response) is moot — AC-1 makes the adapter ignore the field.
  - **MR-2 (Circular tx storm prevention):** P4-T-09 TxSubscriber implements two filters: (1) PRIMARY: `tx.createdBy === serviceAccountPersonUuid` filter resolved at subscriber start; (2) DEFENSE-IN-DEPTH: transient `_originated: 'gitlab'` marker stamped by every applyRemote write path (EpicsSyncManager + MR manager). Cases 13 and 14 in P4-T-09 verify both filters. E2E case 4 in P4-T-20 (`path-b` test) is the GATING regression with the real transactor. New metric `tx.subscription.echo.dropped`.
  - **Bug-6 (Bearer in query string):** P4-T-16 UI accepts bearer ONLY via postMessage from parent window OR sessionStorage; query-string bearer is REJECTED with console warning. P4-T-16 acceptance includes `grep` negation on query-string code paths. P4-T-19 adds CSP header middleware on `/user/ui/*` responses with `frame-ancestors`. P4-T-15 case 13 asserts the bearer-extraction path. P4-T-20 case 7 covers UI postMessage delivery in E2E.
  - **Bug-4 (Phase 3 approvalStatus CE regression):** P4-T-08 case 7 added — "CE approvalStatus derivation matches Phase 3" — explicit fixture replay against the new rule-aware logic to assert CE path is unchanged.
  - **SCG-1 (`change.actorToken` provenance guard):** Legacy Phase 3 carry path in `mr-review.ts:333` is REMOVED in P4-T-08. The resolver `bctx.credentials.resolveActorToken(workspaceUuid, hulyPersonUuid)` is the SOLE source of actor tokens. Change envelopes never carry an actorToken. P4-T-08 case 10 verifies synthetic `change.actorToken` payloads are IGNORED. P4-T-10 case 4 type-level guards the resolver signature. Acceptance includes `! grep -rn "change.actorToken" src/sync tests/sync`.
  - **SCG-2 (`username` field for /user/oauth/status):** `UserCredentialDoc` schema gains `username: string`. P4-T-15 callback fetches `GET /api/v4/user` immediately after token exchange. `/user/oauth/status` response includes `username` when linked. P4-T-15 case 6 (happy path) and case 9 (user_lookup failure with atomicity) and case 11 (status response shape) cover the field.
  - **SCG-3 (Callback identity source clarification):** P4-T-15 callback explicitly does NOT re-verify the `huly-user` cookie. Identity is read from the persisted `oauth-state` row that was created at `/start`. JSDoc on `src/http/user-oauth.ts` documents this. `docs/architecture.md` and `docs/api.md` also document. P4-T-15 case 10 verifies (sends callback with DIFFERENT cookie than original `/start` — callback succeeds).
  - **Bug-3 (Cookie format collision-safety):** P4-T-14 cookie format changed from pipe-separated to base64url-encoded JSON `{w, p, e}` + separate base64url `sig`, joined by `.`. Tampered payload, tampered sig, and odd-character-payload cases added (cases 2, 3, 7).
  - **Bug-7 (Iteration update SLA):** P4-T-07 JSDoc on `IterationsSyncManager.backfill` documents the amended SLA: 30s on MR Hook OR 5min via backfill (whichever first). Spec criterion #9 in §5 acceptance amended. E2E case 6 in P4-T-20 (`ee-features`) verifies both branches.
  - **DAG-3 (P4-T-17 webhook test):** P4-T-17 case 1 makes `enqueueRemoteEvent` assertion explicit (mocked engine spy with exact-call-count + argument shape). New `webhook.payload.invalid` metric added.
  - **TG-2 (Circular storm test):** Covered by MR-2 cases 13-14 in P4-T-09 plus E2E case 4 in P4-T-20.
  - **TG-3 (EpicsSyncManager field-ownership symmetric test):** P4-T-06 case 11 asserts EpicsSyncManager writes `parentEpicIid` on both MR-mirror and Issue-mirror children, AND simultaneously does NOT touch core `gitlab-mr` fields on those children (only `parentEpicIid`).
  - **TG-4 (Multi-instance idmap isolation test):** P4-T-01 adds `prefixGitlabIdForMultiInstance(baseUrl, raw, isMultiInstanceWorkspace)` helper. P4-T-04 surfaces `bctx.isMultiInstanceWorkspace`. Single-instance workspaces are UNCHANGED (no prefix). Multi-instance workspaces get an 8-hex `sha256(baseUrl)` prefix on idmap `gitlabId`. Managers (P4-T-06, P4-T-07) consume the helper. Test cases added (P4-T-04 case 5, P4-T-06 case 12, P4-T-07 case 7). E2E `multi-instance` test (P4-T-20) includes the same-projectId-on-two-instances regression. Migration note added to runbook.
  - **MR-1 (TxSubscriber cold-start):** P4-T-09 TxSubscriber buffers tx events received before `engine.start()` completes; drains FIFO post-start. Bounded buffer (1024 events) with overflow drops oldest + `tx.subscription.buffer.overflow` metric. Case 15 in P4-T-09 covers happy path + overflow.
  - **TG-1 (TxSubscriber production-vs-test divergence):** P4-T-09 case 16 documents the gap: in-process Huly Client fake is used for unit tests; real-transactor verification is the responsibility of P4-T-20 E2E case 4 (`path-b`) which serves as the gating test for the real subscription path.
  - **P4-R3 (EE composite fetch rate limit):** P4-T-03 adds short-TTL in-memory cache for `getMRApprovalRules` (10s TTL, LRU 256 entries) keyed on `(projectId, mrIid)`. Invalidated on `approveMR`/`unapproveMR`. Case 5 in P4-T-03 verifies cache hit + invalidation behavior. Risk register R3 updated to reference the mitigation.

  **Per-task delta summary:** P4-T-01 +1 test (TG-4 prefix), +1 helper. P4-T-01b +1 test, +Self-authored + Cold-start docs. P4-T-02 +AC-1 JSDoc + `gitlab-issue` mixin note. P4-T-03 +3 tests (P4-R3 cache, AC-1, Bug-1), + `resolveTopLevelGroupForProject` + short-TTL cache. P4-T-04 +1 test, + `isMultiInstanceWorkspace` flag. P4-T-05 +1 test, + `username` field. P4-T-06 +3 tests (TG-3, TG-4, MR-2), + Bug-1 group walk usage + TG-4 prefix usage. P4-T-07 +1 test, + Bug-7 SLA docs + Bug-1 usage + TG-4 prefix. P4-T-08 +3 tests (AC-1 regression, Bug-4 CE regression, MR-2 marker, SCG-1 provenance), - parentEpicIid from write set, + mr-review.ts SCG-1 cleanup. P4-T-09 +4 tests (MR-2 PRIMARY, MR-2 DID, MR-1 cold-start, TG-1 doc), - binding-loader.ts edits (DAG-1), + serviceAccount filter + buffer. P4-T-10 +1 test (SCG-1 type guard), + legacy-path-removed assertion. P4-T-14 +2 tests (Bug-3 tamper + collision), + JSON+HMAC format. P4-T-15 +3 tests (SCG-2 happy + failure, SCG-3 cookie-independence, Bug-6 bearer rejection), + GET /api/v4/user + state-row-identity. P4-T-16 + Bug-6 postMessage/sessionStorage hardening + CSP meta tag. P4-T-17 +1 test (DAG-3 explicit + malformed payload). P4-T-19 +3 tests (CSP header, DAG-1 wiring, DAG-1 onTerminalFailure), + absorbed TxSubscriber lifecycle + `registerEvictionListener`. P4-T-20 +6 cases (MR-2 gating, Bug-1, Bug-7 dual SLA, SCG-3, Bug-6 UI, TG-4 isolation). P4-T-21 + AC-1 ADR rejection + JSON+HMAC docs + SCG-3 docs + MR-2 echo-storm doc + Bug-1 doc + Bug-7 doc + TG-4 migration runbook section. P4-T-22 +3 metrics (`echo.dropped`, `buffer.overflow`, `webhook.payload.invalid`).
