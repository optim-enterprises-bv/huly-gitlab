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

## Current Limitations

The following features are **not** included in Phases 1–2 and are targeted for Phases 3–4:

- **Confidential Issues & Merge Requests**: Private issues and confidential merge requests are deliberately skipped (Q5 resolution). Revisit when ACL mapping ships in Phase 4.
- **MR Creation from Huly**: Creating merge requests from within Huly is not yet supported. Phase 3 will add intent capture (UI signal to push Issue to GitLab as MR).
- **Encryption Key Rotation**: In-product key rotation is deferred. Rotation requires pod restart and manual credential re-encryption.
- **Code Review Threads & Line Comments**: Inline review comments, approvals, and threaded discussions on merge requests are Phase 3.
- **MR Diff & Changes Content**: Full diff metadata and commit details are Phase 3.
- **Reviewers as Typed Field**: MR reviewers are stored as synthetic labels (`gitlab:reviewer:<username>`) in Phase 2. Phase 3 will introduce a dedicated typed reviewer field.
- **Pipeline Job Details**: Pipeline status in Huly shows summary only (pending/running/success/failed/canceled). Individual job logs, stages, and artifacts are Phase 3.
- **MR Status Read-Only**: The `pipelineStatus` field on MR mirrors is read-only in Huly (owned by `PipelineSyncManager`). Huly users cannot override.
- **MR Source Branch Read-Only**: The `sourceBranch` field is read-only in Huly; branch changes must be made on GitLab.
- **Existing Binding Re-registration**: Phase 1 bindings registered before Phase 2 deploy will NOT receive MR or pipeline events until a one-time admin re-registration call. See [Phase 2 Migration Runbook](docs/phase2-runbook.md).
- **Custom Fields & Iterations**: Custom fields, epics, and iteration planning are Phase 3–4.
- **Multi-instance Bindings**: Binding a single Huly project to multiple GitLab projects per workspace is Phase 4.
- **File Attachments**: Attachments are link-through only (referenced as plain markdown links). No upload mirror to Huly.

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
