# Post-Mixin-Split-Migration Cleanup Plan

This document describes what to delete once every production binding has completed the mixin-split migration. Until the pre-conditions below are met, do not perform any of these deletions — the legacy reader and dual-write fallback are still load-bearing.

## 1. Pre-conditions for Cleanup

All of the following must hold before starting:

- **Every binding shows `mixinSplitMigratedAt`** — the Mongo query in §4 must return zero documents.
- **No `gitlab-mr` mixin found in any sampled MR mirror** — spot-check a representative set of Issue documents in the Huly transactor and confirm none carry the legacy `gitlab-mr` mixin key. The split writes fields directly onto the Issue; post-migration the composite mixin object should not appear.
- **Migration endpoint has been generally available for at least 6 months** — see §5.
- **No rollback event in the prior 30 days** — confirms the new field layout is stable under production traffic.

## 2. Cleanup Checklist

Perform each deletion in a single PR. The diff should be mechanical and small.

### 2.1 Remove the legacy reader branch

In `src/sync/mr-mixin.ts`, delete the `readMRMixinAttributes` function (lines 81–94 at time of writing). This function reads the legacy `gitlab-mr` composite mixin off the Issue document and is only called from the pre-migration code path.

```
- function readMRMixinAttributes(doc: Issue): Partial<MRMixinDoc> | null {
-   const mixin = (doc as any)[MR_MIXIN]
-   if (!mixin) return null
-   // ... legacy field extraction ...
- }
```

### 2.2 Remove `MR_MIXIN` constant if no longer referenced

After deleting `readMRMixinAttributes`, check whether any remaining code imports `MR_MIXIN`:

```bash
grep -rn 'MR_MIXIN' src/
```

`src/sync/pipeline.ts` and `src/sync/mr.ts` both use `MR_MIXIN` for write-path `updateMixin` calls. Those are not legacy — do **not** delete `MR_MIXIN` if those references remain. Only remove the constant if every import site has been cleaned up.

### 2.3 Remove the dual-write fallback in `applyRemote`

In `src/sync/mr.ts`, the `applyRemote` method currently conditionally writes fields both to the split location and to the legacy `gitlab-mr` mixin for in-flight bindings that have not yet migrated. Delete the legacy write arm:

```
- // dual-write: keep legacy mixin populated for un-migrated bindings
- if (!binding.mixinSplitMigratedAt) {
-   await ctx.updateMixin(issueRef, MR_MIXIN, { ... legacy fields ... })
- }
```

Keep the primary write path (the split fields) intact.

### 2.4 Remove `mixinSplitMigratedAt` branch guard in `POST /api/v1/bindings/:id/migrate-mixin-split`

The migration endpoint itself can be retired (return 410 Gone) or removed entirely. If removed, also delete the route registration and any handler file.

### 2.5 Update tests

Delete or simplify any unit tests that specifically exercise the legacy reader path or the dual-write branch. Do not delete tests that exercise the primary write path.

## 3. Rollback Strategy

If the cleanup PR causes regressions:

1. **Revert the PR** immediately. Git revert is preferred over a fix-forward when the legacy path is missing — there is no safe forward path without it.
2. **Re-add the legacy reader** (`readMRMixinAttributes`) exactly as it was. The function is idempotent; re-adding it does not corrupt any data.
3. **Re-add the dual-write fallback** in `applyRemote`. Bindings that processed events between the broken deploy and the revert will have written only to the split location; the next `applyRemote` call will fill the legacy mixin again.
4. **Re-migration is idempotent** — `POST /api/v1/bindings/:id/migrate-mixin-split` is safe to call multiple times. After rolling back, operators do not need to re-run migration; the dual-write fallback covers any gap.
5. File a post-mortem to identify what pre-condition was not actually met.

## 4. Operator Verification Queries

Run these against the Mongo instance backing the pod before starting cleanup.

### 4.1 All bindings must be migrated

```javascript
db.bindings.find({ mixinSplitMigratedAt: { $exists: false } }).count()
// Must return 0
```

If this returns > 0, do not proceed. Re-trigger migration for the outstanding bindings:

```bash
curl -X POST "https://huly-gitlab.example.com/api/v1/bindings/${BINDING_ID}/migrate-mixin-split" \
  -H "Authorization: Bearer ${SERVER_SECRET}"
```

### 4.2 Sample MR mirror documents

```javascript
// Pick 10 random MR mirrors and verify no legacy mixin key
db.issues.find({ "gitlab-mr": { $exists: true } }).limit(10)
// Must return empty cursor
```

### 4.3 Migration timestamp distribution

```javascript
db.bindings.aggregate([
  { $group: {
      _id: null,
      earliest: { $min: "$mixinSplitMigratedAt" },
      latest:   { $max: "$mixinSplitMigratedAt" },
      total:    { $sum: 1 },
      migrated: { $sum: { $cond: [{ $ifNull: ["$mixinSplitMigratedAt", false] }, 1, 0] } }
  }}
])
// migrated must equal total
```

## 5. Recommended Timeline

| Milestone | Target |
| --- | --- |
| Migration endpoint becomes generally available (GA) | T+0 |
| 100% of production bindings show `mixinSplitMigratedAt` | T+0 to T+2 weeks (operator-driven) |
| Begin 6-month soak period | Once 100% migrated |
| Cleanup PR opened for review | T+6 months |
| Cleanup PR merged | T+6 months + review cycle |

The 6-month soak exists to:

- Confirm no cold-start binding (re-deployed from backup) is still writing the legacy mixin.
- Confirm no rollback event surfaces a gap in the split fields.
- Give Huly platform upgrades time to settle before removing the compatibility shim.

Do not shorten the soak period without explicit sign-off from the on-call engineer and a second operator verification run on production Mongo.
