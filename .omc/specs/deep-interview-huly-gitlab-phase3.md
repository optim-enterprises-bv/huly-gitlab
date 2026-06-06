# Deep Interview Spec: Huly GitLab Integration — Phase 3

**Date:** 2026-06-06
**Status:** Approved through brainstorming with user
**Scope:** Phase 3 of 4-phase integration plan (Phase 1 + 2 shipped, 408 tests passing, all reviewers approved)
**Prerequisite:** Phase 1 spec, Phase 2 spec in `.omc/specs/`
**Ambiguity gate:** ≤ 20%

## Problem

Phase 2 delivered MR sync with general MR notes, but Phase 1's note path treats every comment as flat. GitLab's review workflow uses **threaded discussions** anchored to file positions (line comments), **approvals** that gate merge eligibility, and **diff metadata** that tells reviewers what to look at. Phase 3 extends the MR surface to these review primitives without yet implementing approval rules (EE) or full diff content rendering — both deferred to Phase 4.

## Scope (Phase 3)

Add review threads, line comments, CE approvals, and diff URL + file-list metadata on top of Phase 2's infrastructure. Plus a typed reviewers field on the `gitlab-mr` mixin to replace Phase 2's synthetic `gitlab:reviewer:<u>` label workaround, with a one-shot migration endpoint.

### In scope (Phase 3)
- **Review threads** as `chunter.class.ChatMessage` with a runtime `gitlab-review` mixin carrying `threadId: string`, `resolved: boolean`, `resolvedBy?: PersonUuid`, `resolvedAt?: Date`. Replies share the same threadId. The thread's first message defines the thread's anchor.
- **Line comments** as a special case of review thread with an additional `position` field on the same mixin:
  - `position: { filePath: string, oldLine: number | null, newLine: number | null, baseSha: string, headSha: string, startSha: string }`
  - GitLab's `position_type` is always `'text'` for Phase 3 (image / file-level annotations deferred to Phase 4).
- **CE approvals** as additional fields on the existing `gitlab-mr` mixin:
  - `approvedBy: PersonUuid[]` — list of users who have approved
  - `approvalsRequired: number` — from GitLab MR's `approvals.approvals_required`
  - `approvalStatus: 'pending' | 'approved' | 'changes_requested'` — derived
- **Approval actions two-way**: a Huly user adding themselves to `approvedBy` triggers `POST /merge_requests/:iid/approve` on GitLab; removing triggers `/unapprove`. Reading is per-field LWW from GitLab.
- **Diff metadata** on the `gitlab-mr` mixin:
  - `diffWebUrl: string` — direct link to the diff view on GitLab
  - `changedFiles: Array<{ path: string, oldPath?: string, additions: number, deletions: number, status: 'added' | 'modified' | 'deleted' | 'renamed' }>`
  - Populated from GitLab `GET /merge_requests/:iid/diffs` or the embedded `changes` summary (whichever exposes the needed shape efficiently)
- **Typed reviewers field** on `gitlab-mr` mixin:
  - `reviewers: PersonUuid[]` — typed list resolved via `UserIdentity` from GitLab MR's `reviewers` array
  - Phase 2's `gitlab:reviewer:<username>` synthetic labels are no longer written by Phase 3 code
- **One-shot reviewer migration**: `POST /api/v1/bindings/:id/migrate-reviewer-labels` (bearer-protected) scans the binding's mirrored MRs, converts `gitlab:reviewer:*` labels to typed `reviewers` list, strips those labels from the Huly Issues. Idempotent.
- **Webhook events**: `Merge Request Hook` payloads already carry approval state changes and reviewer updates — Phase 2's MR dispatch handles them; Phase 3 just consumes the new fields. **No new webhook subscription** required for approvals (CE delivers them via MR Hook). Discussion events (`Note Hook` with `position` set) flow through the existing notes path with a new branch in `NotesSyncManager`.
- **NotesSyncManager extension**:
  - When `payload.object_attributes.position` is present, this is a line comment → route to `ReviewThreadsSyncManager.applyRemote` (a thin specialization)
  - Threads' first note creates the thread; subsequent notes with the same `discussion_id` extend it
  - Resolving a discussion (`resolvable: true, resolved: true`) updates the mixin's `resolved` flag

### Explicitly out of scope (deferred to Phase 4)
- EE approval rules (eligible approvers, required reviewer rules, multi-rule combinations)
- Image / file-level annotations (only text position in Phase 3)
- Full unified diff text or per-file hunks rendered in Huly (URL + file-list metadata only)
- Custom field mapping, iterations, epics (all Phase 4)
- Multi-instance per workspace (Phase 4)
- Suggestion comments (`<<<<<<< SUGGEST` blocks) applied via Huly UI
- Pipeline detail (jobs, stages, logs)
- Confidential discussions on confidential MRs (already filtered out via Phase 1+2 layered defense; Phase 3 inherits, no new code path)

## Key Decisions (from brainstorming)

| # | Decision | Choice |
|---|---|---|
| 1 | Review thread model | ChatMessage + runtime `gitlab-review` mixin with `threadId` grouping |
| 2 | Approvals scope | CE approvals only (`approve`/`unapprove`); EE rules → Phase 4 |
| 3 | Diff sync level | URL + file-list metadata only (no diff body sync) |
| 4 | Reviewers field | New typed `reviewers: PersonUuid[]` + one-shot migration endpoint |
| 5 | Line comment position | Stored as JSON on `gitlab-review` mixin; `position_type='text'` only |
| 6 | Approval actions | Two-way: Huly add/remove from `approvedBy` triggers GitLab approve/unapprove |
| 7 | Webhook subscription | No change (MR Hook already delivers approval state + reviewer updates) |
| 8 | Confidential discussions | No new code; inherits Phase 1+2 layered defense |

## Architecture (deltas from Phase 2)

### New modules

```
src/
├── sync/
│   ├── mr-review.ts                    # NEW: ReviewThreadsSyncManager (kind 'review')
│   ├── mr-approval.ts                  # NEW: ApprovalActionsSyncManager (kind 'approval') OR fold into mr.ts
│   ├── mr-diff.ts                      # NEW: helpers for diff URL + file-list parsing
│   ├── reviewer-migration.ts           # NEW: scan-and-migrate synthetic reviewer labels
│   ├── notes.ts                        # extend: route line-position notes to ReviewThreadsSyncManager
│   ├── mr.ts                           # extend: write typed reviewers; write approvedBy/approvalsRequired/approvalStatus; write diffWebUrl/changedFiles
│   ├── mr-mixin.ts                     # extend: MRMixinDoc adds reviewers, approvedBy, approvalsRequired, approvalStatus, diffWebUrl, changedFiles
├── adapter/
│   ├── types.ts                        # NEW types: SyncReviewThread, SyncReviewNote, SyncApproval, SyncChangedFile
│   ├── gitlab-client.ts                # NEW methods: listDiscussions, createDiscussion, resolveDiscussion, getMRApprovals, approveMR, unapproveMR, getMRChanges
├── http/
│   ├── binding.ts                      # NEW route: POST /api/v1/bindings/:id/migrate-reviewer-labels
└── state/
    └── idmap.ts                        # extend: GitlabKind union adds 'review_thread'
```

### Existing modules unchanged
- `src/sync/engine.ts` — provider-agnostic; needs no edits
- `src/sync/conflict.ts` — LWW resolver applies to approval/reviewer/diff fields identically
- `src/auth/*`, `src/state/store.ts` core, markdown adapter — no changes
- Webhook router (`src/http/webhook.ts`) — no new dispatch branches; Note Hook with position routes inside `NotesSyncManager`

### Sync managers

**`ReviewThreadsSyncManager implements SyncManager<SyncReviewThread>`** (Phase 3):
- `kind = 'review'`
- `resourceKey(record) = 'review:${record.discussion_id}'`
- `applyRemote(ctx, binding, syncThread)`:
  1. For each note in the discussion, ensure a `chunter.class.ChatMessage` exists in Huly attached to the parent MR's Huly Issue (via `findByGitlab('merge_request', ...)`).
  2. Apply `gitlab-review` mixin to each ChatMessage with `{ threadId: discussion_id, resolved, resolvedBy, resolvedAt, position }`.
  3. Per-field LWW on `resolved` / `resolvedBy` / `resolvedAt` against `hulyMessage.modifiedOn` and discussion's `updated_at`.
- `applyLocal(ctx, binding, hulyMessage, change)`:
  1. If `change.gitlab-review.resolved` flips true → call `resolveDiscussion(projectId, mrIid, discussionId, true)`.
  2. If body edited → already covered by existing `NotesSyncManager.applyLocal` path; no duplication.
- `backfill(ctx, binding, since)` → `listDiscussions(projectId, mrIid, {updatedAfter: since})` for each mirrored MR.

**`ApprovalActionsSyncManager`** is folded into `MergeRequestsSyncManager` (extension), not a separate manager. Reason: approval state already arrives on the MR Hook payload (`object_attributes.approvals` and `object_attributes.approval_rules` in CE webhook); no new subscription, no new kind. The two-way handling (Huly user marking `approvedBy` → call GitLab approve/unapprove) lives in `MergeRequestsSyncManager.applyLocal`.

### NotesSyncManager dispatch branch
- After existing system-note skip and `noteable_type` routing:
- If `payload.object_attributes.position !== null`, treat as line comment:
  - Build a `SyncReviewNote` envelope (position included)
  - Enqueue with kind `'review'` instead of `'note'`
  - Defer rest of routing to `ReviewThreadsSyncManager`

### Adapter additions
- `listDiscussions(projectId, mrIid, opts?)` — paginated; returns canonical `SyncReviewThread[]` (each with its `notes: SyncReviewNote[]`)
- `createDiscussion(projectId, mrIid, body)` — REST `POST /merge_requests/:mrIid/discussions`
- `resolveDiscussion(projectId, mrIid, discussionId, resolved: boolean)` — REST `PUT /merge_requests/:mrIid/discussions/:discId`
- `getMRApprovals(projectId, mrIid)` — REST `GET /merge_requests/:mrIid/approvals`
- `approveMR(projectId, mrIid)` — REST `POST /merge_requests/:mrIid/approve`
- `unapproveMR(projectId, mrIid)` — REST `POST /merge_requests/:mrIid/unapprove`
- `getMRChanges(projectId, mrIid)` — REST `GET /merge_requests/:mrIid/changes` → mapped to `SyncMRChanges { diffWebUrl, changedFiles }`

### Reviewer migration endpoint
- `POST /api/v1/bindings/:id/migrate-reviewer-labels` (bearer-protected, ObjectId-validated)
- For each MR mirrored under this binding:
  1. Query Huly Issue's labels via `findAll(tracker.class.Label, { space: hulyProjectRef })` filtered by name prefix `gitlab:reviewer:`
  2. For each matching label, parse username, resolve via `UserIdentity.mapByGitlabUser({ username })` → `PersonUuid`
  3. Append resolved PersonUuid to the MR's `gitlab-mr` mixin `reviewers` field (dedup by PersonUuid)
  4. Remove the synthetic label from the Huly Issue
- Idempotent (re-running is safe; labels already stripped just process zero)
- Response: `{ migratedAt, mrsScanned, labelsStripped, reviewersResolved, unresolvedCount }`

### State extensions
- `idmap` kinds: add `'review_thread'` for `(workspaceUuid, gitlabKind='review_thread', gitlabId=discussion_id) ↔ (hulyClass='chunter.class.ChatMessage', hulyRef=firstMessageRef)`
- `cursors` kinds: add `'reviews'` per binding

### Vendor.d.ts extensions
- `chunter.class.ChatMessage` already declared in Phase 2 (notes path)
- Add `gitlab-review` mixin marker: just a string constant `'gitlab-review'` and a `MRReviewMixinDoc` interface

## Error Handling
- Approval action failures (non-2xx from `approveMR`/`unapproveMR`): surface to Huly as a comment on the issue ("approval failed: <reason>") so the operator sees it; do not silently drop. Phase 1 lesson on visibility.
- Line comment with malformed `position` (missing `headSha`, etc.): log warn, drop the note, do NOT create the thread.
- Reviewer migration: per-MR failures don't abort the migration; tracked in unresolvedCount. Migration is idempotent and re-runnable.

## Testing Strategy
- Unit: `ReviewThreadsSyncManager` (≥ 12 cases): create thread, reply, resolve, position parse, LWW resolve flag, line comment via Note Hook routing
- Unit: `MergeRequestsSyncManager` extensions (≥ 8 new cases): typed reviewers vs Phase 2 synthetic labels (regression), approve/unapprove two-way, approvalsRequired propagation
- Unit: reviewer-migration (≥ 6 cases): label scan, PersonUuid resolution, label stripping, idempotency, unresolved counter
- Adapter: nock fixtures for `listDiscussions` paginated, `createDiscussion`, `resolveDiscussion`, `getMRApprovals`, `approveMR`, `unapproveMR`, `getMRChanges` (≥ 14 cases)
- HTTP: `POST /migrate-reviewer-labels` admin route (≥ 3 cases): 401 no bearer, 404 unknown, happy path with migration counts
- E2E: gated MR-with-discussion round-trip + reviewer migration scenario (synthetic webhook for discussion delivery)

## Success Criteria (Phase 3 acceptance)
1. All Phase 1 + Phase 2 tests continue to pass (regression)
2. ≥ 50 new tests added (target: 60+)
3. `npm run build`, `npm run lint`, `npm test` exit 0
4. `npm audit --omit=dev --audit-level=high` shows 0 high
5. Line comment created on GitLab MR appears in Huly within 30s with `position` JSON preserved
6. Resolving discussion in GitLab → Huly mixin `resolved` flips true within 30s
7. Resolving in Huly → GitLab `resolveDiscussion` API called
8. Approval flow round-trips: GitLab approve → Huly `approvedBy` updates; Huly add to `approvedBy` → GitLab approve called
9. Changed-files metadata populates on MR mirror within 30s of MR webhook
10. `POST /migrate-reviewer-labels` strips synthetic labels and populates typed `reviewers` field

## Phase 2 reviewer carry-over items (handled OR explicitly deferred)
- `issues.ts` ↔ `mr.ts` ~80% overlap → **deferred to Phase 4 cleanup** (Phase 3 adds, doesn't refactor)
- `LabelCache` / `MRCache` / `MilestoneCache` → `BiDirectionalCache` LRU → **deferred to Phase 4**
- Centralize metric counters in `src/metrics.ts` → **handled in Phase 3** as a small parallel task
- `gitlab-mr` mixin growth: now 13+ fields (including reviewers, approvedBy, approvalsRequired, approvalStatus, diffWebUrl, changedFiles) — still acceptable as a single mixin per CLAUDE.md "three similar lines is better than premature abstraction"; if it grows further in Phase 4, split

## Phasing
- ✅ Phase 1: Issues + foundation (shipped)
- ✅ Phase 2: MRs + MR notes + pipeline status (shipped)
- → Phase 3 (this spec): review threads + line comments + CE approvals + diff metadata + typed reviewers
- Phase 4: EE approval rules, custom field mapping, iterations, epics, multi-instance, code dedup

## Open Questions (defaults assumed; flag if any need user override during execution)

1. **Discussion delivery via Note Hook vs separate Discussion Hook**: GitLab delivers thread state changes (resolved/unresolved) via Note Hook with the embedded discussion meta. Phase 3 default: use existing Note Hook path. If discussion-only events (no note body change) are needed and Note Hook doesn't deliver them, fall back to polling via `listDiscussions` during backfill.
2. **Approval state mapping**: `approvalStatus = 'approved'` requires `approvedBy.length >= approvalsRequired`. If `approvalsRequired === 0` (project allows no approvals), default to `'pending'` until first approval. Document.
3. **Stripping legacy reviewer labels during migration**: if the same label is on multiple Issues (shouldn't happen but defensive), strip from each independently.
4. **Approval action attribution**: when Huly user adds themselves to `approvedBy`, GitLab needs the user's OAuth token to call `approveMR` as that user. If the user has no stored OAuth credential, fall back to the binding's service-account credential and log a warn (the approval will appear as the service account on GitLab). This is a known limitation; tracker ticket for Phase 4.

## Phase 1+2 infrastructure being reused (no changes)
- HTTP server, OAuth + access token, webhook signature verification
- BindingLoader with per-workspace HulyClient + UserIdentity cache (30 min TTL)
- Sync engine, queue, conflict resolver, breaker, dedup, inflight crash recovery
- AES-256-GCM credentials, ObjectId validation, SSRF allowlist
- helmet + locked-down CORS, sanitized error handler, asyncHandler
- Capability detection (`detectCapabilities` per BindingLoader.load)
- PKCE OAuth, transient/permanent refresh-error classification
- Docker compose stack, CI/release workflows
- `MR_MIXIN` shared constant from Phase 2 (extended with new fields)
- `buildWebhookPayload` helper hardcoding `confidential_*_events: false`
- Phase 2 reviewer carryover labels remain readable until migration
