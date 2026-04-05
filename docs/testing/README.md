# Responio — Test Coverage Guide

This document describes the test strategy, file inventory, running instructions, and coverage goals for the Responio platform.

---

## Quick Start

```bash
# Run all tests (node services + packages)
pnpm test

# Run only the web frontend tests (jsdom environment)
pnpm --filter @responio/web test

# Run tests with coverage report
pnpm test -- --coverage

# Run tests for a single service
pnpm --filter @responio/workflow test
pnpm --filter @responio/billing test
pnpm --filter @responio/gateway test

# Watch mode
pnpm test -- --watch
```

---

## Coverage Thresholds

The root `vitest.config.ts` enforces **60% minimum** on lines, functions, branches, and statements. CI will fail if thresholds are not met.

The `apps/web` package has its own `vitest.config.ts` using a **jsdom** environment (required for React component tests).

---

## Test File Inventory

### `packages/events`

| Test File | Source File | What It Tests |
|-----------|-------------|---------------|
| `src/__tests__/publisher.test.ts` | `publisher.ts` | Subject routing, JSON serialization, correlation_id uniqueness, JetStream ack sequence, error propagation |
| `src/__tests__/subscriber.test.ts` | `subscriber.ts` | Consumer config (durable_name, AckPolicy.Explicit, max_deliver=5), message deserialization, ack/nak callbacks, NAK-on-handler-exception, NAK-on-invalid-JSON |

**Key patterns tested:**
- Every publish encodes the event as UTF-8 JSON with a `correlation_id`, `timestamp`, and `version: "1.0"` envelope
- Subscribers NAK (not drop) on handler exceptions, enabling NATS retry up to `max_deliver` times
- Malformed JSON in the NATS message triggers NAK and writes to stderr — service stays alive

---

### `packages/adapters`

| Test File | Source File | What It Tests |
|-----------|-------------|---------------|
| `src/__tests__/whatsapp-360dialog.test.ts` | `whatsapp-360dialog.ts` | HMAC-SHA256 signature verification, inbound text/image parsing, delivery status parsing, sendMessage API |

---

### `packages/types`

| Test File | Source File | What It Tests |
|-----------|-------------|---------------|
| `src/__tests__/feature-gate.test.ts` | `features.ts` | PLAN_FEATURES matrix per tier (starter/growth/advanced/enterprise) |

---

### `services/workflow`

| Test File | Source File | What It Tests |
|-----------|-------------|---------------|
| `src/__tests__/nats-bridge.test.ts` | `bridge/nats-bridge.ts` | All 7 NATS→n8n webhook trigger paths, correct URL construction, `X-Responio-Secret` header, WORKFLOW_TRIGGERED publish, 404 skip (no active workflow), network-error resilience (always ack) |
| `src/__tests__/execution-tracker.test.ts` | `nats/execution-tracker.ts` | INSERT on `workflow.triggered` (status=running), UPDATE on `workflow.completed` (status=success), UPDATE on `workflow.failed` (status=error + error_message), duplicate-key error resilience (always ack) |
| `src/__tests__/n8n-client.test.ts` | `n8n/client.ts` | All CRUD methods (create/get/update/delete/activate/deactivate/list), execution methods (get/list/delete), URL construction (trailing slash handling), X-N8N-API-KEY header, N8nApiError on non-OK responses, network error wrapping, health check |
| `src/__tests__/translator.test.ts` | `n8n/translator.ts` | React Flow DSL → n8n JSON translation (trigger types, action nodes, conditions, connections) |
| `src/__tests__/handlers.test.ts` | `actions/handlers.ts` | Action endpoints (send-message, change-lifecycle, close-conversation, trigger-webhook), auth guard, 404 handling, feature gates, NATS event publishing |
| `src/__tests__/workflows.routes.test.ts` | `routes/workflows.ts` | Workflow CRUD, DSL schema validation, graph connectivity validation, publish lifecycle, n8n integration, 404 errors |

**Key patterns tested in `nats-bridge.test.ts`:**
```
Event subscription → handler captures → fetch() called with correct n8n URL
  └── on success (2xx): WORKFLOW_TRIGGERED published, NATS ack called
  └── on 404 (no workflow): no publish, NATS ack called  
  └── on network error: error logged, NATS ack still called (never lost)
```

---

### `services/billing`

| Test File | Source File | What It Tests |
|-----------|-------------|---------------|
| `src/__tests__/stripe-client.test.ts` | `services/stripe-client.ts` | `getStripe()` env-var guard (throws without key), `getOrCreateStripeCustomer()` returns existing ID without calling Stripe, creates new customer with correct metadata, propagates Stripe errors |
| `src/__tests__/checkout.routes.test.ts` | `routes/checkout.ts` | Checkout session creation (404 on missing account, 422 on missing price, seat add-on line items, 14-day trial for trialing accounts), Customer Portal session, GET subscription (zero usage fallback, live usage), POST cancel (404 without subscription, cancel_at_period_end) |
| `src/__tests__/mac-metering.test.ts` | `services/mac-metering.ts` | HyperLogLog recording, count query, 80/90/100% threshold warnings, TTL management, reconciliation |
| `src/__tests__/stripe-webhook.test.ts` | `routes/webhooks.ts` | Stripe signature verification, event routing (checkout.session.completed, customer.subscription.deleted), unknown event handling, error resilience |

**Critical financial logic tested:**
- `getOrCreateStripeCustomer` is idempotent — existing customer ID is always returned without creating a duplicate
- Seat add-ons are only added when `seat_count > plan.included_seats`
- Trial period (14 days) only applied when `billing_status === 'trialing'`

---

### `services/ai`

| Test File | Source File | What It Tests |
|-----------|-------------|---------------|
| `src/__tests__/agent-listener.test.ts` | `nats/agent-listener.ts` | Agent DB lookup, conversation history fetch (last 10, reversed), `complete()` called with system prompt + chat history, AI_RESPONSE_GENERATED published, AI_HANDOFF_TRIGGERED when confidence < handoff_threshold, no handoff when confidence ≥ threshold, missing-agent ack (no LLM call), LLM error ack |
| `src/__tests__/internal.routes.test.ts` | `routes/internal.ts` | Auth guards, input validation, LLM response handling |

**Confidence/handoff logic:**
```
confidence = 0.9 (current placeholder)
agent.handoff_threshold = 0.95 → 0.9 < 0.95 → AI_HANDOFF_TRIGGERED published
agent.handoff_threshold = 0.5  → 0.9 < 0.5  → false → no handoff
```

---

### `services/analytics`

| Test File | Source File | What It Tests |
|-----------|-------------|---------------|
| `src/__tests__/event-writer.test.ts` | `nats/event-writer.ts` | All 6 NATS event types → correct ClickHouse table routing and field mapping: `conversation.created` → `conversations_events` (status=open, null assignee_id → ''), `conversation.resolved` → `conversations_events` (status=resolved, resolution_seconds), `message.inbound` → `messages_events` (direction=inbound), `message.outbound` → `messages_events` (direction=outbound), `contact.created` → `contact_events` (event_type=created), `contact.lifecycle_changed` → `contact_events` (lifecycle_stage=new_stage), ClickHouse error resilience (always ack) |

---

### `services/gateway`

| Test File | Source File | What It Tests |
|-----------|-------------|---------------|
| `src/__tests__/proxy.test.ts` | `plugins/proxy.ts` | 7 route registrations, X-Tenant-ID/X-User-ID/X-User-Role header forwarding, 502 JSON response on upstream error, `headersSent` guard (no double-write), env override for service URLs |
| `src/__tests__/whatsapp-webhook.test.ts` | `webhooks/whatsapp.ts` | GET Meta verification challenge (correct token → return challenge, wrong token → 403), POST UUID format validation (400 on malformed ID), silent 200 on missing inbox (anti-enumeration), HMAC-SHA256 signature verification (401 on invalid), MESSAGE_INBOUND publish (with correct payload fields), MESSAGE_DELIVERED publish for status updates, 200 ack-and-ignore for unknown payload types |
| `src/__tests__/auth.routes.test.ts` | `auth/routes.ts` | Login, refresh, logout endpoints, credential validation, JWT issuance, Redis integration |

**Anti-enumeration patterns tested:**
- Missing inbox → `{ ok: true }` (200) with no error detail, so attackers cannot enumerate valid tenant IDs
- Invalid UUID format → 400 only when format is wrong (before DB hit)

---

### `services/broadcast`

| Test File | Source File | What It Tests |
|-----------|-------------|---------------|
| `src/__tests__/broadcasts.routes.test.ts` | `routes/broadcasts.ts` | GET list, GET by id (404), POST create (403 on starter plan, 201 on growth), PATCH update (403, 404, 409 non-draft, update name), POST send (403, 404, 409 already-sent, 422 no recipients, 200 with recipient_count, scheduled vs immediate status), POST cancel (404, 409 non-cancellable, 200 on scheduled/sending), DELETE (404, 409 on sending, 204) |
| `src/__tests__/broadcast-scheduler.test.ts` | `scheduler/broadcast-scheduler.ts` | Polling, status updates, event publishing, error recovery |

**Status machine tested:**
```
draft → send() → sending (immediate) or scheduled
scheduled → cancel() → canceled
sending → cancel() → canceled
sending → delete() → 409 SENDING
draft → delete() → 204
```

---

### `apps/web`

| Test File | Source File | What It Tests |
|-----------|-------------|---------------|
| `src/__tests__/auth-context.test.tsx` | `contexts/auth-context.tsx` | Starts unauthenticated (empty localStorage), hydrates user from stored valid token (all fields populated), `login()` sets isAuthenticated=true and writes to localStorage, `logout()` clears user and removes token, auto-logout fires immediately for expired tokens, auto-logout fires after expiry delay (fake timers), graceful handling of malformed stored token, `workspace_ids` defaults to `[]`, `useAuth` outside provider throws |
| `src/__tests__/api-client.test.ts` | `lib/api-client.ts` | `setToken`/`clearToken` localStorage side-effects, Bearer token injected in Authorization header when present, header absent when no token, Content-Type always application/json, URL construction for all `workflowsApi` and `billingApi` methods, `ApiError` thrown on non-OK response (status + code + message), UNKNOWN code fallback when error body lacks `error` object, UNKNOWN code fallback when response is not JSON |
| `src/__tests__/login.test.tsx` | `pages/login.tsx` | Renders email/password inputs and submit button, renders heading, required attributes on fields, submit disables button during in-flight request, navigates to /dashboard on success, POST to /api/v1/auth/login with correct body, displays server error message, displays generic fallback, network error displayed, re-enables button after failure, clears previous error on new submission |

---

## Test Architecture

### Backend Services (Node/Fastify)

All service tests use **Vitest** with `environment: 'node'`. The common patterns are:

**HTTP routes** — tested via Fastify's `inject()` method (no network):
```typescript
const app = Fastify({ logger: false });
registerRoutes(app, mockDb, mockPublisher);
await app.ready();
const res = await app.inject({ method: 'POST', url: '/api/v1/...', body: {...} });
expect(res.statusCode).toBe(200);
```

**NATS event listeners** — tested by capturing subscription handlers and calling them directly:
```typescript
// Module mock captures the handler
vi.mock('@responio/events', () => ({
  EventSubscriber: vi.fn().mockImplementation(() => ({
    subscribe: vi.fn().mockImplementation((opts, handler) => {
      capturedHandlers.set(opts.filterSubject, handler);
    }),
  })),
}));

// Test drives the handler directly
const handler = capturedHandlers.get('conversation.created');
await handler(fakeEvent, ackFn, nakFn);
expect(ackFn).toHaveBeenCalledOnce();
```

**External integrations** — tested via `vi.stubGlobal('fetch', mockFn)` for HTTP calls, and mock factory functions for Knex, Redis, ClickHouse, Stripe.

### Frontend (React/jsdom)

Web tests use **Vitest** with `environment: 'jsdom'` and **React Testing Library**:

```typescript
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

render(<LoginPage />, { wrapper: ({ children }) => <AuthProvider>{children}</AuthProvider> });
await userEvent.type(screen.getByLabelText(/email/i), 'alice@example.com');
await userEvent.click(screen.getByRole('button', { name: /sign in/i }));
await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/dashboard', { replace: true }));
```

### Mocking Philosophy

| Dependency | How It's Mocked |
|---|---|
| NATS (EventSubscriber/Publisher) | `vi.mock('@responio/events')` — captures subscription handlers |
| PostgreSQL (Knex) | Factory function returning a chainable `vi.fn()` mock |
| Redis | Mock with real `Map`/`Set` to simulate HyperLogLog semantics |
| ClickHouse | `vi.mock('../clickhouse/client')` with `insert: vi.fn()` |
| Stripe | `vi.mock('../services/stripe-client')` — mocked per test |
| fetch (n8n, LiteLLM) | `vi.stubGlobal('fetch', vi.fn())` |
| React Router | `vi.mock('react-router-dom')` — `useNavigate` returns a `vi.fn()` |
| localStorage | jsdom provides a real in-memory implementation; cleared in `beforeEach` |

---

## Coverage by Area (Post Implementation)

| Area | Files | Status |
|---|---|---|
| `packages/events` | publisher, subscriber | Covered |
| `packages/adapters` | whatsapp-360dialog | Covered |
| `packages/types` | features | Covered |
| `services/workflow` | bridge, tracker, n8n client, translator, handlers, routes | Covered |
| `services/billing` | stripe-client, checkout, mac-metering, stripe-webhook | Covered |
| `services/ai` | agent-listener, internal routes | Covered |
| `services/analytics` | event-writer | Covered |
| `services/gateway` | proxy, whatsapp-webhook, auth routes | Covered |
| `services/broadcast` | routes, scheduler | Covered |
| `apps/web` | auth-context, api-client, login page | Covered |
| `services/inbox` | Chatwoot fork | Not initialized — deferred |
| `apps/mobile` | React Native fork | Not initialized — deferred |

---

## What Is Not Tested (Intentionally)

| Area | Reason |
|---|---|
| `services/*/src/index.ts` | Service bootstrap — integration/E2E concern, not unit testable without real infrastructure |
| `apps/web/src/router.tsx` | Route definitions — no business logic |
| `apps/web/src/main.tsx` | App entry point — no business logic |
| Cross-service E2E flows | Requires live NATS + PostgreSQL + n8n stack; covered by `pnpm test:integration` |
| Cross-tenant RLS isolation | Requires live PostgreSQL with RLS policies; covered by `pnpm test:security` |
| `services/inbox` | Chatwoot fork not yet initialized (see ADR-002) |

---

## Writing New Tests

### For a new service route

1. Create `services/<name>/src/__tests__/<route-name>.routes.test.ts`
2. Use `Fastify({ logger: false })` + `inject()` for HTTP testing
3. Mock `db` with a chain factory (see `handlers.test.ts` for the pattern)
4. Add `preHandler` hook to inject `tenantId` as auth middleware would
5. Test: 401/403 (auth), 404 (not found), 422 (validation), happy path, edge cases

### For a new NATS listener

1. Create `services/<name>/src/__tests__/<listener-name>.test.ts`
2. `vi.mock('@responio/events')` to capture subscription handlers
3. Test each event type: handler called, DB/ClickHouse operations, ack called
4. Test error paths: DB throws → ack still called (never lose a message)
5. Test idempotency where relevant (duplicate event_id, duplicate rows)

### For a new React component

1. Create `apps/web/src/__tests__/<component>.test.tsx`
2. Use `render()` from `@testing-library/react` with a `MemoryRouter` wrapper
3. Mock `fetch` via `vi.stubGlobal('fetch', vi.fn())`
4. Use `userEvent` (not `fireEvent`) for realistic user interactions
5. Always clean up localStorage in `afterEach`

---

## CI Integration

Tests run in the GitHub Actions pipeline (`.github/workflows/ci.yml`):

```yaml
unit-tests:
  needs: install
  runs-on: ubuntu-latest
  steps:
    - run: pnpm test -- --coverage

security-tests:
  needs: install
  runs-on: ubuntu-latest
  steps:
    - run: pnpm test:security   # Cross-tenant RLS isolation

integration-tests:
  needs: install
  services:
    postgres: { image: postgres:16 }
    redis: { image: redis:7 }
    nats: { image: nats:2.10-js }
  steps:
    - run: pnpm test:integration
```

The `security-scan` job runs Trivy and blocks merge on HIGH/CRITICAL findings. Test coverage is uploaded as an artifact and tracked over time.
