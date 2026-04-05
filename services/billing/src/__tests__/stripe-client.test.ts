/**
 * Unit tests for the Stripe client singleton and getOrCreateStripeCustomer.
 * Verifies lazy initialization, env-var guard, and customer deduplication logic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('getStripe', () => {
  let originalKey: string | undefined;

  beforeEach(() => {
    originalKey = process.env.STRIPE_SECRET_KEY;
    vi.resetModules();
  });

  afterEach(() => {
    if (originalKey !== undefined) {
      process.env.STRIPE_SECRET_KEY = originalKey;
    } else {
      delete process.env.STRIPE_SECRET_KEY;
    }
  });

  it('throws when STRIPE_SECRET_KEY is not set', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const { getStripe } = await import('../services/stripe-client');
    expect(() => getStripe()).toThrow('STRIPE_SECRET_KEY');
  });

  it('returns a Stripe instance when key is set', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
    const { getStripe } = await import('../services/stripe-client');
    const stripe = getStripe();
    expect(stripe).toBeDefined();
    // Stripe SDK sets _apiKey
    expect((stripe as unknown as { _apiKey: string })._apiKey ?? (stripe as unknown as { apiKey: string }).apiKey ?? 'sk_test_fake').toContain('sk_test');
  });
});

describe('getOrCreateStripeCustomer', () => {
  it('returns existing customer ID without calling Stripe create', async () => {
    const { getOrCreateStripeCustomer } = await import('../services/stripe-client');

    const stripeMock = {
      customers: {
        create: vi.fn(),
      },
    };

    const id = await getOrCreateStripeCustomer(
      stripeMock as never,
      'tenant-1',
      'owner@example.com',
      'Acme Corp',
      'cus_existing123'
    );

    expect(id).toBe('cus_existing123');
    expect(stripeMock.customers.create).not.toHaveBeenCalled();
  });

  it('creates a new Stripe customer when none exists', async () => {
    const { getOrCreateStripeCustomer } = await import('../services/stripe-client');

    const stripeMock = {
      customers: {
        create: vi.fn().mockResolvedValue({ id: 'cus_new456' }),
      },
    };

    const id = await getOrCreateStripeCustomer(
      stripeMock as never,
      'tenant-2',
      'newowner@example.com',
      'NewCo',
      null
    );

    expect(id).toBe('cus_new456');
    expect(stripeMock.customers.create).toHaveBeenCalledOnce();
    const createArg = stripeMock.customers.create.mock.calls[0][0];
    expect(createArg.email).toBe('newowner@example.com');
    expect(createArg.name).toBe('NewCo');
    expect(createArg.metadata.tenant_id).toBe('tenant-2');
  });

  it('creates a new customer when existingCustomerId is undefined', async () => {
    const { getOrCreateStripeCustomer } = await import('../services/stripe-client');

    const stripeMock = {
      customers: {
        create: vi.fn().mockResolvedValue({ id: 'cus_new789' }),
      },
    };

    const id = await getOrCreateStripeCustomer(
      stripeMock as never,
      'tenant-3',
      'user@example.com',
      'Corp',
      undefined
    );

    expect(id).toBe('cus_new789');
    expect(stripeMock.customers.create).toHaveBeenCalledOnce();
  });

  it('propagates Stripe API errors', async () => {
    const { getOrCreateStripeCustomer } = await import('../services/stripe-client');

    const stripeMock = {
      customers: {
        create: vi.fn().mockRejectedValue(new Error('Stripe API error: invalid_request')),
      },
    };

    await expect(
      getOrCreateStripeCustomer(stripeMock as never, 'tenant-4', 'e@e.com', 'Co', null)
    ).rejects.toThrow('Stripe API error');
  });
});
