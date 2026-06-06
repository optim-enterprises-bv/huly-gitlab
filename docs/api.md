# REST API Reference

All admin endpoints require the `Authorization: Bearer ${SERVER_SECRET}` header.

## Health Check

### GET /health

Server health status including external dependencies.

**Request:**
```bash
curl http://localhost:3600/health
```

**Response:**
```json
{
  "status": "ok",
  "uptime": 3600.5,
  "gitlabReachable": true,
  "mongoOk": true
}
```

**Status Codes:**
- `200` — All dependencies reachable
- `503` — MongoDB or GitLab unreachable

---

## Bindings

### POST /api/v1/bindings

Create a new binding between a GitLab project and a Huly project. Automatically registers a webhook on the GitLab project.

**Request:**
```bash
curl -X POST http://localhost:3600/api/v1/bindings \
  -H "Authorization: Bearer ${SERVER_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workspaceUuid": "workspace-uuid",
    "hulyProjectRef": "tracker:class:Project$proj-123",
    "gitlabProjectId": 42,
    "credentialRef": "credential-id"
  }'
```

**Request Body:**
- `workspaceUuid` (string, required) — Huly workspace UUID
- `hulyProjectRef` (string, required) — Huly project reference (format: `tracker:class:Project$<id>`)
- `gitlabProjectId` (integer, required) — GitLab numeric project ID
- `credentialRef` (string, required) — Reference to OAuth or access token credential

**Response:**
```json
{
  "bindingId": "binding-id-123",
  "webhookRegistered": true,
  "gitlabProjectPath": "group/project-name"
}
```

**Status Codes:**
- `201` — Binding created successfully
- `400` — Invalid request body or missing required fields
- `401` — Invalid or missing `Authorization` header
- `409` — Binding already exists for this (workspaceUuid, gitlabProjectId) pair

---

### GET /api/v1/bindings

List all bindings for a workspace. Does not return plaintext webhook secrets.

**Request:**
```bash
curl http://localhost:3600/api/v1/bindings?workspaceUuid=workspace-uuid \
  -H "Authorization: Bearer ${SERVER_SECRET}"
```

**Query Parameters:**
- `workspaceUuid` (string, required) — Filter bindings by workspace

**Response:**
```json
[
  {
    "bindingId": "binding-id-123",
    "workspaceUuid": "workspace-uuid",
    "hulyProjectRef": "tracker:class:Project$proj-123",
    "gitlabProjectId": 42,
    "gitlabProjectPath": "group/project-name",
    "webhookRegistered": true,
    "createdAt": "2026-06-05T10:00:00Z",
    "disabled": false
  }
]
```

**Status Codes:**
- `200` — Bindings retrieved successfully (may be empty array)
- `401` — Invalid or missing `Authorization` header

**Security Note:** `webhookSecretRef` and plaintext webhook secret are not returned in this response.

---

### DELETE /api/v1/bindings/:id

Delete a binding and deregister its GitLab webhook (best-effort).

**Request:**
```bash
curl -X DELETE http://localhost:3600/api/v1/bindings/binding-id-123 \
  -H "Authorization: Bearer ${SERVER_SECRET}"
```

**Response:**
```json
{
  "bindingId": "binding-id-123",
  "deleted": true
}
```

**Status Codes:**
- `200` — Binding deleted successfully (webhook deregistration is best-effort)
- `401` — Invalid or missing `Authorization` header
- `404` — Binding not found

---

### POST /api/v1/bindings/:id/rotate-secret

Rotate the webhook secret for a binding and update the GitLab webhook. Plaintext secret is never returned.

**Request:**
```bash
curl -X POST http://localhost:3600/api/v1/bindings/binding-id-123/rotate-secret \
  -H "Authorization: Bearer ${SERVER_SECRET}"
```

**Response:**
```json
{
  "bindingId": "binding-id-123",
  "rotatedAt": "2026-06-05T10:05:00Z"
}
```

**Status Codes:**
- `200` — Secret rotated successfully
- `401` — Invalid or missing `Authorization` header
- `404` — Binding not found

**Notes:**
- Old webhook signatures are invalid after rotation
- New webhook events will use the rotated secret
- The webhook on GitLab is updated in-place via HTTP PUT

---

### POST /api/v1/bindings/:id/re-register-webhook

Re-register the webhook on a GitLab project, subscribing to additional events introduced in Phase 2 (merge requests and pipelines). Used for Phase 1 → Phase 2 migration of existing bindings.

**Request:**
```bash
curl -X POST http://localhost:3600/api/v1/bindings/binding-id-123/re-register-webhook \
  -H "Authorization: Bearer ${SERVER_SECRET}"
```

**Path Parameters:**
- `id` (string, required) — Binding ID (24-character hex ObjectId)

**Request Body:**
- Empty (POST with no body)

**Response:**
```json
{
  "bindingId": "binding-id-123",
  "rotatedAt": "2026-06-05T10:05:00Z",
  "webhookRegistered": true,
  "webhookId": 12345,
  "reason": "re-registered with merge_requests_events, pipeline_events"
}
```

**Response fields:**
- `bindingId` (string) — The binding that was re-registered
- `rotatedAt` (ISO 8601 string) — Timestamp of the operation
- `webhookRegistered` (boolean) — Whether webhook registration succeeded
- `webhookId` (integer, optional) — GitLab webhook ID if successful
- `reason` (string, optional) — Human-readable status or error message

**Status Codes:**
- `200` — Webhook re-registered successfully
- `400` — Invalid binding ID format (not a 24-hex ObjectId)
- `401` — Invalid or missing `Authorization` header
- `404` — Binding not found

**Notes:**
- **Phase 1 bindings:** After Phase 2 deployment, existing Phase 1 bindings will **not** receive merge request or pipeline events until this endpoint is called once per binding.
- **Confidentiality preserved:** The re-registered webhook explicitly sets `confidential_issues_events: false` and `confidential_merge_requests_events: false` (Phase 1 carryover; Q5 confidentiality filtering remains in effect).
- **Event subscriptions added:** Re-registration subscribes the webhook to `merge_requests_events` and `pipeline_events` (in addition to the existing `issues_events` and `note_events`).
- **Example flow:** See [Phase 2 Migration Runbook](../docs/phase2-runbook.md) for step-by-step migration instructions.

---

### PATCH /api/v1/bindings/:id

Update binding configuration (currently supports the `disabled` toggle). Used to pause a binding before running the reviewer-label migration.

**Request:**
```bash
curl -X PATCH http://localhost:3600/api/v1/bindings/binding-id-123 \
  -H "Authorization: Bearer ${SERVER_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{"disabled": true}'
```

**Path Parameters:**
- `id` (string, required) — Binding ID (24-character hex ObjectId)

**Request Body:**
- `disabled` (boolean, required) — Set to `true` to pause sync; `false` to resume.

**Response:**
```json
{
  "bindingId": "binding-id-123",
  "disabled": true,
  "updatedAt": "2026-06-05T10:30:00Z"
}
```

**Response fields:**
- `bindingId` (string) — The updated binding
- `disabled` (boolean) — Current disabled state
- `updatedAt` (ISO 8601 string) — Timestamp of the update

**Status Codes:**
- `200` — Binding updated successfully
- `400` — Invalid binding ID format (not a 24-hex ObjectId) or invalid request body
- `401` — Invalid or missing `Authorization` header
- `404` — Binding not found

**Notes:**
- **Pause before migration:** The reviewer-label migration endpoint (`POST /api/v1/bindings/:id/migrate-reviewer-labels`) requires the binding to be disabled (`disabled: true`) before migration runs to prevent sync writes during label conversion.
- **Idempotent:** Setting `disabled: true` when already disabled (or `disabled: false` when already enabled) is safe and returns `200`.
- **See also:** [Phase 3 Migration Runbook](../docs/phase3-runbook.md) for the full operator workflow.

---

### POST /api/v1/bindings/:id/migrate-reviewer-labels

Migrate Phase 2 synthetic reviewer labels to Phase 3 typed `reviewers` field. **Requires the binding to be paused (`disabled: true`) before execution.** This is a one-shot operation per binding; running on an already-migrated binding is safe (idempotent).

**Request:**
```bash
curl -X POST http://localhost:3600/api/v1/bindings/binding-id-123/migrate-reviewer-labels \
  -H "Authorization: Bearer ${SERVER_SECRET}"
```

**Path Parameters:**
- `id` (string, required) — Binding ID (24-character hex ObjectId)

**Request Body:**
- Empty (POST with no body)

**Response (success):**
```json
{
  "migratedAt": "2026-06-05T10:35:00Z",
  "mrsScanned": 42,
  "labelsStripped": 87,
  "reviewersResolved": 87,
  "unresolvedCount": 0
}
```

**Response fields:**
- `migratedAt` (ISO 8601 string) — Timestamp of the migration
- `mrsScanned` (integer) — Number of mirrored MR Issues examined
- `labelsStripped` (integer) — Number of `gitlab:reviewer:*` labels removed
- `reviewersResolved` (integer) — Number of labels successfully mapped to PersonUuids
- `unresolvedCount` (integer) — Number of labels that could not be resolved to Huly persons (best-effort migration; these reviewers are dropped)

**Response (conflict):**
```json
{
  "error": "binding_active",
  "message": "Pause binding (PATCH /api/v1/bindings/:id with {disabled: true}) before running migration; re-enable after.",
  "timestamp": "2026-06-05T10:35:00Z"
}
```

**Status Codes:**
- `200` — Migration completed successfully
- `400` — Invalid binding ID format (not a 24-hex ObjectId)
- `401` — Invalid or missing `Authorization` header
- `404` — Binding not found
- `409` — Binding is active (`disabled !== true`); pause before retrying

**Notes:**
- **Idempotent and safe:** Re-running migration on an already-migrated binding is safe. Labels already converted will be re-stripped; `reviewersResolved` will be lower on second run (labels already gone).
- **Unresolved reviewers:** If a `gitlab:reviewer:*` label maps to a GitLab user who has no Huly identity, the label is still stripped but the reviewer is not added to the typed `reviewers` field. Check `unresolvedCount` in the response; manual cleanup via GitLab may be needed for those cases.
- **Operator workflow:** See [Phase 3 Migration Runbook](../docs/phase3-runbook.md) for the recommended sequence:
  1. Pause: `PATCH /api/v1/bindings/:id {disabled: true}`
  2. Migrate: `POST /api/v1/bindings/:id/migrate-reviewer-labels`
  3. Resume: `PATCH /api/v1/bindings/:id {disabled: false}`

---

## OAuth Flow

### GET /oauth/start

Begin OAuth authentication flow. Redirects user to GitLab's OAuth authorize endpoint.

**Request:**
```bash
# Typically called by a web UI or CLI
curl "http://localhost:3600/oauth/start?workspaceUuid=workspace-uuid&hulyProjectRef=tracker:class:Project%24proj-123"
```

**Query Parameters:**
- `workspaceUuid` (string, required) — Huly workspace UUID
- `hulyProjectRef` (string, required) — Huly project reference (URL-encoded)

**Response:**
- Redirect (302) to `${GITLAB_BASE_URL}/oauth/authorize?client_id=...&redirect_uri=...&state=...&scope=api,read_user,read_repository`

**State Parameter:**
- State is signed with `SERVER_SECRET` using HMAC-SHA256
- Prevents CSRF attacks

---

### GET /oauth/callback

OAuth callback endpoint. Exchanges authorization code for access token and stores encrypted credential.

**Request:**
```bash
# GitLab redirects the user's browser here automatically
curl "http://localhost:3600/oauth/callback?code=auth-code&state=signed-state"
```

**Query Parameters:**
- `code` (string, required) — Authorization code from GitLab
- `state` (string, required) — Signed state from `/oauth/start`

**Response (Success):**
```json
{
  "credentialRef": "credential-id-456"
}
```

**Response (Failure):**
```html
<html>
  <body>
    <h1>OAuth Error</h1>
    <p>Invalid state or expired authorization code. Please try again.</p>
  </body>
</html>
```

**Status Codes:**
- `200` — Token exchanged and stored successfully
- `400` — Invalid state, expired code, or network error
- `401` — GitLab returned an error during token exchange

---

## Credentials

### POST /api/v1/credentials/access-token

Register a GitLab personal access token (PAT) as an encrypted credential.

**Request:**
```bash
curl -X POST http://localhost:3600/api/v1/credentials/access-token \
  -H "Authorization: Bearer ${SERVER_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "token": "glpat-1234567890abcdef",
    "scope": "project",
    "resourceId": 42
  }'
```

**Request Body:**
- `token` (string, required) — GitLab personal access token
- `scope` (string, required) — `group` or `project`
- `resourceId` (integer, required) — GitLab group ID or project ID

**Response:**
```json
{
  "credentialRef": "credential-id-789",
  "scope": "project",
  "resourceId": 42,
  "createdAt": "2026-06-05T10:10:00Z"
}
```

**Status Codes:**
- `201` — Token validated and stored successfully
- `400` — Invalid token or missing required fields
- `401` — Invalid or missing `Authorization` header
- `401` — Token validation failed (GitLab returned 401)

---

### GET /api/v1/credentials

List all stored credentials for the workspace. Does not return plaintext tokens.

**Request:**
```bash
curl http://localhost:3600/api/v1/credentials \
  -H "Authorization: Bearer ${SERVER_SECRET}"
```

**Response:**
```json
[
  {
    "credentialRef": "credential-id-456",
    "kind": "oauth",
    "createdAt": "2026-06-05T10:00:00Z",
    "expiresAt": "2026-06-08T10:00:00Z"
  },
  {
    "credentialRef": "credential-id-789",
    "kind": "access_token",
    "createdAt": "2026-06-05T10:10:00Z",
    "expiresAt": null
  }
]
```

**Status Codes:**
- `200` — Credentials retrieved successfully (may be empty array)
- `401` — Invalid or missing `Authorization` header

**Security Note:** Plaintext tokens, ciphertexts, and IVs are not returned in this response.

---

## Phase 4: Per-User OAuth Endpoints

### GET /user/oauth/start

Initiate OAuth flow for a Huly user to link their per-user GitLab credentials. **Cookie-protected; rate-limited.**

**Request:**
```bash
curl -i http://localhost:3600/user/oauth/start \
  -H "Cookie: huly-user=<huly-user-cookie>"
```

**Headers:**
- `Cookie: huly-user` — Required. JSON+HMAC cookie containing `hulyPersonUuid` and `workspaceUuid`.

**Query Parameters:**
- `gitlabBaseUrl` (string, optional) — GitLab instance URL (default: `GITLAB_BASE_URL` env). Used for multi-instance bindings.

**Response:**
```
HTTP/1.1 302 Found
Location: https://gitlab.example.com/oauth/authorize?client_id=...&state=...&code_challenge=...
```

**Status Codes:**
- `302` — Redirect to GitLab OAuth authorize endpoint
- `400` — Invalid or malformed cookie
- `401` — Cookie validation failed (invalid HMAC or expired)
- `429` — Rate limit exceeded (5 req/min per IP)

**Security:**
- Cookie is HMAC-validated on the server; no token in query string.
- PKCE challenge is generated server-side and stored in transient state.
- Caller MUST follow the 302 redirect to complete OAuth flow.

---

### GET /user/oauth/callback

OAuth callback endpoint invoked by GitLab after user grants permission. **Public (no auth required); state-validated.**

**Request:**
```bash
GET /user/oauth/callback?code=...&state=...
```

**Query Parameters:**
- `code` (string, required) — OAuth authorization code from GitLab
- `state` (string, required) — PKCE state parameter (validates `code_challenge`)
- `error` (string, optional) — GitLab error code if user declined

**Response (success):**
```
HTTP/1.1 302 Found
Location: /user/ui/?status=linked&username=@gitlab-username
Set-Cookie: huly-user=...; HttpOnly; SameSite=Lax
```

**Response (error):**
```
HTTP/1.1 302 Found
Location: /user/ui/?status=error&message=oauth_denied
```

**Status Codes:**
- `302` — Redirect to `/user/ui/` UI (always 302, even on error)
- `400` — Invalid state or missing code parameter

**Flow:**
1. Validate PKCE state (prevents CSRF; stored server-side during `/user/oauth/start`)
2. Exchange `code` for `access_token` via GitLab token endpoint
3. Call `GET /api/v4/user` to fetch GitLab username
4. Encrypt and store token + username in `user_credentials` collection (keyed by `(workspaceUuid, hulyPersonUuid, gitlabBaseUrl)`)
5. Redirect to `/user/ui/` with success status

---

### GET /user/oauth/status

Get current OAuth status for the authenticated user. **Cookie-protected.**

**Request:**
```bash
curl http://localhost:3600/user/oauth/status \
  -H "Cookie: huly-user=<huly-user-cookie>"
```

**Headers:**
- `Cookie: huly-user` — Required

**Query Parameters:**
- `gitlabBaseUrl` (string, optional) — GitLab instance URL (default: `GITLAB_BASE_URL`). Use for multi-instance bindings.

**Response (linked):**
```json
{
  "status": "linked",
  "username": "@gitlab-username",
  "gitlabBaseUrl": "https://gitlab.example.com",
  "createdAt": "2026-06-05T10:00:00Z",
  "expiresAt": "2026-06-08T10:00:00Z"
}
```

**Response (not linked):**
```json
{
  "status": "not_linked",
  "gitlabBaseUrl": "https://gitlab.example.com"
}
```

**Response (expired):**
```json
{
  "status": "expired",
  "username": "@gitlab-username",
  "expiresAt": "2026-06-05T10:00:00Z",
  "message": "Token expired; relink required"
}
```

**Status Codes:**
- `200` — Status retrieved successfully
- `400` — Invalid or malformed cookie
- `401` — Cookie validation failed

---

### DELETE /user/oauth/credential

Unlink a per-user GitLab credential. **Cookie-protected.**

**Request:**
```bash
curl -X DELETE http://localhost:3600/user/oauth/credential \
  -H "Cookie: huly-user=<huly-user-cookie>"
```

**Query Parameters:**
- `gitlabBaseUrl` (string, optional) — GitLab instance URL (default: `GITLAB_BASE_URL`)

**Response:**
```json
{
  "status": "unlinked",
  "gitlabBaseUrl": "https://gitlab.example.com",
  "timestamp": "2026-06-05T10:05:00Z"
}
```

**Status Codes:**
- `200` — Credential deleted successfully
- `400` — Invalid or malformed cookie
- `401` — Cookie validation failed
- `404` — No credential found for this user/instance pair

---

### GET /user/ui/

Minimal OAuth UI for linking/unlinking GitLab credentials. **Public endpoint; returns static HTML + vanilla JS.**

**Request:**
```bash
curl http://localhost:3600/user/ui/
```

**Response:**
```html
HTTP/1.1 200 OK
Content-Type: text/html; charset=utf-8
Content-Security-Policy: default-src 'none'; script-src 'wasm-unsafe-eval'; style-src 'unsafe-inline'

<!DOCTYPE html>
<html>
<head>
  <title>GitLab Credential Manager</title>
  <style>
    /* minimal inline CSS; no external resources */
  </style>
</head>
<body>
  <!-- Vanilla HTML + JS; no build step required -->
  <div id="app">
    <h1>Link GitLab Credential</h1>
    <p id="status">Loading...</p>
    <button id="linkBtn" onclick="linkGitlab()">Link GitLab</button>
    <button id="unlinkBtn" style="display:none" onclick="unlinkGitlab()">Unlink</button>
  </div>
  <script>
    // Vanilla JS; bearer token arrives via postMessage or sessionStorage only
    // Query-string bearer is REJECTED
  </script>
</body>
</html>
```

**Security Headers:**
- `Content-Security-Policy: default-src 'none'; script-src 'wasm-unsafe-eval'; style-src 'unsafe-inline'` — Prevents inline-script bearer exfiltration; no external resources
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: SAMEORIGIN`

**Bearer Token Transport (Bug-6):**
- The UI expects the Huly parent window to call `iframe.postMessage({bearer: 'token'}, origin)` to pass credentials
- Alternatively, credentials are read from `sessionStorage.getItem('huly:bearer')`
- **Query-string bearer is explicitly REJECTED** at the UI layer (`location.search` is not consulted for tokens)

---

## Epic Webhook Events (Phase 4)

Webhook subscriptions expand in Phase 4 to include `epic_events` on EE instances:

### POST /webhook/:bindingId (Epic Hook)

GitLab epic webhook event receiver. **Invoked by GitLab, not directly by administrators.**

**Request (example: Epic Hook):**
```
POST /webhook/binding-id-123 HTTP/1.1
Host: your-host:3600
X-Gitlab-Token: webhook-secret-here
X-Gitlab-Event: Epic Hook
Content-Type: application/json

{
  "object_kind": "epic",
  "event_type": "epic",
  "action": "open",
  "object_attributes": {
    "iid": 5,
    "group_id": 42,
    "title": "Q2 Planning",
    "state": "opened",
    "updated_at": "2026-06-05T10:00:00Z",
    "url": "https://gitlab.example/groups/team/-/epics/5",
    ...
  }
}
```

**Webhook Event Subscription (Phase 4 addition):**
- `epic_events` — Epic creation, update, open/close (EE only)

**Processing:**
- Signature validation via `crypto.timingSafeEqual`
- Deduplication check
- Enqueued to SyncEngine via `EpicsSyncManager`
- On CE (Community Edition): epic events are silently dropped with `ee.feature.skipped` metric

**Status Codes:**
- `200` — Event queued for processing
- `401` — Signature validation failed
- `404` — Binding not found
- `503` — Feature unavailable (CE instance; epic_events ignored)

---

## Webhooks

### POST /webhook/:bindingId

GitLab webhook event receiver. **Invoked by GitLab, not directly by administrators.**

GitLab sends the request body as JSON and signs it with the `X-Gitlab-Token` header (the binding's webhook secret).

**Request (example: Issue Hook):**
```
POST /webhook/binding-id-123 HTTP/1.1
Host: your-host:3600
X-Gitlab-Token: webhook-secret-here
X-Gitlab-Event: Issue Hook
Content-Type: application/json
Content-Length: ...

{
  "object_kind": "issue",
  "event_type": "issue",
  "action": "open",
  "object_attributes": {
    "iid": 1,
    "title": "Sample Issue",
    "description": "Issue description",
    "state": "opened",
    "updated_at": "2026-06-05T10:00:00Z",
    "confidential": false,
    ...
  },
  ...
}
```

**Webhook Events Subscribed:**
- `issues_events` — Issue creation, update, reopen, close
- `note_events` — Comments and notes
- Does NOT subscribe to `confidential_issues_events` or `confidential_note_events` (Phase 1 limitation)

**Response:**
```json
{
  "status": "queued"
}
```

**Status Codes:**
- `200` — Event queued for processing
- `401` — Signature validation failed (invalid `X-Gitlab-Token`)
- `404` — Binding not found
- `413` — Request body exceeds 5MB limit

**Flow:**
1. Signature validation via `crypto.timingSafeEqual`
2. Deduplication check (prevent duplicate processing)
3. Event enqueued to SyncEngine
4. Conflict resolution and Huly sync happen asynchronously
5. 200 returned immediately (does not wait for sync completion)

---

## Error Responses

All error responses follow this format:

```json
{
  "error": "error_code",
  "message": "Human-readable error message",
  "timestamp": "2026-06-05T10:00:00Z"
}
```

**Common Error Codes:**
- `invalid_request` — Malformed request or missing required fields
- `unauthorized` — Invalid or missing `Authorization` header
- `forbidden` — Signature validation failed (webhook only)
- `not_found` — Resource (binding, credential) not found
- `conflict` — Binding or credential already exists
- `rate_limited` — Too many requests
- `external_service_error` — GitLab or Huly service error

---

## Rate Limiting

The pod itself does not implement per-client rate limiting. However, it respects GitLab's rate limits:

- GitLab API returns `X-RateLimit-*` headers
- Pod's adapter automatically retries on 429 with exponential backoff
- Default limit: 25 concurrent requests to GitLab API (configurable via `RATE_LIMIT` env)

---

## Metrics

The pod emits structured logs including these key metrics (consumed by monitoring systems):

- `gitlab.confidential.skipped` — Confidential issue/note filtered out
- `gitlab.breaker.dropped.webhook` — Webhook dropped due to circuit breaker OPEN
- `sync.inflight.discarded` — Stale operation discarded during crash recovery
- `cursor.regression.detected` — Clock skew detected; cursor clamped to now-1s
