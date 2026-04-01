/**
 * MAC usage query routes.
 *
 * GET /api/v1/billing/usage             — current period MAC count
 * GET /api/v1/billing/usage/:period     — historical period (YYYY-MM)
 */

import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';
import type { Redis } from 'ioredis';
import { getMacCount } from '../services/mac-metering';
import { PLANS, calculateMacOverage, type PlanId } from '../types/plans';

export function registerUsageRoutes(app: FastifyInstance, db: Knex, redis: Redis): void {
  // ── GET /api/v1/billing/usage ─────────────────────────────────────────────
  app.get('/api/v1/billing/usage', async (request, reply) => {
    const tenantId = (request as unknown as { tenantId: string }).tenantId;

    const account = await db('accounts').where({ id: tenantId }).first();
    if (!account) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Account not found' } });

    const period = currentBillingPeriod();
    const macCount = await getMacCount(redis, tenantId, period);

    const plan = PLANS[account.plan_tier as PlanId] ?? PLANS.starter;
    const macLimit = account.mac_limit ?? plan.mac_limit;
    const overage = macLimit ? calculateMacOverage(account.plan_tier as PlanId, macCount) : null;

    return reply.send({
      data: {
        billing_period: period,
        mac_count: macCount,
        mac_limit: macLimit,
        overage_units: overage?.overage_units ?? 0,
        projected_overage_usd: overage?.overage_amount_usd ?? 0,
        usage_pct: macLimit ? Math.round((macCount / macLimit) * 100) : null,
      },
    });
  });

  // ── GET /api/v1/billing/usage/:period ─────────────────────────────────────
  app.get('/api/v1/billing/usage/:period', async (request, reply) => {
    const tenantId = (request as unknown as { tenantId: string }).tenantId;
    const { period } = request.params as { period: string };

    if (!/^\d{4}-\d{2}$/.test(period)) {
      return reply.status(400).send({ error: { code: 'INVALID_PERIOD', message: 'Period must be YYYY-MM format' } });
    }

    const usage = await db('billing_usage')
      .where({ tenant_id: tenantId, billing_period: period })
      .first();

    return reply.send({ data: usage ?? { billing_period: period, mac_count: 0, overage_units: 0, overage_amount_usd: 0, invoiced: false } });
  });
}

function currentBillingPeriod(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}
