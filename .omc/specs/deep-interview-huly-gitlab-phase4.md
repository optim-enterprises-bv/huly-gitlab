# Deep Interview Spec: Huly GitLab Integration — Phase 4 (FINAL)

**Date:** 2026-06-06
**Status:** Approved through brainstorming with user
**Scope:** Phase 4 of 4-phase integration plan — the final phase
**Prerequisites:** Phase 1+2+3 shipped to `main` (495 tests; PRs #6 and #7 merged)
**Ambiguity gate:** ≤ 20%

## Problem

Phase 1 through 3 delivered a robust read-from-GitLab pipeline (issues, MRs, notes, review threads, pipeline status). However:
1. **Path B gap** — no production `TxMixin`/`TxProcessor` subscription means Huly UI mutations don't propagate to GitLab. All `applyLocal` paths are dead in production. This must close.
2. **CE-only feature ceiling** — EE customers (approval rules, epics, iterations) cannot use the integration meaningfully.
3. **Single-instance assumption** — one Huly workspace cannot mirror multiple GitLab instances simultaneously.
4. **Service-account approval attribution** — every approval shows as the integration's service account, not the real Huly user.

Phase 4 closes all four gaps in one cycle.

## Scope (Phase 4 — FINAL)

### A. Close Path B: Huly tx → engine wiring
- New module `src/sync/tx-subscription.ts` that hooks Huly platform's `TxProcessor` or equivalent observation API on the per-workspace `Client` returned by `BindingLoader.loadFor*`.
- On every `TxCUD`/`TxMixin`/`TxRemoveDoc` that touches a `tracker.class.Issue` (with `gitlab-mr` mixin) or `chunter.class.ChatMessage` (with `gitlab-review` mixin) or a tracker Issue without mixin (potential new comment/edit), build a `change` envelope matching the contract verified in `.omc/specs/p3-t-01b-mixin-change-payload.md` (flat keys) and call `syncEngine.enqueueLocalEvent(...)`.
- Subscription lifecycle: started by `BindingLoader.loadFor*` per workspace on first load, cached for the workspace's TTL (30 min), stopped on cache eviction or pod shutdown.
- Deduplication: same `(workspaceUuid, issueRef, txId)` skip within a 5-second window to defend against fanout (the engine's existing dedup is event-id based).

### B. EE approval rules
- `MRMixinDoc` extension: `approvalRules?: MRApprovalRule[]` where `MRApprovalRule = { id, name, ruleType, eligibleApprovers: PersonUuid[], approvalsRequired: number, approvedBy: PersonUuid[] }`.
- Adapter: `getMRApprovalRules(projectId, mrIid)` returning canonical `SyncMRApprovalRule[]`. EE-only; gated via `capabilities.edition === 'EE'`. CE returns empty array silently.
- `MergeRequestsSyncManager.applyRemote` composite fetch extended with rules call (Promise.allSettled — degrades to undefined on 404/5xx).
- New typed canonical type `SyncMRApprovalRule` in `src/adapter/types.ts`.

### C. Iterations
- `MRMixinDoc` extension: `iteration?: { id: string, title: string, startDate: Date, dueDate: Date, state: 'upcoming'|'started'|'closed' }`.
- Adapter: `listIterations(groupId, projectId?)` and `getIteration(id)`. EE-only.
- Map GitLab iterations to a typed mixin field. Huly tracker has milestones already; map GitLab iterations to those when the names match, else surface only on mixin.
- New idmap kind `'iteration'`.

### D. Epics
- New canonical type `SyncEpic` and new `EpicsSyncManager` (kind `'epic'`).
- Map GitLab epics to Huly `tracker.class.Issue` with a new runtime mixin `gitlab-epic` carrying `epicIid`, `groupId`, `state`, `webUrl`, `childIssueIids: number[]`.
- Adapter: `listEpics(groupId)`, `getEpic(groupId, epicIid)`, `listEpicIssues(groupId, epicIid)`. EE-only.
- Parent-child relationship: when an MR or issue is part of an epic, the mirror Issue's `gitlab-mr` (or `gitlab-issue`) mixin gets `parentEpicIid: number`.
- New idmap kind `'epic'`. New cursor kind `'epics'`.
- Webhook event: `Epic Hook` subscribed; routing branch in `src/http/webhook.ts`.

### E. Multi-instance support
- Today a binding already carries `gitlabBaseUrl` per credential; Phase 4 formalizes:
  - Per-workspace `IdMap` rows already scoped by workspace; no change.
  - `BindingLoader` cache key extended from `workspaceUuid` to `(workspaceUuid, gitlabBaseUrl)` so two bindings pointing to different instances don't share a cached HulyClient (HulyClient is per workspace anyway; that's fine) but each binding's `gitLabClient` is built per-binding from `credential.gitlabBaseUrl`.
  - Webhook router: events identify their source via `X-Gitlab-Webhook-UUID` and the binding's path param; no change needed beyond docs.
  - Reviewer migration scoped per binding — already correct.

### F. Per-user OAuth: store + minimal HTML UI
- Backend:
  - `src/state/user-credentials.ts` — per-user OAuth credential store. Schema: `{_id, workspaceUuid, hulyPersonUuid, gitlabBaseUrl, ciphertext, iv, tag, expiresAt, refreshTokenCiphertext?, ...}`. AES-256-GCM (reuses Phase 1 `CredentialEncryptionKey`).
  - `MRCredentialResolver.resolveActorToken` replaces stub: looks up `(workspaceUuid, hulyPersonUuid)` in `user_credentials`, decrypts, returns access token. Falls back to undefined (service-account) if not found.
  - `OAuthRefresher` extended to refresh per-user credentials with the same transient/permanent classification.
- HTTP endpoints:
  - `GET /user/oauth/start?workspaceUuid=...&hulyPersonUuid=...&gitlabBaseUrl=...&returnTo=...` — generates PKCE state, redirects to GitLab. NOT bearer-protected (must be reachable by browsers).
  - `GET /user/oauth/callback?code&state` — exchanges code, persists credential, redirects to `returnTo` or default success page.
  - `GET /user/oauth/status?workspaceUuid=...&hulyPersonUuid=...` — returns `{linked: boolean, gitlabBaseUrl?: string, expiresAt?: string}`. Bearer-protected (called from Huly UI).
  - `DELETE /user/oauth/credential` — body `{workspaceUuid, hulyPersonUuid, gitlabBaseUrl}`. Bearer-protected.
- HTML UI (minimal, served by pod):
  - `GET /user/ui` — single HTML page (Express static or inline HTML) that lets a user:
    - Enter their workspace + GitLab instance URL
    - See their current link status
    - Click "Link" → triggers `/user/oauth/start`
    - See "Linked as <username>" if already linked
    - Click "Unlink" → DELETE
  - Vanilla HTML+CSS+JS only. No build step. No framework. ≤ 400 LOC of HTML+CSS+JS.
  - Server side: serve via Express static middleware from `public/user-ui/`.
- Security:
  - User-facing endpoints (`/user/oauth/*` except status/delete) are NOT bearer-protected (must be reachable by users).
  - Workspace+person identity comes from a signed cookie set by Huly platform when the user clicks "Link" from inside Huly. The cookie format is `(workspaceUuid|hulyPersonUuid|expiresAt)` HMAC-signed with `ServerSecret`. The pod verifies the HMAC; rejects expired/tampered.
  - Rate limit `/user/oauth/start` per source IP (token bucket; 10 per minute) to prevent abuse.
  - `/user/oauth/start` and `/user/oauth/callback` already covered by Phase 1+3 SSRF allowlist + PKCE.

### G. Code refactor backlog (opportunistic; no new tests required if behavior unchanged)
- Extract `src/sync/mr-approvals.ts` from `mr.ts` (~940 LOC → ~700 + 240 split).
- Extract `src/sync/bi-directional-cache.ts` base class. `LabelCache`/`MRCache`/`MilestoneCache` adopt it. Add bounded LRU (default 1000 entries per binding).
- Extract `src/sync/deferred-parent.ts` retry helper used by `NotesSyncManager` and `ReviewThreadsSyncManager`.
- `change.actorToken` provenance check in `MR_REVIEW_MIXIN` resolution code path (guard via workspace-scoped resolver).

### H. Webhook subscription extension
- `merge_request_events` + `note_events` + `pipeline_events` + new `epic_events` (EE; gated). Confidential events HARDCODED FALSE remains.
- `BindingLifecycleService` event flag set extended.
- One-shot `POST /api/v1/bindings/:id/re-register-webhook` already exists; no new endpoint.

## Explicitly out of scope (no Phase 5)
- Full diff body content (URL + file-list contract from Phase 3 stays).
- Image / file-level discussion annotations.
- Suggestion comments applied via Huly UI.
- GraphQL adapter migration (REST + capability detection stays).
- Per-tenant ACL for admin routes (operator bearer is still admin-global).
- React/Vue frontend for `/user/ui` — vanilla HTML+CSS+JS only.

## Key Decisions (from brainstorming)

| # | Decision | Choice |
|---|---|---|
| 1 | Path B closure | Yes — wire TxMixin subscription in Phase 4 |
| 2 | EE features | All three: approval rules + iterations + epics |
| 3 | Multi-instance | Yes — formalize per-instance binding/credential scoping |
| 4 | Per-user OAuth | Backend store + minimal HTML UI (vanilla, ≤400 LOC) |
| 5 | Code refactor backlog | Opportunistic; no new tests required if behavior unchanged |
| 6 | EE capability gating | `capabilities.edition === 'EE'` check; CE returns empty silently |
| 7 | Cookie-based user identity for OAuth UI | HMAC-signed cookie issued by Huly platform integration (out of pod's scope to issue — pod only verifies) |
| 8 | Rate limiting | Token bucket on `/user/oauth/start` per source IP |

## Architecture (deltas from Phase 3)

### New modules
- `src/sync/tx-subscription.ts` — Huly TxProcessor subscriber → enqueueLocalEvent
- `src/sync/epics.ts` — EpicsSyncManager
- `src/sync/iterations.ts` — IterationsSyncManager (or fold into mr.ts if minimal)
- `src/sync/mr-approvals.ts` — extracted from mr.ts
- `src/sync/bi-directional-cache.ts` — base class
- `src/sync/deferred-parent.ts` — shared retry helper
- `src/state/user-credentials.ts` — per-user OAuth store
- `src/http/user-oauth.ts` — user-facing OAuth routes
- `src/http/cookie-auth.ts` — HMAC cookie verifier middleware
- `src/http/rate-limit.ts` — token bucket per source IP
- `src/state/idmap.ts` — extend kinds: `'epic'`, `'iteration'`, `'approval_rule'`
- `src/adapter/types.ts` — add `SyncEpic`, `SyncIteration`, `SyncMRApprovalRule`
- `src/adapter/gitlab-client.ts` — add EE methods: `listEpics`, `getEpic`, `listEpicIssues`, `listIterations`, `getMRApprovalRules`
- `public/user-ui/index.html` + `public/user-ui/app.js` + `public/user-ui/style.css`
- `src/sync/mr-mixin.ts` — extend `MRMixinDoc` with `approvalRules`, `iteration`, `parentEpicIid`
- New `gitlab-epic` mixin defined in `src/sync/epic-mixin.ts` (new file)

### Existing modules extended
- `src/sync/mr.ts` — composite fetch extended with rules; mixin write includes new EE fields; reduced size via approvals extraction
- `src/http/webhook.ts` — `Epic Hook` dispatch (EE only via capability detection)
- `src/sync/binding-lifecycle.ts` — event flag set extended with `epic_events`
- `src/auth/refresh.ts` — extended to refresh per-user OAuth credentials
- `src/sync/binding-loader.ts` — cache key extended; per-user resolver populated
- `src/index.ts` — register `EpicsSyncManager`, possibly `IterationsSyncManager`; mount user OAuth routes

### Engine boundary
No changes to `src/sync/engine.ts`. The new `TxSubscriber` (TX subscription module) is OUTSIDE the engine; it just constructs `change` envelopes and calls the existing `enqueueLocalEvent` API.

## Error Handling
- TX subscription failures (e.g., Huly Client disconnects) → log warn, attempt reconnection with exponential backoff (5 attempts max), surface metric `tx.subscription.reconnects`.
- EE capability detection failure on `getMRApprovalRules` etc. → 404 treated as `[]` empty, metric `mr.composite.partial` increment (same as Phase 3).
- User OAuth cookie tamper → 401 with sanitized error (no detail).
- User OAuth callback failure → redirect to `?error=<short_code>` to allow UI to show a friendly message.
- Epic with cross-group hierarchy (epic in group A includes issues from group B) → log warn, mirror MR/issue without parent-epic linkage if cross-group access denied.

## Testing Strategy
- Unit: TxSubscriber against fake Huly Client tx stream (≥ 12 cases including idempotency, reconnect, batched txs)
- Unit: EpicsSyncManager (≥ 10 cases including hierarchy)
- Unit: IterationsSyncManager (≥ 6 cases)
- Unit: mr-approvals.ts (≥ 8 cases — extracted from mr.ts)
- Unit: user-credentials.ts (≥ 8 cases including AES round-trip, refresh, expiry)
- Unit: cookie-auth.ts (≥ 5 cases including tamper, expiry, valid)
- Unit: rate-limit.ts (≥ 4 cases)
- Adapter: nock fixtures for EE methods (≥ 14 cases)
- HTTP: user OAuth routes (≥ 10 cases including PKCE, callback success, error redirect, status, delete, rate limit)
- E2E: gated tests for TxSubscriber against the full Huly stack (existing harness already has Huly transactor)
- E2E: gated EE tests — skipped if not running against GitLab EE image (auto-detect via capability detection at boot)

## Success Criteria (Phase 4 acceptance — FINAL)
1. All Phase 1+2+3 tests continue to pass (regression)
2. ≥ 80 new tests added (target: 100+)
3. `npm run build`, `npm run lint`, `npm test` exit 0
4. `npm audit --omit=dev --audit-level=high` shows 0 high
5. Huly user clicks "approve" in Huly UI on a mirror MR → GitLab MR `approveMR` called with the real user's actorToken (within 30s)
6. Huly user resolves a discussion → GitLab `resolveDiscussion` called
7. Huly user edits a tracker Issue title → GitLab `updateIssue` called
8. EE approval rules synced into mixin and respected in `approvalStatus` derivation
9. GitLab iteration created → Huly mixin `iteration` populated within 30s
10. GitLab epic with child issues → epic Issue mirrored AND children get `parentEpicIid` mixin field
11. User opens `/user/ui`, clicks Link → GitLab OAuth dance → credential persisted with PKCE
12. Two bindings under one workspace pointing to different GitLab instances both work concurrently without idmap collision
13. `mr.ts` line count reduced to ≤ 700 (approvals extracted)
14. `LabelCache`/`MRCache`/`MilestoneCache` share a base class with bounded LRU

## Phasing — END STATE
- ✅ Phase 1: Issues + foundation (shipped)
- ✅ Phase 2: MRs + MR notes + pipeline status (shipped)
- ✅ Phase 3: review threads + CE approvals + diff metadata + typed reviewers (shipped)
- → Phase 4 (this spec): Path B + EE features + multi-instance + per-user OAuth — **FINAL**
- No Phase 5

## Phase 1+2+3 infrastructure preserved (no changes)
- All Phase 1+2+3 sync managers, adapters, state collections, HTTP routes
- All security primitives (helmet, CORS, SSRF, ObjectId, AES-256-GCM, PKCE, timingSafeEqual)
- Defense-in-depth confidential filtering (4 layers — Phase 4 adds same for epics + approvals)
- Docker compose, CI/release workflows, dependabot
- BindingLoader pattern with per-mode loaders
- Metrics centralization in `src/metrics.ts`

## Open Questions (resolved with defaults; flag during execution if needed)

1. **Huly TxProcessor API**: P3-T-01b verified the change-payload shape but the SUBSCRIBER API was not investigated. P4-T-01b (new investigation task) verifies the exact subscription pattern in `@hcengineering/core`. Likely `client.notify(tx => ...)` or `txHandler` registration.
2. **Cookie format**: Default to `${workspaceUuid}|${hulyPersonUuid}|${expiresAt}|${HMAC-SHA256(ServerSecret, prev)}`. Phase 4 documents the format; Huly platform issues the cookie out-of-band.
3. **Epic hierarchy depth**: GitLab supports nested epics. Phase 4 mirrors one level deep (epic + direct child issues). Deeper hierarchies stored as flat `parentEpicIid` only.
4. **Iteration vs milestone mapping**: GitLab milestones already mapped (Phase 1+2). Iterations are different. Phase 4 keeps them separate: iterations only on mixin field, milestones continue to map to Huly milestones.
5. **EE capability detection caching**: Already 1-hour TTL from Phase 1. No change needed for Phase 4.
