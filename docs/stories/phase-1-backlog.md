# Phase 1 Backlog — Core Inbox & Channels
**Target**: Weeks 1–12 | **Exit Criteria**: Paying Starter-tier customers on WhatsApp + web chat

## Epic 1: Infrastructure Foundation
**Checklist Tasks**: #1, #2, #3, #4, #5, #13

### Story 1.1: Local Dev Infrastructure
**Status**: IN PROGRESS (docker-compose.infra.yml created)

**Acceptance Criteria**:
- [ ] `pnpm infra:up` starts PostgreSQL, Redis, NATS, MinIO, Traefik, Grafana
- [ ] PostgreSQL has pgvector and pg_trgm extensions enabled
- [ ] NATS JetStream is enabled with core streams created
- [ ] All services pass healthchecks
- [ ] MinIO buckets (media, documents, exports) are created
- [ ] Grafana is accessible at http://localhost:3030

### Story 1.2: PostgreSQL RLS Tenant Isolation
**Status**: IN PROGRESS (02-schema.sql created with RLS policies)

**Acceptance Criteria**:
- [ ] All tenant-scoped tables have `tenant_id` column with RLS
- [ ] Integration test: query as Tenant A returns ZERO rows belonging to Tenant B
- [ ] `responio_app` role cannot bypass RLS
- [ ] `responio_admin` role can bypass RLS (for billing/admin)
- [ ] Cross-tenant probe test passes (see QA checklist)

### Story 1.3: NATS JetStream Event Streams
**Status**: IN PROGRESS (`packages/events` created)

**Acceptance Criteria**:
- [ ] 6 core streams created: CONVERSATION, MESSAGE, CONTACT, WORKFLOW, AI, BILLING
- [ ] EventPublisher correctly publishes to all streams
- [ ] EventSubscriber receives events with at-least-once delivery
- [ ] Idempotent consumers using correlation_id
- [ ] Event round-trip latency < 100ms (local)

### Story 1.4: CI/CD Pipeline
**Status**: IN PROGRESS (.github/workflows/ci.yml created)

**Acceptance Criteria**:
- [ ] GitHub Actions runs on every PR: lint → typecheck → test → build
- [ ] Integration tests run against real PostgreSQL + Redis + NATS
- [ ] Docker images built and pushed to GHCR on merge to main
- [ ] PRs blocked from merge if tests fail
- [ ] Security scan (Trivy) runs on every PR

---

## Epic 2: Chatwoot Fork
**Checklist Tasks**: #6, #7, #8, #9, #16

### Story 2.1: Fork and Rebrand Chatwoot
**Status**: TODO

**Steps**:
1. Fork https://github.com/chatwoot/chatwoot to this org
2. Add as subtree at `services/inbox/`:
   ```bash
   git subtree add --prefix=services/inbox https://github.com/chatwoot/chatwoot main --squash
   ```
3. Strip Chatwoot branding (logo, colors, copy)
4. Add upstream remote for security patches
5. Create `services/inbox/FORK_CHANGES.md`

**Acceptance Criteria**:
- [ ] `services/inbox/` contains Chatwoot source
- [ ] App runs locally with rebranded UI
- [ ] All existing Chatwoot tests pass
- [ ] Upstream remote configured

### Story 2.2: Contact Lifecycle Pipeline
**Status**: TODO

**Acceptance Criteria**:
- [ ] `lifecycle_stage` field added to Contact model
- [ ] Default stages: new_lead, qualified, hot_lead, customer, churned
- [ ] Workspace can configure custom lifecycle stages
- [ ] Stage transitions emit `contact.lifecycle_changed` event to NATS
- [ ] Kanban view of contacts by lifecycle stage in UI

### Story 2.3: SLA Timers
**Status**: TODO

**Acceptance Criteria**:
- [ ] SLA policy configurable per workspace (e.g., first reply within 1h)
- [ ] `sla_breach_at` populated on conversation creation
- [ ] Sidekiq job checks SLA breaches every 5 minutes
- [ ] SLA breach emits `conversation.sla_breached` event to NATS
- [ ] SLA breach indicator shown in inbox UI

### Story 2.4: Web Chat Widget
**Status**: TODO

**Acceptance Criteria**:
- [ ] Chatwoot web widget deployed and functional
- [ ] Customizable appearance (color, position)
- [ ] Pre-chat form (name, email)
- [ ] End-to-end test: send message via widget → appears in inbox

---

## Epic 3: WhatsApp Integration
**Checklist Tasks**: #10, #11

### Story 3.1: Apply for WhatsApp BSP Access ⚠️ START IMMEDIATELY
**Status**: TODO — Longest lead time (2-4 weeks for approval)

**Manual Steps (M.Sabir)**:
1. Apply to 360dialog: https://www.360dialog.com/partner-program
2. Apply to Twilio WhatsApp: https://www.twilio.com/en-us/whatsapp
3. Complete Meta Business verification for both
4. Set up test phone number
5. Estimated approval: 2-4 weeks

### Story 3.2: WhatsApp Channel Adapter (360dialog)
**Status**: IN PROGRESS (`packages/adapters/src/whatsapp-360dialog.ts` created)

**Acceptance Criteria**:
- [ ] WhatsApp360DialogAdapter implements ChannelAdapter interface
- [ ] Webhook signature verification (HMAC-SHA256)
- [ ] Parse inbound messages: text, image, video, audio, document, location
- [ ] Parse delivery status updates (sent → delivered → read)
- [ ] Send text messages
- [ ] Send template messages with variable interpolation
- [ ] Unit tests for all message types

### Story 3.3: WhatsApp Webhook Receiver
**Status**: TODO

**Acceptance Criteria**:
- [ ] Webhook endpoint: `POST /webhooks/whatsapp/{tenant_id}`
- [ ] Signature verification BEFORE any processing
- [ ] Idempotent processing (duplicate provider message IDs ignored)
- [ ] Dead letter queue for failed webhook processing
- [ ] Webhook events published to NATS `message.inbound`

---

## Epic 4: Stripe Billing
**Checklist Tasks**: #14, #15

### Story 4.1: Stripe Checkout Integration
**Status**: IN PROGRESS (plans.ts + mac-metering.ts created)

**Acceptance Criteria**:
- [ ] Signup flow: email → verify → create Account → Stripe Checkout → workspace created
- [ ] Starter plan ($79/mo + $948/yr) in Stripe Products
- [ ] Stripe webhook handler processes: invoice.paid, subscription.updated, subscription.deleted
- [ ] User seats tracked (5 included, $12/mo each additional)
- [ ] Tenant billing_status updated on Stripe events

### Story 4.2: MAC Metering
**Status**: IN PROGRESS (mac-metering.ts created)

**Acceptance Criteria**:
- [ ] Every message event increments Redis HyperLogLog counter
- [ ] `pnpm infra:up` reconciliation job runs hourly
- [ ] Real-time MAC count available via API endpoint
- [ ] Threshold alerts fired at 80%, 90%, 100% via NATS `billing.threshold_warning`
- [ ] Starter plan: MAC display only (no limits — Starter has unlimited contacts)
- [ ] Growth/Advanced: overage billing activated

---

## Epic 5: Mobile App
**Checklist Tasks**: #16

### Story 5.1: React Native Fork
**Status**: TODO

**Steps**:
1. Fork https://github.com/chatwoot/chatwoot-mobile-app
2. Rebrand (name, icon, splash screen)
3. Build and deploy to TestFlight (iOS) + Play Console (Android) beta
4. Core features: inbox view, conversation reply, push notifications

---

## Phase 1 Exit Criteria Checklist
- [ ] Tenant can sign up and pay via Stripe Checkout
- [ ] Tenant can connect WhatsApp Business API (BSP approved)
- [ ] Agents can see and reply to WhatsApp conversations in inbox
- [ ] Web chat widget works end-to-end
- [ ] Basic reports (response times, conversation counts) visible
- [ ] Mobile app in TestFlight/Play Console beta
- [ ] All security tests passing (cross-tenant probe, webhook sig verification)
- [ ] Monitoring: Grafana dashboards showing key metrics
- [ ] Revenue: First Starter-tier paying customer onboarded
