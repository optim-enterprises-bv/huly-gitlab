# Deep Interview Spec: Huly GitLab Integration — Phase 1

**Date:** 2026-06-05
**Status:** Approved through brainstorming with user
**Scope:** Phase 1 of 4-phase integration plan
**Ambiguity gate:** ≤ 20% (decisions captured below are explicit)

## Problem

Huly platform ships a GitHub integration (`services/github/` in `hcengineering/platform`) but has no GitLab equivalent. Three upstream feature requests exist (#6653, #7061, #9743) with no work in progress, no PRs, no third-party forks. Users running self-hosted GitLab cannot use Huly's tracker as a synchronized view of their GitLab issues and merge requests.

## Scope (Phase 1)

Build a standalone out-of-tree pod (`pod-gitlab`) that delivers two-way Issues sync between a Huly workspace and one or more bound GitLab projects. This phase includes all the foundation work (OAuth, repo binding, webhook receiver, polling, markdown adapter) needed for later phases.

### In scope (Phase 1)
- New repo: `huly-gitlab` (separate from `hcengineering/platform` monorepo)
- Pod skeleton: Express HTTP surface, MongoDB state store, Huly transactor client
- Auth: OAuth 2.0 user flow + Group/Project Access Token for service accounts (no PAT)
- Repo/project binding: user picks GitLab projects to mirror into Huly tracker projects
- Webhook receiver: per-project webhooks auto-registered when binding
- Polling fallback: every 5 min, uses `updated_after` filters and stored cursors
- GitLab API adapter: REST v4 as floor, GraphQL with capability detection on top
- Markdown adapter: GitLab Flavored Markdown ↔ Huly text (TipTap ProseMirror)
- Issues sync (two-way):
  - Title, description, state (open/closed → Huly statuses)
  - Labels (mapped to Huly labels, autocreated as needed)
  - Milestones (mapped to Huly milestones)
  - Assignees (mapped via user identity layer)
  - Notes/comments two-way
- Conflict resolution: last-write-wins by timestamp, field-level
- User identity: OAuth-authorized users mapped to Huly accounts by email + GitLab OAuth subject; unmatched commenters surface as stub guest contacts with a `gitlab` mixin

### Explicitly out of scope (later phases)
- Merge Requests (Phase 2)
- Code review threads, line comments, approvals (Phase 3)
- Custom field mapping, iterations, epics (Phase 4)
- Upstream PR to hcengineering/platform (separate workstream)
- gitlab.com SaaS production hardening (works architecturally; validated against self-hosted first)
- Multi-instance per workspace (deferred; one Huly workspace ↔ one GitLab instance for Phase 1)
- Attachment upload sync (link-through only in Phase 1)

## Key Decisions (from brainstorming)

| # | Decision | Choice |
|---|---|---|
| 1 | Scope shape | Full parity via 4-phase decomposition; this spec is Phase 1 |
| 2 | Deployment target | Self-hosted first; gitlab.com works via configurable base URL |
| 3 | Auth | OAuth 2.0 + Group/Project Access Token; no PAT |
| 4 | Code home | Out-of-tree pod, consuming `@hcengineering/*` from npm |
| 5 | API | REST v4 floor; GraphQL layered with capability detection (EE/version aware) |
| 6 | Conflict resolution | Last-write-wins by timestamp, field-level |
| 7 | Change capture | Webhooks primary + 5-min polling fallback |
| 8 | Architecture | Sync engine core + GitLab adapter (provider-agnostic core) |

## Architecture

### Layers
1. **HTTP surface** (Express): `/webhook/:installationId`, `/oauth/callback`, `/health`
2. **Sync engine** (provider-agnostic core):
   - `EventQueue` — ordered per `(workspace, project)`
   - `SyncRunner` — pulls events, applies via Mapper
   - `Mapper` — Huly model ↔ canonical `SyncIssue`/`SyncNote` records
   - `ConflictResolver` — timestamp LWW per field
   - `BackfillScheduler` — 5-min polling per bound project
3. **HulyClient** — connects to Huly account service + per-workspace transactor using `@hcengineering/account-client` and `@hcengineering/server-client`
4. **GitLabAdapter** — REST always, GraphQL when supported; capability detection at startup; returns canonical typed records

### Adapter boundary
The sync engine never sees raw GitLab JSON. The adapter returns `SyncIssue`, `SyncNote`, `SyncProject`, `SyncUser` canonical types. This makes the engine unit-testable with a fake adapter and makes future Gitea/Forgejo work an adapter swap.

### State store
- MongoDB (configurable URI; can share Huly's instance)
- Collections:
  - `bindings` — workspace ↔ GitLab project bindings (project IDs, credentials reference, webhook secret)
  - `cursors` — last-sync timestamp per binding
  - `idMap` — `gitlab_id` ↔ `huly_ref` mappings (issues, notes, users, labels, milestones)
  - `dedup` — `(project_id, event_id, version)` for webhook+poll idempotency
  - `inflight` — operations currently being applied, for crash recovery
  - `credentials` — encrypted OAuth tokens / access tokens

### Capability detection
On adapter startup: query `GET /api/v4/version` + GraphQL introspection. Record GitLab version, CE/EE, and which GraphQL fields exist. `adapter.supports('graphql.issue.notes')` etc. drive degradation paths. Capabilities cached with 1-hour TTL.

### Webhook auto-registration
When user binds a Huly project to a GitLab project: pod registers a project webhook pointed at `{publicBaseUrl}/webhook/{installationId}` with a per-binding secret. Requires the credential to have Maintainer role on the GitLab project. If registration fails, pod logs warning and falls back to polling-only for that project.

## Component Layout

```
huly-gitlab/
├── package.json                       # @hcengineering/* (npm versions, pinned)
├── tsconfig.json
├── src/
│   ├── index.ts                       # entry, Express bootstrap
│   ├── config.ts                      # env config
│   ├── http/
│   │   ├── webhook.ts                 # GitLab webhook receiver + signature check
│   │   ├── oauth.ts                   # OAuth code → token, refresh handling
│   │   └── health.ts
│   ├── adapter/
│   │   ├── gitlab-client.ts           # REST + GraphQL wrapper with retry
│   │   ├── capabilities.ts            # version / EE detection
│   │   ├── webhooks.ts                # register/deregister project webhooks
│   │   └── types.ts                   # canonical Sync* types
│   ├── sync/
│   │   ├── engine.ts                  # SyncRunner, EventQueue
│   │   ├── mapper.ts                  # Sync* ↔ Huly model
│   │   ├── conflict.ts                # LWW resolver
│   │   ├── backfill.ts                # 5-min polling scheduler
│   │   └── issues.ts                  # issue-specific mapping
│   ├── huly/
│   │   ├── client.ts                  # HulyClient wrapping account + transactor
│   │   ├── users.ts                   # identity mapping + stub guest creation
│   │   └── projects.ts                # tracker project lookup/creation
│   ├── markdown/
│   │   ├── gfm-to-huly.ts             # GitLab markdown → ProseMirror JSON
│   │   └── huly-to-gfm.ts             # ProseMirror → GitLab markdown
│   └── state/
│       ├── store.ts                   # Mongo collections accessor
│       ├── bindings.ts
│       ├── cursors.ts
│       ├── idmap.ts
│       ├── dedup.ts
│       └── credentials.ts             # encryption at rest (AES-256-GCM)
├── tests/
│   ├── adapter/                       # GitLab adapter unit tests (fake fetch)
│   ├── sync/                          # engine tests with fake adapter
│   └── e2e/                           # docker-compose harness (local GitLab CE)
├── docker/
│   ├── Dockerfile
│   └── docker-compose.dev.yml         # GitLab CE + Mongo + pod for dev
├── docs/
│   └── architecture.md
└── README.md
```

## Error Handling
- All GitLab API calls go through a retrying client with exponential backoff and respect for `Retry-After` headers
- Per-binding circuit breaker: 5 consecutive failures pauses sync for that binding for 15 min, then half-opens
- Webhook signature validation (compare `X-Gitlab-Token` to stored per-binding secret); reject mismatched 401
- All Huly writes use idempotent transactions via `TxOperations`
- Structured JSON logging with correlation IDs per event flow
- Crash recovery: on boot, scan `inflight` collection and resume/discard pending ops

## Testing Strategy
- **Unit:** sync engine with mock adapter; mapper with hand-crafted Sync* fixtures; conflict resolver with timestamp matrix; LWW edge cases (equal timestamps, missing timestamps)
- **Adapter:** record/replay against GitLab REST/GraphQL fixtures; capability detection across CE/EE and versions 15/16/17
- **Integration:** docker-compose with GitLab CE, Mongo, and the pod; tests issue create/update/comment round-trips end-to-end
- **Manual smoke:** README walkthrough binding a real GitLab project to a Huly tracker project

## Success Criteria (Phase 1 acceptance)
1. Pod builds in Docker; image runs and reports `/health` 200
2. OAuth flow + Access Token flow both work against self-hosted GitLab CE 16+
3. Binding a GitLab project to a Huly tracker project succeeds and registers a webhook
4. Issue created in GitLab appears in Huly within 30s (webhook) or 5min (polling fallback)
5. Issue created in Huly appears in GitLab within 30s
6. Edits (title, description, state, labels, milestone, assignees, comments) round-trip both directions
7. Conflicting concurrent edits resolve via LWW without data corruption
8. Two-way sync stable over 1 hour of mixed traffic in the integration test harness
9. Unit + integration tests pass; e2e suite passes against GitLab CE in CI

## Open Questions (deferred)
- Multi-instance support (workspace ↔ multiple GitLab instances) — Phase 4
- Attachment upload sync — Phase 2 or 3
- Status mapping when GitLab issue board lists are richer than open/closed — Phase 4
- Upstream contribution path to hcengineering/platform — separate workstream

## Phasing (future cycles)
- Phase 1 (this spec): Issues + foundation
- Phase 2: Merge Requests, MR comments, MR state
- Phase 3: Code review depth (threads, line comments, approvals)
- Phase 4: Custom field mapping, iterations, epics (EE), multi-instance
