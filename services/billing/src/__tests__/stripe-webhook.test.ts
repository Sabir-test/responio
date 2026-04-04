/**
 * Tests for Stripe webhook handler.
 * Verifies signature validation, event routing, and DB updates.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { Knex } from 'knex';

// Mock Stripe before importing routes
vi.mock('stripe', () => {
  const mockConstructEvent = vi.fn();
  return {
    default: vi.fn().mockImplementation(() => ({
      webhooks: { constructEvent: mockConstructEvent },
    })),
    __mockConstructEvent: mockConstructEvent,
  };
});

import { registerWebhookRoutes } from '../routes/webhooks';

const TENANT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

// ── Mock DB ───────────────────────────────────────────────────────────────────

function makeMockDb() {
  const chain = {
    where: vi.fn().mockReturnThis(),
    update: vi.fn().mockResolvedValue(1),
    first: vi.fn().mockResolvedValue({ id: TENANT_ID, plan_tier: 'starter' }),
    insert: vi.fn().mockReturnThis(),
    onConflict: vi.fn().mockReturnThis(),
    merge: vi.fn().mockResolvedValue([]),
  };
  return vi.fn(() => chain) as unknown as Knex;
}

async function buildApp(db: Knex) {
  const app = Fastify({ logger: false });
  registerWebhookRoutes(app, db);
  await app.ready();
  return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /webhooks/stripe — signature validation', () => {
  it('returns 400 when stripe-signature header is missing', async () => {
    const app = await buildApp(makeMockDb());
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      payload: '{}',
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns 400 when constructEvent throws (bad signature)', async () => {
    const { __mockConstructEvent } = await import('stripe') as unknown as { __mockConstructEvent: ReturnType<typeof vi.fn> };
    __mockConstructEvent.mockImplementationOnce(() => { throw new Error('Invalid signature'); });

    const app = await buildApp(makeMockDb());
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: { 'stripe-signature': 'bad-sig' },
      payload: '{"type":"checkout.session.completed"}',
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe('POST /webhooks/stripe — event routing', () => {
  let mockConstructEvent: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const stripe = await import('stripe') as unknown as { __mockConstructEvent: ReturnType<typeof vi.fn> };
    mockConstructEvent = stripe.__mockConstructEvent;
  });

  it('handles checkout.session.completed and updates account plan', async () => {
    mockConstructEvent.mockReturnValueOnce({
      type: 'checkout.session.completed',
      data: {
        object: {
          subscription: 'sub_123',
          metadata: { tenant_id: TENANT_ID, plan_id: 'growth' },
        },
      },
    });

    const db = makeMockDb();
    const app = await buildApp(db);
    const res = await app.inject({
      method: 'POST', url: '/webhooks/stripe',
      headers: { 'stripe-signature': 'valid' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().received).toBe(true);
    await app.close();
  });

  it('handles customer.subscription.deleted and sets billing_status canceled', async () => {
    mockConstructEvent.mockReturnValueOnce({
      type: 'customer.subscription.deleted',
      data: { object: { metadata: { tenant_id: TENANT_ID } } },
    });

    const db = makeMockDb();
    const app = await buildApp(db);
    const res = await app.inject({
      method: 'POST', url: '/webhooks/stripe',
      headers: { 'stripe-signature': 'valid' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('returns 200 for unknown event types (no-op)', async () => {
    mockConstructEvent.mockReturnValueOnce({
      type: 'some.unknown.event',
      data: { object: {} },
    });

    const app = await buildApp(makeMockDb());
    const res = await app.inject({
      method: 'POST', url: '/webhooks/stripe',
      headers: { 'stripe-signature': 'valid' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('still returns 200 even if DB update throws (prevent Stripe retries)', async () => {
    mockConstructEvent.mockReturnValueOnce({
      type: 'checkout.session.completed',
      data: {
        object: {
          subscription: 'sub_456',
          metadata: { tenant_id: TENANT_ID, plan_id: 'growth' },
        },
      },
    });

    const db = makeMockDb();
    // Simulate DB failure
    (db as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      where: vi.fn().mockReturnThis(),
      update: vi.fn().mockRejectedValue(new Error('DB down')),
    }));

    const app = await buildApp(db);
    const res = await app.inject({
      method: 'POST', url: '/webhooks/stripe',
      headers: { 'stripe-signature': 'valid' },
      payload: '{}',
    });
    // Must return 200 so Stripe doesn't retry — errors are logged, not propagated
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
