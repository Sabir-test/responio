/**
 * Stripe checkout and subscription management routes.
 *
 * POST /api/v1/billing/checkout      — create a Stripe Checkout Session
 * POST /api/v1/billing/portal        — create a Stripe Customer Portal session
 * GET  /api/v1/billing/subscription  — get current subscription details
 * POST /api/v1/billing/cancel        — cancel subscription at period end
 */

import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';
import { z } from 'zod';
import { getStripe, getOrCreateStripeCustomer } from '../services/stripe-client';
import { PLANS, type PlanId } from '../types/plans';

const APP_URL = process.env.APP_URL ?? 'http://localhost:5173';

export function registerCheckoutRoutes(app: FastifyInstance, db: Knex): void {
  // ── POST /api/v1/billing/checkout ─────────────────────────────────────────
  // Creates a Stripe Checkout Session for plan upgrade/initial subscription.
  const checkoutSchema = z.object({
    plan_id: z.enum(['starter', 'growth', 'advanced']),
    billing_interval: z.enum(['monthly', 'annual']).default('monthly'),
    seat_count: z.number().int().min(1).optional(),
  });

  app.post('/api/v1/billing/checkout', async (request, reply) => {
    const tenantId = (request as unknown as { tenantId: string }).tenantId;
    const body = checkoutSchema.parse(request.body);
    const stripe = getStripe();

    const account = await db('accounts').where({ id: tenantId }).first();
    if (!account) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Account not found' } });

    const plan = PLANS[body.plan_id as PlanId];
    const priceId = plan.stripe_price_ids[body.billing_interval];
    if (!priceId) {
      return reply.status(422).send({ error: { code: 'NO_PRICE', message: `No Stripe price configured for ${body.plan_id}/${body.billing_interval}` } });
    }

    const customerId = await getOrCreateStripeCustomer(
      stripe,
      tenantId,
      account.owner_email ?? '',
      account.name,
      account.stripe_customer_id
    );

    // Persist customer ID if newly created
    if (!account.stripe_customer_id) {
      await db('accounts').where({ id: tenantId }).update({ stripe_customer_id: customerId });
    }

    const lineItems: { price: string; quantity: number }[] = [{ price: priceId, quantity: 1 }];

    // Add seat add-ons if requested beyond plan's included seats
    const additionalSeats = (body.seat_count ?? plan.included_seats ?? 1) - (plan.included_seats ?? 1);
    if (additionalSeats > 0 && plan.stripe_price_ids.seat_addon) {
      lineItems.push({ price: plan.stripe_price_ids.seat_addon, quantity: additionalSeats });
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: lineItems,
      success_url: `${APP_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${APP_URL}/billing`,
      subscription_data: {
        metadata: { tenant_id: tenantId, plan_id: body.plan_id },
        trial_period_days: account.billing_status === 'trialing' ? 14 : undefined,
      },
      metadata: { tenant_id: tenantId },
    });

    return reply.send({ checkout_url: session.url, session_id: session.id });
  });

  // ── POST /api/v1/billing/portal ───────────────────────────────────────────
  // Creates a Stripe Customer Portal session for self-service billing management.
  app.post('/api/v1/billing/portal', async (request, reply) => {
    const tenantId = (request as unknown as { tenantId: string }).tenantId;
    const stripe = getStripe();

    const account = await db('accounts').where({ id: tenantId }).first();
    if (!account?.stripe_customer_id) {
      return reply.status(404).send({ error: { code: 'NO_CUSTOMER', message: 'No Stripe customer found. Subscribe first.' } });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: account.stripe_customer_id,
      return_url: `${APP_URL}/billing`,
    });

    return reply.send({ portal_url: session.url });
  });

  // ── GET /api/v1/billing/subscription ──────────────────────────────────────
  // Returns current subscription and usage summary.
  app.get('/api/v1/billing/subscription', async (request, reply) => {
    const tenantId = (request as unknown as { tenantId: string }).tenantId;

    const account = await db('accounts').where({ id: tenantId }).first();
    if (!account) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Account not found' } });

    // Current billing period usage
    const period = currentBillingPeriod();
    const usage = await db('billing_usage')
      .where({ tenant_id: tenantId, billing_period: period })
      .first();

    const plan = PLANS[account.plan_tier as PlanId] ?? PLANS.starter;

    return reply.send({
      data: {
        plan_id: account.plan_tier,
        plan_name: plan.name,
        billing_status: account.billing_status,
        stripe_subscription_id: account.stripe_subscription_id,
        seat_count: account.seat_count,
        mac_limit: account.mac_limit ?? plan.mac_limit,
        current_period: period,
        mac_count: usage?.mac_count ?? 0,
        overage_amount_usd: usage?.overage_amount_usd ?? 0,
      },
    });
  });

  // ── POST /api/v1/billing/cancel ───────────────────────────────────────────
  // Cancels subscription at the end of the current billing period.
  app.post('/api/v1/billing/cancel', async (request, reply) => {
    const tenantId = (request as unknown as { tenantId: string }).tenantId;
    const stripe = getStripe();

    const account = await db('accounts').where({ id: tenantId }).first();
    if (!account?.stripe_subscription_id) {
      return reply.status(404).send({ error: { code: 'NO_SUBSCRIPTION', message: 'No active subscription found' } });
    }

    await stripe.subscriptions.update(account.stripe_subscription_id, {
      cancel_at_period_end: true,
    });

    return reply.send({ message: 'Subscription will be cancelled at the end of the billing period.' });
  });
}

function currentBillingPeriod(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}
