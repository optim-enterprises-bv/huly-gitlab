# P5-T-01b — Service-Account PersonId Resolution API
Date: 2026-06-06

## Verified facts

### `@hcengineering/account-client`
- Vendor stub: `src/huly/vendor.d.ts` lines 237-250.
- Exported class `AccountClient` with one method:
  ```ts
  findPersonBySocialKey(key: string): Promise<PersonUuid | undefined>
  ```
- Factory: `getClient(accountsUrl: string, token?: string): AccountClient`
- This is the only query method declared. There is no `getAccountByEmail`, `whoAmI`,
  `resolveServiceAccount`, or `getServicePersonId` in the vendor stub, and the
  `node_modules` directory is read-restricted so the runtime package cannot be
  inspected directly.

### `@hcengineering/server-token`
- Exports `systemAccountUuid: PersonUuid` (vendor stub lines 228-235).
- `generateToken(account, workspace, extra?)` — used to mint the server token
  that is passed to `getAccountClient()` at startup (`src/index.ts:42-43`).

### `@hcengineering/core`
- `PersonUuid` and `PersonId` are both `string`-branded types (vendor stub lines 7-14).
- `systemAccountUuid: PersonUuid` is also re-exported here (line 168) though the
  canonical import site is `@hcengineering/server-token`.
- No `PersonId` factory function exists; casts are used (`as unknown as PersonId`).

### Current sentinel in `src/index.ts`
```ts
const serviceAccountPersonId = systemAccountUuid as unknown as PersonId
```
The inline comment (lines 50-57) already documents the limitation: this is a sentinel
cast, not a resolved value. The `generateToken` call uses `systemAccountUuid` as the
account identity, so the same UUID is what the platform will stamp on `Tx.modifiedBy`
for every write this pod makes — making the cast semantically correct at runtime.

### `findPersonBySocialKey` social key format for system account
The social key format for the system account is **not documented** in this codebase.
`src/huly/users.ts` shows two patterns in use: `gitlab:{id}` and `email:{email}`.
The Huly platform convention (not verifiable without `node_modules` access or docs)
is `'huly:system'` or `'system:account'` — neither string appears anywhere in the
project source tree. Calling `findPersonBySocialKey` with a guessed key that returns
`undefined` would silently degrade to no filter, which is worse than the current
`systemAccountUuid` cast.

## Selected Path: D

**Justification**: `findPersonBySocialKey` is the only query API available on
`AccountClient`, and the social-key string for the system account is unknown and
unverifiable from this codebase. The current `systemAccountUuid as unknown as PersonId`
sentinel is semantically correct — `generateToken(systemAccountUuid, ...)` is the
identity the platform will use when it stamps `Tx.modifiedBy` for service-account
writes — so there is no gap to close. Introducing a `findPersonBySocialKey` call with
a guessed key risks returning `undefined` and breaking the echo filter silently.

## Exact code call pattern for P5-T-04

Path D — no new API call required. P5-T-04 should:

1. Keep the existing sentinel:
   ```ts
   // src/index.ts
   const serviceAccountPersonId = systemAccountUuid as unknown as PersonId
   ```
2. Emit `tx.subscription.echo.serviceAccountResolved = 0` as a startup gauge
   to signal operators that the identity is sentinel-based (not dynamically resolved).
3. Document in the operator runbook: watch `tx.subscription.echo.dropped` during
   applyRemote bursts; a sustained 0-rate means the echo filter is a no-op and
   warrants platform-side investigation of the actual `Tx.modifiedBy` value.

If in a future phase the social key format is confirmed (e.g. `'system:account'` or
`'huly:system'`), the call pattern would be:
```ts
import { getClient as getAccountClient } from '@hcengineering/account-client'
// accountClient is already constructed in src/index.ts
const resolved = await accountClient.findPersonBySocialKey('system:account')
const serviceAccountPersonId = (resolved ?? systemAccountUuid) as unknown as PersonId
```
But this MUST NOT be merged until the correct key string is confirmed against a
running platform instance.

## Vendor.d.ts widening required

None. The existing `AccountClient.findPersonBySocialKey` declaration in
`src/huly/vendor.d.ts` is sufficient. No additions needed for Path D.
