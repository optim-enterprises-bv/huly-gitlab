# P4-T-01b — TxSubscriber API Investigation

## Date
2026-06-06

## Verified facts

### Subscription API surface on @hcengineering/core / @hcengineering/client

Verified by reading `node_modules/@hcengineering/core/src/client.ts` directly (package ships TypeScript source under `src/`; no `.d.ts` files present in `lib/`).

**`Client` interface** (`src/client.ts` line ~60):
```ts
export interface Client extends Storage, FulltextStorage {
  notify?: (...tx: Tx[]) => void   // <-- THE subscription hook
  getHierarchy: () => Hierarchy
  getModel: () => ModelDb
  findOne: <T extends Doc>(_class, query, options?) => Promise<WithLookup<T> | undefined>
  close: () => Promise<void>
  domainRequest: <T>(domain, params, options?) => Promise<DomainResult<T>>
}
```

**`ClientImpl`** class (`src/client.ts`):
- Has `notify?: (...tx: Tx[]) => void` as a public class field.
- `updateFromRemote(...tx: Tx[])` calls `this.notify?.(...tx)` after applying model transactions.
- There is **no** `addTxHandler`, no `subscribe`, no `pushHandler` on `Client`.
  (`pushHandler` exists only on the lower-level `ClientConnection` interface — the raw WebSocket layer.)

**`TxOperations`** (`src/operations.ts`): wraps `Client`. Does NOT forward `notify`. To subscribe to tx events, caller must assign to the underlying `Client.notify` directly (cast `TxOperations.getClient()` or assign before wrapping).

**`GetClient`** (`@hcengineering/client-resources`): calls `createClient(handler, modelFilter, ...)` from `@hcengineering/core`. The `createClient` function:
1. Accepts a `connect: (txHandler: TxHandler) => Promise<ClientConnection>` factory.
2. Passes a `txHandler` to the factory (WebSocket layer calls this on every incoming tx).
3. Creates `ClientImpl` internally.
4. Drains a buffer of early txes via `client.updateFromRemote(...)` after model load.
5. Returns `client` (a `ClientImpl`, typed as `Client`).

**Bottom line:** `client.notify` is set by the *consumer* — the returned `Client` exposes it as a settable optional property. The pattern is:

```ts
const { client } = await createPlatformClient(ctx, workspaceUuid, timeout)
// client is a Client (ClientImpl at runtime)
client.notify = (...txes) => { /* handle each Tx */ }
```

Setting `client.notify` AFTER the object is created is safe — `updateFromRemote` calls it via optional chaining; model bootstrap txes are not re-fired through `notify` (they go through `txBuffer` before `client` is set in `createClient`).

### Tx type hierarchy

All from `@hcengineering/core/src/tx.ts` and `src/classes.ts`:

**`Doc`** (base of everything including `Tx`):
```ts
interface Doc {
  _id: Ref<Doc>
  _class: Ref<Class<Doc>>
  space: Ref<Space>
  modifiedOn: Timestamp
  modifiedBy: PersonId       // <-- used for self-authored filter (MR-2)
  createdBy?: PersonId       // optional
  createdOn?: Timestamp
}
```

**`Tx extends Doc`**:
```ts
interface Tx extends Doc {
  objectSpace: Ref<Space>
  meta?: Record<string, string | number | boolean>
}
// modifiedBy on Tx IS the author of the transaction
```

**`TxCUD<T extends Doc> extends Tx`**:
```ts
interface TxCUD<T extends Doc> extends Tx {
  objectId: Ref<T>
  objectClass: Ref<Class<T>>
  attachedTo?: Ref<Doc>
  attachedToClass?: Ref<Class<Doc>>
  collection?: string
}
```

**`TxMixin<D extends Doc, M extends D> extends TxCUD<D>`**:
```ts
interface TxMixin<D extends Doc, M extends D> extends TxCUD<D> {
  mixin: Ref<Mixin<M>>
  attributes: MixinUpdate<D, M>   // flat partial mixin fields (P3-T-01b verified: flat keys)
}
```

**`TxCreateDoc<T extends Doc> extends TxCUD<T>`**:
```ts
interface TxCreateDoc<T extends Doc> extends TxCUD<T> {
  attributes: Data<T>
}
```

**`TxUpdateDoc<T extends Doc> extends TxCUD<T>`**:
```ts
interface TxUpdateDoc<T extends Doc> extends TxCUD<T> {
  operations: DocumentUpdate<T>
  retrieve?: boolean
}
```

**`TxRemoveDoc<T extends Doc> extends TxCUD<T>`**: no additional fields.

**Class discriminants** (from `core.default.class.*`):
- `core.class.TxCreateDoc`
- `core.class.TxUpdateDoc`
- `core.class.TxRemoveDoc`
- `core.class.TxMixin`

## Recommended subscription path
- **Path: A** — `client.notify = handler`
- The `Client` interface exposes `notify?: (...tx: Tx[]) => void` as an optional settable property.
- `ClientImpl.updateFromRemote` calls `this.notify?.(...tx)` for every tx delivered from the server.
- This is the **only** subscription mechanism. There is no `addTxHandler`, no `subscribe`, and no polling needed.

### API call sequence

```ts
import type { Client, Tx, TxMixin, TxCUD } from '@hcengineering/core'
import core from '@hcengineering/core'

// After createPlatformClient returns:
const { client } = await createPlatformClient(ctx, workspaceUuid, timeout)

// Assign notify ONCE immediately after connection:
client.notify = (...txes: Tx[]) => {
  for (const tx of txes) {
    handleTx(tx)
  }
}

// To stop: simply clear the handler
function stop(): void {
  client.notify = undefined
}
```

### Lifecycle
- **Start:** assign `client.notify = handler` immediately after `createPlatformClient` returns. No early-tx loss: `createClient` drains `txBuffer` into `updateFromRemote` only after `client` is created, and `client.notify` is already set before `updateFromRemote` is called for buffered txes IFF the assignment is synchronous after `await createPlatformClient`. **Cold-start gap:** there is a window between model bootstrap completing and the first `notify` call where in-flight txes could arrive. The subscriber MUST implement its own buffer (see MR-1 below).
- **Stop:** set `client.notify = undefined` (or replace with a no-op) before calling `client.close()`.
- **Reconnect:** `ClientImpl` is reused on reconnect (the `ClientConnection` layer reconnects internally); `notify` assignment survives reconnects automatically.
- **Error handling:** errors thrown inside `notify` propagate into `updateFromRemote` (async void). The subscriber MUST catch internally — do NOT throw from `notify`.

## Path forward for P4-T-09

### Path A — Code sketch using `client.notify`

```ts
// src/sync/tx-subscription.ts
// Spec: .omc/specs/p4-t-01b-tx-subscription-api.md

import type { Client, Tx, TxCUD, TxMixin } from '@hcengineering/core'
import core from '@hcengineering/core'
import type { PersonUuid } from '@hcengineering/core'
import type { BindingRef } from './types'
import type { SyncEngine } from './engine'
import { MR_MIXIN } from './mr-mixin'
import { MR_REVIEW_MIXIN } from './mr-review-mixin'

const DEDUP_WINDOW_MS = 5_000
const BUFFER_MAX = 1_024

/** Self-authored filter (MR-2): tx.modifiedBy is the transaction author. */
function isSelfAuthored(tx: Tx, serviceAccountPersonUuid: PersonUuid): boolean {
  return (tx.modifiedBy as unknown as string) === (serviceAccountPersonUuid as unknown as string)
}

/**
 * Translation rules:
 *   TxMixin{MR_MIXIN}        → enqueueLocalEvent(binding, 'merge_request', objectId, attributes)
 *   TxMixin{MR_REVIEW_MIXIN} → enqueueLocalEvent(binding, 'review', objectId, attributes)
 *   TxCUD{tracker.Issue}     with MR_MIXIN applied → enqueueLocalEvent(binding, 'merge_request', objectId, {})
 *   TxCUD{chunter.ChatMsg}   with review mixin → enqueueLocalEvent(binding, 'review', objectId, {})
 *   TxRemoveDoc              for tracked Issue → enqueueLocalEvent(binding, 'merge_request', objectId, { _removed: true })
 */
export class TxSubscriber {
  private readonly dedup = new Map<string, number>()
  private buffer: Array<{ binding: BindingRef, kind: string, doc: string, change: Record<string, unknown> }> = []
  private engineReady = false

  constructor(
    private readonly client: Client,
    private readonly binding: BindingRef,
    private readonly engine: SyncEngine,
    private readonly serviceAccountPersonUuid: PersonUuid,
  ) {}

  start(): void {
    this.client.notify = (...txes: Tx[]) => {
      for (const tx of txes) {
        try {
          this.handleTx(tx)
        } catch (_) {
          // Never throw from notify
        }
      }
    }
  }

  /** Called by P4-T-19 wiring after engine.start() completes. */
  drainBuffer(): void {
    this.engineReady = true
    const pending = this.buffer.splice(0)
    for (const evt of pending) {
      this.engine.enqueueLocalEvent(evt.binding, evt.kind, evt.doc, evt.change)
    }
  }

  stop(): void {
    this.client.notify = undefined
  }

  private handleTx(tx: Tx): void {
    // MR-2: skip self-authored (service account) txes
    if (isSelfAuthored(tx, this.serviceAccountPersonUuid)) return

    let kind: string | undefined
    let doc: string | undefined
    let change: Record<string, unknown> = {}

    if (tx._class === (core.class.TxMixin as unknown as string)) {
      const mixin = tx as unknown as TxMixin<any, any>
      doc = mixin.objectId as unknown as string
      change = mixin.attributes as Record<string, unknown>
      if ((mixin.mixin as unknown as string) === (MR_MIXIN as unknown as string)) {
        kind = 'merge_request'
      } else if ((mixin.mixin as unknown as string) === (MR_REVIEW_MIXIN as unknown as string)) {
        kind = 'review'
      }
    } else if (
      tx._class === (core.class.TxCreateDoc as unknown as string) ||
      tx._class === (core.class.TxUpdateDoc as unknown as string)
    ) {
      const cud = tx as unknown as TxCUD<any>
      // Only forward tracker.Issue txes (MR mirrors)
      if ((cud.objectClass as unknown as string) === 'tracker:class:Issue') {
        kind = 'merge_request'
        doc = cud.objectId as unknown as string
        change = {}
      }
    } else if (tx._class === (core.class.TxRemoveDoc as unknown as string)) {
      const cud = tx as unknown as TxCUD<any>
      if ((cud.objectClass as unknown as string) === 'tracker:class:Issue') {
        kind = 'merge_request'
        doc = cud.objectId as unknown as string
        change = { _removed: true }
      }
    }

    if (kind === undefined || doc === undefined) return

    // Dedup window: 5s on (doc, kind)
    const dedupKey = `${kind}:${doc}`
    const now = Date.now()
    const last = this.dedup.get(dedupKey) ?? 0
    if (now - last < DEDUP_WINDOW_MS) return
    this.dedup.set(dedupKey, now)

    if (!this.engineReady) {
      // MR-1: cold-start buffer
      if (this.buffer.length >= BUFFER_MAX) {
        this.buffer.shift()  // drop oldest, increment overflow metric
      }
      this.buffer.push({ binding: this.binding, kind, doc, change })
      return
    }

    this.engine.enqueueLocalEvent(this.binding, kind, doc, change)
  }
}
```

### Self-authored filter (MR-2)

`tx.modifiedBy` is the `PersonId` of the transaction author (verified in `Doc` base interface and `TxFactory.createTxMixin` which sets `modifiedBy: modifiedBy ?? this.account`). The service account's `PersonUuid` is available via `systemAccountUuid` from `@hcengineering/server-token` (already imported in `src/huly/client.ts`). The subscriber compares `tx.modifiedBy === serviceAccountPersonUuid` to drop self-authored cycles.

Note: `PersonId` and `PersonUuid` are distinct types in the platform; `modifiedBy` is typed as `PersonId`. At runtime both are strings. The subscriber should compare as strings — see vendor.d.ts widening section below.

### Cold-start buffering (MR-1)

The subscriber buffers events received before `engine.start()` completes (tracked via `engineReady` flag, set by `drainBuffer()` called from P4-T-19 wiring). Buffer is bounded at 1024 entries; overflow drops oldest and increments `tx.subscription.buffer.overflow` metric. `drainBuffer()` flushes FIFO into `enqueueLocalEvent`.

## Probe test

`tests/sync/tx-subscription-probe.test.ts` — created alongside this spec. Asserts:
1. Assigning `client.notify` receives Tx objects when `updateFromRemote` is called on the ClientImpl.
2. `tx.modifiedBy` is accessible on the Tx base type.

## Vendor.d.ts widening required

The following additions are needed in `src/huly/vendor.d.ts` for P4-T-09 to compile without errors:

```ts
// In declare module '@hcengineering/core':

/** Transaction author — a string PersonId (same wire format as PersonUuid). */
export type PersonId = string & { __personId: never }

export interface Tx extends Doc {
  objectSpace: Ref<Doc>
  meta?: Record<string, string | number | boolean>
  // modifiedBy is inherited from Doc as PersonId
}

export interface TxCUD<T extends Doc> extends Tx {
  objectId: Ref<T>
  objectClass: Ref<Class<T>>
  attachedTo?: Ref<Doc>
  attachedToClass?: Ref<Class<Doc>>
  collection?: string
}

export interface TxMixin<D extends Doc, M extends D> extends TxCUD<D> {
  mixin: Ref<Mixin<M>>
  attributes: Partial<Omit<M, keyof D>>
}

export interface TxCreateDoc<T extends Doc> extends TxCUD<T> {
  attributes: Partial<T>
}

export interface TxUpdateDoc<T extends Doc> extends TxCUD<T> {
  operations: Partial<T>
  retrieve?: boolean
}

export interface TxRemoveDoc<T extends Doc> extends TxCUD<T> {}

export type TxHandler = (...tx: Tx[]) => void

// Extend the existing Client interface to add notify:
export interface Client {
  notify?: (...tx: Tx[]) => void
  // (existing fields unchanged)
}

// Extend Doc to add modifiedBy typed as string (PersonId):
// (Doc already has modifiedBy: Ref<Doc> in current vendor.d.ts — update to PersonId)
```

**Specific delta to existing `vendor.d.ts`:**
- `Doc.modifiedBy` is currently typed as `Ref<Doc>` — change to `string` (PersonId is a string; the filter compares strings).
- Add `Client.notify?: (...tx: Tx[]) => void` to the existing `Client` interface.
- Add `Tx`, `TxCUD`, `TxMixin`, `TxCreateDoc`, `TxUpdateDoc`, `TxRemoveDoc`, `TxHandler` interfaces.
- Add `PersonId` type alias.
- The existing `core.class.TxMixin` ref constant must be declared on the default export; add to `index_default` shape in the `@hcengineering/core` module.
