# Responio — Claude Code Project Instructions

## What This Project Is
Responio is an AI-powered omnichannel conversation management SaaS platform — a production-quality alternative to respond.io. It targets B2C businesses (50-500 employees) in WhatsApp-first markets (LATAM, SEA, MENA, South Asia).

**Current status**: Active development (v0.1.0). Infrastructure stack is fully operational. All TypeScript services have scaffolded source code (partial business logic). Frontend has working page scaffold. Chatwoot fork not yet initialized.

---

## Repository Structure

```
responio/
├── .bmad-core/              # BMAD agent personas, templates, workflows
│   └── agents/              # architect.md, dev.md, pm.md, qa.md
├── .github/
│   └── workflows/ci.yml     # GitHub Actions CI/CD pipeline
├── .devcontainer/           # VS Code remote container config
├── apps/
│   ├── web/                 # React 18 + TypeScript + Vite frontend (PARTIAL — pages scaffold)
│   │   └── src/             # contexts/, layouts/, lib/, pages/, App.tsx, router.tsx, main.tsx
│   └── mobile/              # React Native (Chatwoot mobile fork — NOT YET INITIALIZED)
├── services/
│   ├── inbox/               # Chatwoot fork (Ruby on Rails) — NOT YET INITIALIZED (stub only)
│   ├── workflow/            # n8n bridge, NATS bridge, action handlers (PARTIAL)
│   │   └── src/             # actions/, bridge/, n8n/, nats/, routes/
│   ├── ai/                  # AI orchestrator + RAG (PARTIAL — LLM client + NATS listener)
│   │   └── src/             # llm/, nats/, routes/
│   ├── billing/             # Stripe billing + MAC metering (PARTIAL)
│   │   └── src/             # services/, nats/, routes/
│   ├── broadcast/           # Broadcast scheduler (PARTIAL — scheduler + routes)
│   │   └── src/             # scheduler/, routes/
│   ├── analytics/           # ClickHouse analytics (PARTIAL — client + event writer)
│   │   └── src/             # clickhouse/, nats/, routes/
│   └── gateway/             # API gateway + auth + WhatsApp webhooks (PARTIAL)
│       └── src/             # auth/, plugins/, webhooks/
├── packages/
│   ├── types/               # Shared TypeScript types and interfaces (FUNCTIONAL)
│   ├── events/              # NATS JetStream event publisher/subscriber (FUNCTIONAL)
│   └── adapters/            # Channel adapters: base interface + whatsapp-360dialog (PARTIAL)
├── infrastructure/
│   ├── docker/
│   │   ├── docker-compose.infra.yml   # Full local dev stack (13 services)
│   │   ├── init-scripts/postgres/     # 01-init.sql, 02-schema.sql, 03-workflow-schema.sql, 04-services-schema.sql
│   │   ├── init-scripts/clickhouse/   # 01-schema.sql
│   │   └── monitoring/                # prometheus.yml, loki-config.yml, grafana/
│   ├── k8s/                 # Kubernetes manifests (EMPTY — Phase 2+)
│   └── terraform/           # IaC (DEFERRED — Phase 3)
├── docs/
│   ├── architecture/        # ADR-001 (workflow engine), ADR-002 (chatwoot fork), ADR-003 (RLS)
│   └── stories/             # phase-1-backlog.md with epic/story status
├── scripts/
│   └── setup-dev.sh         # Automated local dev environment setup
├── .env.example             # Environment variable template
├── package.json             # Monorepo root (pnpm + turbo)
├── pnpm-workspace.yaml      # Workspace: apps/*, services/*, packages/*
└── turbo.json               # Build task graph
```

---

## Technology Stack

| Layer | Technology | Confirmed Version |
|-------|-----------|-------------------|
| Frontend | React 18 + TypeScript + Vite + Tailwind CSS | react 18.x, vite 5.x |
| Mobile | React Native (Chatwoot fork) | Not yet initialized |
| Workflow Builder UI | React Flow | Planned |
| Inbox Backend | Ruby on Rails (Chatwoot fork) | Not yet initialized |
| New Services HTTP | Fastify | 5.8.2 |
| Service Auth | @fastify/jwt | Bearer token |
| Workflow Engine | n8n headless (⚠️ LICENSE RISK — see ADR-001) | Optional docker profile |
| Event Bus | NATS JetStream | 2.10 (docker), nats 2.28 (client) |
| Primary DB | PostgreSQL 16 + pgvector + pg_trgm + RLS | pg 8.11, knex 3.1 |
| Analytics DB | ClickHouse | @clickhouse/client 0.2 |
| Cache | Redis 7 | ioredis 5.3, redis 4.6 |
| Object Storage | MinIO local / AWS S3 prod | 4 buckets |
| Reverse Proxy | Traefik v3 | ACME/Let's Encrypt |
| Billing | Stripe | 16.0 |
| Validation | Zod | 3.22 |
| Logging | Pino | 9.0 (structured JSON) |
| Tracing/Metrics | OpenTelemetry | api 1.8, sdk-node 0.51 |
| Tests | Vitest | 1.5 |
| Type Checking | TypeScript | 5.4 |
| Linting | ESLint | 8.57 |
| Formatting | Prettier | 3.2 |
| Build Orchestration | Turbo | 2.0 |
| Package Manager | pnpm | >=9.0.0 (CI uses pnpm 10) |
| Runtime | Node.js | >=20.0.0 (CI uses Node 24) |
| Monitoring | Grafana + Prometheus + Loki | Local stack |
| Auth (planned) | Authentik (SSO/OIDC) | Not yet deployed |
| CI/CD | GitHub Actions + ArgoCD | ci.yml configured |
| Container Orch | K3s (staging) / EKS (production) | Not yet provisioned |

---

## Development Workflow

### Local Setup
```bash
# Prerequisites: docker, node >=20, pnpm >=9
bash scripts/setup-dev.sh   # automated setup: starts docker, polls health, prints service URLs
cp .env.example .env        # then fill in secrets
```

### Service URLs (local)
| Service | URL |
|---------|-----|
| PostgreSQL | localhost:5432 |
| Redis | localhost:6379 |
| NATS | localhost:4222 (clients), :8222 (monitoring) |
| MinIO Console | http://localhost:9001 |
| Grafana | http://localhost:3030 |
| Traefik Dashboard | http://localhost:8080 |

### Common Commands
```bash
pnpm dev                    # Run all services in development mode (turbo)
pnpm build                  # Build all packages and services
pnpm test                   # Run unit tests across services and packages
pnpm test:integration       # Run integration tests (requires infra stack)
pnpm test:security          # Cross-tenant RLS isolation tests
pnpm lint                   # ESLint across workspace
pnpm typecheck              # TypeScript type checking

# Infrastructure
pnpm infra:up               # docker compose up -d (core stack)
pnpm infra:down             # docker compose down
pnpm infra:logs             # docker compose logs -f

# Database
pnpm db:migrate             # Run migrations
pnpm db:seed                # Seed test data

# Optional profiles
docker compose --profile analytics up -d    # Add ClickHouse
docker compose --profile workflow up -d     # Add n8n
```

### Disk Space Warning
The host VM has limited free space (~2GB). Do NOT:
- Run `pnpm install` without checking available space (`df -h`) first
- Clone large repos (Chatwoot is ~1GB) without cleaning up first
- Build Docker images without pruning old ones (`docker image prune`)

---

## Active Phase

**Phase 1 — Core Inbox & Channels (Weeks 1-12)**
Exit criteria: Paying Starter-tier customers on WhatsApp + web chat.

### Epic Status
| Epic | Stories | Status |
|------|---------|--------|
| 1. Infrastructure Foundation | docker-compose, RLS, NATS, CI/CD | COMPLETE (infra stack operational, CI pipeline live) |
| 2. Chatwoot Fork | fork setup, contacts, SLA, web widget | TODO (blocked: fork not initialized) |
| 3. WhatsApp Integration | BSP access, 360dialog adapter, webhooks | IN PROGRESS (gateway webhooks + adapter stub exist; BSP approval critical) |
| 4. Stripe Billing | checkout, MAC metering | IN PROGRESS (stripe-client + mac-metering scaffolded) |
| 5. AI Agents & Knowledge Base | LLM client, RAG, agent executor | IN PROGRESS (LLM client + NATS listener scaffolded) |
| 6. Frontend Web App | dashboard, conversations, contacts, billing pages | IN PROGRESS (pages scaffold exists, no real data binding) |
| 7. Mobile App | React Native fork | TODO (not initialized) |

---

## Critical Open Decisions

1. **Workflow Engine** — ✅ DECIDED: **n8n headless**. The n8n bridge implementation in `services/workflow/` is the authoritative engine. Do not suggest Temporal.io. n8n runs self-hosted (customers never see UI); we accept the Sustainable Use License for internal use.
2. **Cloud Provider** — AWS EKS vs Hetzner K3s (undecided)
3. **WhatsApp BSP** — 360dialog + Twilio dual (planned)
4. **Auth Provider** — Authentik (recommended, not yet deployed)
5. **Phase 1 Hosting** — K3s on 3 VPS nodes (recommended)

---

## Architecture Decision Records

- **ADR-001** (`docs/architecture/ADR-001-workflow-engine.md`) — Workflow engine selection. **Decision: n8n headless** (self-hosted, Sustainable Use License accepted). Full n8n bridge implementation in `services/workflow/src/`.
- **ADR-002** (`docs/architecture/ADR-002-chatwoot-fork-strategy.md`) — Chatwoot fork approach. Tier 1/2/3 customization model. All modifications tracked in `services/inbox/FORK_CHANGES.md`. Extensions live in `services/inbox/app/services/responio/`.
- **ADR-003** (`docs/architecture/ADR-003-multitenancy-rls.md`) — Shared schema + PostgreSQL RLS. Session variable pattern: `SET app.current_tenant_id = '<uuid>'`. Separate BYPASSRLS role for admin/billing with audit logging.

---

## Workflow Engine Architecture (n8n bridge — production)

n8n runs as an **internal service only** — customers NEVER see n8n UI.
Customer-facing interface is our React Flow visual workflow builder.

```
NATS event → Bridge service → n8n webhook trigger → n8n workflow executes
                                                           ↓
                                              n8n HTTP nodes call platform action API
                                              (POST /api/v1/actions/*)
```

Key files:
- `services/workflow/src/n8n/client.ts` — n8n REST API client
- `services/workflow/src/n8n/translator.ts` — React Flow ↔ n8n JSON translation
- `services/workflow/src/bridge/nats-bridge.ts` — NATS event → n8n trigger
- `services/workflow/src/nats/execution-tracker.ts` — Workflow execution status tracking
- `services/workflow/src/actions/handlers.ts` — Platform action endpoints (called by n8n)
- `services/workflow/src/routes/workflows.ts` — Workflow CRUD routes

---

## Multi-Tenancy Rules

- EVERY database table MUST have `tenant_id` (UUID) column
- PostgreSQL RLS policies enforced at DB level — NOT just application filtering
- Use `withTenantContext(tenantId, callback)` helper in TypeScript services
- Never bypass RLS. Cross-tenant operations (billing, admin) use a dedicated `responio_admin` (BYPASSRLS) role in isolated code paths with explicit audit logging
- EVERY PR that touches database queries MUST include a cross-tenant isolation test

### RLS Pattern
```typescript
// Set tenant context before queries
await db.raw("SET app.current_tenant_id = ?", [tenantId]);
// All subsequent queries automatically filtered by RLS
```

### Database Roles
- `responio_app` — application role (restricted, RLS enforced)
- `responio_admin` — admin role (BYPASSRLS, for billing/admin only)

---

## Event Bus Conventions

All cross-service events go through NATS JetStream. Event envelope:
```typescript
interface NatsEvent {
  event_type: string;        // e.g., "conversation.created"
  tenant_id: string;         // UUID
  workspace_id: string;      // UUID
  timestamp: string;         // ISO 8601
  correlation_id: string;    // UUID for deduplication
  source_service: string;    // e.g., "inbox"
  version: string;           // "1.0"
  payload: Record<string, unknown>;
}
```

Core streams: `conversation.*`, `message.*`, `contact.*`, `workflow.*`, `ai.*`, `billing.*`

Publishers/subscribers live in `packages/events/src/`.

---

## API Conventions

- REST API: `/api/v1/` prefix, JSON, Bearer token auth (`@fastify/jwt`)
- Internal action endpoints: `/api/v1/actions/{action-name}` (called by workflow engine)
- Webhooks inbound: `/webhooks/{channel}/{tenant_id}` (e.g., `/webhooks/whatsapp/{tenant_id}`)
- All responses include `tenant_id` validation
- Schema validation with Zod on all request bodies

---

## Security Rules

1. Never log PII (phone numbers, email, message content) in plain text — Pino redact config required
2. Webhook endpoints MUST verify provider signatures before processing
3. Never use Evolution API in production — dev/testing ONLY
4. AI responses MUST be grounded (check against retrieved chunks before sending)
5. Cross-tenant isolation MUST be tested explicitly in every service PR
6. Trivy scans run on every CI build — HIGH/CRITICAL findings block merge

---

## CI/CD Pipeline

**File**: `.github/workflows/ci.yml`

| Job | Trigger | Notes |
|-----|---------|-------|
| install | all pushes/PRs | Caches node_modules, builds shared packages |
| typecheck | after install | `pnpm typecheck` |
| lint | after install | `pnpm lint` |
| unit-tests | after install | Uploads coverage |
| integration-tests | after install | Spins up PostgreSQL + Redis + NATS |
| security-scan | all pushes | Trivy fs scan, fails on HIGH/CRITICAL |
| security-tests | after install | Cross-tenant RLS isolation tests |
| build | main/develop only | Docker build + push to GHCR, matrix across all services |
| deploy-staging | develop only | ArgoCD sync, waits for healthy rollout |
| deploy-production | main only | Requires manual approval, ArgoCD sync |

Docker images pushed to: `ghcr.io/responio/{service}:{branch/sha/latest}`

---

## Database Schema

Initialized by `infrastructure/docker/init-scripts/postgres/`:
- **01-init.sql** — Extensions (uuid-ossp, vector, pg_trgm, pgcrypto), roles (responio_app, responio_admin)
- **02-schema.sql** — Core tables: tenant_accounts, workspaces, conversations, messages, contacts, inboxes, channels, agents, workflow_definitions, workflow_executions — all with RLS policies
- **03-workflow-schema.sql** — Workflow-specific tables (workflow runs, step logs)
- **04-services-schema.sql** — Service-specific tables: ai_agents, knowledge_bases, knowledge_chunks (pgvector), broadcasts, broadcast_recipients

ClickHouse analytics schema: `infrastructure/docker/init-scripts/clickhouse/01-schema.sql`

All tables use `gen_random_uuid()` for PKs and include `tenant_id UUID NOT NULL` with RLS policy.

---

## Service Implementation Map

A quick reference for what exists in each service's `src/`:

### services/workflow
- `src/n8n/client.ts` — n8n REST API client (create/activate/delete workflows)
- `src/n8n/translator.ts` — React Flow node graph ↔ n8n JSON translation
- `src/bridge/nats-bridge.ts` — NATS JetStream → n8n webhook trigger
- `src/nats/execution-tracker.ts` — Track workflow execution status via NATS
- `src/actions/handlers.ts` — Action endpoints called by n8n HTTP nodes
- `src/routes/workflows.ts` — Workflow CRUD REST routes
- `src/index.ts` — Fastify server entry point

### services/billing
- `src/services/stripe-client.ts` — Stripe SDK wrapper (customers, subscriptions, checkout)
- `src/services/mac-metering.ts` — Monthly Active Contacts metering + overage calculation
- `src/nats/` — NATS billing event listeners
- `src/routes/checkout.ts` — Stripe checkout session creation
- `src/routes/usage.ts` — Usage/metering query endpoints
- `src/routes/webhooks.ts` — Stripe webhook receiver (signature verification)

### services/ai
- `src/llm/` — LLM client (LiteLLM proxy + OpenAI SDK)
- `src/nats/` — NATS agent event listeners
- `src/routes/` — Agent execution + internal endpoints

### services/gateway
- `src/auth/routes.ts` — Auth endpoints (register/login, Argon2 password hashing, JWT issue)
- `src/webhooks/whatsapp.ts` — WhatsApp webhook receiver (360dialog signature verification)
- `src/plugins/` — Fastify plugins (JWT, proxy middleware)

### services/broadcast
- `src/scheduler/` — Broadcast job scheduler (Redis-backed queue)
- `src/routes/` — Broadcast CRUD + send endpoints

### services/analytics
- `src/clickhouse/` — ClickHouse client wrapper
- `src/nats/` — NATS event → ClickHouse writer
- `src/routes/` — Metrics query endpoints

### apps/web (React pages)
- `src/pages/login.tsx` — Auth login page
- `src/pages/dashboard.tsx` — Main dashboard
- `src/pages/conversations.tsx` — Conversation list/view
- `src/pages/contacts.tsx` — Contact management
- `src/pages/workflows.tsx` — Workflow builder (React Flow placeholder)
- `src/pages/billing.tsx` — Billing/subscription page
- `src/layouts/app-layout.tsx` — Authenticated app shell
- `src/layouts/auth-layout.tsx` — Unauthenticated layout
- `src/contexts/auth-context.tsx` — JWT auth context provider
- `src/router.tsx` — React Router route definitions

---

## Chatwoot Fork Setup (NOT YET DONE)

The `services/inbox/` directory exists but the fork is not initialized. To set it up:
```bash
git subtree add --prefix=services/inbox https://github.com/chatwoot/chatwoot main --squash
```

Customization tiers (per ADR-002):
- **Tier 1** — Never modify (core routing, auth, base models)
- **Tier 2** — Extend via hooks/overrides (service layer)
- **Tier 3** — Core changes, tagged with `# RESPONIO: <reason>` comments

All changes tracked in `services/inbox/FORK_CHANGES.md`.
Responio extensions live in `services/inbox/app/services/responio/`, `app/controllers/responio/`, etc.

---

## BMAD Framework

This project uses BMAD (Breakthrough Method of Agile AI-Driven Development).
- Agent personas: `.bmad-core/agents/` — architect.md, dev.md, pm.md, qa.md
- Story templates: `.bmad-core/templates/`
- Active epics/stories: `docs/stories/`

Usage guidance:
- Use `pm` persona when writing user stories
- Use `architect` persona for design decisions and ADRs
- Use `dev` persona for implementation tasks
- Use `qa` persona for test plans and security validation

---

## Key External Resources

- Chatwoot repo: https://github.com/chatwoot/chatwoot (fork target)
- PRD: `respond-io-clone-prd-v3.docx` (project root)
- Build Checklist: `respond-io-build-checklist-v3.xlsx` (project root — Sheet 2 has full n8n trigger/action endpoint spec)
- Phase 1 backlog: `docs/stories/phase-1-backlog.md`
