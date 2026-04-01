/**
 * Stripe webhook handler.
 *
 * POST /webhooks/stripe — receives events from Stripe and updates our DB.
 *
 * Handles:
 *   - checkout.session.completed  → activate subscription in DB
 *   - customer.subscription.updated → sync plan/status changes
 *   - customer.subscription.deleted → mark as canceled
 *   - invoice.payment_failed → mark as past_due, notify tenant
 *   - invoice.payment_succeeded → record invoice, reset past_due
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Knex } from 'knex';
import type { EventPublisher } from '@responio/events';
import type Stripe from 'stripe';
import { getStripe } from '../services/stripe-client';
import { PLANS, calculateMacOverage, type PlanId } from '../types/plans';

const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? '';

export function registerWebhookRoutes(
  app: FastifyInstance,
  db: Knex,
  _publisher: EventPublisher
): void {
  // Raw body is required for Stripe signature verification.
  // Fastify parses JSON by default so we need to handle the raw body ourselves.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    done(null, body);
  });

  app.post('/webhooks/stripe', async (request: FastifyRequest, reply: FastifyReply) => {
    const sig = request.headers['stripe-signature'];
    if (!sig) return reply.status(400).send({ error: 'Missing stripe-signature header' });
    if (!STRIPE_WEBHOOK_SECRET) {
      return reply.status(500).send({ error: 'Webhook secret not configured' });
    }

    const stripe = getStripe();
    let event: Stripe.Event;

    try {
      event = stripe.webhooks.constructEvent(
        request.body as Buffer,
        sig,
        STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      request.log.warn(`Stripe webhook signature verification failed: ${msg}`);
      return reply.status(400).send({ error: `Webhook verification failed: ${msg}` });
    }

    try {
      await handleStripeEvent(db, event, request.log);
    } catch (err) {
      request.log.error({ err, event_type: event.type }, 'Error handling Stripe webhook');
      // Return 200 so Stripe doesn't retry — we handle failures internally
    }

    return reply.send({ received: true });
  });
}

async function handleStripeEvent(
  db: Knex,
  event: Stripe.Event,
  log: FastifyRequest['log']
): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.mode !== 'subscription') break;

      const tenantId = session.metadata?.tenant_id;
      const planId = session.subscription_data?.metadata?.plan_id as PlanId | undefined;
      if (!tenantId || !planId) {
        log.warn({ session_id: session.id }, 'checkout.session.completed missing tenant_id or plan_id');
        break;
      }

      const plan = PLANS[planId];
      await db('accounts').where({ id: tenantId }).update({
        plan_tier: planId,
        billing_status: 'active',
        stripe_subscription_id: session.subscription as string,
        mac_limit: plan.mac_limit,
        updated_at: new Date(),
      });

      log.info({ tenant_id: tenantId, plan_id: planId }, 'Subscription activated via checkout');
      break;
    }

    case 'customer.subscription.updated': {
      const sub = event.data.object as Stripe.Subscription;
      const tenantId = sub.metadata?.tenant_id;
      if (!tenantId) break;

      const planId = sub.metadata?.plan_id as PlanId | undefined;
      const billingStatus = stripeStatusToInternal(sub.status);
      const updates: Record<string, unknown> = {
        billing_status: billingStatus,
        stripe_subscription_id: sub.id,
        updated_at: new Date(),
      };

      if (planId && PLANS[planId]) {
        updates.plan_tier = planId;
        updates.mac_limit = PLANS[planId].mac_limit;
      }

      await db('accounts').where({ id: tenantId }).update(updates);
      log.info({ tenant_id: tenantId, status: sub.status }, 'Subscription updated');
      break;
    }

    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      const tenantId = sub.metadata?.tenant_id;
      if (!tenantId) break;

      await db('accounts').where({ id: tenantId }).update({
        billing_status: 'canceled',
        stripe_subscription_id: null,
        updated_at: new Date(),
      });

      log.info({ tenant_id: tenantId }, 'Subscription canceled');
      break;
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object as Stripe.Invoice;
      const customerId = invoice.customer as string;

      await db('accounts').where({ stripe_customer_id: customerId }).update({
        billing_status: 'past_due',
        updated_at: new Date(),
      });

      log.warn({ customer_id: customerId }, 'Invoice payment failed — marked past_due');
      break;
    }

    case 'invoice.payment_succeeded': {
      const invoice = event.data.object as Stripe.Invoice;
      const customerId = invoice.customer as string;
      const billingPeriod = invoicePeriodToString(invoice.period_start);

      // Update billing_usage with invoiced overage
      const account = await db('accounts').where({ stripe_customer_id: customerId }).first();
      if (account) {
        const plan = PLANS[account.plan_tier as PlanId];
        const usage = await db('billing_usage')
          .where({ tenant_id: account.id, billing_period: billingPeriod })
          .first();

        if (usage && plan.mac_limit) {
          const overage = calculateMacOverage(account.plan_tier as PlanId, usage.mac_count);
          await db('billing_usage')
            .where({ tenant_id: account.id, billing_period: billingPeriod })
            .update({
              overage_units: overage?.overage_units ?? 0,
              overage_amount_usd: overage?.overage_amount_usd ?? 0,
              invoiced: true,
              reconciled_at: new Date(),
            });
        }

        // Clear past_due if it was set
        if (account.billing_status === 'past_due') {
          await db('accounts').where({ id: account.id }).update({
            billing_status: 'active',
            updated_at: new Date(),
          });
        }
      }

      log.info({ customer_id: customerId }, 'Invoice payment succeeded');
      break;
    }

    default:
      log.debug({ event_type: event.type }, 'Unhandled Stripe event type');
  }
}

function stripeStatusToInternal(
  status: Stripe.Subscription.Status
): 'active' | 'trialing' | 'past_due' | 'canceled' | 'paused' {
  switch (status) {
    case 'active': return 'active';
    case 'trialing': return 'trialing';
    case 'past_due': return 'past_due';
    case 'canceled': return 'canceled';
    case 'paused': return 'paused';
    default: return 'active';
  }
}

function invoicePeriodToString(periodStartUnix: number): string {
  const d = new Date(periodStartUnix * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
