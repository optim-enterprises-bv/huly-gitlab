# Implementation Plan — huly-gitlab Phase 1

**Status:** Approved (autopilot Phase 1)
**Spec:** `.omc/specs/deep-interview-huly-gitlab-phase1.md`
**Target tree:** `/Users/dingo/huly-gitlab/`
**Reference (read-only):** `/Users/dingo/huly-platform/services/github/pod-github/`
**Compose reference (read-only):** `/Users/dingo/huly-selfhost/compose.yml`

## Revision history
- v1 (initial): created
- v2 (this revision): applied critic findings + user resolutions for Q1 (full Huly stack in compose), Q3 (smoke install passed), Q5 (skip confidential issues). See §8 for change log.

---

## 1. Overview

Build `huly-gitlab`, a standalone out-of-tree pod that delivers two-way Issues sync between a Huly workspace and one or more bound GitLab projects, against self-hosted GitLab CE/EE 16+ first (gitlab.com via configurable base URL). The pod is the Phase 1 foundation: Express HTTP surface, MongoDB state store, OAuth + Group/Project Access Token credentials, webhook receiver with 5-min polling fallback, a provider-agnostic sync engine, and a `GitLabAdapter` returning canonical `Sync*` records. Issues sync covers title, description, state, labels, milestones, assignees, and notes both directions; conflicts resolve field-level by last-write-wins timestamp. The pod consumes `@hcengineering/*` packages from npm (version line `^0.7.423`, verified by smoke install — see Q3 resolution) instead of the platform monorepo workspace versions, and mirrors `pod-github` for HTTP/worker/sync structure without copying its GitHub-specific model dependencies.

**Confidential issues (Q5 resolution):** Phase 1 deliberately skips confidential issues and confidential notes. The webhook receiver does not subscribe to `confidential_issues_events` / `confidential_note_events`; the backfill filters out `confidential=true`. A `gitlab.confidential.skipped` counter is emitted per binding per cycle. Revisit in Phase 4 when ACL mapping ships.

---

## 2. Dependency Graph / Phase Ordering

```
                          T-01 Repo Bootstrap
                                  │
            ┌─────────────┬───────┼─────────────┬─────────────┐
            ▼             ▼       ▼             ▼             ▼
        T-02 Config   T-03 State T-04 Adapter T-05 Markdown T-06 Huly
        + Logging     Store      Skeleton     Adapter       Client
            │             │       │             │             │
            └─────────────┴───────┼─────────────┴─────────────┘
                                  ▼
            ┌─────────────────────┼─────────────────────┐
            ▼                     ▼                     ▼
        T-07 Sync Engine     T-08 HTTP Server      T-09 OAuth +
        Core (queue,         (webhook, health,     Access Token
        runner, conflict)    binding routes)       credential flow
            │                     │                     │
            ├──────────────┐      └────────┬────────────┘
            ▼              ▼               ▼
       T-10 Issues    T-11 Notes      T-13 Webhook
       Sync Manager   Sync Manager    Auto-Reg
                                      + T-13b Rotate
            ▼              ▼               ▼
            └──────────────┴───────────────┘
                          │
                          ▼
                   T-12 Backfill Scheduler
                   (depends only on SyncManager iface
                   from T-07; runs in parallel with T-10/T-11)
                          │
            ┌─────────────┼─────────────┐
            ▼             ▼             ▼
        T-14 Docker   T-15 E2E       T-16 README
        + compose     Harness        + arch docs
                          │
                          ▼
                  T-17 CI + Release
```

**Parallel waves (revised — DAG corrections):**

- **Wave A (after T-01):** T-02, T-03, T-04, T-05, T-06 — independent modules touching disjoint directories.
- **Wave B (after Wave A):** T-07, T-08, T-09 — depend on Wave A; touch disjoint files.
- **Wave C (after T-07 publishes `SyncManager` interface + T-04 idMap contract):**
  - T-10 (Issues), T-11 (Notes — needs T-10's issue-resolution helper so depends on T-10's contract not its impl; can start with stubbed `resolveIssueRef`), T-12 (Backfill — needs only `SyncManager.backfill` interface from T-07), T-13 + T-13b (Webhook lifecycle — needs T-04 webhook adapter methods + T-08 binding route surface).
  - Practical width: up to 4 concurrent tasks here once interface contracts are committed.
- **Wave D (after T-13):** T-14, T-15, T-16 in parallel.
- **Final:** T-17.

**Interface contracts that gate Wave C parallelism (deliverable of T-07):**
- `src/sync/types.ts` with `SyncManager` interface frozen on T-07 day-1.
- `src/state/idmap.ts` contract (kinds: `issue`, `note`, `user`, `label`, `milestone`) frozen on T-04 day-1.
- Commit these stub files before Wave B starts to unblock T-10/T-11/T-12/T-13 in Wave C.

**Parallelism width:** up to 5 concurrent executors (Wave A); up to 4 in Wave C; typical 3.

---

## 3. Task List

### T-01 — Repo Bootstrap & Tooling Skeleton

- **Owner:** Sonnet
- **Inputs:**
  - Spec §Component Layout
  - `/Users/dingo/huly-platform/services/github/pod-github/package.json`
  - `/Users/dingo/huly-platform/services/github/pod-github/tsconfig.json`
  - `/Users/dingo/huly-platform/services/github/pod-github/.eslintrc.js`
  - `/Users/dingo/huly-platform/services/github/pod-github/jest.config.js`
  - `/Users/dingo/huly-platform/foundations/utils/packages/platform-rig/profiles/default/tsconfig.json`
  - `/Users/dingo/huly-platform/foundations/utils/packages/platform-rig/profiles/default/eslint.config.json`
- **Outputs:**
  - `package.json` — name `huly-gitlab`, private (not published), scripts: `build`, `lint`, `format`, `test`, `test:e2e`, `dev`, `bundle`, `docker:build`. Engines `node >=22 <23`. Inline rig contents (do not depend on `@hcengineering/platform-rig`).
  - `tsconfig.json` — inlined from rig defaults: `target: esnext`, `module: commonjs`, `strict: true`, `esModuleInterop: true`, `experimentalDecorators: true`, `emitDecoratorMetadata: true`, `isolatedModules: true`, `skipLibCheck: true`, `rootDir: ./src`, `outDir: ./lib`, `declaration: true`, `resolveJsonModule: true`, `sourceMap: true`, `incremental: true`, `types: ["jest","node"]`.
  - `.eslintrc.cjs` — extends `eslint-config-love` (replacement for the deprecated `standard-with-typescript`); ignore patterns inlined from rig.
  - `.prettierrc.json` — `{ "semi": false, "singleQuote": true, "trailingComma": "none", "printWidth": 120 }` (matches huly observed style).
  - `jest.config.js` — `ts-jest`, `testMatch: ['**/?(*.)+(spec|test).[jt]s?(x)']`, `roots: ['./src','./tests']`, `collectCoverageFrom: ['src/**/*.ts','!src/**/*.test.ts']`.
  - `.editorconfig`, `.gitignore` (add `lib/`, `bundle/`, `logs/`, `coverage/`, `.build/`, `node_modules/`).
  - Placeholder `src/index.ts` that exits cleanly with `console.log('huly-gitlab placeholder')` — guaranteed to exist so eslint has a target.
  - `LICENSE` (EPL-2.0 to match huly).
  - `tests/.gitkeep`.
- **Acceptance criteria:**
  - `npm install` exits 0.
  - `npm run lint` exits 0 against `src/index.ts` placeholder (no `--passWithNoFiles` flag; use `--no-error-on-unmatched-pattern` if needed, but the placeholder guarantees a match).
  - `npm run build` (`tsc -p .`) exits 0 and produces `lib/index.js`.
  - `npm test` exits 0 with `--passWithNoTests`.
  - `node lib/index.js` prints placeholder and exits 0.
- **Dependencies:** none.
- **Complexity:** S (~150 LOC config).

**Pinned hcengineering packages (all `^0.7.423`, smoke-install verified — see Q3 resolution):** `core`, `platform`, `analytics`, `analytics-service`, `measurements`, `account-client`, `server-client`, `server-token`, `server-core`, `client`, `client-resources`, `contact`, `chunter`, `tracker`, `task`, `text`, `text-markdown`, `query`, `setting`, `mongo`.

**Third-party runtime deps:**
- `express@^4.21.2`
- `cors@^2.8.5`
- `body-parser@^1.20.3`
- `mongodb@^6.16.0`
- `ws@^8.18.2`
- `dotenv@^16.4.5`
- `fast-equals@^5.2.2`
- `markdown-it@^14.0.0`
- `@tiptap/core@^2.11.7`, `@tiptap/pm@^2.11.7`, `@tiptap/html@^2.11.7`
- `graphql@^16.8.0`, `graphql-request@^7.1.0`

**Explicitly NOT used (critic-removed):**
- `node-fetch` — Node 22 has stable built-in `fetch`; use the global.
- `axios` — adapter uses `fetch`; nothing else needs it.

**Third-party dev deps:**
- `typescript@^5.9.3`
- `ts-node@^10.9.2`
- `@types/node@^22.18.1`
- `@types/express@^4.17.13`, `@types/cors@^2.8.12`, `@types/body-parser@^1.19.2`
- `jest@^29.7.0`, `ts-jest@^29.1.1`, `@types/jest@^29.5.5`
- `eslint@^8.54.0`
- `eslint-config-love@^43.1.0` (replaces deprecated `eslint-config-standard-with-typescript`)
- `@typescript-eslint/parser@^6.21.0`, `@typescript-eslint/eslint-plugin@^6.21.0`
- `eslint-plugin-import@^2.26.0`, `eslint-plugin-promise@^6.1.1`, `eslint-plugin-n@^16.6.2`
- `prettier@^3.6.2`, `cross-env@^7.0.3`, `nodemon@^3.1.4`

---

### T-02 — Config & Structured Logging

- **Owner:** Haiku
- **Inputs:** spec §Architecture; `pod-github/src/config.ts`; `pod-github/src/index.ts`.
- **Outputs:**
  - `src/config.ts` — typed `Config` with envMap, `required` list, throws on missing. Fields:
    - `Port` (default 3600)
    - `PublicBaseUrl` (required)
    - `AccountsURL` (required)
    - `ServerSecret` (required)
    - `ServiceID` (default `gitlab-service`)
    - `MongoUrl` (required)
    - `MongoDb` (default `huly-gitlab`)
    - `GitLabBaseUrl` (default `https://gitlab.com`)
    - `GitLabClientId`, `GitLabClientSecret` (required)
    - `CredentialEncryptionKey` (32-byte base64, required)
    - `WebhookSecretSeed` (required)
    - `AllowedWorkspaces` (csv → string[], default `['*']`)
    - `BackfillIntervalMs` (default 300000)
    - `RateLimit` (default 25)
    - `LogLevel` (default `info`)
    - `BrandingPath` (default `''`)
  - **Derived (not env-driven):** `OAuthRedirectUri` = `${PublicBaseUrl}/oauth/callback`. Document that operators wishing to override must change `PublicBaseUrl`.
  - `src/logging.ts` — thin wrapper that prefers `MeasureContext` from `@hcengineering/core` when available and falls back to JSON logging via `console.log` (`{level, ts, correlationId, msg, ctx}`).
- **Outputs (tests):**
  - `src/config.test.ts` — Jest test that imports `./src/config`, mutates `process.env`, and asserts:
    - Missing required env throws `Missing env variables: ...` with the correct list.
    - CSV parsing of `AllowedWorkspaces`.
    - Integer parsing of `Port`, `BackfillIntervalMs`, `RateLimit`.
    - `OAuthRedirectUri` is derived correctly from `PublicBaseUrl`.
- **Acceptance criteria:**
  - `npm test -- src/config.test.ts` passes.
  - (No standalone `ts-node` smoke command — replaced with the Jest test above per critic.)
- **Dependencies:** T-01.
- **Complexity:** S (~120 LOC).

---

### T-03 — Mongo State Store

- **Owner:** Sonnet
- **Inputs:** spec §State store; R6 resolution.
- **Outputs:**
  - `src/state/store.ts` — `Store` class that owns a single `MongoClient`, exposes typed collection accessors, creates indexes on connect.
  - `src/state/bindings.ts` — CRUD for `bindings` collection.
    - **Schema (R6 resolution — secret moved into `credentials` collection):**
      - `_id`, `workspaceUuid`, `hulyProjectRef`, `gitlabProjectId`, `gitlabProjectPath`, `credentialRef`, `webhookSecretRef` (points to a `credentials` row with `kind:'webhook_secret'`), `webhookId`, `webhookRegistered` (boolean), `createdAt`, `disabled`.
      - Index: `{workspaceUuid:1, gitlabProjectId:1}` unique.
    - The plaintext webhook secret is never persisted in `bindings`. The admin response from `GET /api/v1/bindings` projects `webhookSecretRef` away.
  - `src/state/cursors.ts` — last-sync `updated_after` cursors per binding per resource kind (`issues`, `notes`). Index: `{bindingId:1, kind:1}` unique.
  - `src/state/idmap.ts` — bidirectional `(gitlabKind, gitlabId) ↔ (hulyClass, hulyRef)` mapping with workspace scope. Indexes on both directions. **Kind contract (frozen day-1, consumed by Wave C):** `issue`, `note`, `user`, `label`, `milestone`.
  - `src/state/dedup.ts` — `(bindingId, eventId, version)` records with TTL index (7 days).
  - `src/state/inflight.ts` — operations being applied, used for crash recovery. Fields: `_id`, `bindingId`, `op`, `payload`, `startedAt`. TTL 1h.
  - `src/state/credentials.ts` — encrypted credential records.
    - Fields: `_id`, `kind: 'oauth' | 'access_token' | 'webhook_secret'`, `ciphertext`, `iv`, `tag`, `createdAt`, `expiresAt`, `refreshTokenCiphertext?`.
    - AES-256-GCM with key from `Config.CredentialEncryptionKey`. Exposes `put`, `get`, `delete`, `rotate(id, newPlaintext)`.
- **Outputs (tests):**
  - `src/state/credentials.test.ts` (round-trip encryption + rotate).
  - `src/state/store.test.ts` (uses `mongodb-memory-server@^10` to start ephemeral mongod; exercises index creation + binding CRUD; asserts `webhookSecret` plaintext is never returned).
- **Acceptance criteria:**
  - `npm test -- src/state` passes.
  - `npm run lint -- src/state` exits 0.
  - `npm test -- --coverage src/state/credentials.ts` reports ≥ 90% statements (jest coverage config from T-01 makes this measurable).
- **Dependencies:** T-01, T-02. Add `mongodb-memory-server@^10.1.4` as devDependency.
- **Complexity:** M (~500 LOC).

---

### T-04 — GitLab Adapter Skeleton (REST + capability detection)

- **Owner:** Sonnet
- **Inputs:** spec §GitLabAdapter, §Capability detection; R10 resolution.
- **Outputs:**
  - `src/adapter/types.ts` — canonical types:
    - `SyncProject`, `SyncIssue`, `SyncNote`, `SyncUser`, `SyncLabel`, `SyncMilestone`, `SyncWebhook`, `Cursor`.
    - `Capabilities` = `{ gitlabVersion: string, edition: 'ce'|'ee', graphqlAvailable: boolean, featureFlags: { 'graphql.issue.notes': boolean, 'graphql.issue.batchedNotes': boolean } }` — flags are an **explicit, closed set** (R10 resolution). Each flag must name its consumer in a code comment. Phase 1 ships `graphql.issue.notes` (consumed by T-11 batched note fetch) and `graphql.issue.batchedNotes` (consumed by T-04 itself for `graphql<T>` fallback decisions).
  - `src/adapter/rate-limit.ts` — `TokenBucket` honoring `Retry-After` (integer seconds AND HTTP-date format per RFC 7231) and `RateLimit-*` headers, with exponential backoff (max 5 retries, base 500ms, factor 2, cap 30s).
  - `src/adapter/gitlab-client.ts` — `GitLabClient` exposes:
    - `request<T>(method, path, opts)` REST wrapper using the **global Node 22 `fetch`** (no `node-fetch`).
    - `graphql<T>(query, vars)` using `graphql-request`, only if `capabilities.graphqlAvailable`.
    - `listProjects(opts)`, `getProject(id)`.
    - `listIssues(projectId, {updatedAfter?})` — **MUST filter out `confidential: true` results per Q5 resolution. Emit metric `gitlab.confidential.skipped` per filtered row.**
    - `getIssue(projectId, iid)`, `createIssue(projectId, body)`, `updateIssue(projectId, iid, body)`.
    - `listNotes(projectId, issueIid, {updatedAfter?})` — also filters confidential notes (note has `confidential: true` OR parent issue confidential).
    - `createNote(projectId, issueIid, body)`, `updateNote(projectId, issueIid, noteId, body)`, `deleteNote(...)`.
    - `listLabels(projectId)`, `createLabel(projectId, body)`.
    - `listMilestones(projectId)`, `createMilestone(projectId, body)`.
    - `getCurrentUser()`, `lookupUserByEmail(email)`.
    - Each returns canonical `Sync*` records, never raw GitLab JSON.
  - `src/adapter/capabilities.ts` — `detectCapabilities(client)`: calls `GET /api/v4/version` and runs a minimal GraphQL introspection ping; caches result with 1-hour TTL.
  - `src/adapter/webhooks.ts` — `registerProjectWebhook(projectId, url, secret, events)`, `deregisterProjectWebhook(projectId, webhookId)`. The `events` argument is exact-controlled by the caller; T-13 passes only non-confidential events.
  - `src/adapter/index.ts` — re-exports.
- **Outputs (tests):** `tests/adapter/gitlab-client.test.ts` — uses `nock@^14` to record/replay fixtures. **Required fixture coverage (critic-mandated enumeration):**
  1. `listProjects` happy path with pagination.
  2. `getIssue` happy path.
  3. `listIssues` with `confidential` rows filtered out (asserts metric incremented).
  4. Rate-limit retry: `Retry-After: 2` (integer seconds).
  5. Rate-limit retry: `Retry-After: Wed, 21 Oct 2026 07:28:00 GMT` (HTTP-date).
  6. Rate-limit retry: respects `RateLimit-Reset` header on 429.
  7. GraphQL ping success → `capabilities.graphqlAvailable=true`.
  8. GraphQL ping failure (introspection 401/403) → REST fallback, `graphqlAvailable=false`.
  9. Capability cache hit within TTL (no second `/version` HTTP call).
  10. Capability cache miss after TTL expiry triggers re-fetch.
  11. CE detection: `/version` returns `revision` without `Enterprise Edition`.
  12. EE detection: `/version` returns `revision` containing `EE`.
- **Acceptance criteria:**
  - `npm test -- tests/adapter` passes with all 12 enumerated cases.
  - `npm run lint -- src/adapter` exits 0.
  - No `any` types in `src/adapter/types.ts`.
  - Every entry in `Capabilities.featureFlags` has a code-comment citing the consumer task (T-04 or T-11).
- **Dependencies:** T-01. Add `nock@^14.0.0` devDep (Node 22 compatible; v13 is not).
- **Complexity:** L (~1100 LOC including fixtures).

---

### T-05 — Markdown Adapter (GFM ↔ Huly)

- **Owner:** Sonnet
- **Inputs:**
  - `/Users/dingo/huly-platform/services/github/pod-github/src/markdown/index.ts`
  - `/Users/dingo/huly-platform/services/github/pod-github/src/markdown/extensions.ts`
- **Outputs:**
  - `src/markdown/extensions.ts` — Tiptap kit `GitLabKit` built from `@hcengineering/text`'s `ServerKit` + extensions for GitLab-specific syntax (autolinks `~label`, `%milestone`, `@user`, `#123` issue refs, `!123` MR refs as plain text in Phase 1, task lists, tables, strikethrough, fenced code with language).
  - `src/markdown/gfm-to-huly.ts` — `parseGfmMarkdown(message, refUrl, imageUrl)` returns ProseMirror `MarkupNode`, then `gfmMarkdownToMarkup(...)` returns markup string (parallels pod-github `markdownToMarkup`).
  - `src/markdown/huly-to-gfm.ts` — `markupToGfmMarkdown(markup, refUrl, imageUrl, preprocessor?)` (parallels pod-github `markupToMarkdown`). Uses `MarkdownState`, `storeNodes`, `storeMarks` from `@hcengineering/text-markdown`.
  - `src/markdown/index.ts` — re-exports.
- **Outputs (tests):** `tests/markdown/round-trip.test.ts` — at least 15 fixtures covering:
  - paragraphs, headings, lists, fenced code, inline code, tables, task lists, strikethrough, links, images
  - **attachment link-through (spec coverage gap):** markdown referencing `/uploads/abc123/file.png` and `https://gitlab.example/group/proj/-/uploads/...` survives round-trip verbatim as a plain link/image reference (no proxy or upload in Phase 1).
  - GitLab `@mentions`/`#issue`/`~label`/`%milestone`/`!mr` references survive round-trip as text (do not try to resolve in Phase 1).
- **Acceptance criteria:**
  - All round-trip tests pass.
  - For each fixture, `markupToGfm(gfmToMarkup(x)) === x` after the `isMarkdownsEquals` normalizer from `@hcengineering/text-markdown` (allows whitespace differences).
  - Explicit assertion that any `/uploads/...` URL is byte-identical after round-trip.
- **Dependencies:** T-01.
- **Complexity:** M (~450 LOC including fixtures).

---

### T-06 — HulyClient + Identity Mapper

- **Owner:** Sonnet
- **Inputs:**
  - `pod-github/src/client.ts`, `pod-github/src/users.ts`
  - spec §HulyClient, §user identity
- **Outputs:**
  - `src/huly/client.ts` — `createPlatformClient(ctx, workspaceUuid, timeout)` mirroring `pod-github/src/client.ts`. Returns `{client: Client, endpoint: string}`. Uses `generateToken(systemAccountUuid, workspace, {service:'gitlab', mode:'gitlab'})`. Sets `client.metadata.UseBinaryProtocol`, `UseProtocolCompression`, `ConnectionTimeout`, `FilterModel='client'`.
  - `src/huly/projects.ts` — `getTrackerProject(client, hulyProjectRef)` validates the ref exists in `tracker.class.Project` and returns project + statuses + project type.
  - `src/huly/users.ts` — `UserIdentity` service:
    - **`AccountClient.findPersonBySocialKey` returns `PersonUuid | undefined` (NOT `PersonId`).** All downstream code must accept the `PersonUuid` return type and resolve to a `PersonId` separately via account lookup.
    - **Social key format (critic-required, frozen contract):**
      - OAuth-authenticated GitLab users → `gitlab:{oauth_subject}` (the immutable `sub` claim from the OAuth token).
      - Email-matched (no OAuth) → `email:{lowercased_email}`.
      - Document these formats in `src/huly/users.ts` as a top-of-file constant.
    - `mapByEmail(email)` — looks up via `findPersonBySocialKey('email:' + email.toLowerCase())`; returns `PersonUuid | undefined`.
    - `mapByGitlabUser(gitlabUser)` — tries `gitlab:{sub}` first (when an OAuth-known sub exists for that user via prior auth), then `email:{lowercased_email}`; falls back to stored `{gitlabUserId → PersonUuid}` in Mongo `idMap` (kind `user`).
    - `ensureStubGuest(workspace, gitlabUser)` — when no match, **deduplicates on `(workspaceUuid, gitlabUserId)` first (R9 mitigation)**; if a prior stub exists, return its `PersonUuid`. Only on miss, create stub `contact.class.Person` with a runtime-only `gitlab` marker (NOT a model mixin — see Q5 resolution; mixin foot-gun removed) carrying `gitlabUserId`, `gitlabUsername`, `gitlabWebUrl`. Returns `PersonUuid`.
    - All operations cached per workspace with 5-min TTL.
- **Outputs (tests):** `tests/huly/users.test.ts` — uses a fake Mongo + a fake Huly client (stubbed `findAll`/`createDoc`) to exercise mapping, stub creation, **stub dedup (same gitlabUserId twice → one create, second call hits cache)**, and cache hits. Asserts `PersonUuid` return type.
- **Acceptance criteria:**
  - All tests pass; cache hit count asserted; stub dedup asserted with assertion message naming R9.
  - `npm run lint -- src/huly` exits 0.
- **Dependencies:** T-01, T-02, T-03.
- **Complexity:** M (~450 LOC).

---

### T-07 — Sync Engine Core (EventQueue, SyncRunner, ConflictResolver)

- **Owner:** Sonnet
- **Inputs:** spec §Sync engine, §Conflict resolution; R7 resolution; circuit-breaker shared-state gap from critic.
- **Outputs:**
  - `src/sync/types.ts` — **frozen day-1** as the contract that unblocks Wave C: `SyncManager` interface (`kind: string`, `applyRemote(ctx, binding, record)`, `applyLocal(ctx, binding, doc, change)`, `backfill(ctx, binding, since)`); `BreakerState`; `SyncEvent`.
  - `src/sync/queue.ts` — `EventQueue` keyed by `(workspaceUuid, bindingId, resourceKey)` where `resourceKey = issueIid | noteId | '*'` (R7 resolution — per-resource ordering rather than per-binding serialization). Document the trade-off: in-memory map grows linearly with active resources; bound by a 1000-entry LRU per binding to cap memory.
  - `src/sync/conflict.ts` — `resolveLww(localField, localTs, remoteField, remoteTs)`; **conflict matrix (critic-enumerated, all must be implemented + tested):**
    1. Remote newer than local → remote wins.
    2. Local newer than remote → local wins.
    3. Equal timestamps → remote wins (tiebreak documented).
    4. Local timestamp missing → remote wins.
    5. Remote timestamp missing → local wins.
    6. Both missing → no-op.
    7. Remote update arrives twice (same `event_id`) → dedup, no-op.
    8. Local update arrives during remote-apply → queued behind active op for same `resourceKey`, applied second.
  - `src/sync/engine.ts` — `SyncEngine`:
    - Owns `EventQueue`, dispatches events to registered `SyncManager`s by kind.
    - `enqueueWebhookEvent`, `enqueueBackfillBatch`, `start`, `stop`.
    - Idempotency via `dedup` collection (`(bindingId, eventId, version)`).
    - Crash recovery: on boot, scan `inflight`, resume queued ops, discard ops older than 1h.
    - **Shared circuit-breaker state (critic gap):** the per-binding breaker state owned by T-12's `BackfillScheduler` is exposed as a service `BindingBreaker` so the engine's webhook-event path consults the same state before applying. When the breaker is OPEN for a binding, the engine drops the event with a `gitlab.breaker.dropped.webhook` metric and returns 200 to GitLab to avoid retry storms.
- **Outputs (tests):** `tests/sync/engine.test.ts` — uses a fake `SyncManager` and fake adapter:
  - All 8 LWW matrix cases above.
  - Ordering: two events with the same `(binding, resourceKey)` apply in arrival order; events with different `resourceKey` may interleave (the relaxation from R7).
  - Dedup: re-delivery of same `(bindingId, eventId, version)` produces one apply call.
  - **Crash recovery (critic-required):** pre-populate `inflight` with a stale op (`startedAt` > 1h ago) and a fresh op; on engine boot, the fresh op resumes and the stale op is discarded with a `sync.inflight.discarded` metric.
  - Breaker integration: when breaker is OPEN for a binding, webhook event is dropped (metric asserted) and applied normally when CLOSED.
- **Acceptance criteria:**
  - All tests pass; conflict matrix has exactly 8 enumerated cases.
  - Crash-recovery test passes.
  - `npm run lint -- src/sync` exits 0 (excluding files written by T-10/T-11/T-12/T-13).
- **Dependencies:** T-03, T-04, T-06. **T-07's `src/sync/types.ts` and `src/state/idmap.ts` kind list must land in repo on day-1 of Wave B to unblock Wave C parallel kickoff.**
- **Complexity:** M (~600 LOC).

---

### T-08 — HTTP Server (Express): webhook, health, binding admin routes

- **Owner:** Sonnet
- **Inputs:** spec §HTTP surface; `pod-github/src/server.ts`; R8 resolution.
- **Outputs:**
  - `src/http/health.ts` — `GET /health` returns `{status:'ok', uptime, gitlabReachable, mongoOk}`.
  - `src/http/webhook.ts` — `POST /webhook/:bindingId`:
    - Loads the binding's `webhookSecretRef`, decrypts the secret.
    - **Validates `X-Gitlab-Token` via `crypto.timingSafeEqual` shared-secret compare (NOT HMAC — the spec's wording was technically incorrect; GitLab uses a plaintext shared secret).** Buffers must be same length; on length mismatch return 401 without timing-leak.
    - Parses payload using **`body-parser` JSON with `{ limit: '5mb' }`** (R8 — GitLab webhooks on busy issues with many notes can exceed default 100kb).
    - Hands to `SyncEngine.enqueueWebhookEvent`.
    - Returns 401 on signature mismatch, 404 on unknown binding, 413 on body-too-large (with `gitlab.webhook.rejected.size` metric — R8 alerting), 200 otherwise.
  - `src/http/binding.ts` — admin routes (auth by `Authorization: Bearer {ServerSecret}`):
    - `POST /api/v1/bindings` `{workspaceUuid, hulyProjectRef, gitlabProjectId, credentialRef}` → creates binding, attempts webhook registration via T-13.
    - `DELETE /api/v1/bindings/:id` → deregisters webhook, deletes binding.
    - `GET /api/v1/bindings?workspaceUuid=...` → lists bindings. **Response schema must NOT include `webhookSecretRef` or any decrypted form (critic R4 mitigation).** Test asserts absence.
  - `src/http/index.ts` — Express bootstrap, wires routes; mounts `cors`, `body-parser` (5mb JSON limit), error handler that emits structured logs.
  - `src/index.ts` (replace placeholder) — initializes `Store`, `GitLabClient` factory, `HulyClient` factory, `SyncEngine`, **`CredentialResolver` (T-09 contract)**, then `start(http)`. SIGINT/SIGTERM handlers.
- **Outputs (tests):**
  - `tests/http/webhook.test.ts` (supertest@^7) — signature mismatch, valid issue/note event, unknown binding, payload at 4.9mb (200), payload at 6mb (413).
  - `tests/http/binding.test.ts` — covers create/list/delete with stubbed adapter and store; **explicit test that `GET /api/v1/bindings` JSON does not contain the strings `webhookSecret`, `webhookSecretRef`, or any base64 secret pattern**.
- **Acceptance criteria:**
  - `npm test -- tests/http` passes.
  - `npm run build` exits 0.
  - `npm run dev` (nodemon) boots locally, `curl http://localhost:3600/health` returns 200 within 5s. (Note: this criterion implicitly depends on T-09's `CredentialResolver`. If T-09 is not yet landed, T-08 may stub it; the 5s boot criterion graduates to a hard requirement once T-09 is wired.)
- **Dependencies:** T-02, T-03, T-07. Soft dep on T-09 for the boot-time `CredentialResolver`. Add `supertest@^7.0.0`, `@types/supertest@^6.0.2` devDeps.
- **Complexity:** M (~550 LOC).

---

### T-09 — OAuth + Access Token Credential Flow

- **Owner:** Sonnet
- **Inputs:** spec §Auth.
- **Outputs:**
  - `src/http/oauth.ts`:
    - `GET /oauth/start?workspaceUuid=...&hulyProjectRef=...` — generates `state`, signs with `ServerSecret`, redirects to `${GitLabBaseUrl}/oauth/authorize?...&redirect_uri=${OAuthRedirectUri}`.
    - `GET /oauth/callback?code=...&state=...` — verifies state, exchanges code at `${GitLabBaseUrl}/oauth/token`, stores encrypted token via `credentials` (T-03), returns short HTML page or JSON `{credentialRef}` for CLI flows.
  - `src/auth/access-token.ts` — `POST /api/v1/credentials/access-token` admin route (bearer `ServerSecret`): accepts `{token, scope:'group'|'project', resourceId}`, validates token against GitLab (`GET /api/v4/user` with the token), stores encrypted.
  - `src/auth/refresh.ts` — periodic refresher (runs every 30 min); refreshes OAuth tokens 5 min before expiry.
  - `src/auth/index.ts` — `CredentialResolver` used by adapter factory to fetch + decrypt by `credentialRef`.
- **Outputs (tests):**
  - `tests/auth/oauth.test.ts` — supertest with nock-mocked GitLab token endpoint:
    - State HMAC validity.
    - Error on tampered state.
    - Successful storage of encrypted token.
    - **Full OAuth flow integration (critic-required, replaces manual-only smoke):** `/oauth/start` → simulated user-agent follow → callback with valid code → `/api/v1/credentials/list` shows the new credential. Entirely nock-driven.
  - `tests/auth/refresh.test.ts` — refresh path with jest fake timers.
- **Acceptance criteria:**
  - All tests pass, including the full nock-mocked OAuth round-trip.
  - Manual smoke against a real GitLab CE container is documented in README as a *secondary* validation, no longer the sole acceptance criterion.
- **Dependencies:** T-02, T-03, T-08.
- **Complexity:** M (~500 LOC).

---

### T-10 — Issues Sync Manager (two-way)

- **Owner:** Opus
- **Inputs:**
  - `pod-github/src/sync/issues.ts` (reference for patterns only — do not copy field maps).
  - `pod-github/src/sync/issueBase.ts` (priority/status mapping patterns).
  - spec §Issues sync.
  - T-04 canonical types (with confidential filter already applied), T-06 user mapping, T-05 markdown adapter, T-07 engine.
  - Q5 resolution: NO `tracker.mixin.IssueGitlab` model mixin. No model-migration script.
- **Outputs:**
  - `src/sync/issues.ts` — `IssuesSyncManager implements SyncManager` with `kind: 'issue'`:
    - `applyRemote(ctx, binding, syncIssue)`:
      - Look up `idMap` for existing Huly `tracker.class.Issue`.
      - If absent, create via `TxOperations.createDoc` under `binding.hulyProjectRef` with default `TaskType`.
      - Diff title, description (markdown), priority (default `IssuePriority.NoPriority`), status (open → first "Active" status, closed → first "Done" status; configurable via project-type statuses lookup), labels (autocreate Huly `tags.Tag` via `tags`/tracker-labels collection if missing), milestone (autocreate `tracker.class.Milestone`), assignees (via `UserIdentity`).
      - Per-field LWW: compare `binding.cursor.issues` vs incoming `updated_at`; for each field where remote ts > stored local ts, apply.
      - Persist new cursor; upsert `idMap`.
    - `applyLocal(ctx, binding, hulyIssue, change)`:
      - Map back to GitLab via `idMap`; call `GitLabClient.updateIssue` / `createIssue`.
      - Translate Huly statuses to GitLab `open/closed` (any non-Done → `opened`).
      - Translate labels/milestones; create on GitLab side if absent on this project.
    - `backfill(ctx, binding, since)`:
      - `GitLabClient.listIssues(projectId, {updatedAfter: since})` paginated. The adapter already drops confidential issues; this method just enqueues each non-confidential row as a remote event.
    - **Q5 reminder:** No mixin is created. `confidential` field is not mirrored to Huly. The `gitlab.confidential.skipped` counter is incremented inside the adapter (T-04), not here.
  - `src/sync/label-cache.ts` — per-binding cache of GitLab labels and Huly tag refs.
  - `src/sync/status-map.ts` — `mapStatus(remoteState, projectStatuses)` / inverse, deterministic.
- **Outputs (tests):** `tests/sync/issues.test.ts` — at least 12 cases covering:
  - create remote→local
  - create local→remote
  - edit title both directions
  - label autocreate
  - milestone autocreate
  - assignee mapping including unmatched (stub guest)
  - conflict where both sides edit different fields (no loss)
  - conflict where both sides edit same field (LWW)
  - idempotent re-delivery
  - confidential issue from `listIssues` is never enqueued (adapter-level filter test, asserted here)
  - **attachment link-through (spec coverage gap):** issue description containing `/uploads/abc/file.png` reference survives `applyRemote → applyLocal → applyRemote` (round-trip both directions) as plain markdown reference, byte-identical
  - no spurious writes when no field changed
- **Acceptance criteria:**
  - All tests pass; mutation count to fake Huly client and fake adapter is asserted.
  - Round-trip attachment-link test passes with byte-identical assertion.
  - `npm run lint -- src/sync/issues.ts` exits 0.
- **Dependencies:** T-04, T-05, T-06, T-07. **Wave C — can start once T-07's `SyncManager` interface and T-04's `idMap` contract are committed.**
- **Complexity:** L (~1300 LOC including tests). If implementer estimates > 1500 LOC, split label/milestone/status mapping into a follow-up sub-task T-10b before starting.

---

### T-11 — Notes / Comments Sync Manager (two-way)

- **Owner:** Sonnet
- **Inputs:** `pod-github/src/sync/comments.ts`; T-10 patterns; spec §Notes/comments two-way; Q5 resolution.
- **Outputs:**
  - `src/sync/notes.ts` — `NotesSyncManager implements SyncManager` with `kind: 'note'`:
    - Maps GitLab notes ↔ `chunter.class.ChatMessage` attached to the Huly issue.
    - Skips system notes (`note.system === true`).
    - **Confidential notes are already filtered by the adapter (T-04); no extra filter here.**
    - Maps author via `UserIdentity`; if unmatched, attaches via stub guest (with R9 dedup).
    - LWW per-note on body; deletion: GitLab note delete → remove `ChatMessage`; Huly delete → call `GitLabClient.deleteNote`.
    - May call `GitLabClient.graphql<T>` for batched note fetch when `capabilities.featureFlags['graphql.issue.notes']` is true (consumer of the feature flag — closes R10).
  - Updates `src/sync/issues.ts` to enqueue note backfill after each issue backfill (`listNotes(projectId, iid, {updatedAfter: lastNoteCursor})`).
- **Outputs (tests):** `tests/sync/notes.test.ts` — ≥ 8 cases: create both directions, edit, delete, system-note skip, stub-guest author (dedup asserted), confidential note never appears (adapter filters; integration asserts), GraphQL batched fetch path when capability flag is true.
- **Acceptance criteria:**
  - All tests pass.
  - `npm run lint -- src/sync/notes.ts` exits 0.
- **Dependencies:** T-04, T-05, T-06, T-07 (the contracts, not T-10's implementation). **Wave C parallel with T-10 once T-10 publishes its `resolveIssueRef(binding, gitlabIssueIid)` helper signature as a stub for T-11 to consume.**
- **Complexity:** M (~600 LOC including tests).

---

### T-12 — Backfill Scheduler (5-min polling)

- **Owner:** Sonnet
- **Inputs:** spec §Polling fallback, §BackfillScheduler.
- **Outputs:**
  - `src/sync/backfill.ts` — `BackfillScheduler`:
    - On start, schedules every `Config.BackfillIntervalMs` (default 5 min).
    - **Polling-vs-webhook semantics (critic gap):** Polling runs for ALL non-disabled bindings regardless of `binding.webhookRegistered`. Webhooks make sync *faster*, polling guarantees eventual consistency. (Chosen over the alternative "poll only when webhook down" because it provides defense-in-depth against missed webhook deliveries.) Document this in code comment and `docs/architecture.md`.
    - For each non-disabled binding, computes `since = cursors.get(bindingId,'issues')` and calls `IssuesSyncManager.backfill`. Repeats for notes.
    - **Cursor regression guard (critic test-required):** if a stored cursor is in the future relative to wall clock (clock skew), clamp to `now - 1s` and log `cursor.regression.detected`.
    - Per-binding circuit breaker (`BindingBreaker` — shared with T-07 engine per shared-state gap): 5 consecutive failures → OPEN for 15 min, then HALF_OPEN with one probe.
    - Emits structured logs with correlation id `backfill-{bindingId}-{epoch}`.
    - Per-cycle metric: `gitlab.confidential.skipped` (Q5 resolution).
- **Outputs (tests):** `tests/sync/backfill.test.ts` — jest fake timers:
  - Schedule, cursor advance, circuit-breaker open/half-open/close transitions.
  - **Disabled-binding skip (critic-required):** binding with `disabled:true` is never polled in a tick.
  - **Cursor regression on future-timestamp (critic-required):** preset a cursor 1h in the future, assert it is clamped + warning logged.
  - 100 bindings simulated in a single tick completes in < 2s (fairness check, not perf benchmark).
- **Acceptance criteria:**
  - All tests pass.
  - Disabled-binding and cursor-regression tests pass.
- **Dependencies:** T-07 (only the `SyncManager` interface; full impl not required). **Wave C parallel — runs against stub `SyncManager` until T-10/T-11 land.**
- **Complexity:** M (~400 LOC).

---

### T-13 — Webhook Auto-Registration

- **Owner:** Sonnet
- **Inputs:** spec §Webhook auto-registration; T-04 `webhooks.ts`; Q5 resolution.
- **Outputs:**
  - `src/sync/binding-lifecycle.ts`:
    - `onBindingCreate(binding)`:
      - Generates per-binding webhook secret: `crypto.randomBytes(32).toString('base64')` (32 raw bytes; base64 yields 44 chars).
      - Persists secret encrypted via `credentials` collection with `kind: 'webhook_secret'` (R6 resolution); writes `webhookSecretRef` on the binding (never the plaintext).
      - Calls `GitLabClient.registerProjectWebhook` with url `${PublicBaseUrl}/webhook/{bindingId}`, events: **`issues_events`, `note_events` ONLY**. **Does NOT subscribe to `confidential_issues_events` or `confidential_note_events` (Q5 resolution).**
      - Stores returned `webhookId` on the binding.
    - On 4xx (insufficient permissions): logs warning, marks binding `webhookRegistered=false`, leaves polling-only.
    - `onBindingDelete(binding)`: best-effort `deregisterProjectWebhook`; deletion of binding proceeds regardless; secret credential is also deleted.
  - **Webhook dispatch routing (`src/http/webhook.ts` is owned by T-08; T-13 contributes the dispatch table consumed there):**
    - On `X-Gitlab-Event: Issue Hook` → enqueue as `kind: 'issue'`. If `body.object_attributes.confidential === true`, drop with `gitlab.confidential.skipped` metric (defense in depth — GitLab should not be sending these since we did not subscribe, but assert anyway).
    - On `X-Gitlab-Event: Note Hook` → enqueue as `kind: 'note'`. If the note's parent issue is confidential (check `body.issue.confidential`), drop with metric.
    - On `X-Gitlab-Event: Confidential Issue Hook` / `Confidential Note Hook` → drop with metric (should not arrive given subscription set; defense in depth).
    - Any other event header → 200 with no-op (graceful degradation if GitLab adds new event types).
  - Hook `src/http/binding.ts` from T-08 to call `onBindingCreate`/`onBindingDelete`.
- **Outputs (tests):** `tests/sync/binding-lifecycle.test.ts`:
  - Success path: secret length assertion (44 base64 chars), `webhookSecretRef` populated, only `issues_events` + `note_events` in the registration call (assert subscription set explicitly).
  - Permission-denied fallback (`webhookRegistered=false`).
  - Deregister-best-effort (failure does not block delete).
  - **Critic-required:** `GET /api/v1/bindings` response schema test (string-absence assertion for `webhookSecret`/`webhookSecretRef`).
  - Confidential issue webhook arriving anyway → dropped with metric.
- **Acceptance criteria:**
  - Tests pass.
  - `POST /api/v1/bindings` against a nock-mocked GitLab returns `{bindingId, webhookRegistered:true|false}` deterministically per fixture.
  - Secret length is 44 base64 chars (32 raw bytes); assertion does not pin a literal value.
- **Dependencies:** T-04 (webhooks adapter), T-08 (binding admin route surface). **Wave C parallel.**
- **Complexity:** S (~250 LOC).

---

### T-13b — Webhook Secret Rotation Endpoint (R4 orphan mitigation)

- **Owner:** Sonnet
- **Inputs:** T-13 outputs; R4 mitigation note.
- **Outputs:**
  - `src/http/binding.ts` — add `POST /api/v1/bindings/:id/rotate-secret` (bearer `ServerSecret`):
    - Generates a new 32-byte random secret.
    - Calls `credentials.rotate(binding.webhookSecretRef, newPlaintext)`.
    - Optionally re-registers the GitLab webhook with the new token (GitLab requires deregistering + reregistering or `PUT /projects/:id/hooks/:hook_id`); use `PUT` to update token in place.
    - Returns `{bindingId, rotatedAt}`. Plaintext secret never returned.
- **Outputs (tests):** add to `tests/sync/binding-lifecycle.test.ts`:
  - Rotation produces a new ciphertext (asserted by reading the encrypted blob before/after).
  - Webhook signature validation with the OLD secret returns 401 after rotation.
  - Webhook signature validation with the NEW secret returns 200 after rotation.
  - Endpoint requires bearer auth (401 without).
- **Acceptance criteria:**
  - Tests pass.
- **Dependencies:** T-13.
- **Complexity:** S (~100 LOC). Sub-task of T-13 per critic constraint.

---

### T-14 — Dockerfile + docker-compose for dev (full Huly stack — Q1 resolution)

- **Owner:** Sonnet
- **Inputs:**
  - `pod-github/Dockerfile`
  - **`/Users/dingo/huly-selfhost/compose.yml`** (the reference for the real Huly stack: nginx, cockroach, redpanda, minio, elastic, plus the Huly services — transactor, account, front, etc.)
  - spec §Component layout.
- **Outputs:**
  - `Dockerfile` — multi-stage: `node:22-bookworm-slim` builder running `npm ci && npm run build`, final `node:22-bookworm-slim` running `node lib/index.js`. Exposes 3600.
  - `docker/docker-compose.dev.yml` — **full Huly stack per Q1 resolution; NO stub transactor.**
    - Adapted from `huly-selfhost/compose.yml`: `nginx`, `cockroach`, `redpanda`, `minio`, `elastic`, and Huly services (`transactor`, `account`, `front`, `huly`, `kvs`, `stats`, `workspace`, etc. — exact list pulled from the upstream compose).
    - Plus `mongo` (mongo:7) — the pod's own state store, separate from the Huly stack's Cockroach/MinIO/Elastic.
    - Plus `gitlab` — **pinned to `gitlab/gitlab-ce:16.11.10-ce.0`** (the 16+ baseline floor per spec). Document a follow-up matrix variant for 17.x in T-16 README.
    - Plus `pod-gitlab` — built from repo Dockerfile, depends on mongo + gitlab + transactor, healthcheck on `/health`.
    - Volumes for gitlab config/logs/data; named volumes for cockroach/redpanda/minio/elastic.
    - `.env.example` documenting required env (covers both Huly stack env and pod env).
  - `docker/docker-compose.test.yml` — minimal compose used by CI for non-E2E suites (`mongo` + `pod-gitlab` only; GitLab interactions mocked at adapter layer for unit/integration suites).
  - `scripts/wait-for.sh` — small helper used by compose for ordering.
  - **`docs/architecture.md` note documenting realistic wall-time:** first cold-start of the full dev compose (including GitLab CE first-boot reconfiguration and Huly stack warm-up) is 10–15 minutes. Warm restarts are 1–3 minutes.
- **Acceptance criteria:**
  - `docker build -f Dockerfile -t huly-gitlab:dev .` exits 0.
  - `docker compose -f docker/docker-compose.test.yml up -d && docker compose -f docker/docker-compose.test.yml exec pod-gitlab wget -qO- http://localhost:3600/health` returns JSON with `status:"ok"` within 60s. Down afterward.
  - `docker compose -f docker/docker-compose.dev.yml up -d` brings the full stack to a state where `curl http://localhost:8929/api/v4/version` (GitLab) and the Huly transactor port both respond, within **15 minutes cold**.
- **Dependencies:** T-08.
- **Complexity:** M (~400 LOC config, up from S because the full Huly stack adds substantial wiring).

---

### T-15 — E2E Harness (full stack — Q1 resolution, no stub)

- **Owner:** Opus
- **Inputs:** spec §Success criteria; T-14 compose.
- **Outputs:**
  - `tests/e2e/setup.ts`:
    - Boots `docker-compose.dev.yml`.
    - Waits for GitLab `/api/v4/version` to return 200 (up to **10 minutes**).
    - Waits for Huly transactor TCP port readiness (up to **5 minutes**).
    - Creates a root personal access token via GitLab's seed script.
    - Creates a fresh GitLab project.
    - Creates a Huly workspace fixture **via the real Huly account service running in compose** (Q1 resolution — no stub).
    - Binds them via the pod admin API.
  - `tests/e2e/issues.e2e.test.ts`:
    - Create issue in GitLab → assert appears in Huly within 30s (webhook).
    - Create issue in GitLab → with webhook disabled, appears within ~6 min (polling).
    - Create issue in Huly → assert appears in GitLab within 30s.
    - Edit title/description/state/labels/milestone/assignees both directions → round-trip.
    - Concurrent conflicting edits → LWW resolves without data loss in non-conflicting fields.
    - Confidential issue created in GitLab → does NOT appear in Huly; `gitlab.confidential.skipped` metric incremented (Q5).
    - **Assertions hit BOTH the pod's REST/Mongo state AND direct queries against the real Huly transactor** (Q1 — now meaningful since the transactor is real).
  - `tests/e2e/notes.e2e.test.ts` — comment round-trip + confidential-note skip.
  - `tests/e2e/soak.e2e.test.ts` (opt-in, gated by env `E2E_SOAK=1`) — 1 hour of mixed traffic generator; asserts zero drift at end.
  - `jest.e2e.config.js` — separate config with `testTimeout: 900000` (15 min), `testMatch: ['**/tests/e2e/**/*.test.ts']`.
  - `npm run test:e2e` script wired in T-01 pointing at this config.
- **Acceptance criteria:**
  - `npm run test:e2e` exits 0 against the compose stack (excluding soak by default).
  - All round-trip tests assert via the pod's REST/Mongo state AND via direct GitLab API + Huly transactor queries.
  - Cold-start E2E (full compose-up + test suite) completes within **45 minutes** on a 4-core dev machine (up from 30 min per Q1 honesty); warm runs within **15 minutes**.
- **Dependencies:** T-13, T-13b, T-14.
- **Complexity:** L (~1400 LOC — up from 1200 since the harness now drives a real Huly transactor).

---

### T-16 — README + Architecture Docs

- **Owner:** Haiku
- **Inputs:** spec, all prior task outputs; Q1, Q3, Q5 resolutions.
- **Outputs:**
  - `README.md` — quickstart: requirements, env vars table, OAuth setup steps (mirror pod-github Readme.md shape), `docker compose up`, `curl` bind example, troubleshooting.
    - **Phase 1 limitations section (mandatory):**
      - Confidential issues / notes are not synced (Q5).
      - Multi-instance per workspace is deferred to Phase 4.
      - Attachment upload sync is link-through only.
      - Encryption key rotation is manual (Phase 2 work).
    - **Wall-time expectations:** cold-start dev compose 10–15 min; warm 1–3 min; first E2E run 30–45 min.
    - **GitLab version support:** CE/EE 16+ baseline; 16.11.10-ce.0 is the validated floor; 17.x is a follow-up matrix target.
  - `docs/architecture.md` — diagrams (mermaid) of layers, state collections, event flow webhook→engine→adapter↔huly, conflict resolution decision tree. Document the polling-always semantics from T-12 and the shared `BindingBreaker` between T-07 and T-12.
  - `docs/api.md` — admin REST endpoints with request/response examples (including `POST /api/v1/bindings/:id/rotate-secret` from T-13b).
  - `CONTRIBUTING.md` — branch model, commit style, `npm run lint`/`format` policy.
- **Acceptance criteria:**
  - `npx markdownlint-cli2 "**/*.md"` (devDep) exits 0.
  - All admin endpoints from T-08/T-09/T-13/T-13b documented in `docs/api.md` with at least one curl example each.
  - Phase 1 limitations section present and lists all four items above.
- **Dependencies:** T-13, T-13b, T-14, T-15.
- **Complexity:** S (~500 lines markdown).

---

### T-17 — CI + Release

- **Owner:** Sonnet
- **Inputs:** T-01..T-16 outputs.
- **Outputs:**
  - `.github/workflows/ci.yml` — on `push` and `pull_request`:
    - matrix `node: [22.x]`.
    - jobs: `lint`, `build`, `unit` (`npm test`), `integration` (`docker compose -f docker/docker-compose.test.yml up -d` then targeted integration subset), `e2e` (gated by label `e2e` or on push to `main`, runs the full GitLab CE + Huly harness).
    - artifacts: `coverage/`, `logs/`.
  - `.github/workflows/release.yml` — on tag `v*.*.*`: build Docker image, push to `ghcr.io/${{ github.repository_owner }}/huly-gitlab:${{ github.ref_name }}` and `:latest`. **Use `${{ github.repository_owner }}` interpolation, NOT a literal `{owner}` placeholder.**
  - `Makefile` with shortcuts: `make lint`, `make test`, `make e2e`, `make docker`, `make compose-up`, `make compose-down`.
- **Acceptance criteria:**
  - **CI green on a draft PR** (the disjunction with `act -j lint` is dropped per critic — `act` cannot fully emulate compose-based jobs, so the draft-PR validation is the authoritative path).
  - `make e2e` from a clean checkout reaches green within **45 minutes** cold / 15 minutes warm on a 4-core dev machine (revised from 30 min per Q1).
- **Dependencies:** T-15, T-16.
- **Complexity:** S (~250 lines yaml + make).

---

## 4. Testing Plan

| Layer | Tasks owning tests | Command |
|---|---|---|
| Config/env | T-02 | `npm test -- src/config` |
| State (Mongo) | T-03 | `npm test -- src/state` (uses `mongodb-memory-server`) |
| Adapter (REST/GraphQL) | T-04 | `npm test -- tests/adapter` (nock@^14) |
| Markdown round-trip | T-05 | `npm test -- tests/markdown` |
| HulyClient/identity | T-06 | `npm test -- tests/huly` |
| Sync engine core | T-07 | `npm test -- tests/sync/engine` |
| HTTP routes | T-08 | `npm test -- tests/http` (supertest) |
| OAuth/credentials | T-09 | `npm test -- tests/auth` (full nock OAuth flow) |
| Issues sync | T-10 | `npm test -- tests/sync/issues` |
| Notes sync | T-11 | `npm test -- tests/sync/notes` |
| Backfill scheduler | T-12 | `npm test -- tests/sync/backfill` |
| Webhook lifecycle + rotate | T-13, T-13b | `npm test -- tests/sync/binding-lifecycle` |
| End-to-end (full compose) | T-15 | `npm run test:e2e` |
| Soak (opt-in) | T-15 | `E2E_SOAK=1 npm run test:e2e -- --testPathPattern=soak` |

**Local developer loop:**
- Unit: `npm test` (excludes e2e).
- Integration: `npm run test:integration` → starts `mongodb-memory-server` + a nock-backed GitLab; no docker required.
- E2E: `make compose-up && npm run test:e2e && make compose-down` (45 min cold / 15 min warm).

---

## 5. Build & Verification Commands (Phase 3 QA reference)

Run from `/Users/dingo/huly-gitlab`:

```bash
# Install
npm ci

# Static checks
npm run lint
npm run format -- --check

# Build
npm run build                     # tsc -p .

# Unit + integration (no docker)
npm test

# Docker image
docker build -t huly-gitlab:local .

# Dev stack (full Huly + GitLab + pod; cold start 10-15 min)
docker compose -f docker/docker-compose.dev.yml up -d
curl http://localhost:3600/health

# End-to-end (full stack)
make e2e                          # 45 min cold, 15 min warm

# Soak (optional)
E2E_SOAK=1 npm run test:e2e -- --testPathPattern=soak
```

Acceptance for Phase 1 release (matches spec §Success Criteria):
1. `docker compose ... up` succeeds; `/health` returns 200.
2. `make e2e` exits 0, covering OAuth + Access Token + binding + webhook + polling + round-trip for issues and notes + confidential-skip assertion.
3. `npm test` exits 0; coverage report uploaded.

---

## 6. Risk Register

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Huly packages on npm are publish-only artifacts and lack the server-side runtime context pod-github relies on. Out-of-tree consumption may surface missing peer deps. | **Low** (downgraded from High — smoke install of full pinned list succeeded per Q3 resolution; 496 packages installed cleanly) | High | Keep as defensive note. If a runtime import fails despite clean install, narrow consumption — Phase 1 only strictly needs `core`, `platform`, `account-client`, `server-client`, `server-token`, `client`, `client-resources`, `text`, `text-markdown`, `tracker`, `chunter`, `contact`, `query`, `task`, `analytics`, `analytics-service`. |
| R2 | GitLab CE container takes ~3–5 min to become healthy on first boot, making CI flaky and slow. With the full Huly stack added (Q1 resolution), cold-start is now 10–15 min total. | High | Medium | Cache GitLab + Huly data volumes in CI; preflight wait loops: 10 min for GitLab, 5 min for Huly transactor; soak test opt-in only; allow running issues/notes tests against a recorded fixture mode (`E2E_MODE=record|replay`) for fast local iteration. |
| R3 | LWW with field-level timestamps can lose updates when GitLab webhook timestamps lag webhook delivery (event time vs payload `updated_at`). | Medium | Medium | Always use the payload's `updated_at` (not delivery time); for ties, prefer the side whose stored cursor is older to avoid feedback loops; cover the 8-case matrix in T-07/T-10 tests; add structured log of every LWW decision with both timestamps. |
| R4 | Per-binding webhook secret leak via admin endpoints. | Low | High | Secret stored in `credentials` collection (NOT `bindings`) per R6 resolution; `GET /api/v1/bindings` projects `webhookSecretRef` away; explicit test asserts string absence; rotation endpoint `POST /api/v1/bindings/:id/rotate-secret` shipped in T-13b. |
| R5 | Markdown round-trip fidelity on GitLab-specific syntax (`~label`, `%milestone`, `@user`, `#123`, `!123`, `/quick actions`) — Phase 1 does not resolve these, but the round-trip must not mangle them. | Medium | Medium | T-05 fixture suite covers all six tokens plus `/uploads/...` attachment-link-through (spec coverage gap); quick-action commands at start of line are preserved verbatim; reject Phase 1 if any fixture mutates these tokens. |
| **R6** | **Per-binding webhook secret schema inconsistency.** Original plan stored `webhookSecret` plaintext in `bindings`. | Medium | High | **Resolved by schema change in T-03:** secret moved into the `credentials` collection with `kind:'webhook_secret'` and AES-256-GCM encryption. `bindings.webhookSecretRef` is the only reference. |
| **R7** | **Sync queue key granularity.** Original `(workspaceUuid, bindingId)` serializes unrelated issues from the same project unnecessarily. | Low | Medium | **Resolved by key refinement in T-07:** queue keyed on `(workspaceUuid, bindingId, resourceKey)` where `resourceKey = issueIid | noteId | '*'`. Trade-off (linear memory growth) bounded by 1000-entry LRU per binding. |
| **R8** | **GitLab webhook payload size.** Active issues with many notes can produce payloads > 100kb default. | Medium | Medium | T-08 sets `body-parser` JSON limit to `5mb`; emit `gitlab.webhook.rejected.size` metric and alert on rejections. |
| **R9** | **Stub-guest contact spam.** Duplicate stubs for the same unmatched GitLab user across many notes. | Medium | Low | T-06 `ensureStubGuest` deduplicates on `(workspaceUuid, gitlabUserId)`; idMap kind `user` stores the mapping; cache TTL 5 min. Phase 2 follow-up: cleanup job converts orphaned stubs after 90 days. |
| **R10** | **GraphQL feature-flag dead code.** Original `Capabilities.featureFlags: Record<string,boolean>` had no Phase 1 consumer. | Low | Low | T-04 `featureFlags` narrowed to a **closed** object type with two named keys: `'graphql.issue.notes'` (consumed by T-11 batched note fetch) and `'graphql.issue.batchedNotes'` (consumed by T-04 `graphql<T>` fallback). Code comments cite the consumer for each flag. |

---

## 7. Open Questions for Executors

1. ~~**Q1 — E2E Huly transactor.**~~ **RESOLVED.** Full Huly stack in `docker-compose.dev.yml` per `huly-selfhost/compose.yml` reference. No stub. Realistic cold-start 10–15 min, E2E run 30–45 min. See T-14/T-15.
2. **Q2 — Issue priority mapping.** GitLab has no native priority field (only labels with conventions like `priority::1`). Should Phase 1 map labels `priority::*` to Huly `IssuePriority`? **Default assumption:** no — Phase 1 leaves priority as `IssuePriority.NoPriority` on remote-originated issues and does not propagate Huly priority to GitLab. Surface as label `huly::priority::{Urgent|High|...}` from Huly→GitLab only.
3. ~~**Q3 — Server-side hcengineering packages.**~~ **RESOLVED.** Smoke install of the full T-01 pinned list at `^0.7.423` exited 0 and installed 496 packages. R1 likelihood downgraded to Low.
4. **Q4 — Encryption key rotation.** Plan stores `CredentialEncryptionKey` as a single env var. No rotation strategy in Phase 1. **Default assumption:** documented as a Phase 1 limitation in T-16 README; rotation is Phase 2 work.
5. ~~**Q5 — Confidential issues.**~~ **RESOLVED → Phase 1 limitation.** Confidential issues and confidential notes are not synced. Webhook does not subscribe to confidential events; backfill filters them out; metric `gitlab.confidential.skipped` per binding per cycle. Revisit in Phase 4 when ACL mapping ships. T-10 has no model mixin and no migration script.
6. **Q6 — Multi-credential per workspace.** Phase 1 scope says "one Huly workspace ↔ one GitLab instance," but multiple bindings against the same GitLab using different credentials (OAuth user vs project access token) is implicitly allowed. **Default assumption:** allowed; `credentialRef` is per-binding.

Executors must answer or escalate the remaining open questions (Q2, Q4, Q6) before completing the affected task.

---

## 8. Change log (v1 → v2)

**Resolved open questions applied:**
- **Q1 → full Huly stack:** T-14 now references `/Users/dingo/huly-selfhost/compose.yml` and includes real Huly services (transactor, account, front, cockroach, redpanda, minio, elastic, etc.) + GitLab CE + Mongo + pod. Stub transactor dropped. T-15 setup queries the real Huly transactor; cold-start ceiling raised to 45 min, warm 15 min. T-17 makefile ceiling raised accordingly. R2 mitigation updated.
- **Q3 → smoke install passed:** R1 likelihood downgraded High → Low. T-01 pinned list no longer "tentative." Q3 marked resolved in §7.
- **Q5 → skip confidential entirely:** T-04 adapter filters `confidential:true` from `listIssues` / `listNotes` and emits `gitlab.confidential.skipped` metric. T-13 webhook subscription excludes `confidential_*_events`. T-13 dispatch dropper for any confidential events that arrive anyway (defense in depth). T-10 mixin `tracker.mixin.IssueGitlab` removed; no model migration script. T-16 README documents as Phase 1 limitation. Q5 marked resolved in §7.

**Concrete bug fixes in T-01:**
- Removed `node-fetch@^3.3.2` (ESM-only, breaks under CommonJS); switched to global Node 22 `fetch`.
- Removed `axios` (unused; adapter uses `fetch`).
- Bumped `nock` to `^14.0.0` (v13 incompatible with Node 22).
- Bumped `eslint-plugin-n` to `^16.6.2` (peer match for standard-with-typescript@40 range).
- Switched from deprecated `eslint-config-standard-with-typescript@40` to `eslint-config-love@^43.1.0`.
- Removed `--passWithNoFiles` invalid flag note from acceptance criterion; placeholder `src/index.ts` ensures eslint always has a target.
- `tsconfig.json` now includes `types: ["jest","node"]`, `resolveJsonModule: true`, `sourceMap: true`, `incremental: true`.
- `jest.config.js` now includes `collectCoverageFrom: ['src/**/*.ts','!src/**/*.test.ts']` so T-03 coverage criterion is measurable.

**T-02 corrections:**
- `OAuthRedirectUri` derived from `${PublicBaseUrl}/oauth/callback`; removed as standalone env var.
- `ts-node` smoke command in acceptance replaced with a Jest test that imports `./src/config`.

**T-03 corrections (R6):**
- `bindings.webhookSecret` plaintext field removed; replaced by `webhookSecretRef` pointing to an encrypted `credentials` row with `kind:'webhook_secret'`.
- `credentials.kind` extended to include `'webhook_secret'`; `rotate(id, newPlaintext)` method added.

**T-04 corrections:**
- Enumerated 12 required test fixtures (rate-limit integer/HTTP-date, GraphQL ping success/failure, capability cache TTL, CE/EE detection, confidential filter).
- `listIssues` and `listNotes` filter `confidential:true` and emit metric (Q5).
- `Capabilities.featureFlags` narrowed from open `Record<string,boolean>` to closed object with two named flags, each citing its consumer (R10).

**T-06 corrections:**
- `AccountClient.findPersonBySocialKey` corrected to return `PersonUuid | undefined` (was incorrectly typed as `PersonId`).
- Social-key formats frozen: `gitlab:{oauth_subject}` and `email:{lowercased_email}`.
- `ensureStubGuest` deduplicates on `(workspaceUuid, gitlabUserId)` (R9).
- Mixin removed (Q5); replaced with runtime-only marker on the stub `Person`.

**T-07 corrections:**
- 8-case LWW matrix enumerated (was "at least 8").
- Crash-recovery test now mandatory: stale `inflight` op (>1h) discarded with metric; fresh op resumed.
- `EventQueue` keying changed to `(workspaceUuid, bindingId, resourceKey)` (R7).
- `BindingBreaker` extracted as a shared service so engine consults the same breaker state as backfill (critic shared-state gap).
- `SyncManager` interface and `idMap` kind list listed as day-1 deliverables to unblock Wave C parallel kickoff.

**T-08 corrections:**
- `X-Gitlab-Token` validation clarified as `crypto.timingSafeEqual` shared-secret compare (NOT HMAC — spec wording was incorrect).
- `body-parser` JSON limit set to `5mb` (R8); 413 with metric on oversized payloads.
- `/api/v1/bindings` response asserted to not leak any secret (R4).
- 5s boot+health acceptance noted as soft-dependent on T-09 `CredentialResolver` landing.

**T-09 corrections:**
- Added nock-mocked integration test for the full OAuth flow as primary acceptance; manual smoke demoted to documented secondary validation.

**T-10 corrections:**
- Removed mixin / migration script (Q5).
- Added attachment link-through round-trip test (`/uploads/...` byte-identical).
- Added test that confidential issues from adapter never enqueue.

**T-11 corrections:**
- Confidential filter deferred to adapter (Q5).
- Stub-guest dedup asserted (R9).
- GraphQL batched-fetch path explicitly tied to `featureFlags['graphql.issue.notes']` (R10 consumer).
- Dependency narrowed to T-10's contract (`resolveIssueRef` helper signature) rather than its implementation, enabling Wave C parallelism.

**T-12 corrections:**
- Polling-vs-webhook semantics decided: polling runs for ALL bindings regardless of `webhookRegistered` (defense in depth); documented in code and architecture doc.
- Disabled-binding-skip test added.
- Cursor-regression test added (future-timestamp clamped + warning).
- Shared `BindingBreaker` instance per T-07 shared-state gap.
- Dependency narrowed to T-07 interface only; promoted to Wave C parallel.

**T-13 corrections:**
- Webhook subscription set restricted to `issues_events`, `note_events` only (Q5).
- Dispatch routing on `X-Gitlab-Event` enumerated: `Issue Hook`, `Note Hook`, with confidential drop as defense in depth.
- Per-binding secret generation: assert length (44 base64 chars from 32 raw bytes), NOT literal value.
- `GET /api/v1/bindings` schema-absence assertion added.
- Dependency narrowed to T-04 + T-08 surface; promoted to Wave C parallel.

**T-13b added (R4 orphan):**
- New sub-task: `POST /api/v1/bindings/:id/rotate-secret` admin endpoint with credential rotation + GitLab webhook token update. Tests cover old-secret-rejected / new-secret-accepted / auth-required.

**T-14 corrections (Q1):**
- `docker-compose.dev.yml` now includes the full Huly stack from `huly-selfhost/compose.yml` reference (nginx, cockroach, redpanda, minio, elastic, transactor, account, front, etc.) plus mongo + gitlab + pod.
- GitLab pinned to `gitlab/gitlab-ce:16.11.10-ce.0` (16+ floor); 17.x is follow-up matrix.
- Wall-time documented honestly: 10–15 min cold start.
- Complexity bumped S → M.

**T-15 corrections (Q1):**
- Stub-transactor option dropped. Real Huly transactor in compose.
- Wait loops: 10 min GitLab, 5 min Huly transactor.
- E2E assertions now hit real Huly transactor (meaningful now).
- Confidential-skip E2E assertion added.
- Timeout raised to 15 min per test (900000ms).
- Complexity bumped L (1200 → 1400 LOC).

**T-16 corrections:**
- Added mandatory Phase 1 limitations section: confidential not synced (Q5), multi-instance deferred, attachment link-through only, encryption key rotation manual (Q4).
- Wall-time expectations documented (cold/warm).
- GitLab version floor (16.11.10) and follow-up 17.x noted.
- Added T-13b rotate-secret endpoint to api.md scope.

**T-17 corrections:**
- `{owner}` literal replaced with `${{ github.repository_owner }}` in release.yml.
- `act -j lint` disjunction dropped; CI green on draft PR is the authoritative path.
- `make e2e` ceiling raised to 45 min cold / 15 min warm.

**DAG corrections:**
- T-10, T-11, T-12, T-13 promoted to Wave C parallel (was sequential T-10→T-11→T-12→T-13). Gating contracts: T-07 `SyncManager` interface and T-04 `idMap` kinds committed day-1 of Wave B.
- T-13b added as sub-task of T-13 within Wave C.

**Risk register additions:**
- R6 (secret schema), R7 (queue granularity), R8 (webhook payload size), R9 (stub-guest spam), R10 (feature-flag dead code) added with mitigations applied to T-03/T-04/T-07/T-08/T-13.

**Spec coverage gaps closed:**
- Attachment link-through: T-05 fixture + T-10 round-trip assertion.
- Polling-only-when-webhook-down: decided as polling-always (defense in depth); documented in T-12 + architecture doc.
- Real-time circuit-breaker shared state: shared `BindingBreaker` between T-07 and T-12.
- Crash-recovery test: T-07 mandatory.
