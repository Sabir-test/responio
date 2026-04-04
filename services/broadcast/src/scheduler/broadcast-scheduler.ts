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

const POLL_INTERVAL_MS = Number(process.env.BROADCAST_POLL_INTERVAL_MS ?? '60000'); // 1 min default

export function startBroadcastScheduler(
  db: Knex,
  log: { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void }
): void {
  const tick = async (): Promise<void> => {
    try {
      await dispatchDueBroadcasts(db, log);
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

    // MAC counting is handled per-contact downstream when the sender emits MESSAGE_OUTBOUND.
    // Do not publish BILLING_MAC_INCREMENTED here — contact_id would be empty and corrupt HyperLogLog.
  });
}
