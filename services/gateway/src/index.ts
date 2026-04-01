/**
 * API Gateway
 *
 * Single entry point for all external traffic.
 * Responsibilities:
 *   - JWT verification and tenant context extraction
 *   - Reverse proxy to downstream microservices
 *   - Inbound webhook handling (WhatsApp, future channels)
 *   - Rate limiting (TODO: add @fastify/rate-limit in Phase 2)
 */

import Fastify from 'fastify';
import fjwt from '@fastify/jwt';
import fcors from '@fastify/cors';
import knex from 'knex';
import { createNatsConnection, initializeStreams, EventPublisher } from '@responio/events';
import { registerAuthPlugin } from './plugins/auth';
import { registerProxyRoutes } from './plugins/proxy';
import { registerWhatsAppWebhook } from './webhooks/whatsapp';

const fastify = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    transport: process.env.NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined,
    redact: ['req.headers.authorization', 'req.headers["x-hub-signature-256"]'],
  },
});

const PORT = Number(process.env.PORT ?? 3000);
const NATS_URL = process.env.NATS_URL ?? 'nats://localhost:4222';
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://responio:dev_password_change_in_prod@localhost:5432/responio_development';
const JWT_SECRET = process.env.JWT_SECRET ?? 'dev_jwt_secret_change_in_prod';

async function start(): Promise<void> {
  // ── Infrastructure connections ─────────────────────────────────────────────
  const nc = await createNatsConnection(NATS_URL);
  await initializeStreams(nc);
  const publisher = new EventPublisher(nc);

  const db = knex({
    client: 'pg',
    connection: DATABASE_URL,
    pool: { min: 2, max: 5 },
  });

  // ── Fastify plugins ────────────────────────────────────────────────────────
  await fastify.register(fcors, {
    origin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  });

  await fastify.register(fjwt, { secret: JWT_SECRET });

  // ── Auth middleware ────────────────────────────────────────────────────────
  registerAuthPlugin(fastify);

  // ── Health & metrics ───────────────────────────────────────────────────────
  fastify.get('/health', async () => ({ status: 'ok', service: 'gateway' }));
  fastify.get('/metrics', async (_, reply) => {
    reply.type('text/plain');
    return '# responio-gateway metrics\n';
  });

  // ── Inbound webhooks (before proxy to avoid double-parsing) ───────────────
  registerWhatsAppWebhook(fastify, db, publisher);

  // ── Reverse proxy to downstream services ──────────────────────────────────
  registerProxyRoutes(fastify);

  await fastify.listen({ port: PORT, host: '0.0.0.0' });
  fastify.log.info(`API Gateway listening on :${PORT}`);
}

process.on('SIGTERM', async () => { await fastify.close(); process.exit(0); });
start().catch((err) => { console.error('Fatal:', err); process.exit(1); });
