# Phase 4 Migration & Operations Runbook

This runbook guides operators through Phase 3 → Phase 4 deployment and day-2 operations.

**Phase 4 adds:**
- Path B closure via TxSubscriber (Huly mutations now sync to GitLab)
- EE approval rules, iterations, and epics
- Multi-instance binding support (one Huly workspace → multiple GitLab instances)
- Per-user OAuth credential store with HTML UI

---

## Pre-Deployment Checklist

Before upgrading from Phase 3 to Phase 4:

- [ ] All Phase 3 bindings are healthy (`GET /api/v1/bindings` shows `webhookRegistered: true`)
- [ ] No stale Phase 3 bindings paused before reviewer-label migration
- [ ] MongoDB has `user_credentials` collection created (automatic on first access, but ensure backup compatibility)
- [ ] `CREDENTIAL_ENCRYPTION_KEY` env var is set (same as Phase 1–3; no new key infrastructure)
- [ ] `PUBLIC_BASE_URL` is correct (used by OAuth callback redirect)

---

## Automatic Phase 4 Features (No Migration Step)

### TxSubscriber

**No migration required.** When the Phase 4 pod starts:

1. On first `BindingLoader.loadFor*` call per workspace, TxSubscriber is instantiated and registered with the per-workspace Huly Client.
2. TxSubscriber begins buffering Tx events immediately (even before `engine.start()` completes).
3. After `engine.start()`, the buffer is drained FIFO into `enqueueLocalEvent`.
4. Cold-start is safe: bounded buffer (default 1024 events) with overflow metric `tx.subscription.buffer.overflow`.

**Validation:** Check pod logs for `tx.subscription.started` at INFO level after first binding load. Subsequent Huly UI approvals/resolutions should emit `sync.local.*` events.

### Multi-instance Binding

**No migration required for existing single-instance bindings.** When Phase 4 detects a second binding under the same workspace pointing to a different `gitlabBaseUrl`:

1. `BindingLoader` sets `bctx.isMultiInstanceWorkspace = true` for that workspace.
2. New idmap entries use 8-hex-hash-prefixed `gitlabId` (e.g., `a1b2c3d4:42:7` for epic in instance 1).
3. Existing single-instance idmap rows remain unprefixed (zero retroactive migration).

**If you need to migrate old single-instance rows to prefixed format (rare):**
- Phase 4 limitation: single-instance workspaces are not retroactively migrated to multi-instance prefix.
- Out of scope for Phase 4. Operators who genuinely add a second instance MUST run a one-time migration script (document as maintenance ticket).

---

## Epic Events Webhook Re-registration (EE Only)

On EE instances, re-register bindings to subscribe to `epic_events`:

```bash
# Phase 3 bindings must re-register to receive epic webhooks in Phase 4
curl -X POST http://localhost:3600/api/v1/bindings/<binding-id>/re-register-webhook \
  -H "Authorization: Bearer ${SERVER_SECRET}"
```

**For each binding on an EE instance:**
1. Operator calls `/re-register-webhook` once
2. Pod calls GitLab `PUT /api/v4/projects/:id/hooks/:webhook_id` with `epic_events: true` added
3. Future epic changes on GitLab emit webhooks to the pod

**Validation:** After re-registration, expect `epic_hook` events in pod logs when epics are created/updated on GitLab. Bindings on CE instances silently ignore epic_events (no error).

---

## Per-User OAuth Credential Linking

Users can now link their per-user GitLab credentials (instead of relying only on the binding's service-account token for approval actions).

### User Self-Service Flow

1. Huly user navigates to `/user/ui/` (can be embedded in Huly as an iframe)
2. Clicks "Link GitLab"
3. Redirected to GitLab OAuth authorize
4. After granting permission, redirected back to `/user/ui/?status=linked&username=@gitlab-user`
5. User's token is encrypted and stored in `user_credentials` collection (keyed by `(workspaceUuid, hulyPersonUuid, gitlabBaseUrl)`)

### Token Refresh (Automatic)

- The pod's `OAuthRefresher` background task checks for expiring tokens every 30 seconds
- Tokens within 5 minutes of expiry are refreshed via GitLab's refresh token endpoint
- Permanent refresh failures set `expired: true`; users must relink

### UI Integration

The `/user/ui/` endpoint returns minimal vanilla HTML (no build step required). Embedding in Huly:

```html
<!-- Huly client (parent window) -->
<iframe id="oauth-ui" src="http://localhost:3600/user/ui/" sandbox="allow-same-origin allow-top-navigation"></iframe>

<script>
  // Huly client passes bearer token to iframe via postMessage
  document.getElementById('oauth-ui').contentWindow.postMessage(
    { bearer: userToken },
    'http://localhost:3600'
  );
</script>
```

**Security:**
- Bearer tokens NEVER appear in query strings (rejected at UI layer)
- CSP headers (`Content-Security-Policy: default-src 'none'`) prevent inline-script exfiltration
- Only query parameters like `status=linked` and `username=@user` are rendered in the UI

---

## Approval Action Attribution

When a Huly user approves/unapproves an MR via the Huly UI (Path B), the integration now picks up per-user tokens:

### Preferred Path: Per-User Token

1. User has linked their GitLab credential via `/user/ui/`
2. Huly UI calls `applyLocal` with the user's PersonUuid
3. `MRCredentialResolver.resolveActorToken(workspaceUuid, hulyPersonUuid)` finds the encrypted token
4. Approval is attributed to the individual user on GitLab

### Fallback: Service Account

1. No per-user token found for the user
2. Uses the binding's service-account token
3. Posts a visibility comment: _"Approved via service account; per-user OAuth UI coming in Phase 4"_ (this message is now outdated and can be removed in Phase 5)
4. Emits `approval.action.fallback.service_account` warning

---

## Monitoring & Metrics

Key Phase 4 metrics to watch:

| Metric | Description | Alert Threshold |
|--------|-------------|-----------------|
| `tx.subscription.started` | TxSubscriber instantiated | Should see once per workspace at startup |
| `tx.subscription.buffer.overflow` | Cold-start buffer exceeded (dropped events) | > 0 = investigate |
| `tx.filter.self_authored` | Self-authored tx filtered (MR-2) | Normal; spike may indicate circular storms |
| `ee.feature.skipped` | EE feature requested on CE instance | Normal on CE; should not occur on EE |
| `epic.applyLocal.skipped` | Epic mutation attempted (expected; out of scope) | Normal; log at DEBUG |
| `user.oauth.linked` | User successfully linked credential | Track adoption |
| `user.oauth.refresh.failed` | Token refresh permanent failure | Alert if > 5% of users |

---

## Troubleshooting

### TxSubscriber not starting

**Symptom:** Pod logs show no `tx.subscription.started` after 5 minutes, and Huly UI approvals do not propagate to GitLab.

**Checks:**
1. Verify at least one binding is healthy: `GET /api/v1/bindings?workspaceUuid=...` returns binding(s)
2. Verify pod is not crashing: `docker logs <container> | grep -i error | head -20`
3. Check BindingLoader cache TTL: TxSubscriber is cached for 30 min; if you delete and recreate a binding rapidly, ensure > 30s gap
4. Verify Huly Client connection: Look for `huly.client.connected` in pod logs

**Resolution:**
- Restart pod: `docker restart <container>`
- Or wait 30+ min for cache eviction and reload a binding

### OAuth flow stuck on redirect

**Symptom:** `/user/oauth/start` returns 302, but GitLab OAuth shows "Invalid redirect URI" or callback never returns to pod.

**Checks:**
1. Verify `PUBLIC_BASE_URL` env var matches the registered OAuth app's redirect URI on GitLab
2. Ensure pod is reachable from GitLab instance network: `curl -i http://${PUBLIC_BASE_URL}/health`
3. Check GitLab OAuth app configuration: Admin → Applications → `huly-gitlab` → Redirect URI must be `${PUBLIC_BASE_URL}/user/oauth/callback`

**Resolution:**
1. Update GitLab OAuth app: change redirect URI to correct `${PUBLIC_BASE_URL}`
2. Or update pod env var: `PUBLIC_BASE_URL=http://correct.host:3600` and restart

### Per-user token expired; approval fails

**Symptom:** User approves MR in Huly; pod logs show `user.oauth.refresh.failed` and approval falls back to service account.

**Checks:**
1. Verify token expiry: `GET /user/oauth/status` (from user's browser with correct cookie)
2. Check MongoDB: `db.user_credentials.findOne({hulyPersonUuid: "..."})`

**Resolution:**
- User must relink: navigate to `/user/ui/` and click "Link GitLab" again
- Or operator can delete: `DELETE /user/oauth/credential` (cookie-protected)

### Epic webhook not arriving

**Symptom:** Pod logs show no `epic_hook` events even after `re-register-webhook`, and epics created on GitLab don't sync.

**Checks:**
1. Is the binding on an EE instance? `curl http://gitlab:80/api/v4/version` → should show `"edition": "EE"`
2. Did `/re-register-webhook` succeed? Check pod logs for `webhook.registered` with `events` field including `epic_events`
3. Is the webhook on GitLab configured? `curl http://gitlab:80/api/v4/projects/:id/hooks/:webhook_id` → check `epic_events: true`

**Resolution:**
1. If CE instance: epic sync is skipped silently; no action needed (intended behavior)
2. If EE instance: call `/re-register-webhook` again and verify pod logs

### Multi-instance idmap collision

**Symptom:** Two bindings pointing to different GitLab instances (both have project ID 42) are writing conflicts in Huly (same mirror issue appearing twice).

**Root Cause:** Phase 3 or earlier bindings were created before Phase 4 multi-instance detection, so idmap entries are unprefixed. When the second instance is added, `isMultiInstanceWorkspace` becomes true, but old rows are not migrated.

**Resolution (Phase 4 scope):**
- This is a known limitation: single-instance to multi-instance migration is out of scope.
- Operators who genuinely add a second instance must pause affected bindings and run a one-time migration script (not provided; requires manual idmap prefix-update).
- Document as a Phase 5 item.

---

## Rollback to Phase 3

If Phase 4 deployment causes critical issues:

1. **Stop Phase 4 pod**
2. **Revert to Phase 3 container image**
3. **Restart pod**: TxSubscriber is not instantiated; no runtime state leakage
4. **No data migration required**: user_credentials collection and epic-related idmap rows are ignored by Phase 3; they do not interfere
5. **Webhooks continue**: Phase 4 re-registrations added `epic_events`, but Phase 3 simply ignores them (no error)

---

## Operational Notes

- **TxSubscriber is the single most consequential change:** Path B being live means Huly UI edits now propagate to GitLab. Test in a non-production workspace first.
- **EE features degrade gracefully:** CE instances silently return empty arrays for approval rules, iterations, and epics. No manual CE flag needed.
- **Per-user OAuth is opt-in:** Users who do not link credentials fall back to service-account approval. No breaking change.
- **Phase 4 is the final phase:** No Phase 5 is planned. All remaining operational debt is documented in "Phase 4 Remaining Limitations" section of README.md.

---

## See Also

- [README.md](README.md) — Phase 4 features and final limitations
- [docs/architecture.md](docs/architecture.md) — Phase 4 system design and flow diagrams
- [docs/api.md](docs/api.md) — Phase 4 OAuth and Epic webhook endpoints
- [docs/adr-phase4-final.md](docs/adr-phase4-final.md) — Architecture decision record for Phase 4 as final
