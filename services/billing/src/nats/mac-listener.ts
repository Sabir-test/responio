/**
 * NATS event listener for MAC (Monthly Active Contact) metering.
 *
 * Subscribes to message.inbound and message.outbound events and increments
 * the HyperLogLog counter for each unique contact_id per billing period.
 *
 * Also fires threshold warnings when 80%, 90%, or 100% of the MAC limit
 * is reached.
 */

import type { NatsConnection } from 'nats';
import type { Knex } from 'knex';
import type { Redis } from 'ioredis';
import {
  EventSubscriber,
  EventPublisher,
  Subjects,
  type MessageInboundPayload,
  type MessageOutboundPayload,
  type BillingThresholdWarningPayload,
} from '@responio/events';
import {
  recordMacInteraction,
  checkMacThresholds,
} from '../services/mac-metering';
import { PLANS, type PlanId } from '../types/plans';

const SERVICE_NAME = 'billing';

// Track which thresholds have been fired per tenant per period to avoid duplicate alerts.
// In-memory; good enough for single-instance billing service.
const firedThresholds = new Map<string, Set<number>>();

function thresholdKey(tenantId: string, period: string, pct: number): string {
  return `${tenantId}:${period}:${pct}`;
}

export function startMacListener(
  nc: NatsConnection,
  db: Knex,
  redis: Redis
): void {
  const sub = new EventSubscriber(nc);
  const publisher = new EventPublisher(nc);

  // ── message.inbound → count the contact as active ─────────────────────────
  sub.subscribe<MessageInboundPayload>(
    {
      consumerName: `${SERVICE_NAME}.mac-inbound`,
      streamName: 'MESSAGE',
      filterSubject: Subjects.MESSAGE_INBOUND,
    },
    async (event, ack) => {
      await handleMacEvent(db, redis, publisher, event.tenant_id, event.payload.contact_id);
      ack();
    }
  );

  // ── message.outbound → also counts (agent/AI outbound to a contact) ───────
  sub.subscribe<MessageOutboundPayload>(
    {
      consumerName: `${SERVICE_NAME}.mac-outbound`,
      streamName: 'MESSAGE',
      filterSubject: Subjects.MESSAGE_OUTBOUND,
    },
    async (event, ack) => {
      await handleMacEvent(db, redis, publisher, event.tenant_id, event.payload.contact_id);
      ack();
    }
  );

  console.log('[mac-listener] Subscribed to message.inbound and message.outbound for MAC metering');
}

async function handleMacEvent(
  db: Knex,
  redis: Redis,
  publisher: EventPublisher,
  tenantId: string,
  contactId: string
): Promise<void> {
  const period = currentBillingPeriod();

  await recordMacInteraction(redis, tenantId, contactId, period);

  // Fetch the tenant's plan and MAC limit
  const account = await db('accounts').where({ id: tenantId }).first();
  if (!account) return;

  const plan = PLANS[account.plan_tier as PlanId];
  const macLimit = account.mac_limit ?? plan.mac_limit;
  if (!macLimit) return; // Unlimited (Starter has no workflows/AI so no MAC limit)

  const crossedPcts = await checkMacThresholds(redis, tenantId, macLimit, period);

  for (const pct of crossedPcts) {
    const key = thresholdKey(tenantId, period, pct);

    // Use the in-memory set to avoid repeated alerts within the same process lifecycle
    const tenantSet = firedThresholds.get(tenantId) ?? new Set<number>();
    if (tenantSet.has(pct)) continue;
    tenantSet.add(pct);
    firedThresholds.set(tenantId, tenantSet);

    const macCount = await import('../services/mac-metering').then((m) =>
      m.getMacCount(redis, tenantId, period)
    );

    const payload: BillingThresholdWarningPayload = {
      threshold_pct: pct as 80 | 90 | 100,
      current_mac_count: macCount,
      mac_limit: macLimit,
      plan_tier: account.plan_tier,
    };

    await publisher.publish(Subjects.BILLING_THRESHOLD_WARNING, {
      tenant_id: tenantId,
      workspace_id: '',
      source_service: SERVICE_NAME,
      payload,
    });

    void key; // suppress unused variable warning — key is conceptually useful
    console.warn(`[mac-listener] Tenant ${tenantId} hit ${pct}% MAC threshold (${macCount}/${macLimit})`);
  }
}

function currentBillingPeriod(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}
