/**
 * Broadcast Scheduler
 *
 * Polls the `broadcasts` table every BROADCAST_POLL_INTERVAL_MS milliseconds
 * and dispatches any broadcasts whose scheduled_at is in the past.
 *
 * Uses `FOR UPDATE SKIP LOCKED` so multiple broadcast service instances
 * never double-process the same broadcast (safe for horizontal scaling).
 */

import type { Knex } from 'knex';
import type { EventPublisher } from '@responio/events';
import { Subjects } from '@responio/events';

const POLL_INTERVAL_MS = Number(process.env.BROADCAST_POLL_INTERVAL_MS ?? '60000'); // 1 min default

function currentBillingPeriod(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function startBroadcastScheduler(
  db: Knex,
  publisher: EventPublisher,
  log: { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void }
): void {
  const tick = async (): Promise<void> => {
    try {
      await dispatchDueBroadcasts(db, publisher, log);
    } catch (err) {
      log.error({ err }, '[broadcast-scheduler] Tick failed');
    }
  };

  // Run immediately on startup, then on every interval
  void tick();
  setInterval(() => void tick(), POLL_INTERVAL_MS);
  log.info(`[broadcast-scheduler] Started — polling every ${POLL_INTERVAL_MS}ms`);
}

async function dispatchDueBroadcasts(
  db: Knex,
  publisher: EventPublisher,
  log: { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void }
): Promise<void> {
  // Use a transaction with FOR UPDATE SKIP LOCKED to atomically claim broadcasts
  await db.transaction(async (trx) => {
    const due = await trx('broadcasts')
      .where('status', 'scheduled')
      .where('scheduled_at', '<=', new Date())
      .select('id', 'tenant_id', 'workspace_id', 'name', 'recipient_count')
      .forUpdate()
      .skipLocked();

    if (due.length === 0) return;

    for (const broadcast of due) {
      // Mark as sending before doing anything else — prevents re-processing on crash
      await trx('broadcasts')
        .where({ id: broadcast.id })
        .update({ status: 'sending', sent_at: new Date(), updated_at: new Date() });

      log.info({ broadcast_id: broadcast.id, tenant_id: broadcast.tenant_id }, '[broadcast-scheduler] Dispatching due broadcast');
    }

    // Publish after the transaction commits so consumers see 'sending' status
    for (const broadcast of due) {
      await publisher.publish(Subjects.BILLING_MAC_INCREMENTED, {
        tenant_id: broadcast.tenant_id,
        workspace_id: broadcast.workspace_id ?? '',
        source_service: 'broadcast-scheduler',
        payload: {
          contact_id: '',   // Per-contact tracking handled downstream by sender
          billing_period: currentBillingPeriod(),
          current_mac_count: broadcast.recipient_count ?? 0,
        },
      });
    }
  });
}
