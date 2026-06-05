# Phase 2 Migration Runbook

Phase 2 adds Merge Request and Pipeline sync. Existing Phase 1 bindings have webhooks subscribed only to `issues_events` and `note_events`. They will **NOT** receive MR or Pipeline events until re-registered.

## Migration Steps

### 1. Deploy Phase 2 Image

Update your deployment to the Phase 2 image (or build from the Phase 2 tag):

```bash
docker pull your-registry/huly-gitlab:phase2
# or
docker build -t your-registry/huly-gitlab:phase2 .
```

Restart the pod. The Phase 2 service is backward-compatible with Phase 1; existing issue and note sync continues to work without modification.

### 2. List Existing Bindings

Identify all Phase 1 bindings that need re-registration:

```bash
curl -X GET "https://huly-gitlab.example.com/api/v1/bindings?workspaceUuid=${WORKSPACE_UUID}" \
  -H "Authorization: Bearer ${SERVER_SECRET}" \
  -H "Content-Type: application/json" | jq '.[] | {bindingId, gitlabProjectPath, webhookRegistered}'
```

Expected output:
```json
{
  "bindingId": "507f1f77bcf86cd799439011",
  "gitlabProjectPath": "group/project-name",
  "webhookRegistered": true
}
```

Note the `bindingId` for each binding.

### 3. Re-register Each Binding

For each binding from step 2, call the re-register endpoint:

```bash
curl -X POST "https://huly-gitlab.example.com/api/v1/bindings/507f1f77bcf86cd799439011/re-register-webhook" \
  -H "Authorization: Bearer ${SERVER_SECRET}"
```

Expected success response:
```json
{
  "bindingId": "507f1f77bcf86cd799439011",
  "rotatedAt": "2026-06-05T10:05:00Z",
  "webhookRegistered": true,
  "webhookId": 12345,
  "reason": "re-registered with merge_requests_events, pipeline_events"
}
```

If `webhookRegistered: false`, check:
- **Credential permissions:** The GitLab API token must have **Maintainer** access to the GitLab project.
- **Network access:** The GitLab instance must be able to reach `https://huly-gitlab.example.com/webhook/...`.
- **Pod logs:** Check service logs for `binding-lifecycle` events.

### 4. Verify Re-registration on GitLab

Optionally, verify the webhook subscriptions directly on GitLab (Admin only):

```bash
# Replace PROJECT_ID and HOOK_ID from the response above
curl -X GET "https://gitlab.example.com/api/v4/projects/${PROJECT_ID}/hooks/${HOOK_ID}" \
  -H "PRIVATE-TOKEN: ${GITLAB_ADMIN_TOKEN}" | jq '.push_events, .issues_events, .note_events, .merge_requests_events, .pipeline_events'
```

Expected output:
```json
true
true
true
true
true
```

Also verify confidentiality flags are preserved:
```bash
curl -X GET "https://gitlab.example.com/api/v4/projects/${PROJECT_ID}/hooks/${HOOK_ID}" \
  -H "PRIVATE-TOKEN: ${GITLAB_ADMIN_TOKEN}" | jq '.confidential_issues_events, .confidential_note_events, .confidential_merge_requests_events'
```

Expected output (all `false`):
```json
false
false
false
```

### 5. Backfill MR & Pipeline History

Phase 2 includes a backfill job that runs on the standard 5-minute cycle (configurable via `BACKFILL_INTERVAL_MS`). After re-registration:

- **First backfill cycle** will fetch all non-deleted, non-confidential MRs from the GitLab project and create corresponding Huly Issues.
- **Subsequent cycles** fetch only updates since the last cursor position.
- **Pipeline backfill** is webhook-driven in Phase 2; historical pipelines are NOT backfilled. Phase 3 will add pipeline backfill if needed.

No manual action is required; backfill is automatic.

## Automation (Script Template)

For deployments with many bindings, use this bash script:

```bash
#!/bin/bash

SERVER_SECRET="${SERVER_SECRET}"
BASE_URL="${BASE_URL:-https://huly-gitlab.example.com}"
WORKSPACE_UUID="${WORKSPACE_UUID}"

# List all bindings
BINDINGS=$(curl -s -X GET "${BASE_URL}/api/v1/bindings?workspaceUuid=${WORKSPACE_UUID}" \
  -H "Authorization: Bearer ${SERVER_SECRET}" \
  -H "Content-Type: application/json")

echo "Found $(echo "$BINDINGS" | jq 'length') bindings. Starting re-registration..."

# Re-register each
echo "$BINDINGS" | jq -r '.[] | .bindingId' | while read -r BINDING_ID; do
  echo "Re-registering binding: ${BINDING_ID}"
  RESPONSE=$(curl -s -X POST "${BASE_URL}/api/v1/bindings/${BINDING_ID}/re-register-webhook" \
    -H "Authorization: Bearer ${SERVER_SECRET}")
  
  REGISTERED=$(echo "$RESPONSE" | jq -r '.webhookRegistered // false')
  if [ "$REGISTERED" = "true" ]; then
    echo "  ✓ Success"
  else
    echo "  ✗ Failed: $(echo "$RESPONSE" | jq -r '.reason // .error')"
  fi
done

echo "Re-registration complete."
```

Run with:
```bash
SERVER_SECRET=your-secret \
BASE_URL=https://huly-gitlab.example.com \
WORKSPACE_UUID=your-workspace-uuid \
bash re-register-bindings.sh
```

## Known Limitations

- **No autonomous migration:** Each binding must be re-registered individually. No bulk operation available in Phase 2.
- **No historical pipeline backfill:** MRs created before Phase 2 deploy will backfill their pipelines only for events that arrive after re-registration. Phase 3 will add historical pipeline sync.
- **Confidential MRs:** Confidential merge requests continue to be filtered at the adapter layer (Phase 1 carryover; Q5 resolution deferred to Phase 4).
- **MR creation from Huly:** Creating merge requests from within Huly is not yet supported. Phase 3 will add this capability.

## Rollback

If Phase 2 needs to be rolled back to Phase 1:

1. Redeploy the Phase 1 image.
2. The re-registered webhooks will continue to deliver MR/Pipeline events to the Phase 1 handler.
3. Phase 1's webhook handler returns 200 for unknown event types and silently drops them — no errors logged.
4. After re-deploying Phase 2, re-register bindings again to resume MR/Pipeline sync.

## Troubleshooting

### Re-register endpoint returns 404

**Cause:** The binding ID is invalid or the binding does not exist.  
**Fix:** Verify the binding ID from step 2 is correct (24-character hex string).

### Re-register endpoint returns 401

**Cause:** The `SERVER_SECRET` is missing or incorrect.  
**Fix:** Verify the bearer token matches your `SERVER_SECRET` environment variable.

### Re-register returns `webhookRegistered: false`

**Cause:** GitLab API token lacks permissions.  
**Fix:** Verify the credential's GitLab user has **Maintainer** access on the project. Retry after credential update.

### MR events not arriving after re-registration

**Cause:** Webhook delivery may be blocked by network policy or GitLab cannot reach your pod.  
**Fix:** Check pod logs (`docker logs` or `kubectl logs`) for `webhook.received` events. If none appear, verify GitLab can reach your `PUBLIC_BASE_URL` and check GitLab webhook delivery logs (GitLab Admin → System Hooks → recent deliveries).

### Backfill not fetching MRs

**Cause:** Backfill may be rate-limited by GitLab, or binding is disabled.  
**Fix:** Check pod logs for `gitlab.rate_limit` events. Verify the binding is not marked `disabled: true` via `GET /api/v1/bindings`. Consider increasing `BACKFILL_INTERVAL_MS` if rate limits are tight.

---

**For additional support:** See [Architecture](architecture.md) for data flow details and [API Reference](api.md) for endpoint specifications.
