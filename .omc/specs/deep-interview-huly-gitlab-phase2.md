# Deep Interview Spec: Huly GitLab Integration — Phase 2

**Date:** 2026-06-05
**Status:** Approved through brainstorming with user
**Scope:** Phase 2 of 4-phase integration plan (Phase 1 shipped 306 tests passing, all reviewers approved)
**Prerequisite:** Phase 1 spec at `.omc/specs/deep-interview-huly-gitlab-phase1.md`
**Ambiguity gate:** ≤ 20% (decisions captured below are explicit)

## Problem

Phase 1 delivered two-way Issues sync. Phase 2 extends the integration to GitLab Merge Requests — the second pillar of the GitLab workflow. Users running Huly as a unified work-item view need their MRs visible alongside Issues with the same Phase 1 properties: two-way sync, LWW conflicts, webhook + polling, OAuth + access token credentials.

## Scope (Phase 2)

Add Merge Requests as a synced work item type, reusing all Phase 1 infrastructure (sync engine, adapter, state store, HulyClient, markdown, OAuth, webhook router, BindingLoader). New surface:

- `MergeRequestsSyncManager` registered alongside the existing two managers
- `SyncMergeRequest` canonical type in adapter
- GitLab adapter REST methods: `listMergeRequests`, `getMergeRequest`, `createMergeRequest`, `updateMergeRequest`
- Webhook handler dispatches `Merge Request Hook` events
- NotesSyncManager extended to handle MR-parent notes (`noteable_type === 'MergeRequest'`)
- Pipeline summary status sync (single field on the MR mixin)
- Webhook auto-registration extended to subscribe to `merge_requests_events`

### In scope (Phase 2)
- **MR data model**: runtime mixin `gitlab-mr` applied to `tracker.class.Issue` carrying `sourceBranch`, `targetBranch`, `draft`, `mergedAt`, `mergeStatus` (`can_be_merged|cannot_be_merged|unchecked`), `pipelineStatus` (`pending|running|success|failed|canceled|null`)
- **Two-way MR sync**: title, description, state (opened/closed/merged/locked → Huly status), labels, milestone, assignees, sourceBranch, targetBranch, draft flag — all per-field LWW
- **State mapping**:
  - GitLab `opened` (non-draft) → first Active status
  - GitLab `opened` (draft) → first Active status + `draft=true` mixin field + priority `Low` autoset
  - GitLab `closed` → first Cancelled status
  - GitLab `merged` → first Done status + `mergedAt` timestamp recorded
  - GitLab `locked` → keep current status, add `mergeStatus=locked` mixin field (no separate Huly state)
- **MR notes sync**: NotesSyncManager extended; same LWW, system-note skip, deferred-retry-on-missing-parent semantics
- **Pipeline status**: subscribed via `pipeline_events` webhook + pulled on `getMergeRequest`; written to mixin `pipelineStatus` field. Huly-side edits to this field are ignored (read-only from Huly's perspective — GitLab is source of truth for CI state)
- **Webhook auto-registration**: BindingLifecycleService updated to subscribe to `merge_requests_events`, `pipeline_events` in addition to existing `issues_events`, `note_events`. Confidential MR events filtered (Q5 Phase 1 carryover)
- **idmap extension**: add kinds `merge_request`, `pipeline` to the existing kind enum

### Explicitly out of scope (deferred to Phase 3 / Phase 4)
- Review threads, line comments, position diffs → Phase 3
- Approvals (EE + CE approval rules) → Phase 3
- Approvers/reviewers as a typed list → Phase 3 (Phase 2 maps as comma-separated assignees via UserIdentity)
- Diff content / file changes → Phase 3
- Merge conflict resolution UX → Phase 3
- Pipeline detail (jobs, stages, logs) — Phase 2 only does summary status
- Confidential MRs (analogous to confidential issues) → carry Phase 1 Q5 default = skip; defense in depth at adapter + webhook layers
- Branch operations (creating branches from Huly) — out of scope entirely
- MR creation from Huly with draft markup parsing — Phase 2 supports updateMergeRequest from Huly only; createMergeRequest exists in the adapter but is not surfaced through `applyLocal` until Phase 3 establishes user intent

## Key Decisions (from brainstorming)

| # | Decision | Choice |
|---|---|---|
| 1 | MR model | Runtime mixin `gitlab-mr` on `tracker.class.Issue` carrying MR-specific fields |
| 2 | Draft handling | Sync as Issue with priority Low + `draft=true` mixin field |
| 3 | Pipeline status | Sync 5-state summary (`pending|running|success|failed|canceled`) on mixin |
| 4 | MR notes | Extend `NotesSyncManager` to recognize MR-parent notes via `noteable_type` |
| 5 | Confidential MRs | Skip entirely (Phase 1 Q5 carryover) |
| 6 | Approvals / reviews | Deferred to Phase 3 |
| 7 | Diff/changes | Deferred to Phase 3 |
| 8 | Local-side MR create | Out of scope for Phase 2 `applyLocal` (defer to Phase 3) |

## Architecture (deltas from Phase 1)

### New / extended modules

```
src/
├── adapter/
│   ├── types.ts                   # +SyncMergeRequest, +SyncPipeline, +MergeStatus enum
│   ├── gitlab-client.ts           # +listMergeRequests, +getMergeRequest,
│   │                              #  +createMergeRequest, +updateMergeRequest,
│   │                              #  +listMRNotes (reuses listNotes shape)
│   └── webhooks.ts                # +eventFlags: merge_requests_events, pipeline_events
├── sync/
│   ├── types.ts                   # +'merge_request', +'pipeline' kinds
│   ├── mr.ts                      # NEW: MergeRequestsSyncManager
│   ├── mr-status-map.ts           # NEW: opened/closed/merged/locked ↔ Huly status
│   ├── notes.ts                   # +MR-parent recognition via noteable_type
│   ├── binding-loader.ts          # +mrCache (analogous to labelCache/milestoneCache)
│   └── binding-lifecycle.ts       # +eventFlags update for webhook auto-registration
├── state/
│   └── idmap.ts                   # +'merge_request', +'pipeline' kinds
├── http/
│   └── webhook.ts                 # +dispatch 'Merge Request Hook',
│                                  #  +dispatch 'Pipeline Hook',
│                                  #  +confidential filter for MR events
└── huly/
    └── vendor.d.ts                # +Issue.mixin('gitlab-mr') type marker
```

### Existing modules unchanged
- `src/sync/engine.ts` (Phase 1 architecture validated; manager.resourceKey + kind threading already provider-agnostic)
- `src/sync/conflict.ts` (LWW resolver applies to MR fields identically)
- `src/auth/*`, `src/state/credentials.ts`, `src/state/store.ts` core (collections extended; schema otherwise unchanged)
- `src/markdown/*` (MR description uses same GFM ↔ Huly round-trip)
- `src/sync/binding-lifecycle.ts` only gains a few event-flag additions

### Adapter additions
```ts
// src/adapter/types.ts (additions)
export interface SyncMergeRequest {
  iid: number
  projectId: number
  title: string
  description: string
  state: 'opened' | 'closed' | 'merged' | 'locked'
  draft: boolean
  sourceBranch: string
  targetBranch: string
  mergeStatus: 'can_be_merged' | 'cannot_be_merged' | 'unchecked'
  mergedAt: Date | null
  pipelineStatus: SyncPipelineStatus | null
  labels: string[]
  milestone: { iid: number, title: string } | null
  assignees: SyncUser[]
  author: SyncUser
  createdAt: Date
  updatedAt: Date
  webUrl: string
  confidential: boolean    // always filtered out at adapter layer (Q5)
}

export type SyncPipelineStatus = 'pending' | 'running' | 'success' | 'failed' | 'canceled'
```

### Webhook dispatch (http/webhook.ts)
- `'Merge Request Hook'` → kind `'merge_request'`, payload's `object_attributes.confidential` skip per Q5
- `'Pipeline Hook'` → kind `'pipeline'`, only processed if the pipeline is tied to a known MR via `merge_request.iid` in payload; otherwise dropped (we don't track standalone pipelines)
- `'Note Hook'` extends: when `object_attributes.noteable_type === 'MergeRequest'`, route to MR-aware path inside NotesSyncManager

### Sync manager
`MergeRequestsSyncManager implements SyncManager<SyncMergeRequest>`:
- `kind = 'merge_request'`
- `resourceKey(record) = 'mr:${record.object_attributes.iid}'`
- `applyRemote(ctx, binding, syncMR)` — analogous to IssuesSyncManager but writes via `gitlab-mr` mixin
- `applyLocal(ctx, binding, hulyDoc, change)` — calls `updateMergeRequest` only; does NOT call `createMergeRequest` in Phase 2
- `backfill(ctx, binding, since)` — `listMergeRequests(projectId, {updatedAfter: since})` pagination

`PipelineSyncManager` (lightweight):
- `kind = 'pipeline'`
- Receives Pipeline Hook events
- Maps `pipeline.status` → `SyncPipelineStatus`
- Resolves parent MR via webhook payload's `merge_request.iid`; writes to mixin field on the Huly Issue
- No `applyLocal` (read-only)

### MR notes handling
Inside existing `NotesSyncManager.applyRemote`:
- Parse `noteable_type` from incoming `SyncNote`
- If `'Issue'` → existing path (resolve via `resolveIssueRef`)
- If `'MergeRequest'` → resolve via new `resolveMRRef(binding, mrIid)` helper in `mr.ts`
- Both routes converge on the same ChatMessage attachment to the resolved Huly Issue (since MRs are mixin'd Issues)

### State store
- `idmap` kinds enum extended: `'issue' | 'note' | 'user' | 'label' | 'milestone' | 'project' | 'merge_request' | 'pipeline'`
- `cursors` kinds extended: `'issues' | 'notes' | 'merge_requests' | 'pipelines'`
- No new collections

## Error Handling
- Per-binding circuit breaker continues to gate MR sync (no new breaker needed; the engine's existing infrastructure covers MR events).
- Pipeline events for unknown MRs: 200 OK, no apply, count via existing `confidentialSkippedCount` analog (`unboundPipelineCount`).
- MR merge events arriving before MR creation events: deferred retry via existing parent-deferral pattern (analogous to notes' deferred retry).

## Testing Strategy
- Unit: `MergeRequestsSyncManager` against fake adapter + fake HulyClient + fake UserIdentity (≥ 12 cases)
- Unit: `PipelineSyncManager` (≥ 6 cases)
- Adapter: nock-backed REST round-trip for `listMergeRequests`, `getMergeRequest`, `updateMergeRequest` (≥ 8 cases including draft handling, merge status, pipeline summary)
- Integration: NotesSyncManager MR-note path with fake idmap
- Webhook router: Merge Request Hook + Pipeline Hook dispatch (≥ 5 cases including confidential skip)
- Binding-lifecycle: webhook auto-reg includes new event flags
- E2E harness: extend Phase 1 harness with one MR round-trip case (real-stack gated)

## Success Criteria (Phase 2 acceptance)
1. All Phase 1 tests continue to pass (regression)
2. ≥ 25 new tests added (target: 30+)
3. `npm run build`, `npm run lint`, `npm test` exit 0
4. `npm audit --omit=dev --audit-level=high` shows 0 high
5. MR created in GitLab appears in Huly within 30s (webhook) — verifiable via integration test with fake stack
6. MR title/description/state edits round-trip both directions via LWW
7. MR notes round-trip; system notes skipped
8. Pipeline status updates write to Huly mixin field on each pipeline event
9. Draft MRs auto-tagged with priority Low + draft=true mixin field
10. Confidential MRs filtered at adapter AND webhook (defense in depth)
11. Webhook auto-registration subscribes to `merge_requests_events` and `pipeline_events`

## Open Questions (defaults assumed; flag during implementation if any need user override)

- **Pipeline events without an attached MR**: payload's `merge_request` field is null for branch/tag pipelines. Default: silently drop with metric.
- **MR merge-conflict (cannot_be_merged) display**: stored as `mergeStatus` mixin field; UI representation deferred to Phase 3.
- **Approvers vs assignees collision**: Phase 2 treats GitLab `reviewers` as a comma-separated label list (`gitlab:reviewer:<username>`) until Phase 3 introduces typed reviewer field. Document as Phase 2 limitation.
- **Removing the mixin when state transitions**: if a Huly user manually changes the issue type to "not an MR", do we strip the mixin? Default: no — mixin persists; only GitLab → Huly applies remove. Local edits to mixin fields are limited to title/description/labels/milestone/assignees (the same as Phase 1 Issue fields).

## Phasing (future cycles)

- ✅ Phase 1: Issues + foundation (shipped, 306 tests, all reviewers approved)
- → Phase 2 (this spec): Merge Requests + MR notes + pipeline summary
- Phase 3: Review threads, line comments, approvals, diff metadata
- Phase 4: Custom field mapping, iterations, epics (EE), multi-instance

## Phase 1 infrastructure being reused (no changes)

- HTTP server, OAuth + access token, webhook signature verification (`crypto.timingSafeEqual`)
- BindingLoader pattern with per-workspace HulyClient + UserIdentity cache (30 min TTL)
- Sync engine, queue, conflict resolver, breaker, dedup, inflight crash recovery
- AES-256-GCM credentials, ObjectId validation, SSRF allowlist
- helmet + locked-down CORS, sanitized error handler, asyncHandler
- Capability detection (`detectCapabilities` per BindingLoader.load)
- PKCE OAuth, transient/permanent refresh-error classification
- Docker compose stack (full Huly + GitLab CE)
- CI/release workflows
- 27 test suites, 306 tests
