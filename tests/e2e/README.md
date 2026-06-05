# E2E harness

This directory hosts the end-to-end harness that drives the full
`docker/docker-compose.dev.yml` stack: GitLab CE + Huly (cockroach, redpanda,
minio, elastic, transactor, account, front, etc.) + Mongo + the `huly-gitlab`
pod.

## Default behavior (no docker required)

Running `npm run test:e2e` **without** environment overrides:

- Loads `jest.e2e.config.js`.
- Discovers `tests/e2e/**/*.test.ts`.
- All real-stack suites short-circuit via `describe.skip(...)` when
  `E2E_REAL_STACK !== '1'`.
- Jest exits **0**.

The harness-unit tests (`setup.test.ts`) run unconditionally and exercise the
boot/seed/bind code paths through fakes (`fakes/docker-mock.ts`,
`fakes/http-mock.ts`). They have no docker or network dependency.

## Real-stack manual smoke

Prerequisites:

- Docker daemon running, at least 8 GiB free RAM, 4 cores.
- Ports 8929 (GitLab), 8087 (Huly front), 3600 (pod) free.
- `.env` populated from `.env.example` (at minimum: `SECRET`,
  `CREDENTIAL_ENCRYPTION_KEY`, `WEBHOOK_SECRET_SEED`, OAuth client pair).

Run:

```bash
E2E_REAL_STACK=1 npm run test:e2e
```

Expected wall time on a 4-core dev machine:

| Phase | Cold | Warm |
| --- | --- | --- |
| `docker compose up -d` + image pulls | 8–12 min | 30–60 s |
| GitLab `/api/v4/version` healthy | 5–10 min | 30–90 s |
| Huly account `/api/v1/accounts` healthy | 1–3 min | 10–30 s |
| pod-gitlab `/health` healthy | 10–30 s | 5–10 s |
| Issues + notes round-trips | 3–6 min | 3–6 min |
| **Total** | **20–35 min** | **6–10 min** |

## Soak (opt-in, 1 h+)

```bash
E2E_REAL_STACK=1 E2E_SOAK=1 npm run test:e2e -- --testPathPattern=soak
```

## Debugging tips

- Compose logs: `docker compose -f docker/docker-compose.dev.yml logs -f <service>`
  where `<service>` is one of `gitlab`, `account`, `transactor`, `pod-gitlab`,
  `mongo`, `cockroach`, `redpanda`, `minio`, `elastic`.
- Inspect Mongo state: `docker compose exec mongo mongosh huly-gitlab`.
- Inspect GitLab: open `http://localhost:8929`. Initial root password lives at
  `/etc/gitlab/initial_root_password` inside the `gitlab` container; the
  harness reads it via `docker compose exec`.
- Inspect Huly: open `http://localhost:8087`.
- pod-gitlab admin REST: `curl -H "Authorization: Bearer $SECRET" http://localhost:3600/api/v1/bindings`.
- Force teardown if a test crashed before `afterAll`:
  `docker compose -f docker/docker-compose.dev.yml down -v` (the `-v` wipes
  volumes, which forces a fresh cold start next run).

## Environment overrides

| Var | Purpose | Default |
| --- | --- | --- |
| `E2E_REAL_STACK` | Set to `1` to enable real-stack suites | unset → skipped |
| `E2E_SOAK` | Set to `1` (with REAL_STACK) to enable soak | unset → skipped |
| `E2E_GITLAB_URL` | Override base URL for GitLab probes | `http://localhost:8929` |
| `E2E_HULY_ACCOUNT_URL` | Override base URL for Huly account | `http://localhost:8087/_accounts` |
| `E2E_POD_URL` | Override base URL for pod-gitlab | `http://localhost:3600` |
| `SECRET` | Shared `SERVER_SECRET` for bearer auth | `change-me-shared-secret` |

## Architecture

```
tests/e2e/
├── setup.ts              harness — boot, seed, bind (DI-friendly)
├── setup.test.ts         unit tests of the harness using fakes
├── issues.e2e.test.ts    real-stack issue round-trips (skipped by default)
├── notes.e2e.test.ts     real-stack note round-trips (skipped by default)
├── mr.e2e.test.ts        Phase 2 — MR round-trips (skipped by default)
├── mr-notes.e2e.test.ts  Phase 2 — MR-attached note round-trips (skipped by default)
├── pipeline.e2e.test.ts  Phase 2 — pipeline status via synthetic webhooks (skipped by default)
├── soak.e2e.test.ts      1 h mixed traffic (skipped by default)
├── README.md             this file
└── fakes/
    ├── docker-mock.ts    child_process exec stub
    └── http-mock.ts      fetch stub with per-URL response queues
```

## Phase 2 — MR, MR-notes, pipeline

New real-stack suites (gated on `E2E_REAL_STACK=1`):

- `mr.e2e.test.ts` — 8 MR round-trip cases. Seeds an MR through the GitLab
  REST API and asserts the pod mirrors it to a Huly Issue with the runtime
  `gitlab-mr` mixin. Covers title/description edits, state transitions
  (`merged`, `closed`), draft, locked, and synthetic reviewer-label cases.
- `mr-notes.e2e.test.ts` — 4 MR-attached note cases. Uses the
  `noteable_type='MergeRequest'` discriminator branch of NotesSyncManager;
  asserts that system notes (e.g. auto-generated "marked as Draft") are
  skipped.
- `pipeline.e2e.test.ts` — 3 pipeline cases. **Uses synthetic webhook POSTs
  to the pod (not real GitLab runners)** — see C9 below. Each case constructs
  a Pipeline Hook payload, then `postSyntheticWebhook` sends it to
  `${podUrl}/webhook/${bindingId}` with the binding's shared secret.

### Pipeline tests use synthetic webhooks (C9)

GitLab CI requires a registered runner to produce real pipeline events. Rather
than gate the pipeline suite behind `RUNNERS_AVAILABLE=true`, the harness
constructs a Pipeline Hook payload directly and posts it to the webhook
receiver. This exercises the full intake → PipelineSyncManager → mixin write
path **without any runner infrastructure** and works on any CI environment.

### Test sequence (Phase 2 MR suites)

1. `setupStackForMR(deps)` — boots compose, seeds GitLab project, seeds Huly
   workspace, binds via admin API, then seeds a single MR through
   `POST /api/v4/projects/:id/merge_requests`.
2. Per-case GitLab-side mutation (PUT title, PUT description, POST notes,
   PUT merge, synthetic webhook POST, etc.).
3. Poll Huly transactor for mirror state convergence within 30 s (helper lands
   with the round-trip assertion suite).
4. `afterAll` → `shutdownStack` (compose down).

### Wall-time expectations

| Suite | Cold (first GitLab boot) | Warm |
| --- | --- | --- |
| `mr.e2e.test.ts` | 10–15 min | 4–6 min |
| `mr-notes.e2e.test.ts` | 10–15 min | 2–3 min |
| `pipeline.e2e.test.ts` | 10–15 min | 1–2 min |

Cold time is dominated by the one-time GitLab CE boot. Warm runs share state
inside a single `npm run test:e2e` invocation because each suite has its own
`beforeAll`/`afterAll` lifecycle.


The harness exposes a small `HarnessDeps` interface so every side-effecting
primitive (`exec`, `fetch`, `readFile`, `sleep`) can be swapped during unit
tests. `defaultHarness()` returns real implementations.
