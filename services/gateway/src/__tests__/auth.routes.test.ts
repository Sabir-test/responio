/**
 * Integration tests for gateway auth routes.
 * Uses Fastify inject — no real DB/Redis required (mocked inline).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import fjwt from '@fastify/jwt';
import { registerAuthRoutes } from '../auth/routes';
import type { Knex } from 'knex';
import type { Redis } from 'ioredis';

// ── Helpers ───────────────────────────────────────────────────────────────────

const TENANT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_ID   = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

/** Build a minimal Fastify app with auth routes wired. */
async function buildApp(db: Knex, redis: Redis) {
  const app = Fastify({ logger: false });
  await app.register(fjwt, { secret: 'test_secret' });
  registerAuthRoutes(app, db, redis);
  await app.ready();
  return app;
}

/** Create a mock Knex that returns a specific user row on users.first(). */
function makeMockDb(user: Record<string, unknown> | null = null, workspaces: string[] = []) {
  const mockQuery = {
    join: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(user),
    pluck: vi.fn().mockResolvedValue(workspaces),
    update: vi.fn().mockReturnThis(),
    catch: vi.fn().mockReturnThis(),
  };
  return vi.fn(() => mockQuery) as unknown as Knex;
}

function makeMockRedis(stored: string | null = null) {
  return {
    get: vi.fn().mockResolvedValue(stored),
    setex: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
  } as unknown as Redis;
}

// ── POST /api/v1/auth/login ───────────────────────────────────────────────────

describe('POST /api/v1/auth/login', () => {
  it('returns 401 for missing user (email not found)', async () => {
    const app = await buildApp(makeMockDb(null), makeMockRedis());
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'ghost@example.com', password: 'any' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('INVALID_CREDENTIALS');
    await app.close();
  });

  it('returns 400 for invalid email format', async () => {
    const app = await buildApp(makeMockDb(null), makeMockRedis());
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'not-an-email', password: 'pass' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns 403 for canceled account', async () => {
    // Build a real argon2id hash for the test password
    const { hashPassword } = await import('../auth/routes');
    const hash = await hashPassword('correct-pass');

    const user = {
      id: USER_ID, tenant_id: TENANT_ID, email: 'a@b.com',
      name: 'Test', role: 'agent', password_hash: hash,
      plan_tier: 'starter', billing_status: 'canceled',
    };
    const app = await buildApp(makeMockDb(user, []), makeMockRedis());
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'a@b.com', password: 'correct-pass' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('ACCOUNT_CANCELED');
    await app.close();
  });

  it('returns 200 + JWT for valid credentials', async () => {
    const { hashPassword } = await import('../auth/routes');
    const hash = await hashPassword('my-secret');

    const user = {
      id: USER_ID, tenant_id: TENANT_ID, email: 'a@b.com',
      name: 'Test', role: 'agent', password_hash: hash,
      plan_tier: 'growth', billing_status: 'active',
    };
    const app = await buildApp(makeMockDb(user, [TENANT_ID]), makeMockRedis());
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'a@b.com', password: 'my-secret' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    await app.close();
  });
});

// ── POST /api/v1/auth/refresh ─────────────────────────────────────────────────

describe('POST /api/v1/auth/refresh', () => {
  it('returns 401 when refresh token not in Redis', async () => {
    const app = await buildApp(makeMockDb(), makeMockRedis(null));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refresh_token: 'does-not-exist' },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('returns 401 when Redis value is corrupted JSON', async () => {
    const app = await buildApp(makeMockDb(), makeMockRedis('NOT_JSON'));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refresh_token: 'corrupted' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('INVALID_REFRESH_TOKEN');
    await app.close();
  });

  it('returns 401 when user no longer active', async () => {
    const stored = JSON.stringify({ user_id: USER_ID, tenant_id: TENANT_ID });
    const app = await buildApp(makeMockDb(null), makeMockRedis(stored));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refresh_token: 'valid-token' },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

// ── POST /api/v1/auth/logout ──────────────────────────────────────────────────

describe('POST /api/v1/auth/logout', () => {
  it('returns 200 and deletes refresh token from Redis', async () => {
    const redis = makeMockRedis();
    const app = await buildApp(makeMockDb(), redis);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      payload: { refresh_token: 'some-token' },
    });
    expect(res.statusCode).toBe(200);
    expect(redis.del).toHaveBeenCalledWith('auth:refresh:some-token');
    await app.close();
  });

  it('returns 200 even without a refresh_token body', async () => {
    const app = await buildApp(makeMockDb(), makeMockRedis());
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
