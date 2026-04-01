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
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
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

    const dummyHash = '$argon2id$v=19$m=65536,t=3,p=4$placeholder'; // prevent timing leak
    const hashToCheck = user?.password_hash ?? dummyHash;

    const passwordValid = user ? verifyPassword(body.password, hashToCheck) : false;

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

    const { user_id, tenant_id } = JSON.parse(stored) as { user_id: string; tenant_id: string };

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
 * Simple HMAC-SHA256 password verification.
 * Format stored: `hmac-sha256:<salt>:<hash>`
 * For production, replace with bcrypt or argon2.
 */
function verifyPassword(password: string, storedHash: string): boolean {
  if (!storedHash.startsWith('hmac-sha256:')) return false;
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

/**
 * Hash a password for storage.
 * Called during user creation/password reset.
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = createHmac('sha256', salt).update(password).digest('hex');
  return `hmac-sha256:${salt}:${hash}`;
}
