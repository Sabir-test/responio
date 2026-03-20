# Responio — Claude Code Project Instructions

## What This Project Is
Responio is an AI-powered omnichannel conversation management SaaS platform — a production-quality alternative to respond.io. It targets B2C businesses (50-500 employees) in WhatsApp-first markets (LATAM, SEA, MENA, South Asia).

## Repository Structure
```
responio/
├── .bmad-core/          # BMAD agent personas, templates, workflows
├── apps/
│   ├── web/             # React 18 + TypeScript frontend (Chatwoot fork extension)
│   └── mobile/          # React Native (Chatwoot mobile fork)
├── services/
│   ├── inbox/           # Chatwoot fork (Ruby on Rails) — core inbox engine
│   ├── workflow/        # Workflow orchestration service (Node.js/TS)
│   ├── ai/              # AI orchestrator service (Node.js/TS)
│   ├── billing/         # Stripe billing + MAC metering (Node.js/TS)
│   ├── broadcast/       # Broadcast engine (Node.js/TS)
│   ├── analytics/       # ClickHouse analytics service (Node.js/TS)
│   └── gateway/         # API gateway (Node.js/TS)
├── packages/
│   ├── types/           # Shared TypeScript types and interfaces
│   ├── events/          # NATS JetStream event schemas and publishers
│   └── adapters/        # Channel adapter implementations (WhatsApp, Telegram, etc.)
├── infrastructure/
│   ├── docker/          # Docker Compose for local dev
│   ├── k8s/             # Kubernetes manifests (K3s)
│   └── terraform/       # IaC (deferred to Phase 3)
├── docs/
│   ├── architecture/    # ADRs (Architecture Decision Records)
│   ├── prd/             # Product requirements summaries
│   └── stories/         # User stories by phase/epic
└── scripts/             # Dev and deployment scripts
```

## Technology Stack
| Layer | Technology |
|-------|-----------|
| Frontend | React 18 + TypeScript + Tailwind CSS |
| Mobile | React Native (Chatwoot fork) |
| Workflow Builder UI | React Flow |
| Inbox Backend | Ruby on Rails (Chatwoot fork) |
| New Services | Node.js + TypeScript |
| Workflow Engine | **See ADR-001** — n8n (headless) or Temporal.io |
| Event Bus | NATS JetStream |
| Primary DB | PostgreSQL 16 + pgvector + RLS |
| Analytics DB | ClickHouse |
| Cache | Redis 7 (Cluster) |
| Object Storage | S3-compatible (MinIO local, AWS S3 prod) |
| LLM Abstraction | LiteLLM |
| Auth | Authentik (SSO/OIDC) |
| Reverse Proxy | Traefik |
| Billing | Stripe Billing |
| CI/CD | GitHub Actions + ArgoCD |
| Container Orch | K3s (staging/self-hosted) / EKS (production) |
| Monitoring | Grafana + Prometheus + Loki |
| Tracing | OpenTelemetry + Jaeger |

## Active Phase
**Phase 1 — Core Inbox & Channels (Weeks 1-12)**

Priority tasks (see docs/stories/phase-1-backlog.md):
1. Infrastructure provisioning (K3s or local docker-compose)
2. PostgreSQL RLS tenant isolation
3. NATS JetStream event bus
4. CI/CD pipeline
5. Chatwoot fork setup
6. WhatsApp BSP application (MUST start immediately)

## Critical Open Decisions (Block Phase 1)
1. **Workflow Engine** — n8n (headless) vs Temporal.io → see `docs/architecture/ADR-001-workflow-engine.md`
2. **Cloud Provider** — AWS EKS vs Hetzner K3s
3. **WhatsApp BSP** — 360dialog + Twilio (dual)
4. **Auth Provider** — Authentik (recommended)
5. **Phase 1 Hosting** — K3s on 3 VPS nodes (recommended)

## Multi-Tenancy Rules
- EVERY database table MUST have `tenant_id` (account_id) column
- PostgreSQL RLS policies enforced at DB level — NOT just application filtering
- Never bypass RLS. If you need to query across tenants (billing, admin), use a dedicated superuser connection in isolated code paths with explicit audit logging.

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

## API Conventions
- REST API: `/api/v1/` prefix, JSON, Bearer token auth
- Internal action endpoints: `/api/v1/actions/{action-name}` (called by workflow engine)
- Webhooks inbound: `/webhooks/{channel}/{tenant_id}` (e.g., `/webhooks/whatsapp/{tenant_id}`)
- All responses include `tenant_id` validation

## Security Rules
1. Never log PII (phone numbers, email, message content) in plain text
2. Webhook endpoints MUST verify provider signatures before processing
3. Never use Evolution API in production — dev/testing ONLY
4. AI responses MUST be grounded (check against retrieved chunks before sending)
5. Cross-tenant isolation MUST be tested explicitly in every service PR

## BMAD Framework
This project uses BMAD (Breakthrough Method of Agile AI-Driven Development).
- Agent personas: `.bmad-core/agents/`
- Story templates: `.bmad-core/templates/`
- Active epics/stories: `docs/stories/`
- Use the `pm` agent persona when writing stories, `architect` for design decisions, `dev` for implementation

## Key External Resources
- Chatwoot repo: https://github.com/chatwoot/chatwoot (fork target)
- PRD: `respond-io-clone-prd-v3.docx` (project root)
- Build Checklist: `respond-io-build-checklist-v3.xlsx` (project root)
- n8n Integration Map: See checklist Sheet 2 for full trigger/action endpoint spec

## Disk Space Warning
The host VM has limited free space (~2GB). Do NOT:
- Run `pnpm install` without checking space first
- Clone large repos without cleaning up first
- Build Docker images without pruning old ones
