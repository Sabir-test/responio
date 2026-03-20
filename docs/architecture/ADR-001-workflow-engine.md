# ADR-001: Workflow Engine Selection

**Status**: OPEN — Decision Required from M.Sabir
**Date**: 2026-03-20
**Deciders**: M.Sabir, Architect
**Impact**: High — blocks Phase 2 workflow development

---

## Context

The platform requires a durable workflow execution engine to power the no-code automation builder (equivalent to respond.io's Workflow module). Requirements:

- ≥1,000 concurrent workflow executions per tenant
- Durable execution: retries, timeouts, timeouts, saga compensation
- Visual workflow builder (React Flow) as the customer-facing UI
- Trigger types: NATS events, scheduled (cron), external webhooks
- Action types: send message, update contact, assign agent, HTTP webhook, AI steps
- Workflow versioning: immutable published versions, rollback
- License: must allow embedding in commercial SaaS without royalties or restrictions

---

## The Conflict

**PRD v3 (Section 5.4) recommends: Temporal.io (Apache 2.0)**
> "n8n is NOT used due to fair-code license restrictions that prohibit embedding in a competing SaaS product."

**Build Checklist v3 (Task #18) uses: n8n (headless)**
> "Deploy n8n as headless workflow engine. Customers never see n8n UI."

These two documents conflict. This ADR documents both options and their trade-offs.

---

## Option A: Temporal.io (PRD recommendation)

**License**: Apache 2.0 — safe for commercial SaaS embedding.

### Pros
- Apache 2.0: No license risk, period.
- Durable execution is the core primitive — retries, timeouts, sagas are first-class
- Horizontal scaling to millions of workflows
- Strong OSS community and Temporal Cloud option for managed deployment
- Workflow versioning built-in (deterministic replay)
- TypeScript/Go/Java SDKs — fits our Node.js/TypeScript stack

### Cons
- Higher implementation complexity: must build workflow translator (React Flow → Temporal Workflow code generation or DSL)
- No built-in node library — every action type must be implemented as a Temporal Activity
- Temporal cluster adds operational overhead (Cassandra or PostgreSQL backend)
- Learning curve for new developers unfamiliar with the Temporal programming model
- Estimated build: ~10-14 eng-days for core engine vs ~3 for n8n bridge

### Architecture with Temporal
```
React Flow Builder → JSON DSL → Temporal Workflow Service
    (our visual UI)     (our IR)    (executes Activities)
                                          ↓
                               Temporal Activities
                               (send-message, update-contact, ai-classify, etc.)
                               These are our action endpoints
```

---

## Option B: n8n (Headless) — Checklist recommendation

**License**: n8n Community Edition uses **Sustainable Use License (SUL)** (as of 2023).
The SUL prohibits:
> "...using the software to provide a commercial product or service to third parties"
> This INCLUDES embedding n8n in a SaaS to power customer-facing automation.

**n8n Enterprise Edition** has a commercial license but:
- Per-node pricing can be expensive at scale
- Requires direct commercial agreement with n8n GmbH
- License terms may change

### ⚠️ CRITICAL LICENSE RISK
Using n8n Community Edition in a production SaaS platform where customers use the workflow engine **is a license violation**. This was correctly identified in PRD v3 Section 5.4. The checklist v3 may have been written before fully evaluating this risk.

### Pros
- Lower initial build complexity: NATS bridge + HTTP action endpoints = ~3 eng-days
- Rich built-in node library (HubSpot, Salesforce, HTTP, etc.)
- Execution history UI available (though hidden from customers)
- Faster time to working demo for Phase 2

### Cons
- **License violation risk in production** — HIGH severity
- n8n may audit/sue or demand licensing fees retroactively
- React Flow → n8n JSON translation layer is non-trivial (~5 eng-days)
- Coupling to n8n's internal JSON schema (breaking changes on n8n upgrades)
- Operational complexity: n8n is a full application, not a library

---

## Option C: Hybrid — n8n for MVP, migrate to Temporal

Build with n8n for Phase 2 speed, design the abstraction layer so Temporal is a drop-in replacement.

### Pros
- Fastest path to Growth-tier revenue (Phase 2 exit criteria)
- Buy time to evaluate Temporal learning curve

### Cons
- Two migrations (n8n dev → n8n prod → Temporal) = 2x rework
- Abstraction layer adds complexity upfront
- License risk remains for the period n8n is in production

---

## Recommendation

**Option A: Temporal.io** — aligned with PRD v3's reasoning.

Rationale:
1. License risk from Option B is real and material — legal liability outweighs Phase 2 speed advantage
2. The "3 eng-days saved" with n8n is offset by the risk and the translation layer work (~5 eng-days)
3. Temporal's programming model produces more maintainable workflow code long-term
4. The abstraction layer (React Flow → DSL → execution engine) should be built regardless — design it for Temporal from day one

### Implementation path with Temporal:
1. Deploy Temporal cluster (PostgreSQL backend — reuses existing infra)
2. Build a JSON Workflow DSL that React Flow serializes to
3. Temporal Workflow Service reads the DSL and executes Activities
4. Each action type (send-message, update-contact, AI steps) is a typed Temporal Activity
5. NATS bridge triggers Temporal workflow starts for event-based triggers

---

## Decision Required

**M.Sabir must choose one option before Phase 2 workflow development begins.**

Options:
- [ ] A — Temporal.io (Apache 2.0, higher complexity, zero license risk)
- [ ] B — n8n with Enterprise license negotiation (fast, requires paid license agreement)
- [ ] C — Temporal.io with n8n-inspired node design patterns

Update this ADR status to **ACCEPTED** with the chosen option.

---

## References
- n8n Sustainable Use License: https://github.com/n8n-io/n8n/blob/master/LICENSE.md
- Temporal Apache 2.0: https://github.com/temporalio/temporal/blob/master/LICENSE
- PRD v3 Section 5.4: "n8n is NOT used due to fair-code license restrictions"
- Build Checklist v3 Task #18: "Deploy n8n as headless workflow engine"
