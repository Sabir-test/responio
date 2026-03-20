import type { Redis } from 'ioredis';
import type { Knex } from 'knex';

/**
 * Monthly Active Contact (MAC) metering using Redis HyperLogLog.
 *
 * HyperLogLog provides ~1% error rate at minimal memory.
 * Keys: billing:mac:{tenantId}:{billingPeriod}  (e.g. billing:mac:uuid:2026-03)
 *
 * Counters are reconciled to PostgreSQL hourly for accurate billing.
 */

const MAC_KEY_PREFIX = 'billing:mac';
const THRESHOLD_PCTS = [80, 90, 100] as const;

function macKey(tenantId: string, billingPeriod: string): string {
  return `${MAC_KEY_PREFIX}:${tenantId}:${billingPeriod}`;
}

function currentBillingPeriod(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Record a contact interaction for MAC counting.
 * Uses HyperLogLog PFADD for approximate unique counting.
 * Called on every inbound/outbound message event.
 */
export async function recordMacInteraction(
  redis: Redis,
  tenantId: string,
  contactId: string,
  billingPeriod?: string
): Promise<void> {
  const period = billingPeriod ?? currentBillingPeriod();
  const key = macKey(tenantId, period);

  await redis.pfadd(key, contactId);

  // TTL: keep for 90 days after end of billing period (for audit)
  await redis.expire(key, 90 * 24 * 60 * 60);
}

/**
 * Get approximate current MAC count for a tenant.
 */
export async function getMacCount(
  redis: Redis,
  tenantId: string,
  billingPeriod?: string
): Promise<number> {
  const period = billingPeriod ?? currentBillingPeriod();
  const key = macKey(tenantId, period);
  return redis.pfcount(key);
}

/**
 * Check MAC threshold and return which thresholds have been crossed.
 * Called after each MAC increment to determine if alerts should fire.
 */
export async function checkMacThresholds(
  redis: Redis,
  tenantId: string,
  macLimit: number,
  billingPeriod?: string
): Promise<Array<(typeof THRESHOLD_PCTS)[number]>> {
  if (!macLimit) return [];

  const currentMac = await getMacCount(redis, tenantId, billingPeriod);
  const currentPct = (currentMac / macLimit) * 100;

  return THRESHOLD_PCTS.filter((pct) => currentPct >= pct);
}

/**
 * Reconcile Redis HyperLogLog counters to PostgreSQL.
 * Runs hourly via cron job.
 * Updates billing_usage table with accurate MAC counts for invoicing.
 */
export async function reconcileMacCounters(
  redis: Redis,
  db: Knex,
  billingPeriod?: string
): Promise<void> {
  const period = billingPeriod ?? currentBillingPeriod();

  // Find all HyperLogLog keys for this billing period
  const keys = await redis.keys(`${MAC_KEY_PREFIX}:*:${period}`);

  for (const key of keys) {
    const tenantId = key.split(':')[2];
    const count = await redis.pfcount(key);

    await db('billing_usage')
      .insert({
        tenant_id: tenantId,
        billing_period: period,
        mac_count: count,
        reconciled_at: new Date(),
      })
      .onConflict(['tenant_id', 'billing_period'])
      .merge({
        mac_count: count,
        reconciled_at: new Date(),
      });
  }
}
