/**
 * Internal authentication routes.
 *
 * POST /api/v1/auth/login   — email + password → JWT
 * POST /api/v1/auth/refresh — refresh token → new JWT
 * POST /api/v1/auth/logout  — invalidate refresh token
 *
 * NOTE: This is the internal auth handler used until Authentik SSO is deployed.
 * Passwords are hashed with bcrypt (work factor 12).
 * Refresh tokens are stored in Redis with a 30-day TTL.
 */

import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';
import type { Redis } from 'ioredis';
import { randomBytes, timingSafeEqual, createHmac } from 'crypto';
import { verify as argon2Verify, hash as argon2Hash, Algorithm } from '@node-rs/argon2';
import { z } from 'zod';

const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN ?? '7d';
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

export function registerAuthRoutes(
  app: FastifyInstance,
  db: Knex,
  redis: Redis
): void {
  // ── POST /api/v1/auth/login ───────────────────────────────────────────────
  const loginSchema = z.object({
    email: z.string().email(),
    password: z.string().min(1),
  });

  app.post('/api/v1/auth/login', async (request, reply) => {
    const body = loginSchema.parse(request.body);

    // Look up user — do NOT reveal whether email exists (timing-safe path)
    const user = await db('users')
      .join('accounts', 'users.tenant_id', 'accounts.id')
      .where({ 'users.email': body.email, 'users.status': 'active' })
      .select(
        'users.id',
        'users.tenant_id',
        'users.email',
        'users.name',
        'users.role',
        'users.password_hash',
        'accounts.plan_tier',
        'accounts.billing_status'
      )
      .first();

    const dummyHash = '$argon2id$v=19$m=65536,t=3,p=4$dGVzdHNhbHQ$placeholder00000000000000000000000000000'; // prevent timing leak
    const hashToCheck = user?.password_hash ?? dummyHash;

    const passwordValid = await verifyPassword(body.password, hashToCheck);

    if (!user || !passwordValid) {
      return reply.status(401).send({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' } });
    }

    if (user.billing_status === 'canceled') {
      return reply.status(403).send({ error: { code: 'ACCOUNT_CANCELED', message: 'Account has been canceled' } });
    }

    // Fetch workspace IDs the user can access
    const workspaces = await db('workspaces')
      .where({ tenant_id: user.tenant_id })
      .pluck('id') as string[];

    const token = app.jwt.sign(
      {
        sub: user.id,
        tenant_id: user.tenant_id,
        email: user.email,
        role: user.role,
        workspace_ids: workspaces,
      },
      { expiresIn: JWT_EXPIRES_IN }
    );

    // Issue a refresh token stored in Redis
    const refreshToken = randomBytes(48).toString('hex');
    await redis.setex(
      `auth:refresh:${refreshToken}`,
      REFRESH_TOKEN_TTL_SECONDS,
      JSON.stringify({ user_id: user.id, tenant_id: user.tenant_id })
    );

    // Update last active timestamp (best-effort, don't fail login on error)
    db('users').where({ id: user.id }).update({ last_active_at: new Date() }).catch(() => {});

    return reply.send({
      token,
      refresh_token: refreshToken,
      expires_in: JWT_EXPIRES_IN,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        tenant_id: user.tenant_id,
        workspace_ids: workspaces,
      },
    });
  });

  // ── POST /api/v1/auth/refresh ─────────────────────────────────────────────
  const refreshSchema = z.object({ refresh_token: z.string().min(1) });

  app.post('/api/v1/auth/refresh', async (request, reply) => {
    const body = refreshSchema.parse(request.body);
    const stored = await redis.get(`auth:refresh:${body.refresh_token}`);

    if (!stored) {
      return reply.status(401).send({ error: { code: 'INVALID_REFRESH_TOKEN', message: 'Refresh token is invalid or expired' } });
    }

    let parsed: { user_id: string; tenant_id: string };
    try {
      parsed = JSON.parse(stored) as { user_id: string; tenant_id: string };
    } catch {
      await redis.del(`auth:refresh:${body.refresh_token}`);
      return reply.status(401).send({ error: { code: 'INVALID_REFRESH_TOKEN', message: 'Refresh token data is corrupted' } });
    }
    const { user_id, tenant_id } = parsed;

    const user = await db('users').where({ id: user_id, status: 'active' }).first();
    if (!user) {
      return reply.status(401).send({ error: { code: 'USER_NOT_FOUND', message: 'User no longer exists' } });
    }

    const workspaces = await db('workspaces').where({ tenant_id }).pluck('id') as string[];

    const token = app.jwt.sign(
      {
        sub: user.id,
        tenant_id,
        email: user.email,
        role: user.role,
        workspace_ids: workspaces,
      },
      { expiresIn: JWT_EXPIRES_IN }
    );

    // Rotate refresh token
    await redis.del(`auth:refresh:${body.refresh_token}`);
    const newRefreshToken = randomBytes(48).toString('hex');
    await redis.setex(`auth:refresh:${newRefreshToken}`, REFRESH_TOKEN_TTL_SECONDS, stored);

    return reply.send({ token, refresh_token: newRefreshToken, expires_in: JWT_EXPIRES_IN });
  });

  // ── POST /api/v1/auth/logout ──────────────────────────────────────────────
  const logoutSchema = z.object({ refresh_token: z.string().optional() });

  app.post('/api/v1/auth/logout', async (request, reply) => {
    const body = logoutSchema.parse(request.body);
    if (body.refresh_token) {
      await redis.del(`auth:refresh:${body.refresh_token}`);
    }
    return reply.send({ message: 'Logged out successfully' });
  });
}

/**
 * Verify a password against a stored hash.
 * Supports Argon2id (primary) and legacy HMAC-SHA256 (migration period only).
 */
async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  // Primary path: Argon2id
  if (storedHash.startsWith('$argon2id$')) {
    try {
      return await argon2Verify(storedHash, password);
    } catch {
      return false;
    }
  }
  // Legacy path: HMAC-SHA256 — kept for accounts created before argon2 migration
  if (storedHash.startsWith('hmac-sha256:')) {
    const parts = storedHash.split(':');
    if (parts.length !== 3) return false;
    const [, salt, expectedHex] = parts;
    const actualHex = createHmac('sha256', salt).update(password).digest('hex');
    try {
      return timingSafeEqual(Buffer.from(actualHex, 'hex'), Buffer.from(expectedHex, 'hex'));
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Hash a password for storage using Argon2id.
 * Called during user creation and password reset.
 */
export async function hashPassword(password: string): Promise<string> {
  return argon2Hash(password, {
    algorithm: Algorithm.Argon2id,
    memoryCost: 65536,  // 64 MiB
    timeCost: 3,
    parallelism: 4,
  });
}
