/**
 * Unit tests for MAC metering utilities.
 * Uses Vitest with a mock Redis client.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  recordMacInteraction,
  getMacCount,
  checkMacThresholds,
  reconcileMacCounters,
} from '../services/mac-metering';
import type { Redis } from 'ioredis';
import type { Knex } from 'knex';

// ── Mock Redis ────────────────────────────────────────────────────────────────

function makeMockRedis(pfcountValue = 0): vi.Mocked<Redis> {
  const store = new Map<string, Set<string>>();
  const expiries = new Map<string, number>();

  return {
    pfadd: vi.fn(async (key: string, ...members: string[]) => {
      if (!store.has(key)) store.set(key, new Set());
      members.forEach((m) => store.get(key)!.add(m));
      return 1;
    }),
    pfcount: vi.fn(async (key: string) => {
      if (pfcountValue !== 0) return pfcountValue;
      return store.get(key)?.size ?? 0;
    }),
    expire: vi.fn(async () => 1),
    set: vi.fn(async () => 'OK'),
    keys: vi.fn(async (pattern: string) => {
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      return [...store.keys()].filter((k) => regex.test(k));
    }),
  } as unknown as vi.Mocked<Redis>;
}

// ── Mock Knex ─────────────────────────────────────────────────────────────────

function makeMockDb() {
  const onConflictMock = {
    merge: vi.fn(async () => []),
  };
  const insertMock = {
    onConflict: vi.fn(() => onConflictMock),
  };
  return vi.fn(() => ({
    insert: vi.fn(() => insertMock),
  })) as unknown as Knex;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('recordMacInteraction', () => {
  it('calls pfadd with tenant+period key and contactId', async () => {
    const redis = makeMockRedis();
    await recordMacInteraction(redis as unknown as Redis, 'tenant-1', 'contact-abc', '2026-03');

    expect(redis.pfadd).toHaveBeenCalledWith(
      'billing:mac:tenant-1:2026-03',
      'contact-abc'
    );
  });

  it('sets a 90-day TTL on the key', async () => {
    const redis = makeMockRedis();
    await recordMacInteraction(redis as unknown as Redis, 'tenant-1', 'contact-abc', '2026-03');

    expect(redis.expire).toHaveBeenCalledWith(
      'billing:mac:tenant-1:2026-03',
      90 * 24 * 60 * 60
    );
  });
});

describe('getMacCount', () => {
  it('returns pfcount for the key', async () => {
    const redis = makeMockRedis(42);
    const count = await getMacCount(redis as unknown as Redis, 'tenant-1', '2026-03');
    expect(count).toBe(42);
    expect(redis.pfcount).toHaveBeenCalledWith('billing:mac:tenant-1:2026-03');
  });
});

describe('checkMacThresholds', () => {
  it('returns empty array when under 80%', async () => {
    const redis = makeMockRedis(700); // 700 / 1000 = 70%
    const result = await checkMacThresholds(redis as unknown as Redis, 'tenant-1', 1000, '2026-03');
    expect(result).toEqual([]);
  });

  it('returns [80] when between 80-89%', async () => {
    const redis = makeMockRedis(850); // 85%
    const result = await checkMacThresholds(redis as unknown as Redis, 'tenant-1', 1000, '2026-03');
    expect(result).toEqual([80]);
  });

  it('returns [80, 90] when between 90-99%', async () => {
    const redis = makeMockRedis(950); // 95%
    const result = await checkMacThresholds(redis as unknown as Redis, 'tenant-1', 1000, '2026-03');
    expect(result).toEqual([80, 90]);
  });

  it('returns [80, 90, 100] when at or over limit', async () => {
    const redis = makeMockRedis(1000); // 100%
    const result = await checkMacThresholds(redis as unknown as Redis, 'tenant-1', 1000, '2026-03');
    expect(result).toEqual([80, 90, 100]);
  });

  it('returns empty array when macLimit is 0', async () => {
    const redis = makeMockRedis(500);
    const result = await checkMacThresholds(redis as unknown as Redis, 'tenant-1', 0, '2026-03');
    expect(result).toEqual([]);
  });
});

describe('reconcileMacCounters', () => {
  it('upserts billing_usage for each HyperLogLog key found', async () => {
    const redis = makeMockRedis(300);
    // Simulate two tenants having data in Redis
    await redis.pfadd('billing:mac:tenant-a:2026-03', 'c1');
    await redis.pfadd('billing:mac:tenant-b:2026-03', 'c2');

    const db = makeMockDb();
    await reconcileMacCounters(redis as unknown as Redis, db, '2026-03');

    // Should have called db('billing_usage').insert(...) twice
    expect(db).toHaveBeenCalledTimes(2);
  });
});
