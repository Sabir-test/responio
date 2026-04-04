/**
 * Unit tests for the broadcast scheduler.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Knex } from 'knex';
import type { EventPublisher } from '@responio/events';
import { startBroadcastScheduler } from '../scheduler/broadcast-scheduler';

const TENANT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

// ── Mock helpers ──────────────────────────────────────────────────────────────

function makePublisher() {
  return { publish: vi.fn().mockResolvedValue(undefined) } as unknown as EventPublisher;
}

const silentLog = { info: vi.fn(), error: vi.fn() };

function makeDb(dueBroadcasts: Record<string, unknown>[] = []) {
  const trxChain = {
    where: vi.fn().mockReturnThis(),
    update: vi.fn().mockResolvedValue(1),
    select: vi.fn().mockReturnThis(),
    forUpdate: vi.fn().mockReturnThis(),
    skipLocked: vi.fn().mockResolvedValue(dueBroadcasts),
  };

  const trxFn = vi.fn((table: string) => trxChain) as unknown as Knex;

  const db = vi.fn((table: string) => trxChain) as unknown as Knex;
  (db as unknown as { transaction: typeof vi.fn }).transaction = vi.fn(
    async (cb: (trx: Knex) => Promise<void>) => cb(trxFn)
  );

  return { db, trxChain };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('broadcast scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('dispatches a due broadcast and marks it as sending', async () => {
    const due = [{ id: 'bc-1', tenant_id: TENANT_ID, workspace_id: 'ws-1', name: 'Test', recipient_count: 50 }];
    const { db, trxChain } = makeDb(due);
    const publisher = makePublisher();

    startBroadcastScheduler(db, publisher, silentLog);

    // Flush the immediate tick
    await vi.runAllTimersAsync();

    expect(trxChain.where).toHaveBeenCalled();
    expect(trxChain.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'sending' })
    );
    expect(publisher.publish).toHaveBeenCalledOnce();
  });

  it('does nothing when no broadcasts are due', async () => {
    const { db, trxChain } = makeDb([]);
    const publisher = makePublisher();

    startBroadcastScheduler(db, publisher, silentLog);
    await vi.runAllTimersAsync();

    expect(trxChain.update).not.toHaveBeenCalled();
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it('dispatches multiple due broadcasts in one tick', async () => {
    const due = [
      { id: 'bc-1', tenant_id: TENANT_ID, workspace_id: 'ws-1', name: 'A', recipient_count: 10 },
      { id: 'bc-2', tenant_id: TENANT_ID, workspace_id: 'ws-1', name: 'B', recipient_count: 20 },
    ];
    const { db } = makeDb(due);
    const publisher = makePublisher();

    startBroadcastScheduler(db, publisher, silentLog);
    await vi.runAllTimersAsync();

    expect(publisher.publish).toHaveBeenCalledTimes(2);
  });

  it('continues polling after a tick error', async () => {
    const { db } = makeDb([]);
    // Make the transaction throw on first call
    let firstCall = true;
    (db as unknown as { transaction: ReturnType<typeof vi.fn> }).transaction = vi.fn(async (cb: Function) => {
      if (firstCall) { firstCall = false; throw new Error('DB error'); }
      return cb(db);
    });
    const publisher = makePublisher();

    startBroadcastScheduler(db, publisher, silentLog);
    await vi.runAllTimersAsync();

    expect(silentLog.error).toHaveBeenCalledOnce();
    // Scheduler should still be running — advance timer for next tick
    vi.advanceTimersByTime(60_000);
    await vi.runAllTimersAsync();
    // No more errors
    expect(silentLog.error).toHaveBeenCalledOnce();
  });
});
