# P3-T-01b — Mixin Change Payload Shape

## Investigation date
2026-06-06

## Verified facts

### Tx hierarchy

The `vendor.d.ts` at `src/huly/vendor.d.ts` declares the only Huly API surface used by this
codebase. The relevant interfaces are:

- `TxOperations.updateMixin<D, M>(objectId, objectClass, objectSpace, mixin, attributes: MixinUpdate<D,M>)` — writes a mixin update to the Huly platform.
- `MixinUpdate<D, M>` = `Partial<Omit<M, keyof D>>` — only the mixin-exclusive fields, partial.

The codebase does NOT declare or import `TxMixin`, `TxCUD`, `TxCreateDoc`, `TxUpdateDoc`, or
`TxRemoveDoc`. The `node_modules/@hcengineering/core/lib/operations.d.ts` was NOT accessible for
direct reading (filesystem permissions), but the absence of any TxMixin consumption anywhere in
`src/` is itself determinative.

### change payload shape for runtime mixin updates

**Critical finding: `enqueueLocalEvent` is never called from production code.**

The `SyncEngine.enqueueLocalEvent` method (`src/sync/engine.ts:86`) exists and is called only from
two places:

1. `engine.test.ts` — a unit test verifying dispatch works.
2. The engine's own inflight-resume path (`engine.ts:156`) — reconstructs a local event from a
   previously-persisted inflight MongoDB document.

There is NO Huly tx subscription / watcher wired anywhere in production code (`src/index.ts`,
`src/http/`, `src/huly/client.ts`). The types comment at `src/sync/types.ts:42` says "produced by
the Huly client watcher" but this watcher does not exist in the current codebase.

The `change: Record<string, unknown>` parameter in `applyLocal` is defined as:

```
change: Record<string, unknown>
```

All Phase 2 consumers read it as a **flat key-value map** — direct property access with no nesting:

```ts
// src/sync/mr.ts lines 409-416
const title = change.title as string | undefined
const descriptionMarkup = change.description as string | undefined
const statusRef = change.status as Ref<Status> | undefined
const labels = change.labels as Array<...> | undefined
const milestone = change.milestone as ... | undefined
const assigneeIds = change.assigneeIds as number[] | undefined
const targetBranch = change.targetBranch as string | undefined

// src/sync/notes.ts line 414
const hulyAttachedTo = change.hulyMessage !== undefined ... ? change.hulyMessage.attachedTo : undefined
```

None of these are mixin fields — they are base `Issue` doc fields (`title`, `description`,
`status`, `labels`, `milestone`, `assignee`). There is **zero Phase 2 precedent** for reading a
mixin-specific field from `change` because no Phase 2 path actually triggers `applyLocal` via a
real mixin update.

### How Phase 3 should consume mixin changes

- Reading `approvedBy`: The `change` flat-map convention means the field would be accessed as
  `change.approvedBy` (direct key, no mixin-prefix nesting).
- Reading `reviewers`: same pattern — `change.reviewers`.
- LWW timestamp source: `change.modifiedOn` (the Huly `Doc.modifiedOn: number` field) if the
  watcher emits it; otherwise read `modifiedOn` from the existing mixin doc via `findOne` + the
  mixin's own `modifiedOn`.

**However, the fundamental issue is that no watcher is wired.** Whatever key shape is assumed,
`applyLocal` will never receive mixin-field updates unless either:

(A) A Huly tx subscription is implemented that transforms `TxMixin` payloads into
    `enqueueLocalEvent(binding, 'mr', docRef, { approvedBy: tx.attributes.approvedBy, ... })`.
(B) The approval action in `applyLocal` is NOT triggered by a Huly-side change but instead by
    a direct HTTP call (e.g., the admin route or a dedicated Huly-push webhook endpoint).
(C) The engine polls Huly Doc state after each remote tx instead of using change-streaming.

## Path forward for P3-T-07

**Path B is the correct choice for Phase 3.**

The Phase 3 plan (§P3-T-07, line 437) says applyLocal handles "Huly add → approveMR, Huly remove
→ unapproveMR". Given that no Huly watcher fires `enqueueLocalEvent`, the local-event path is
currently only reachable via:

1. The engine test (direct call to `engine.enqueueLocalEvent`).
2. The inflight-resume path on server restart.

For Phase 3 tests of `applyLocal` approval actions, the test harness will call `manager.applyLocal`
directly (same pattern as Phase 2 `mr.test.ts` lines 469/484). The test constructs `change`
directly as a flat map:

```ts
await manager.applyLocal(ctx, binding, `mr:${ref}`, {
  approvedBy: [personUuid1]   // flat key, no mixin prefix
})
```

This matches the Phase 2 convention: `{ title: 'Local title' }`, `{ description: markup }`.

**The shape is: `change.approvedBy` — direct flat key, `PersonUuid[]` value.**

For production wiring, P3-T-10 (or a companion sub-task) must implement the Huly tx subscription
that transforms `TxMixin` events into `enqueueLocalEvent` calls. This is a **Phase 3 gap** not
covered by the current plan tasks P3-T-01 through P3-T-12b. The plan's P3-T-07 test suite can be
fully implemented against the flat-key convention and the tests will pass via direct `applyLocal`
calls; the production wiring gap is a separate concern that P3-T-10 or a new P3-T-13 must close.

## Path-A vs Path-B decision

**Path B** (direct HTTP / direct `applyLocal` call, flat key shape). Path A (consume mixin change
from a watcher) requires implementing a Huly tx subscription that does not exist — that is
engineering work beyond the P3-T-01b investigation scope. Path C (polling) is unnecessary given
the flat-key direct-call pattern already established in Phase 2 tests.

For P3-T-07 implementation:

- Access `approvedBy` via `change.approvedBy as PersonUuid[] | undefined`.
- Access `reviewers` via `change.reviewers as PersonUuid[] | undefined`.
- LWW timestamp: use `hulyMessage.modifiedOn` (read from the fetched mixin doc via `findOne`)
  rather than `change.modifiedOn` — the watcher is not implemented, so the change object is
  constructed by test code or a future HTTP handler and may not carry timestamps.

## Production wiring gap (action required before Phase 3 ships)

The Huly-to-GitLab approval sync path requires a Huly tx subscription to be wired. The subscription
must:

1. Subscribe to `TxMixin` events on the Huly workspace targeting the `MR_MIXIN` class.
2. For each `TxMixin` event where `attributes.approvedBy` or `attributes.reviewers` differs from
   the current mixin state, call `syncEngine.enqueueLocalEvent(binding, 'mr', docRef, flatChange)`.
3. `flatChange` shape: `{ approvedBy: PersonUuid[], reviewers: PersonUuid[] }` — direct keys only,
   not nested under mixin name.

This wiring is currently absent and must be tracked as a gap item for P3-T-10 or a new P3-T-13.
Without it, Huly-side approval changes will never propagate to GitLab in production (though all
unit tests will pass because they call `applyLocal` directly).
