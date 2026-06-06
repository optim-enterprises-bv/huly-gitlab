# Phase 5 Migration Runbook

This runbook documents the operator procedures for migrating from Phase 4 to Phase 5, closing all remaining limitations.

## Prerequisites

- Phase 4 deployment is stable and bindings are syncing normally
- Huly workspace and GitLab instances are accessible
- All Phase 4 bindings have been running for at least one full sync cycle (5+ minutes)
- Operator has `SERVER_SECRET` for API authentication

## Overview

Phase 5 introduces three major operator procedures:
1. **Mixin split migration** — Convert monolithic `gitlab-mr` to split `gitlab-mr-core` + `gitlab-mr-review`
2. **ServerSecret rotation with grace period** — Rotate `huly-user` cookie secret with zero downtime
3. **GraphQL cache invalidation** — Optional; triggers capability re-detection

Each procedure is independent and can be run in any order. Recommend mixin split first (affects most bindings), then secret rotation (security), then GraphQL cache invalidation (optimization).

---

## Procedure 1: Mixin Split Migration

### Purpose

Splits the 16-field `gitlab-mr` mixin into two specialized mixins:
- `gitlab-mr-core` (7 fields): source, target, draft, merged, status, url, pipeline
- `gitlab-mr-review` (9 fields): reviewers, approvals, rules, iteration, epic

**Benefits:**
- Reduces field count per mixin (improves Huly UI performance)
- Clearer field ownership (MR metadata vs. review/approval metadata)
- Enables future independent evolution of each mixin

### Steps

#### 1.1 List all bindings for the workspace

```bash
curl "http://localhost:3600/api/v1/bindings?workspaceUuid=${WORKSPACE_UUID}" \
  -H "Authorization: Bearer ${SERVER_SECRET}"
```

**Example response:**
```json
[
  {
    "bindingId": "binding-id-1",
    "workspaceUuid": "workspace-uuid",
    "hulyProjectRef": "tracker:class:Project$proj-123",
    "gitlabProjectId": 42,
    "gitlabProjectPath": "group/project-name",
    "webhookRegistered": true,
    "createdAt": "2026-06-05T10:00:00Z",
    "disabled": false
  },
  ...
]
```

Save the list of `bindingId` values. You will migrate each binding independently.

#### 1.2 Pause the binding

Before migration, pause the binding to prevent sync writes during mixin split:

```bash
curl -X PATCH "http://localhost:3600/api/v1/bindings/${BINDING_ID}" \
  -H "Authorization: Bearer ${SERVER_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{"disabled": true}'
```

**Expected response:**
```json
{
  "bindingId": "binding-id-1",
  "disabled": true,
  "updatedAt": "2026-06-06T10:00:00Z"
}
```

Wait 30 seconds to allow in-flight sync operations to drain.

#### 1.3 Run the migration

```bash
curl -X POST "http://localhost:3600/api/v1/bindings/${BINDING_ID}/migrate-mixin-split" \
  -H "Authorization: Bearer ${SERVER_SECRET}"
```

**Expected response (success):**
```json
{
  "migratedAt": "2026-06-06T10:05:00Z",
  "mrsScanned": 156,
  "splitsPerformed": 156,
  "coreFieldsMoved": 1092,
  "reviewFieldsMoved": 1404
}
```

**Error responses:**
- `409 Conflict` — Binding is still active. Retry step 1.2 (pause).
- `404 Not Found` — Binding does not exist. Check binding ID.
- `400 Bad Request` — Invalid binding ID format.

**Interpreting the response:**
- `mrsScanned` — Total MR Issues examined
- `splitsPerformed` — Number of MRs where monolithic mixin was split (typically equals `mrsScanned`)
- `coreFieldsMoved` — Sum of Phase 2–5 MR metadata fields moved to `gitlab-mr-core`
- `reviewFieldsMoved` — Sum of Phase 3–5 review/approval fields moved to `gitlab-mr-review`

If `splitsPerformed = 0`, the binding was already migrated in a previous run (idempotent; safe to re-run).

#### 1.4 Unpause the binding

```bash
curl -X PATCH "http://localhost:3600/api/v1/bindings/${BINDING_ID}" \
  -H "Authorization: Bearer ${SERVER_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{"disabled": false}'
```

**Expected response:**
```json
{
  "bindingId": "binding-id-1",
  "disabled": false,
  "updatedAt": "2026-06-06T10:10:00Z"
}
```

Sync will resume immediately. Verify no errors in pod logs.

#### 1.5 Repeat for all bindings

Repeat steps 1.2–1.4 for each binding in the workspace.

### Troubleshooting

**Issue: Migration times out (>30s)**
- Check pod logs for warnings about large MR collections
- Verify MongoDB is responsive: `mongo --eval db.adminCommand({ping:1})`
- If MongoDB is slow, retry after instance stabilizes

**Issue: Migration completes but `splitsPerformed = 0` on second run**
- This is expected and correct (idempotent behavior)
- No action needed; binding was already migrated

**Issue: After unpause, sync errors appear in logs**
- Check for `mixin not found` errors; may indicate partial migration
- Contact support; escalate to code review

---

## Procedure 2: ServerSecret Rotation with Grace Period

### Purpose

Rotate the `huly-user` cookie HMAC secret (`SERVER_SECRET`) with zero downtime using grace-period mechanism.

**Benefits:**
- No pod restart required
- Existing cookies remain valid during grace period (24h recommended)
- Gradual migration eliminates sudden auth failures

### Prerequisites

- New secret must be ≥32 characters (recommended: `openssl rand -base64 32`)
- Old secret must be known (will set as `SERVER_SECRET_PREVIOUS`)
- Operator has pod restart capability (for step 2.4 if needed)

### Steps

#### 2.1 Generate new secret

```bash
export NEW_SECRET=$(openssl rand -base64 32)
echo "New secret: $NEW_SECRET"
# Save this value securely; you will need it in step 2.3
```

#### 2.2 Verify current secret is valid

```bash
# Try accessing /user/oauth/status with an existing cookie to confirm current secret works
curl http://localhost:3600/user/oauth/status \
  -H "Cookie: huly-user=${EXISTING_COOKIE}"
```

If this fails, check the value of `SERVER_SECRET` in your environment.

#### 2.3 Set `SERVER_SECRET_PREVIOUS` and rotate `SERVER_SECRET`

Update your pod environment:

```bash
# Set previous secret to current value
export SERVER_SECRET_PREVIOUS="${SERVER_SECRET}"

# Set new secret
export SERVER_SECRET="${NEW_SECRET}"

# Restart pod to apply env changes, OR use hot-reload if available
# For hot-reload (if pod supports): send SIGHUP
kill -HUP $(pgrep -f "node lib/index.js")
```

**Alternative (without restart): Edit `.env` or deployment config and redeploy pod.**

After restart/redeploy, verify pod is healthy:

```bash
curl http://localhost:3600/health
```

**Expected response:**
```json
{
  "status": "ok",
  "uptime": 1.2,
  "gitlabReachable": true,
  "mongoOk": true
}
```

#### 2.4 Verify both secrets are accepted

```bash
# Old cookies should still work (validated against SERVER_SECRET_PREVIOUS)
curl http://localhost:3600/user/oauth/status \
  -H "Cookie: huly-user=${OLD_COOKIE}"

# New cookies should work (validated against SERVER_SECRET)
curl -X POST http://localhost:3600/user/oauth/start \
  -H "Cookie: huly-user=${NEW_COOKIE}"
```

Both should return `200` or redirect (not `401 Unauthorized`).

#### 2.5 Wait grace period (24 hours recommended)

Allow time for all existing cookies to rotate naturally:
- Huly browser sessions create fresh cookies on next login
- Older cookies are refreshed by the pod's cookie-refresh cycle
- Monitor auth error rates in logs; should remain at baseline

#### 2.6 Remove `SERVER_SECRET_PREVIOUS` to complete rotation

After grace period, remove the old secret:

```bash
# Unset SERVER_SECRET_PREVIOUS
unset SERVER_SECRET_PREVIOUS

# Or in config: remove SERVER_SECRET_PREVIOUS line
# Restart pod
kill -HUP $(pgrep -f "node lib/index.js")
```

Verify pod is healthy again:

```bash
curl http://localhost:3600/health
```

Old cookies will now fail validation (401), forcing users to re-authenticate on next browser refresh. This is expected.

### Monitoring

**During grace period**, watch these metrics:

```bash
# Monitor auth error rate (should stay at baseline)
tail -f /var/log/pod.log | grep "cookie.invalid"

# Monitor user-oauth endpoints (should see no spike in 401s)
tail -f /var/log/pod.log | grep "user.oauth"
```

**Expected behavior:**
- 0 unplanned `401 Unauthorized` errors
- Existing Huly browser sessions continue to work
- New logins use new secret

### Troubleshooting

**Issue: Old cookies return `401` before grace period expires**
- Verify `SERVER_SECRET_PREVIOUS` was set correctly (equals old `SERVER_SECRET` value)
- Check pod logs for `cookie.validation.fallback` metric
- Restart pod if needed: `kill -HUP $(pgrep -f "node lib/index.js")`

**Issue: New cookies return `401`**
- Verify `SERVER_SECRET` was set to new value
- Check pod environment: `env | grep SERVER_SECRET`
- If environment is correct, pod may not have restarted; force restart

**Issue: Grace period is too short for your environment**
- Extend grace period by keeping `SERVER_SECRET_PREVIOUS` set longer (e.g., 48h)
- Monitor `cookie.validation.previous` metric; when it drops to zero, safe to remove

---

## Procedure 3: GraphQL Cache Invalidation (Optional)

### Purpose

Force fresh GraphQL capability detection on all GitLab instances. Useful after GitLab upgrades or when testing GraphQL support.

**Effect:**
- Next composite query (getMR + approvals + rules) will re-check GraphQL availability
- If available, uses GraphQL (40–60% quota savings); otherwise falls back to REST
- Does not affect in-flight requests; only cached capability status is cleared

### Steps

#### 3.1 Call the invalidation endpoint

```bash
curl -X POST http://localhost:3600/api/v1/admin/invalidate-graphql-cache \
  -H "Authorization: Bearer ${SERVER_SECRET}"
```

**Expected response:**
```json
{
  "invalidatedAt": "2026-06-06T10:30:00Z",
  "instancesAffected": 3,
  "message": "GraphQL capability cache cleared for all instances"
}
```

#### 3.2 Verify cache was cleared

Check pod logs for `graphql.capability.detected` metric in the next 30 seconds:

```bash
tail -f /var/log/pod.log | grep "graphql.capability"
```

**Expected log entries (next sync cycle):**
- `graphql.capability.detected: true` — GraphQL is available, will use it for composite queries
- `graphql.capability.detected: false` — GraphQL unavailable, falling back to REST

#### 3.3 Monitor quota usage (optional)

If you have GitLab quota monitoring enabled, check:
- Before invalidation: REST requests dominate (N requests per MR per backfill cycle)
- After invalidation: If GraphQL is available, requests drop significantly (1 per MR)

### Monitoring

```bash
# Watch for GraphQL capability detection
tail -f /var/log/pod.log | grep "graphql"

# Check GitLab API rate limit headers (if monitoring)
curl "https://gitlab.example.com/api/v4/version" \
  -H "PRIVATE-TOKEN: ${TOKEN}" \
  -i | grep -i "rate"
```

### Troubleshooting

**Issue: `instancesAffected: 0` returned**
- This can occur if no bindings are active (check `/api/v1/bindings`)
- Cache was still cleared; safe to ignore

**Issue: GraphQL still not used after invalidation**
- Verify GitLab version supports GraphQL (16.0+)
- Check pod logs for `graphql.capability.introspection.failed` metric
- GitLab instance may not have GraphQL endpoint enabled; contact GitLab admin

---

## Rollback (Phase 4 Reversion)

If Phase 5 migration introduces issues, revert to Phase 4:

### Mixin Split Rollback

The mixin split migration is **destructive** (old mixin fields are removed). To revert:

1. **From backup:** Restore MongoDB from pre-migration snapshot
   ```bash
   mongorestore --archive < backup.mongodump --drop --oplogReplay
   ```

2. **Manual revert:** If backup unavailable, manually revert mixin structure in Huly (contact support)

**Recommendation:** Backup MongoDB before running migration step 1.3.

### ServerSecret Rollback

If secret rotation went wrong:

1. Revert environment:
   ```bash
   export SERVER_SECRET="${OLD_SECRET}"
   unset SERVER_SECRET_PREVIOUS
   kill -HUP $(pgrep -f "node lib/index.js")
   ```

2. Verify health:
   ```bash
   curl http://localhost:3600/health
   ```

3. Existing cookies should work again after pod restart.

### GraphQL Cache Rollback

GraphQL cache invalidation is non-destructive and self-reverting (1h TTL). No manual action needed; cache will repopulate automatically.

---

## Completion Checklist

- [ ] All Phase 4 bindings listed and accounted for
- [ ] Mixin split: All bindings paused → migrated → unpaused successfully
- [ ] No sync errors in pod logs post-migration
- [ ] ServerSecret rotation: New secret set, grace period started
- [ ] Existing Huly browser sessions still authenticate (no unexpected 401s)
- [ ] After grace period: Old secret removed, verified new secret works
- [ ] (Optional) GraphQL cache invalidation completed, capability re-detected
- [ ] All bindings resume normal sync (5+ minutes of stable operation)

---

## Support

If you encounter issues during migration:

1. Check pod logs: `docker logs <pod-id> | grep -i error`
2. Verify MongoDB: `mongo --eval "db.adminCommand({ping:1})"`
3. Check GitLab API health: `curl https://gitlab.example.com/api/v4/version`
4. Refer to [Architecture](docs/architecture.md) for Phase 5 feature details

For unrecoverable issues, restore from backup and contact support with error logs.
## SLO Alert Expressions

The metrics below are emitted by the pod and scraped by your Prometheus instance. Each alert expression is written in PromQL. Severity levels follow the `warning` / `info` convention from Phase 2–4 runbooks.

For all alerts: the runbook link column points to the anchor in this document where remediation steps are documented.

---

### `tx.subscription.echo.dropped` — TxSubscriber echo-drop rate

Path D routes events through TxSubscriber, which drops self-originated echoes (events the pod itself wrote). Under a healthy Path D deployment this counter advances at a non-zero rate proportional to write traffic. A sustained zero means TxSubscriber is not receiving events at all — either the subscription is broken or no writes are reaching the transactor.

**Alert expression:**

```promql
sum(rate(tx_subscription_echo_dropped[10m])) == 0
```

**For duration:** 30 minutes

**Severity:** `warning`

**Runbook anchor:** [#echo-drop-rate-zero](#echo-drop-rate-zero)

**Remediation:** Verify the TxSubscriber WebSocket connection is established (`tx.subscription.connected` gauge should be 1). Check pod logs for `tx.subscription` events. If the pod has no write traffic (e.g. no active bindings), this alert is a false positive — suppress with a `unless on() sum(rate(huly_gitlab_writes_total[10m])) == 0` guard.

---

### `SERVICE_ACCOUNT_RESOLVED` — service-account resolution gauge

Under Path D, no service-account resolution occurs. This counter should remain 0 permanently. A non-zero value indicates Path A, B, C, or E has activated — which is expected only during a staged rollout or after a regression.

**Alert expression:**

```promql
SERVICE_ACCOUNT_RESOLVED != 0
```

**For duration:** 5 minutes

**Severity:** `info`

**Runbook anchor:** [#service-account-resolved-nonzero](#service-account-resolved-nonzero)

**Remediation:** Informational only. Confirm whether Path D is configured as the default. If a deliberate upgrade from an earlier path is in progress, suppress this alert for the migration window. If unexpected, check the routing decision logic and verify `SYNC_PATH=D` is set in the pod environment.

---

### `MR_COMPOSITE_REST_FALLBACK` — MR composite REST fallback rate

The MR composite fetch strategy tries GraphQL first and falls back to REST when the GitLab instance does not support the required GraphQL fields (tracked in the capability cache). A chronic fallback rate above 50% means the GraphQL adapter is not engaging — likely because the capability cache is stuck in a negative state or the GitLab instance version is below the required minimum.

**Alert expression:**

```promql
rate(mr_composite_rest_fallback[5m]) / rate(mr_composite_total[5m]) > 0.5
```

**For duration:** 30 minutes

**Severity:** `warning`

**Runbook anchor:** [#composite-rest-fallback](#composite-rest-fallback)

**Remediation:** Check the GraphQL capability cache status via pod logs (`graphql.capability` events). If the cache shows a persistent negative entry for the GitLab instance, inspect whether the instance version supports the required GraphQL fields. Force a cache flush by restarting the pod (the cache is in-memory). If the GitLab instance genuinely lacks GraphQL support, the REST fallback is correct behavior and this alert threshold should be adjusted or suppressed.

---

### `EPICS_LIST_REST_FALLBACK` — epics list REST fallback rate

Same shape as `MR_COMPOSITE_REST_FALLBACK`. The epics list strategy prefers GraphQL (which supports group-level epic queries) and falls back to REST. Chronic fallback indicates the GraphQL capability cache is negative for epic queries.

**Alert expression:**

```promql
rate(epics_list_rest_fallback[5m]) / rate(epics_list_total[5m]) > 0.5
```

**For duration:** 30 minutes

**Severity:** `warning`

**Runbook anchor:** [#composite-rest-fallback](#composite-rest-fallback)

**Remediation:** Same as `MR_COMPOSITE_REST_FALLBACK` above. Additionally verify that the GitLab instance has the Epics feature enabled (requires GitLab EE or GitLab.com). If the instance is GitLab CE, epics are unavailable and the REST fallback returning empty is correct — suppress this alert for CE deployments.

---

### `MR_LIST_REST_FALLBACK` — MR list REST fallback rate

Same shape. The MR list strategy uses GraphQL to fetch MR fields in a single round-trip and falls back to REST pagination. Chronic fallback rate above 50% degrades backfill performance (REST pagination is slower and more rate-limit-sensitive than GraphQL).

**Alert expression:**

```promql
rate(mr_list_rest_fallback[5m]) / rate(mr_list_total[5m]) > 0.5
```

**For duration:** 30 minutes

**Severity:** `warning`

**Runbook anchor:** [#composite-rest-fallback](#composite-rest-fallback)

**Remediation:** Same as `MR_COMPOSITE_REST_FALLBACK` above.

---

### `GRAPHQL_CAPABILITY_NEGATIVE_CACHE_HIT` — GraphQL capability negative cache hit rate

The GraphQL capability cache records whether a given GitLab instance supports a specific GraphQL operation. A negative cache hit means a previous probe failed and the cache is short-circuiting the GraphQL attempt, returning immediately to REST. A high negative-hit rate (above 1 req/s sustained) indicates many operations are being short-circuited — either because the instance genuinely lacks support, or because a transient probe error was cached and has not been re-evaluated.

**Alert expression:**

```promql
rate(graphql_capability_negative_cache_hit[10m]) > 1.0
```

**For duration:** 30 minutes

**Severity:** `warning`

**Runbook anchor:** [#graphql-capability-negative-cache](#graphql-capability-negative-cache)

**Remediation:** Check pod logs for `graphql.capability.probe.failed` events to identify which operation(s) triggered the negative cache entries. If the failure was transient (e.g. a GitLab upgrade in progress), restart the pod to flush the in-memory cache. If the probe failures are persistent, verify the GitLab instance version and that the GraphQL endpoint is reachable from the pod (`curl ${GITLAB_URL}/api/graphql`).

---

## Runbook Anchors

### echo-drop-rate-zero

TxSubscriber echo-drop rate is zero for 30+ minutes. Either the subscription is broken or there is no write traffic.

1. Check `tx.subscription.connected` metric — should be `1`.
2. Check pod logs: `docker logs pod-gitlab 2>&1 | grep tx.subscription`.
3. If disconnected, the pod auto-reconnects; check for repeated `tx.subscription.reconnect` events indicating a loop.
4. If connected but no drops, verify there is active binding traffic by checking `GET /api/v1/bindings` for enabled bindings and recent GitLab webhook deliveries.

### service-account-resolved-nonzero

Path D should have retired service-account resolution. A non-zero value is informational — review current `SYNC_PATH` configuration and whether a migration is in progress.

### composite-rest-fallback

GraphQL adapter not engaging for MR composite, epics list, or MR list fetches.

1. Inspect capability cache: grep pod logs for `graphql.capability`.
2. Restart the pod to flush the in-memory capability cache.
3. After restart, watch for `graphql.capability.probe.ok` to confirm re-evaluation.
4. If probes continue to fail, check GitLab version requirements in `docs/architecture.md`.

### graphql-capability-negative-cache

High rate of negative cache hits short-circuiting GraphQL attempts.

1. Identify affected operations: `grep 'graphql.capability.negative_cache_hit' <pod-logs>`.
2. Check whether the GitLab instance was recently upgraded or temporarily unreachable.
3. Restart the pod to flush the cache if the underlying condition has been resolved.
4. If the GitLab instance genuinely does not support the operation, the REST fallback is correct and the alert threshold should be raised or the metric suppressed for that instance.

---

## Service-Account PersonId Resolution

The TxSubscriber echo-storm filter (Layer 1) requires the pod's service-account `PersonId` — the value that the Huly transactor stamps on `tx.modifiedBy` for writes made by this pod. Three resolution paths are supported:

### Path F — operator-provided (recommended)

Set the `SERVICE_ACCOUNT_PERSON_ID` environment variable to the UUID of the service account.

```bash
# .env or pod environment
SERVICE_ACCOUNT_PERSON_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

**How to obtain the value:**

1. Enable `LOG_LEVEL=debug` temporarily on the pod.
2. Watch for log lines like `TxSubscriber: onTx` or inspect `modifiedBy` in platform transaction logs.
3. Alternatively, query the Huly account service for the system-account record.
4. Set `SERVICE_ACCOUNT_PERSON_ID` to the UUID found in step 2 or 3.

When Path F is active, the pod logs:
```
service-account-resolution: Path F engaged (operator-provided)
main: service-account PersonId resolved { path: 'F', resolved: true }
```

The `SERVICE_ACCOUNT_RESOLVED` gauge is set to `1`.

### Path G — boot-time probe (automatic)

If `SERVICE_ACCOUNT_PERSON_ID` is not set, the pod attempts a boot-time probe on each workspace client:

1. Writes a transient sentinel doc to the platform.
2. Reads it back and captures `tx.modifiedBy`.
3. Deletes the sentinel.
4. Uses the captured PersonId as the echo-filter identity.

The probe is bounded to **10 seconds**. On timeout or write error, Path D fallback applies.

When Path G succeeds, the pod logs:
```
service-account-resolution: Path G probe succeeded { personId: "..." }
service-account-resolution: Path G engaged (boot-time probe)
main: service-account PersonId resolved { path: 'G', resolved: true }
```

The `SERVICE_ACCOUNT_RESOLVED` gauge is set to `1`.

**Note:** Path G probe is run at per-workspace client init time. For pods managing many workspaces, probes are run in sequence during each workspace's first `onWorkspaceLoaded` callback.

### Path D — sentinel fallback (degraded)

If neither Path F nor Path G succeeds, the pod uses `systemAccountUuid` cast to `PersonId` as the echo-filter identity.

When Path D is active, the pod logs:
```
service-account-resolution: Path D fallback (systemAccountUuid sentinel)
main: service-account PersonId resolved { path: 'D', resolved: false }
```

The `SERVICE_ACCOUNT_RESOLVED` gauge is set to `0`.

**Operator action:** Alert on `SERVICE_ACCOUNT_RESOLVED=0`. Configure `SERVICE_ACCOUNT_PERSON_ID` (Path F) or ensure Path G probe can write to the platform workspace. If the platform stamps the same `systemAccountUuid` on writes, Path D may be functionally correct but cannot be confirmed without Path F or G.

### Health check

```bash
# Confirm resolution path in pod startup logs
grep "service-account PersonId resolved" <pod-logs>

# Monitor echo-filter metric — should be non-zero during applyRemote activity
# A sustained zero indicates the filter identity may not match platform writes
grep "SERVICE_ACCOUNT_RESOLVED" <pod-metrics>
```
