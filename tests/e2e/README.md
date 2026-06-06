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

## Phase 3 — review threads, approvals, diff metadata, reviewer migration

New real-stack suites (gated on `E2E_REAL_STACK=1`):

- `mr-review.e2e.test.ts` — 6 review-thread cases. Seeds discussions on the
  MR through the GitLab REST API (`POST /merge_requests/:iid/discussions`)
  and asserts the pod mirrors each note as a `chunter.ChatMessage` carrying
  the runtime `gitlab-review` mixin. Covers thread creation, replies (Q1 v2
  per-note storage with `position` only on the root), line-anchored
  positions, GitLab → Huly resolve, Huly → GitLab resolve, and verbatim
  suggestion-block bodies.
- `mr-approval.e2e.test.ts` — 4 approval cases. Drives the GitLab CE
  per-MR approve/unapprove endpoints and asserts the `gitlab-mr` mixin's
  `approvedBy` / `approvalStatus` mirror within 30 s. The Huly → GitLab
  direction exercises the Phase 3 limitation (Q2): no per-user OAuth UI
  exists, so `approveMR` runs under the service-account credential and a
  visibility comment is posted on the GitLab MR.
- `mr-diff.e2e.test.ts` — 2 diff-metadata cases. Asserts the `gitlab-mr`
  mixin's `diffWebUrl` resolves to `${webUrl}/diffs` and that
  `changedFiles` carries `{path, additions, deletions, status}` entries
  matching the GitLab `/changes` response.
- `reviewer-migration.e2e.test.ts` — 3 cases for the operator-pause
  migration convention (Q3): a 409 pre-flight when the binding is active;
  a successful `mrsScanned/labelsStripped/reviewersResolved` payload after
  PATCH `{disabled:true}`; and idempotent re-runs (second call reports
  `labelsStripped=0`).

### Test sequence (Phase 3 suites)

1. `setupStackForMR(deps)` — boots compose, seeds GitLab project, seeds
   Huly workspace, binds via admin API, then seeds a single MR.
2. Per-case GitLab-side seeding (`seedGitLabDiscussion`,
   `seedGitLabDiscussionReply`, `resolveGitLabDiscussion`,
   `seedGitLabApprover`, `unapproveGitLabMR`, `getMRApprovalsFromGitLab`,
   `getMRDiffFromGitLab`) or pod-side admin call
   (`patchBindingDisabled`, `postMigrateReviewerLabels`).
3. Poll Huly transactor for mirror state convergence within 30 s.
4. `afterAll` → `shutdownStack` (compose down).

### `directMixinPatch` — ChatMessage support (C18)

Phase 2's harness exposed mixin patching only for `tracker.Issue` targets.
Phase 3 review tests need to flip `gitlab-review.resolved` on a
`chunter.ChatMessage` from the Huly side, so the harness now exposes:

- `directMixinPatchOnIssue(transactor, args)` — Phase 2 shape, unchanged.
- `directMixinPatchOnChatMessage(transactor, args)` — Phase 3 addition;
  passes `HARNESS_CHAT_MESSAGE_CLASS` to the transactor.

Both helpers accept the same `DirectMixinPatchArgs` shape and an explicit
`mode: 'create' | 'update'` switch (default `'update'`). The transactor
parameter is typed as a minimal `MinimalTransactor` interface so unit tests
can record call shape without depending on the heavy `@hcengineering/client`
runtime.

### Approval attribution: service-account fallback (Q2)

Approval mirroring from Huly → GitLab is the only direction in Phase 3 that
runs under the service-account credential. The Huly side has no UI for
end-users to self-link a per-user OAuth token yet, so every Huly-initiated
approval surfaces a visibility comment on the GitLab MR
("Approved via service account; per-user OAuth UI coming in Phase 4") and
emits the `approval.action.fallback.service_account` warn log. This is a
documented Phase 3 limitation; the per-user OAuth path lands in Phase 4.

### Wall-time expectations (Phase 3 suites)

| Suite | Cold | Warm |
| --- | --- | --- |
| `mr-review.e2e.test.ts` | 10–15 min | 2–4 min |
| `mr-approval.e2e.test.ts` | 10–15 min | 1–2 min |
| `mr-diff.e2e.test.ts` | 10–15 min | 1 min |
| `reviewer-migration.e2e.test.ts` | 10–15 min | 1–2 min |

Phase 3 adds roughly five minutes to the full warm `npm run test:e2e`
invocation on top of Phase 2; cold time is unchanged because all suites
share the same GitLab boot.
