/**
 * Unit tests for billing checkout routes.
 * Covers checkout session creation, seat add-ons, customer portal,
 * subscription query, and cancellation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { Knex } from 'knex';

// ── Stripe mock ───────────────────────────────────────────────────────────────

const createSessionMock = vi.fn();
const createPortalMock = vi.fn();
const updateSubMock = vi.fn();
const getOrCreateCustomerMock = vi.fn();

vi.mock('../services/stripe-client', () => ({
  getStripe: vi.fn().mockReturnValue({
    checkout: { sessions: { create: createSessionMock } },
    billingPortal: { sessions: { create: createPortalMock } },
    subscriptions: { update: updateSubMock },
  }),
  getOrCreateStripeCustomer: getOrCreateCustomerMock,
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

const TENANT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function makeDb(accountRow?: Record<string, unknown>, usageRow?: Record<string, unknown>) {
  const firstMock = vi.fn();
  const whereMock = vi.fn().mockReturnThis();

  return vi.fn((table: string) => {
    if (table === 'accounts') {
      return {
        where: vi.fn().mockReturnThis(),
        first: vi.fn().mockResolvedValue(accountRow ?? null),
        update: vi.fn().mockResolvedValue(1),
      };
    }
    if (table === 'billing_usage') {
      return {
        where: vi.fn().mockReturnThis(),
        first: vi.fn().mockResolvedValue(usageRow ?? null),
      };
    }
    return { where: whereMock, first: firstMock, update: vi.fn().mockResolvedValue(1) };
  }) as unknown as Knex;
}

async function buildApp(db: Knex) {
  // Set env so plan price IDs are non-empty
  process.env.STRIPE_PRICE_STARTER_MONTHLY = 'price_starter_monthly';
  process.env.STRIPE_PRICE_GROWTH_MONTHLY = 'price_growth_monthly';
  process.env.STRIPE_PRICE_GROWTH_ANNUAL = 'price_growth_annual';
  process.env.STRIPE_PRICE_SEAT_ADDON_GROWTH = 'price_seat_addon_growth';

  const app = Fastify({ logger: false });

  // Inject tenantId as the auth middleware would
  app.addHook('preHandler', (req, _reply, done) => {
    (req as unknown as { tenantId: string }).tenantId = TENANT_ID;
    done();
  });

  const { registerCheckoutRoutes } = await import('../routes/checkout');
  registerCheckoutRoutes(app, db);
  await app.ready();
  return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/v1/billing/checkout', () => {
  beforeEach(() => {
    createSessionMock.mockReset();
    getOrCreateCustomerMock.mockReset();
  });

  it('returns 404 when account not found', async () => {
    const app = await buildApp(makeDb(null));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      body: { plan_id: 'growth', billing_interval: 'monthly' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('returns 422 when no Stripe price is configured for the plan/interval', async () => {
    delete process.env.STRIPE_PRICE_STARTER_MONTHLY;
    const app = await buildApp(makeDb({ id: TENANT_ID, name: 'Test', owner_email: 'o@e.com', stripe_customer_id: null, billing_status: 'active' }));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      body: { plan_id: 'starter', billing_interval: 'monthly' },
    });
    expect(res.statusCode).toBe(422);
  });

  it('creates a checkout session and returns url + session_id', async () => {
    const account = {
      id: TENANT_ID,
      name: 'Acme',
      owner_email: 'ceo@acme.com',
      stripe_customer_id: 'cus_existing',
      billing_status: 'active',
    };
    getOrCreateCustomerMock.mockResolvedValue('cus_existing');
    createSessionMock.mockResolvedValue({ url: 'https://checkout.stripe.com/pay/cs_test', id: 'cs_test' });

    const app = await buildApp(makeDb(account));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      body: { plan_id: 'growth', billing_interval: 'monthly' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().checkout_url).toBe('https://checkout.stripe.com/pay/cs_test');
    expect(res.json().session_id).toBe('cs_test');
  });

  it('adds seat add-on line item when seat_count exceeds plan included seats', async () => {
    const account = {
      id: TENANT_ID,
      name: 'BigCo',
      owner_email: 'cfo@bigco.com',
      stripe_customer_id: 'cus_bigco',
      billing_status: 'active',
    };
    getOrCreateCustomerMock.mockResolvedValue('cus_bigco');
    createSessionMock.mockResolvedValue({ url: 'https://checkout.stripe.com/pay/cs_seats', id: 'cs_seats' });

    const app = await buildApp(makeDb(account));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      body: { plan_id: 'growth', billing_interval: 'monthly', seat_count: 15 },
    });

    expect(res.statusCode).toBe(200);
    const sessionArg = createSessionMock.mock.calls[0][0];
    // growth includes 10 seats; requesting 15 → 5 add-ons
    expect(sessionArg.line_items).toHaveLength(2);
    expect(sessionArg.line_items[1].price).toBe('price_seat_addon_growth');
    expect(sessionArg.line_items[1].quantity).toBe(5);
  });

  it('includes 14-day trial when account is trialing', async () => {
    const account = {
      id: TENANT_ID,
      name: 'Startup',
      owner_email: 'founder@startup.com',
      stripe_customer_id: null,
      billing_status: 'trialing',
    };
    getOrCreateCustomerMock.mockResolvedValue('cus_new');
    createSessionMock.mockResolvedValue({ url: 'https://checkout.stripe.com/pay/cs_trial', id: 'cs_trial' });

    const app = await buildApp(makeDb(account));
    await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      body: { plan_id: 'growth', billing_interval: 'monthly' },
    });

    const sessionArg = createSessionMock.mock.calls[0][0];
    expect(sessionArg.subscription_data.trial_period_days).toBe(14);
  });

  it('validates plan_id — rejects invalid plan', async () => {
    const app = await buildApp(makeDb({ id: TENANT_ID }));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      body: { plan_id: 'enterprise', billing_interval: 'monthly' },
    });
    // enterprise not in the enum
    expect(res.statusCode).toBe(500); // Zod parse throws
  });
});

describe('POST /api/v1/billing/portal', () => {
  it('returns 404 when no Stripe customer on account', async () => {
    const account = { id: TENANT_ID, stripe_customer_id: null };
    const app = await buildApp(makeDb(account));
    const res = await app.inject({ method: 'POST', url: '/api/v1/billing/portal', body: {} });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NO_CUSTOMER');
  });

  it('returns portal url on success', async () => {
    const account = { id: TENANT_ID, stripe_customer_id: 'cus_portal' };
    createPortalMock.mockResolvedValue({ url: 'https://billing.stripe.com/session/test' });
    const app = await buildApp(makeDb(account));
    const res = await app.inject({ method: 'POST', url: '/api/v1/billing/portal', body: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().portal_url).toContain('billing.stripe.com');
  });
});

describe('GET /api/v1/billing/subscription', () => {
  it('returns 404 when account not found', async () => {
    const app = await buildApp(makeDb(null));
    const res = await app.inject({ method: 'GET', url: '/api/v1/billing/subscription' });
    expect(res.statusCode).toBe(404);
  });

  it('returns subscription details with zero usage when no usage row', async () => {
    const account = {
      id: TENANT_ID,
      plan_tier: 'growth',
      billing_status: 'active',
      stripe_subscription_id: 'sub_123',
      seat_count: 10,
      mac_limit: 1000,
    };
    const app = await buildApp(makeDb(account, null));
    const res = await app.inject({ method: 'GET', url: '/api/v1/billing/subscription' });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.plan_id).toBe('growth');
    expect(data.mac_count).toBe(0);
    expect(data.overage_amount_usd).toBe(0);
    expect(data.billing_status).toBe('active');
  });

  it('returns current usage when billing_usage row exists', async () => {
    const account = {
      id: TENANT_ID,
      plan_tier: 'growth',
      billing_status: 'active',
      stripe_subscription_id: 'sub_456',
      seat_count: 10,
      mac_limit: 1000,
    };
    const usage = { mac_count: 350, overage_amount_usd: 0 };
    const app = await buildApp(makeDb(account, usage));
    const res = await app.inject({ method: 'GET', url: '/api/v1/billing/subscription' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.mac_count).toBe(350);
  });
});

describe('POST /api/v1/billing/cancel', () => {
  it('returns 404 when no active subscription', async () => {
    const account = { id: TENANT_ID, stripe_subscription_id: null };
    const app = await buildApp(makeDb(account));
    const res = await app.inject({ method: 'POST', url: '/api/v1/billing/cancel', body: {} });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NO_SUBSCRIPTION');
  });

  it('calls stripe.subscriptions.update with cancel_at_period_end=true', async () => {
    const account = { id: TENANT_ID, stripe_subscription_id: 'sub_cancel_me' };
    updateSubMock.mockResolvedValue({});
    const app = await buildApp(makeDb(account));
    const res = await app.inject({ method: 'POST', url: '/api/v1/billing/cancel', body: {} });
    expect(res.statusCode).toBe(200);
    expect(updateSubMock).toHaveBeenCalledWith('sub_cancel_me', { cancel_at_period_end: true });
  });
});
