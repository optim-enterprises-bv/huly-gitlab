# E2E Runbook

The `tests/e2e/` directory contains real-stack end-to-end tests that exercise the full path from GitLab webhook/API through the pod to a Huly transactor. All real-stack suites are **skipped by default** — `npm run test:e2e` exits 0 without Docker. This document describes how to enable and run them.

## 1. Required Services

The full E2E stack requires:

| Service | Role |
| --- | --- |
| GitLab CE/EE container | Source of truth; the pod registers webhooks and polls its REST/GraphQL API |
| MongoDB | Pod persistence (bindings, cursors, migration state) |
| Huly Account service | Workspace provisioning and user auth |
| Huly Workspace / Transactor | Receives mirrored Issues, Notes, MR fields |
| Huly Front | Optional; needed only for browser-level smoke |
| MinIO | Huly object storage (attachments) |
| `huly-gitlab` pod | The service under test |

Minimum host resources: 8 GiB free RAM, 4 CPU cores, ~10 GiB free disk for image layers. Ports 8929 (GitLab), 8087 (Huly front), 3600 (pod) must be free.

## 2. Compose Recipe

All services are declared in `docker/docker-compose.dev.yml`. Start the full stack:

```bash
# From repo root
docker compose -f docker/docker-compose.dev.yml up -d
```

The compose file includes: `gitlab`, `mongo`, `cockroach`, `redpanda`, `minio`, `elastic`, `account`, `transactor`, `front`, `pod-gitlab`.

**Additional flags:**

```bash
# Stream logs from a specific service
docker compose -f docker/docker-compose.dev.yml logs -f pod-gitlab

# Force a clean cold start (wipes volumes)
docker compose -f docker/docker-compose.dev.yml down -v
```

**`.env` setup:** Copy `.env.example` to `.env` and populate at minimum:

```
SECRET=<server secret>
CREDENTIAL_ENCRYPTION_KEY=<32-byte hex key>
WEBHOOK_SECRET_SEED=<random seed>
GITLAB_APP_ID=<OAuth app id>
GITLAB_APP_SECRET=<OAuth app secret>
```

The harness reads `SECRET` as the shared bearer token for pod admin endpoints.

## 3. Environment Variable Matrix

The gate for each suite is controlled by the variables below. The harness resolves them in `tests/e2e/setup.ts`.

| Variable | Default | Effect |
| --- | --- | --- |
| `E2E_REAL_STACK` | unset | Set to `1` to un-skip all real-stack suites |
| `E2E_SOAK` | unset | Set to `1` (requires `E2E_REAL_STACK=1`) to enable the 1-hour soak suite |
| `E2E_GITLAB_URL` | `http://localhost:8929` | Override GitLab base URL (useful for remote stacks) |
| `E2E_HULY_ACCOUNT_URL` | `http://localhost:8087/_accounts` | Override Huly account service base URL |
| `E2E_POD_URL` | `http://localhost:3600` | Override pod base URL |
| `SECRET` | `change-me-shared-secret` | Shared `SERVER_SECRET` for bearer auth against pod admin endpoints |

Suites use a `describeReal` / `describeSoak` wrapper:

```typescript
const REAL = process.env.E2E_REAL_STACK === '1'
const SOAK = REAL && process.env.E2E_SOAK === '1'
const describeReal = REAL ? describe : describe.skip
const describeSoak = SOAK ? describe : describe.skip
```

## 4. Running All E2E Gates

```bash
E2E_REAL_STACK=1 npm run test:e2e
```

To also run the soak suite:

```bash
E2E_REAL_STACK=1 E2E_SOAK=1 npm run test:e2e -- --testPathPattern=soak
```

To target a single suite:

```bash
E2E_REAL_STACK=1 npm run test:e2e -- --testPathPattern=mr\.e2e
```

The `npm run test:e2e` script uses `jest.e2e.config.js` with a 15-minute global timeout per test (cold GitLab boot can take 10 minutes).

## 5. CI Integration Recommendation

Run E2E on a **nightly schedule**, not per-PR:

- Cold-start wall time is 20–35 minutes (dominated by GitLab CE image pull and initialization). This is too slow for PR feedback loops.
- The stack requires ~8 GiB RAM; most PR runners are provisioned at 2–4 GiB.
- A nightly job on a larger runner (e.g. GitHub Actions `ubuntu-latest-8core`) keeps the signal without blocking developers.

Suggested nightly workflow trigger:

```yaml
on:
  schedule:
    - cron: '0 2 * * *'   # 02:00 UTC daily
```

Cache Docker layers between nightly runs to reduce cold-start time from 20–35 min to 6–10 min.

## 6. Expected Failure Modes

**Cold-start timing sensitivity** — GitLab CE can take 5–10 minutes to pass its `/api/v4/version` health check after container start. The harness polls with a 60-second retry interval; if the poll budget is exhausted, the suite fails with a timeout rather than an assertion error. Recommend a **60-second warm-up sleep** after `docker compose up -d` before invoking Jest when running outside the harness's own boot loop:

```bash
docker compose -f docker/docker-compose.dev.yml up -d
sleep 60
E2E_REAL_STACK=1 npm run test:e2e
```

**Port conflicts** — If ports 8929, 8087, or 3600 are occupied, compose will exit immediately. Check with `lsof -i :8929` before starting.

**Volume state bleed** — If a previous run crashed before `afterAll` ran `shutdownStack`, stale GitLab state may cause seed collisions. Force clean:

```bash
docker compose -f docker/docker-compose.dev.yml down -v
```

**Mongo connection refused on pod start** — The pod may start before Mongo is accepting connections. The `scripts/wait-for.sh` helper is used in compose health checks; if running the pod manually, ensure Mongo is healthy before starting the pod.

**GitLab initial root password** — The harness reads the initial root password from `/etc/gitlab/initial_root_password` inside the `gitlab` container via `docker compose exec`. This file is only present on first boot; subsequent warm runs reuse the seeded credentials.

## 7. Per-Suite Descriptions

| Test file | Description |
| --- | --- |
| `issues.e2e.test.ts` | Issue round-trips: creates a GitLab issue via REST, asserts the pod mirrors it to a Huly Issue; covers title/description edits, state transitions (closed/reopened), label sync, and assignment. Gated on `E2E_REAL_STACK=1`. |
| `notes.e2e.test.ts` | Note round-trips: posts comments on a GitLab issue, asserts they appear as Huly Comments; covers edit and delete propagation. Gated on `E2E_REAL_STACK=1`. |
| `mr.e2e.test.ts` | MR round-trips (Phase 2): seeds a merge request through `POST /api/v4/projects/:id/merge_requests`, asserts the pod mirrors it to a Huly Issue with the `gitlab-mr` mixin; covers title/description edits, draft, locked, merged, and closed state transitions. 8 cases. Gated on `E2E_REAL_STACK=1`. |
| `mr-notes.e2e.test.ts` | MR-attached notes (Phase 2): uses the `noteable_type='MergeRequest'` branch of NotesSyncManager; asserts system notes (e.g. auto-generated "marked as Draft") are skipped. 4 cases. Gated on `E2E_REAL_STACK=1`. |
| `pipeline.e2e.test.ts` | Pipeline status (Phase 2): sends synthetic Pipeline Hook payloads directly to `${podUrl}/webhook/${bindingId}` (no real GitLab runner required); asserts the pod writes `pipelineStatus` to the mirrored Issue via PipelineSyncManager. 3 cases. Gated on `E2E_REAL_STACK=1`. |
| `soak.e2e.test.ts` | 1-hour mixed traffic soak: drives a continuous stream of issue, note, MR, and pipeline events and asserts no errors accumulate over the run window. Gated on `E2E_REAL_STACK=1 E2E_SOAK=1`. |
| `setup.test.ts` | Harness unit tests: exercises boot/seed/bind code paths through fakes (`fakes/docker-mock.ts`, `fakes/http-mock.ts`). No Docker or network dependency. Runs unconditionally on every `npm test`. |

---

**For service-specific debugging:** See `tests/e2e/README.md` for compose log commands, Mongo inspection, and GitLab admin access details.
