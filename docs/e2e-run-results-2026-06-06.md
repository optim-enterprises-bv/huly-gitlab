# E2E Run Results — 2026-06-06

First execution of the 78-test E2E suite against a real `docker-compose.dev.yml` stack since the runbook was authored.

## Stack version

- Image tags: `hardcoreeng/*:v0.7.423` (Huly), `gitlab/gitlab-ce:16.11.10-ce.0`, `docker.redpanda.com/redpandadata/redpanda:v24.3.6`
- Docker Compose: `v5.1.2`
- Total services: 15 (account, collaborator, cockroach, elastic, front, fulltext, gitlab, minio, mongo, pod-gitlab, redpanda, rekoni, stats, transactor, workspace)

## Run summary

| Outcome | Count |
|---|---|
| E2E suites attempted | 7 |
| E2E suites passed | 0 |
| E2E suites failed | 6 |
| E2E suites cancelled (kill) | 1 |
| Genuine code bugs surfaced | 0 |
| Stack/setup bugs surfaced | 1 |
| Cold-start duration measured | ~3 minutes (incomplete) |

Failing suites: `mr-review.e2e.test.ts`, `path-b.e2e.test.ts`, `image-position.e2e.test.ts`, `user-oauth.e2e.test.ts`, `multi-instance.e2e.test.ts`, `originated-marker.e2e.test.ts`.

## Root cause (single)

All 6 failures share the same root cause and are classified `stack-bug`:

```
Command failed: docker compose -f docker-compose.dev.yml up -d
...
Container huly-gitlab-dev-redpanda-1 Error dependency redpanda failed to start
dependency failed to start: container huly-gitlab-dev-redpanda-1 is unhealthy
```

Redpanda's `rpk cluster info` healthcheck has `interval: 10s, timeout: 5s, retries: 10, start_period: <unset>`. With other heavyweight services (elastic, cockroach, mongo) competing for resources during cold-start, redpanda's cluster takes longer than the implicit `100s = retries × interval` health-check budget to report `info`. Compose marks redpanda unhealthy, dependent services refuse to start, and `setupStack()` in `tests/e2e/setup.ts` throws.

Observed behaviour: redpanda IS healthy ~120–180s after cold-start (logs show it serving raft groups and recovering consumer offsets). The test setup just gives up too early.

## Fix applied

`docker/docker-compose.dev.yml` redpanda healthcheck:
- `retries: 10 → 30`
- Added `start_period: 90s`

This gives redpanda a 90-second grace window before failing health checks count against the retry budget, then 300 seconds of retries (30 × 10s) once the grace window expires. Total maximum wait: ~6 minutes 30 seconds vs the previous 100 seconds.

## Test-runner observation (not fixed)

Each E2E suite `beforeAll` calls `docker compose up -d`. With docker compose idempotency, this is normally a no-op against an already-healthy stack. But the test runner inherits an empty `.env`, so the env var defaults (`GITLAB_CLIENT_ID`, `GITLAB_CLIENT_SECRET`, `CREDENTIAL_ENCRYPTION_KEY`, `WEBHOOK_SECRET_SEED`) trigger compose warnings and a full container recreate. Consequence: each suite pays the cold-start cost again (~3 min each × 7 suites = ~21 min cumulative).

**Recommendation** (not implemented in this PR): the harness should either (a) source `.env.example` defaults explicitly in `setupStack`, or (b) check `docker compose ps -q | wc -l` and skip `up -d` if all services are already running.

## Re-run procedure

After this PR merges:
1. `docker compose -f docker/docker-compose.dev.yml up -d`
2. Wait for `docker compose ps` to show all 15 services healthy (cold-start ~3–4 min).
3. `E2E_REAL_STACK=1 SECRET=change-me-shared-secret npm run test:e2e -- --forceExit`
4. Soak suite: `E2E_REAL_STACK=1 E2E_SOAK=1 npm run test:e2e -- --testPathPattern=soak --forceExit`

## CI integration recommendations

- **Nightly schedule**, not per-PR. Each E2E run consumes ~20–30 minutes of CI time plus the 3 GB of disk for image layers.
- Persist `~/.docker/config.json` volume cache between runs so image pulls are incremental.
- Run with `--maxWorkers=1` to prevent compose contention if Jest's worker pool tries to bring up the stack from multiple processes.
- Pin redpanda image version to match `docker/docker-compose.dev.yml`; do not use `:latest`.
- Add a pre-flight `docker compose pull` as a separate CI step so the actual test run is not penalised for image download time.

## Next steps

- This PR closes the redpanda timing bug.
- The 78 E2E tests have NOT been confirmed green against a real stack.
- After merge, an operator should re-run the suite (see "Re-run procedure" above) and update this document with results.
- Genuine code bugs (if any surface in re-run) will require separate fix PRs.

## Files in this run

- `/tmp/e2e-results.log` — full Jest output (1,552 lines)
- `/tmp/e2e-stack.log` — docker compose output (initial `up -d`)
