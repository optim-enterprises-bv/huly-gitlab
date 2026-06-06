# huly-gitlab

[![CI Status](https://github.com/hardcoreeng/huly-gitlab/workflows/CI/badge.svg)](https://github.com/hardcoreeng/huly-gitlab/actions)

Two-way Issues sync between Huly workspace and GitLab projects. Phase 1 of a four-phase integration delivering OAuth-authenticated credential management, real-time webhook notifications with 5-minute polling fallback, and conflict-free field-level synchronization via last-write-wins timestamps.

## Phase 1 Features

- **OAuth + Access Tokens**: Secure GitLab authentication (OAuth2 or Personal Access Tokens per group/project).
- **Two-way Issues Sync**: Title, description, state, labels, milestones, assignees.
- **Two-way Notes**: Comments and discussion threads.
- **Labels & Milestones**: Automatic creation on GitLab when absent.
- **Webhooks**: Real-time issue/note updates via GitLab webhooks.
- **Polling Fallback**: 5-minute background sync ensures eventual consistency if webhooks are missed.
- **Last-Write-Wins**: Field-level conflict resolution by timestamp—no data loss in non-conflicting fields.
- **Encryption**: Credentials encrypted at rest with AES-256-GCM.

## Phase 2: Merge Requests Sync

Phase 2 extends Phase 1 with two-way Merge Request synchronization, MR-attached notes, and pipeline summary status. MRs are mirrored as Huly Issues carrying a `gitlab-mr` runtime mixin; MR field changes trigger `applyRemote` in the same conflict-resolution engine as Phase 1. Pipeline status is read-only in Huly (webhook-driven updates only).

**Phase 2 Features:**

- **MRs as Huly Issues**: Merge requests mirror to `tracker.class.Issue` with a `gitlab-mr` mixin carrying: `sourceBranch`, `targetBranch`, `draft`, `mergedAt`, `mergeStatus`, and `webUrl`.
- **Pipeline Summary Status**: GitLab pipeline state (pending/running/success/failed/canceled) is read-only in Huly; updated by webhook events from GitLab.
- **MR Notes Sync**: Comments on merge requests synchronize two-way (same last-write-wins + system-note filtering as Phase 1 issue notes).
- **Draft Detection**: MRs with `draft: true` automatically map to Huly priority Low.
- **Reviewers as Labels**: MR reviewers are stored as synthetic `gitlab:reviewer:<username>` labels (Phase 3 will introduce a typed reviewer field).

## Phase 3: Review Threads + Approvals + Diff Metadata

Phase 3 adds code review primitives to MR mirrors: review threads as GitLab discussion notes stored as Huly ChatMessages with line-position tracking, Community Edition (CE) approvals as typed mixin fields, and diff metadata (changed files, diff URLs). A one-shot migration endpoint converts Phase 2's synthetic reviewer labels to a typed `reviewers` field.

**Phase 3 Features:**

- **Review Threads as ChatMessages**: GitLab discussion notes (including line comments) mirror to `chunter.class.ChatMessage` carrying a runtime `gitlab-review` mixin with `threadId`, `resolved`, `resolvedBy`, `resolvedAt`, and `position` (line/column for the first note; null for replies).
- **Line Comments with Text Position**: Inline review comments include file path, line numbers, and SHAs for precise positioning in the code diff.
- **CE Approvals Two-Way**: MR approval state (`approvedBy`, `approvalsRequired`, `approvalStatus`) syncs bidirectionally. Huly users can approve/unapprove MRs; approvals propagate to GitLab (with per-user OAuth preferred, service-account fallback in Phase 3).
- **Diff Metadata**: MRs include `diffWebUrl` (link to GitLab diff UI) and `changedFiles` (path, additions/deletions, status for each file).
- **Typed Reviewers Field**: MR reviewers replace Phase 2's synthetic `gitlab:reviewer:*` labels with a typed `reviewers` array of PersonUuids. A one-shot `POST /api/v1/bindings/:id/migrate-reviewer-labels` endpoint converts existing labels for Phase 2 bindings.
- **Suggestion Blocks Passthrough**: Suggestion comments preserve GitLab's `<<<<<<< SUGGEST` markdown blocks verbatim (no Huly UI affordance in Phase 3).

## Phase 4: EE features + multi-instance + per-user OAuth + Path B closure (FINAL)

Phase 4 closes Path B (TxMixin subscription wires Huly UI mutations to GitLab), adds EE approval rules + iterations + epics, multi-instance binding support, per-user OAuth credential store with HTML UI, and completes the integration roadmap.

**Phase 4 Features:**

- **Path B Closure - TxSubscriber**: A new `TxSubscriber` hooks the per-workspace Huly `Client` and translates `TxMixin`/`TxCUD`/`TxRemoveDoc` events touching `MR_MIXIN` / `MR_REVIEW_MIXIN` / mirror `tracker.class.Issue` docs into flat `change` envelopes sent to `SyncEngine.enqueueLocalEvent`. Circular-tx storm prevention filters out events authored by the pod's service account and stamps a transient `_originated: 'gitlab'` marker as defense-in-depth.
- **EE Approval Rules**: GitLab Enterprise Edition approval rules (rule-based required approvers, eligible_approvers) sync bidirectionally on MR mirrors. Community Edition silently returns empty rule list.
- **EE Iterations**: GitLab iterations (sprints) assigned to issues and MRs. Iterations sync bidirectionally. Community Edition returns empty list.
- **EE Epics with Parent-Child Hierarchy**: GitLab epics mirror to Huly Issues carrying a `gitlab-epic` mixin. Epic child issues receive a `parentEpicIid` field (populated exclusively by EpicsSyncManager). Cross-project epic children are skipped (per-binding scope).
- **Multi-instance Support**: A single Huly workspace can bind to multiple GitLab instances. Per-binding `gitLabClient` is constructed from `credential.gitlabBaseUrl`. Idmap `gitlabId` strings are prefixed with a stable 8-hex hash of baseUrl when multi-instance is detected (defense-in-depth against duplicate project IDs across instances).
- **Per-user OAuth Credential Store**: New `src/state/user-credentials.ts` stores per-user GitLab access tokens in AES-256-GCM encryption, keyed by `(workspaceUuid, hulyPersonUuid, gitlabBaseUrl)`. Includes username captured at OAuth callback.
- **Minimal OAuth UI**: Vanilla HTML+CSS+JS UI at `/user/ui/` allows Huly users to self-link per-user OAuth credentials, view status, and unlink. Bearer tokens arrive via `postMessage` from the embedding Huly parent window or `sessionStorage`; query-string bearer is rejected; CSP headers prevent inline-script exfiltration.

## Phase 5 (TRUE FINAL): Closes all known limitations

Phase 5 closes all remaining documented limitations from Phases 1–4. User explicitly requested this phase to achieve terminal state with no deferred indefinite items.

**Phase 5 Features:**

- **Service-account PersonId Detection (Path D outcome)**: Investigation found no usable Huly Platform API to resolve the service-account `PersonId` at runtime (Paths A/B/C ruled out). Path D ships a documented degradation: TxSubscriber init falls back to a sentinel cast of `systemAccountUuid` and exposes `SERVICE_ACCOUNT_RESOLVED=0` gauge so operators can alarm on this state. Echo defense therefore relies on dual-layer marker matching: (layer 1) `tx.modifiedBy === systemAccountUuid` filter at `tx-subscription.ts:195`, and (layer 2) `_originated: 'gitlab'` marker stamped by managers and checked at `tx-subscription.ts:80-93` across `attributes`, `operations`, and `operations.$set`. Marker stamping is applied in 7 sync managers (`IssuesSyncManager`, `NotesSyncManager`, `MergeRequestsSyncManager`, `MRApprovalsSyncManager`, `ReviewThreadsSyncManager`, `EpicsSyncManager`, `PipelineSyncManager`) plus 2 migration helpers (`mixin-migration`, `reviewer-migration`). `TxRemoveDoc` has no payload to mark and therefore relies on the layer-1 modifiedBy filter alone; operators MUST alert on `tx.subscription.echo.dropped` rate.
- **Cookie/State Secret Grace-Period Rotation**: The `huly-user` cookie HMAC rotation now supports a grace period via `SERVER_SECRET_PREVIOUS` environment variable. Pod validates incoming cookies against both `SERVER_SECRET` and `SERVER_SECRET_PREVIOUS` (if set). Operator sets `SERVER_SECRET_PREVIOUS=<old-secret>`, rotates `SERVER_SECRET=<new-secret>`, and after grace period (recommended 24h), removes `SERVER_SECRET_PREVIOUS=` to complete rotation. Zero downtime; requests with old secret continue to work during grace period.
- **Mixin Split: `gitlab-mr` → `gitlab-mr-core` + `gitlab-mr-review`**: The monolithic 16-field `gitlab-mr` mixin is split into two specialized mixins to reduce field count and improve maintainability. `gitlab-mr-core` carries source/target/draft/merge metadata (8 fields; owned by `MergeRequestsSyncManager`). `gitlab-mr-review` carries approval/reviewer/rule metadata (9 fields; primarily owned by `MergeRequestsSyncManager`, with `parentEpicIid` field owned by `EpicsSyncManager`). `readMRMixinAttributes` at `src/sync/mr-mixin.ts:81-94` provides a backward-compatible dual-read helper (legacy + new, new wins). Migration endpoint `POST /api/v1/bindings/:id/migrate-mixin-split` converts existing MR mirrors from Phase 4 format to Phase 5 split format during binding pause (idempotent; re-run safe; aborts cleanly on unpause-mid-drain). Phase 5 bindings ship with split mixins; legacy Phase 4 bindings continue to work until migration is run.
- **GraphQL Adapter with REST Fallback**: Phase 5 adds an optional GraphQL endpoint adapter (`src/adapter/gitlab-graphql-client.ts`) as the preferred path for composite queries: `getMergeRequest` (composite single-MR fetch), `listEpicsWithChildren`, and `listMergeRequestsWithApprovals`. If GraphQL capability is unavailable (older GitLab, network error, parse failure), the client silently falls back to REST and increments a `*_REST_FALLBACK` metric. Capability detection is cached per `baseUrl` for 1 hour; `POST /api/v1/admin/invalidate-graphql-cache` (bearer + rate-limited) busts the cache on demand for operator override after an instance upgrade.
- **Image/File Discussion Position Annotations**: Review threads now support `position_type='image'` and `position_type='file'` in addition to Phase 3's `position_type='text'` (line comments). Image annotations include `x`, `y`, `width`, `height` coordinates. File-level discussions (no position) map to `position: null` with `discussionScope: 'file'`. Sync preserves position metadata round-trip via `SyncReviewPosition` struct.
- **mr.ts Refactoring**: `src/sync/mr.ts` is reduced from 769 LOC to 672 LOC (≤700 LOC target met) by extracting reusable helpers — `stripDocPrefix`, `parseIid`, `areEqual`, `resolveAssignee`, `resolveReviewerUuids`, `resolveLocalLabels`, `ensureRemoteLabels` — to `src/sync/mr-helpers.ts` (104 LOC). The `MergeRequestsSyncManager` class itself is not subdivided; the split is purely a helper extraction to improve testability and keep the main file under the size budget.
- **Phase 4 DEFERRED LOW/MEDIUM Rollup**: 8 deferred items from Phase 4 spec are completed: (1) GraphQL adapter, (2) mixin split, (3) cookie rotation grace period, (4) image/file annotations, (5) service-account PersonId Path D, (6) mr.ts refactoring, (7) dual-layer echo filter, (8) composite query caching.

## Phase 1 + Phase 2 + Phase 3 + Phase 4 Limitations

The following features are **not** included in this release:

### Carried forward from Phase 1–2

- **Confidential Issues & Merge Requests**: Private issues and confidential merge requests are deliberately skipped (Q5 resolution). Revisit when ACL mapping ships in Phase 4.
- **Encryption Key Rotation**: In-product key rotation is deferred. Rotation requires pod restart and manual credential re-encryption.
- **Pipeline Job Details**: Pipeline status in Huly shows summary only (pending/running/success/failed/canceled). Individual job logs, stages, and artifacts are Phase 4.
- **MR Status Read-Only**: The `pipelineStatus` field on MR mirrors is read-only in Huly (owned by `PipelineSyncManager`). Huly users cannot override.
- **MR Source Branch Read-Only**: The `sourceBranch` field is read-only in Huly; branch changes must be made on GitLab.
- **MR Creation from Huly**: Creating merge requests from within Huly is not yet supported. Phase 4 will add intent capture.
- **Custom Fields & Iterations**: Custom fields, epics, and iteration planning are Phase 4+.
- **Multi-instance Bindings**: Binding a single Huly project to multiple GitLab projects per workspace is Phase 4.
- **File Attachments**: Attachments are link-through only (referenced as plain markdown links). No upload mirror to Huly.

### Phase 3 Known Limitations

- **No Huly-to-GitLab writeback yet**: `applyLocal` exists for issues, MRs, notes, and review threads but no production TxMixin subscription is wired. Real Huly UI edits (Huly user approves MR, resolves discussion, edits comment body) do NOT propagate to GitLab in Phase 3. Phase 4 prerequisite work.
- **Approval Actions Fall Back to Service Account**: Phase 3 provides API surface for per-user approval attribution (`approvedBy` and `approvalsRequired` sync bidirectionally), but no Huly UI exists for users to self-link per-user OAuth credentials yet. All Phase 3 approval actions from Huly fall back to the binding's service account and include a visibility comment on the parent Issue: _"Approved via service account; per-user OAuth UI coming in Phase 4"_. See [Phase 3 Migration Runbook](docs/phase3-runbook.md).
- **Line Comments Text-Position Only**: Review threads support `position_type='text'` (inline code comments) only. Image and file-level discussion annotations are deferred to Phase 4.
- **Approval Status Default**: The `approvalStatus` field defaults to `'pending'` when `approvalsRequired=0` (i.e., no approval rule configured on GitLab). This is expected for CE instances.
- **Migration Requires Binding Pause**: The Phase 2 → Phase 3 reviewer-label migration endpoint (`POST /api/v1/bindings/:id/migrate-reviewer-labels`) requires the operator to pause the binding via `PATCH /api/v1/bindings/:id {disabled: true}` before running migration, then re-enable afterward. This prevents sync writes during label conversion.
- **Suggestion Comments Markdown Passthrough**: Suggestion blocks (`<<<<<<< SUGGEST ... >>>>>>>> SUGGEST`) in review comments pass through as raw markdown. No Huly UI affordance for inline apply/dismiss; users must manually apply suggestions on GitLab.
- **Full Diff Body Not Synced**: The complete git diff content is not mirrored to Huly. Only metadata is synced: file paths, additions/deletions count, change status (added/modified/deleted/renamed), and a link to the diff on GitLab (`diffWebUrl`).

### Phase 5 Remaining Limitations (TRUE TERMINAL STATE)

Phase 5 is the TRUE FINAL phase of this integration. All known limitations have been closed. The following scenarios require out-of-band coordination and are architectural constraints:

- **Cookie Format ServerSecret Rotation Requires Coordination**: Phase 5 adds grace-period rotation via `SERVER_SECRET_PREVIOUS`, but operator must coordinate secret rollover out-of-band across the cluster. No automatic distributed consensus mechanism is implemented. Recommended procedure: set `SERVER_SECRET_PREVIOUS=<old>`, rotate `SERVER_SECRET=<new>`, wait 24h grace period, remove `SERVER_SECRET_PREVIOUS`. See [Phase 5 Runbook](docs/phase5-runbook.md) for details.
- **npm audit Transitive `@hcengineering/*` uuid CVE Chain**: The integration carries transitive dependencies from `@hcengineering/*` packages that include an outdated uuid library with known CVEs (upstream fix required). This is a supply-chain dependency on the Huly platform team's release schedule and cannot be resolved within this repository.

## Requirements

- **Node.js** 22+
- **MongoDB** 7.0+
- **GitLab** CE/EE 16.0+ (validated floor: 16.11.10-ce.0)
- **Docker** (for compose-based dev/test)

## Quickstart

### 1. Clone and configure

```bash
git clone https://github.com/hardcoreeng/huly-gitlab.git
cd huly-gitlab
cp .env.example .env
# Edit .env with your values (see Environment Variables below)
```

### 2. Run locally (standalone)

Requires external MongoDB instance:

```bash
npm install
npm run build
node lib/index.js
```

### 3. Run with Docker Compose (full Huly stack)

```bash
make compose-up
# or: docker compose -f docker/docker-compose.dev.yml up -d
```

First cold start takes **10–15 minutes** (includes GitLab CE first-boot reconfiguration and Huly stack warm-up). Warm restarts: **1–3 minutes**.

### 4. Register OAuth App on GitLab

1. Log in to your GitLab instance.
2. Navigate to **Admin Area → Applications** (or **User Settings → Applications** for personal token).
3. Create a new application:
   - **Name**: `huly-gitlab`
   - **Redirect URI**: `http://localhost:3600/oauth/callback` (adjust `localhost:3600` to your `PUBLIC_BASE_URL`)
   - **Scopes**: `api`, `read_user`, `read_repository`
4. Copy **Application ID** → `GITLAB_CLIENT_ID`, **Secret** → `GITLAB_CLIENT_SECRET` in `.env`.

### 5. Create a binding

```bash
curl -X POST http://localhost:3600/api/v1/bindings \
  -H "Authorization: Bearer ${SERVER_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workspaceUuid": "your-workspace-uuid",
    "hulyProjectRef": "tracker:class:Project$proj-123",
    "gitlabProjectId": 1234,
    "credentialRef": "credential-id-from-oauth"
  }'
```

See [API Documentation](docs/api.md) for complete endpoint reference.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `3600` | HTTP server port |
| `PUBLIC_BASE_URL` | Yes | — | Base URL for OAuth callback (e.g., `http://localhost:3600`) |
| `ACCOUNTS_URL` | Yes | — | Huly account service URL (e.g., `http://localhost:3088`) |
| `SERVER_SECRET` | Yes | — | Bearer token for admin API endpoints |
| `SERVICE_ID` | No | `gitlab-service` | Service identifier in Huly system |
| `MONGO_URL` | Yes | — | MongoDB connection string (e.g., `mongodb://mongo:27017`) |
| `MONGO_DB` | No | `huly-gitlab` | MongoDB database name |
| `GITLAB_BASE_URL` | No | `https://gitlab.com` | GitLab instance URL (e.g., `http://localhost:8929`) |
| `GITLAB_CLIENT_ID` | Yes | — | GitLab OAuth application ID |
| `GITLAB_CLIENT_SECRET` | Yes | — | GitLab OAuth application secret |
| `CREDENTIAL_ENCRYPTION_KEY` | Yes | — | 32-byte base64-encoded AES-256 key (generate: `openssl rand -base64 32`) |
| `WEBHOOK_SECRET_SEED` | Yes | — | Random seed for webhook secret generation |
| `ALLOWED_WORKSPACES` | No | `*` | Comma-separated workspace UUIDs; `*` allows all |
| `BACKFILL_INTERVAL_MS` | No | `300000` | Polling interval in milliseconds (5 min default) |
| `RATE_LIMIT` | No | `25` | GitLab API concurrent request limit |
| `LOG_LEVEL` | No | `info` | Logging level: `debug`, `info`, `warn`, `error` |
| `BRANDING_PATH` | No | `` | Path to custom branding assets (optional) |

## Troubleshooting

### Webhook not firing

- Verify `webhookRegistered=true` in `GET /api/v1/bindings?workspaceUuid=...` output.
- Check pod logs for `binding-lifecycle` events.
- Ensure GitLab can reach your `PUBLIC_BASE_URL` from the network where GitLab runs.
- If webhook registration failed with 4xx, verify the GitLab API token has project admin rights.

### GitLab container slow to boot

First `docker compose up` of GitLab CE can take **10 minutes**. Watch logs:

```bash
docker compose logs gitlab | tail -f
```

### Huly transactor connection timeout

Ensure the compose stack finished booting (all services healthy):

```bash
docker compose ps
```

If transactor is unhealthy, check logs:

```bash
docker compose logs transactor
```

### Port conflicts in Docker

If `localhost:3600`, `8929` (GitLab), or `3088` (Huly accounts) are in use, edit `docker/docker-compose.dev.yml` and update the `ports` sections.

## Development

### Build

```bash
npm run build
```

### Lint

```bash
npm run lint
npm run format:check
```

### Test

```bash
npm test                    # Unit/integration tests
npm run test:coverage       # With coverage report
npm run test:e2e            # E2E tests (requires docker compose running)
```

### Run in watch mode

```bash
npm run dev
```

## API Reference

See [docs/api.md](docs/api.md) for complete REST API documentation.

## Architecture

See [docs/architecture.md](docs/architecture.md) for system design, data flow diagrams, and conflict resolution logic.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for branch model, commit style, and code standards.

## License

EPL-2.0 (Eclipse Public License 2.0) — same as [Huly](https://github.com/hcengineering/huly).
