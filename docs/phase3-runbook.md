# Phase 3 Migration Runbook

Phase 3 adds review threads, approvals, diff metadata, and a typed `reviewers` field replacing Phase 2's synthetic `gitlab:reviewer:*` labels. Existing Phase 2 bindings need only the reviewer-label migration to clean up legacy synthetic labels.

## Overview

**What's new in Phase 3:**
- Review threads (discussions) as Huly ChatMessages with line-position tracking.
- CE approvals two-way sync: `approvedBy`, `approvalsRequired`, `approvalStatus`.
- Diff metadata: file list and diff URL.
- Typed `reviewers` field (PersonUuids) replacing synthetic labels.

**What requires migration:**
- Phase 2 bindings with synthetic `gitlab:reviewer:<username>` labels on mirrored MRs.
- A one-shot endpoint converts labels to the typed field.

## Pre-flight Checks

- **Webhook subscriptions:** No new subscriptions needed. Phase 3 uses existing `merge_requests_events` (approvals + reviewer updates) and `note_hook` (review thread notes).
- **Binding state:** Identify bindings created in Phase 2 (before Phase 3 deployment) that have mirrored MRs with `gitlab:reviewer:*` labels.

```bash
# List all bindings
curl http://localhost:3600/api/v1/bindings?workspaceUuid=your-workspace-uuid \
  -H "Authorization: Bearer ${SERVER_SECRET}" | jq '.[] | {bindingId, gitlabProjectPath}'
```

## Migration Steps (Per Binding)

### 1. Pause the Binding

Stopping sync writes prevents the migration from racing with incoming webhook events or backfill operations.

```bash
curl -X PATCH http://localhost:3600/api/v1/bindings/binding-id-123 \
  -H "Authorization: Bearer ${SERVER_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{"disabled": true}'
```

**Expected response:**
```json
{
  "bindingId": "binding-id-123",
  "disabled": true,
  "updatedAt": "2026-06-05T10:30:00Z"
}
```

### 2. Run the Migration

Convert Phase 2 synthetic labels to the typed `reviewers` field.

```bash
curl -X POST http://localhost:3600/api/v1/bindings/binding-id-123/migrate-reviewer-labels \
  -H "Authorization: Bearer ${SERVER_SECRET}"
```

**Expected response (success):**
```json
{
  "migratedAt": "2026-06-05T10:35:00Z",
  "mrsScanned": 42,
  "labelsStripped": 87,
  "reviewersResolved": 87,
  "unresolvedCount": 0
}
```

**If binding is still active (409):**
```json
{
  "error": "binding_active",
  "message": "Pause binding (PATCH /api/v1/bindings/:id with {disabled: true}) before running migration; re-enable after.",
  "timestamp": "2026-06-05T10:35:00Z"
}
```

Retry after ensuring the binding is disabled.

### 3. Verify Migration Success

Check that synthetic labels are gone and the typed `reviewers` field is populated.

**Inspect a sample MR-mirror Issue in Huly:**
- Open a mirrored MR Issue.
- Confirm NO labels matching `gitlab:reviewer:*` are present (should be clean).
- Confirm the mixin carries a non-empty `reviewers` array (if the MR had reviewers).

**Inspect via API (if available):**
```bash
# List issues in the Huly project
# (specific endpoint depends on Huly workspace / project setup)
```

**Logs:** Check pod logs for `migration.complete` or `migration.error` metrics:
```bash
kubectl logs pod/huly-gitlab-<pod-id> | grep migration
```

### 4. Re-enable the Binding

Resume sync to pick up new changes from GitLab.

```bash
curl -X PATCH http://localhost:3600/api/v1/bindings/binding-id-123 \
  -H "Authorization: Bearer ${SERVER_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{"disabled": false}'
```

**Expected response:**
```json
{
  "bindingId": "binding-id-123",
  "disabled": false,
  "updatedAt": "2026-06-05T10:40:00Z"
}
```

## Handling Migration Conflicts

### Unresolved Reviewers (`unresolvedCount > 0`)

If the response shows `unresolvedCount > 0`, some GitLab users could not be resolved to Huly persons (e.g., they have no OAuth identity mapped and no matching email).

**Behavior:** Those labels are still stripped, but the reviewer is not added to the typed `reviewers` field.

**Manual remediation:** 
1. Note the `unresolvedCount` from the response.
2. Manually inspect the MR on GitLab to identify which reviewers were affected.
3. Manually add them to the Huly Issue if desired (e.g., as labels, assignees, or comments).
4. No re-run of migration is needed; unresolved labels are already gone.

### Partial Migration (Binding Failed During Migration)

Migration is **idempotent**. If the pod crashes mid-migration:
1. Check pod logs for where it stopped.
2. Re-run the migration from step 2 above.
3. The second run will pick up any MRs missed by the first attempt and strip any remaining labels.

## Verification Checklist

- [ ] Binding is in `disabled: false` state after re-enable.
- [ ] No `gitlab:reviewer:*` labels appear on mirrored MR Issues.
- [ ] Mirrored MR mixin contains `reviewers: [...]` (non-empty for MRs that had reviewers).
- [ ] New MR updates from GitLab carry approval state in `approvedBy` and `approvalsRequired`.
- [ ] Review thread notes (discussions) appear as ChatMessages in the Huly Issue.

## Known Limitations (Phase 3)

### No Huly-to-GitLab Writeback (Path B Wiring Missing)

`applyLocal` code paths exist for issues, MRs, notes, and review threads, but **no production `TxProcessor`/`TxMixin` subscription** is wired in `src/index.ts` that would feed real Huly mutations into `engine.enqueueLocalEvent`. These paths are reachable today only from unit tests.

**Impact:** Huly UI actions — approving/unapproving an MR, resolving a discussion, editing a comment body — do NOT propagate to GitLab in Phase 3. The GitLab adapter side is effectively **read-only from Huly's perspective** until Phase 4 wires the missing TxMixin subscription.

**Workaround:** Perform write actions (approvals, discussion resolution, comment edits) directly on GitLab; they will sync back to Huly via webhooks/backfill.

### Approval Actions from Huly UI

API surface exists for approval actions (`approvedBy` / `approvalsRequired` sync), but **no Huly UI exists for users to self-link per-user OAuth credentials in Phase 3**.

**Result:** All Phase 3 approval actions from Huly fall back to the binding's service account with a visibility comment: _"Approved via service account; per-user OAuth UI coming in Phase 4"_.

**Workaround:** Approve/unapprove directly on GitLab if per-user attribution is required.

### Unresolved Reviewer Identities

If a GitLab reviewer has no Huly identity (no OAuth, no matching email), the migration cannot map them to a PersonUuid.

**Result:** The label is stripped but the reviewer is not added to the typed `reviewers` field.

**Workaround:** Manually add them back to the Huly Issue or re-sync the MR from GitLab if their Huly identity is created later.

## Rollback

If Phase 3 needs to be rolled back to Phase 2:

1. The typed `reviewers` field is additive on the `gitlab-mr` mixin — Phase 2 code will ignore it (safe).
2. Synthetic labels removed by migration are **gone** (would need re-population by a full MR re-sync from GitLab).
3. **Recommendation:** Keep Phase 2 binary deployable as a safety net. Consider reverting the migration by re-syncing all MRs if a full rollback is needed.

## Operator Workflow Summary

```bash
#!/bin/bash
BINDING_ID="binding-id-123"
SERVER_SECRET="your-secret"
BASE_URL="http://localhost:3600"

# 1. Pause
echo "Pausing binding..."
curl -X PATCH "${BASE_URL}/api/v1/bindings/${BINDING_ID}" \
  -H "Authorization: Bearer ${SERVER_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{"disabled": true}' | jq .

# 2. Migrate
echo "Running migration..."
curl -X POST "${BASE_URL}/api/v1/bindings/${BINDING_ID}/migrate-reviewer-labels" \
  -H "Authorization: Bearer ${SERVER_SECRET}" | jq .

# 3. Resume
echo "Re-enabling binding..."
curl -X PATCH "${BASE_URL}/api/v1/bindings/${BINDING_ID}" \
  -H "Authorization: Bearer ${SERVER_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{"disabled": false}' | jq .

echo "Migration complete!"
```
