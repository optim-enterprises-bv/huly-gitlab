# Open Questions Tracker

## autopilot-impl-phase2 — 2026-06-05

- [ ] Pipeline backfill omission — Phase 2 PipelineSyncManager.backfill is a no-op (webhook-driven only). Acceptable for Phase 2 because pipeline state churns fast; promote to Phase 3 if drift observed. — Affects observability of CI status on bindings where the pod was offline during pipeline runs.
- [ ] Shared `'notes'` cursor across issue-notes and MR-notes — both paths share one cursor; worst case is one redundant fetch per backfill cycle. Split into `'issue_notes'` + `'mr_notes'` in Phase 3 only if performance metrics demand. — Affects backfill efficiency on note-heavy bindings.
- [ ] Mixin removal on type change — if a Huly user changes an MR-mirror Issue's type to "not an MR," do we strip the `gitlab-mr` mixin? Default: no; mixin persists; only GitLab-side delete removes the mirror. — Affects UX consistency when Huly users edit mirror Issues directly.
- [ ] `reviewers` mapping as comma-separated labels (`gitlab:reviewer:<username>`) — Phase 2 ships as labels; Phase 3 should introduce a typed reviewer field. — Affects fidelity of approver/reviewer modeling vs raw labels.
- [ ] `createMergeRequest` callable from tests but not production — `applyLocal` does not call it in Phase 2 (deferred to Phase 3 when intent capture lands). — Affects expectations for users who edit a Huly-only "MR-like" Issue and expect it to push.
- [ ] One-time webhook re-registration for existing Phase 1 bindings — documented as manual admin operation via `POST /api/v1/bindings/:id/re-register-webhook`. Autonomous batch migration deferred to Phase 3. — Affects operators with active Phase 1 deployments who must run the runbook to receive MR + pipeline events.
- [ ] Runtime mixin `gitlab-mr` viability without model registration (P2-R1 contingency) — if E2E mixin read fails against the real Huly transactor, fall back to JSON-string custom field on the Issue. Confirm during P2-T-07 / P2-T-11. — Affects whether the chosen data model survives contact with the real platform; contingency adds ~200 LOC to P2-T-07.
