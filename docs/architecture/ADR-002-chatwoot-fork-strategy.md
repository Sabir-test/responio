# ADR-002: Chatwoot Fork Strategy

**Status**: ACCEPTED
**Date**: 2026-03-20
**Deciders**: M.Sabir, Architect

---

## Context

The inbox and core conversation management module is built on a fork of Chatwoot (MIT License). We need a clear strategy for:
1. How to customize Chatwoot without creating unmaintainable divergence
2. How to track upstream changes and apply security patches
3. Where to draw the fork boundary

---

## Decision

### Fork Location
Chatwoot fork lives at `services/inbox/`. When cloned, it maintains an `upstream` remote pointing to `https://github.com/chatwoot/chatwoot`.

### Customization Rules

**Tier 1 — Never modify (extend only via hooks)**:
- Core conversation/message models
- ActionCable WebSocket infrastructure
- Authentication middleware
- Database migration framework

**Tier 2 — Extend via existing extension points**:
- Add custom attributes to models using Chatwoot's `CustomAttributeDefinition`
- Add channel adapters implementing `Channels::BaseChannel` interface
- Add integrations via Chatwoot's `Integrations::Hook` system
- Add custom report types via `V2::Reports::*` namespace

**Tier 3 — Necessary core modifications (document all)**:
- Any change to a core file MUST include comment `# RESPONIO: [reason] [date]`
- All modified core files MUST be listed in `services/inbox/FORK_CHANGES.md`
- Core changes must be reviewed and approved by Architect

### Upstream Sync Strategy
- Weekly: Check Chatwoot releases for security patches
- Monthly: Attempt upstream merge to `develop` branch
- Branch strategy:
  - `upstream/master` — tracks Chatwoot upstream
  - `main` — our production branch
  - `develop` — integration branch
  - `feature/*` — feature branches
- Git remote setup:
  ```bash
  git remote add upstream https://github.com/chatwoot/chatwoot.git
  git fetch upstream
  git checkout -b upstream/master upstream/master
  ```

### New Features vs. Extensions

| Feature | Approach |
|---------|----------|
| Lifecycle pipeline | Extend Contact model via custom attributes + NATS events |
| SLA timers | New `SlaTimer` model + Sidekiq job + Chatwoot conversation hooks |
| Collision detection | Extend existing typing indicator with agent identity |
| Web chat widget | Reuse Chatwoot SDK, rebrand only |
| WhatsApp BSP | Implement as `Channels::WhatsappBsp < Channels::BaseChannel` |
| Additional channels | Implement channel adapter interface |

### Responio Extensions Directory
New code that extends Chatwoot lives in:
```
services/inbox/app/services/responio/     # Service classes
services/inbox/app/models/responio/       # Model extensions
services/inbox/app/controllers/responio/  # API endpoints
services/inbox/app/jobs/responio/         # Background jobs
services/inbox/app/lib/responio/          # Library code
```

---

## Consequences

**Positive**:
- Chatwoot upstream security patches can be applied with minimal conflict
- New developers can understand what's "ours" vs. "upstream"
- Feature additions are isolated and testable

**Negative**:
- Some features require core modification (unavoidable for deep integrations)
- Upstream merges require review of Tier-3 changes each time
- Two codebases (Rails + Node.js services) — team needs Ruby AND TypeScript skills
