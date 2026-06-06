# ADR-001: Phase 4 as Final Phase

**Date:** 2026-06-05  
**Status:** Accepted  
**Deciders:** Integration Team  

---

## Context

The huly-gitlab integration was originally planned as a 5-phase roadmap:
- Phase 1: Issue + note sync (OAuth + webhooks + conflict resolution)
- Phase 2: Merge request sync
- Phase 3: Review threads + CE approvals + diff metadata
- Phase 4: EE features (approval rules, iterations, epics) + multi-instance + per-user OAuth
- Phase 5: (undefined maintenance tasks)

Over the course of Phases 1–3 (495 tests, ~13,200 LOC), the integration delivered a closed-loop two-way sync for issues, notes, merge requests, and review threads. The core differentiators have been achieved:

1. **Conflict-free field-level sync** via last-write-wins timestamps
2. **Bidirectional propagation** (GitLab ↔ Huly)
3. **Real-time webhook + polling fallback** ensuring eventual consistency
4. **Encrypted per-user credential management**

Phase 4 completes the feature set:
- Path B closure (Huly mutations now reach GitLab via TxSubscriber)
- Enterprise Edition features (approval rules, iterations, epics)
- Multi-instance support (one Huly workspace → multiple GitLab instances)
- Per-user OAuth credential UI (reducing reliance on service-account fallback)

---

## Decision

**We will declare Phase 4 as the FINAL phase of this integration.**

After Phase 4 ships, **no Phase 5 is planned.** All remaining operational debt and nice-to-have features are deferred indefinitely. The integration will enter a maintenance-only mode.

---

## Rationale

### 1. **Product Maturity**

Phase 4 achieves the core integration goals:
- Users can create issues/MRs/reviews in Huly and have them propagate to GitLab
- Users can manage approval status, iterations, and epic hierarchy from Huly
- Multi-workspace operators can bind a single Huly workspace to multiple GitLab instances
- Per-user OAuth credentials are stored and used, reducing service-account friction

This is a production-ready, closed-loop integration. Further phases are feature creep, not critical path.

### 2. **Operational Debt is Acceptable**

The remaining deferred items are not blocking production utility:

| Item | Scope | Impact | Deferred |
|------|-------|--------|----------|
| Cookie ServerSecret rotation | Cookie format uses single-secret HMAC | Requires pod downtime; rare in practice | Indefinitely |
| GraphQL adapter | REST API + capability detection works well | Performance optimization only | Indefinitely |
| Image-level annotations | Text-position comments cover 95% of use case | Advanced feature; low demand | Indefinitely |
| Mixin field splitting | 16-field `gitlab-mr` mixin is manageable | Code organization; no user impact | Indefinitely |
| Suggestion UI affordances | Suggestion blocks pass through as markdown | Users manually apply on GitLab; acceptable | Indefinitely |

None of these block approval workflows, epic management, or multi-instance operation.

### 3. **Maintenance Burden**

Five-phase roadmaps create perpetual feature-backlog pressure. Declaring Phase 4 final:
- Removes ambiguity about scope creep boundaries
- Allows the team to shift from feature development to operational excellence
- Stabilizes the API surface (no breaking changes expected)
- Simplifies deployment and testing

### 4. **Team Capacity**

The integration has consumed significant research and implementation effort across four phases. By anchoring on Phase 4 finality, the team can:
- Allocate cycles to production support and monitoring
- Invest in observability (metrics, dashboards, runbooks)
- Address operational requests (scaling, performance tuning) without roadmap pressure

---

## Consequences

### **Positive**

- **Clear scope boundary:** Operators and users understand the integration is feature-complete
- **Simplified deployment:** No "hidden" Phase 5 tasks to maintain in the backlog
- **Maintenance focus:** Post-Phase 4, effort shifts to production support and stabilization
- **Documentation stability:** README, architecture docs, and runbooks are final; no perpetual updates

### **Negative**

- **No GraphQL migration:** REST API + capability detection remains the norm (acceptable; no user impact)
- **No multi-secret cookie rotation:** ServerSecret rotation requires downtime (rare; acceptable risk)
- **No advanced features:** Image-level annotations, sophisticated suggestion UI, mixin field splitting are not coming
- **Maintenance debt:** Teams must manage the codebase as-is; no future refactors planned

### **Neutral**

- **Team transition:** Development team becomes on-call support + operational excellence focus
- **Stakeholder communication:** Users and operators must understand Phase 4 is the final state

---

## Alternatives Considered

### Alternative A: Keep Phase 5 on the Roadmap (Rejected)

**Pros:**
- Leaves room for future enhancements
- Avoids hard commitments

**Cons:**
- Creates perpetual backlog pressure
- Users never know when "finality" is reached
- Team cannot shift focus to operations
- Scope creep incentivizes features rather than stability

**Decision:** Rejected. Hard boundaries are better for team focus and user expectations.

### Alternative B: Soft Maintenance-Only Mode (Partial Adoption)

**Pros:**
- Allows Phase 5 to re-emerge if critical needs arise

**Cons:**
- Equivalent to "no declared final phase" — ambiguity remains
- Team cannot fully context-switch to operations
- Backlog pressure continues

**Decision:** Rejected. We need a clear final state, not a gray area.

---

## Compliance

This ADR supersedes any previous roadmap documents mentioning Phase 5. The integration is officially feature-complete at Phase 4 GA.

---

## Sign-Off

- **Integration Team:** Accepts Phase 4 as final
- **Operations:** Aware; will shift to production support mode
- **Product:** Concurs; no customer requests for Phase 5 features

---

## Appendix: Feature Summary at Phase 4

### Implemented (Phase 1–4)

- Two-way Issue sync (title, description, state, labels, milestones, assignees)
- Two-way Note sync (comments on issues and MRs)
- Two-way Merge Request sync (source/target branches, draft, status)
- Review threads as ChatMessages (with position tracking)
- CE Approval sync (required count, approved users, approval status)
- **Phase 4:** EE Approval Rules (rule-based approvers)
- **Phase 4:** Iterations (sprint assignment)
- **Phase 4:** Epics with parent-child hierarchy
- **Phase 4:** Multi-instance binding support
- **Phase 4:** Per-user OAuth credential store + UI
- **Phase 4:** Path B closure (Huly mutations propagate to GitLab)
- Webhook subscriptions + 5-min polling fallback
- Last-write-wins conflict resolution
- Encrypted credential storage (AES-256-GCM)
- Circuit breaker for fault tolerance

### Explicitly Deferred (Forever)

- Confidential issues/MRs access control (requires Huly ACL integration)
- GraphQL adapter (REST is sufficient)
- Image/file-level discussion annotations (text-position comments cover 95% of use)
- Multi-secret cookie rotation (single-secret acceptable; rare rotation in practice)
- Mixin field splitting (16-field `gitlab-mr` is manageable)
- Suggestion UI apply/dismiss affordances (passthrough to GitLab is acceptable)

---

## References

- [README.md](README.md) — Phase 4 features and final limitations
- [docs/architecture.md](docs/architecture.md) — System design overview
- [docs/phase4-runbook.md](docs/phase4-runbook.md) — Operator deployment guide
- `.omc/plans/autopilot-impl-phase4.md` — Phase 4 implementation plan
