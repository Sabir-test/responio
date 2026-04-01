import Fastify from 'fastify';
import fjwt from '@fastify/jwt';
import fcors from '@fastify/cors';
import knex from 'knex';
import Redis from 'ioredis';
import { createNatsConnection, initializeStreams, EventPublisher } from '@responio/events';
import { registerCheckoutRoutes } from './routes/checkout';
import { registerWebhookRoutes } from './routes/webhooks';
import { registerUsageRoutes } from './routes/usage';
import { startMacListener } from './nats/mac-listener';
import { reconcileMacCounters } from './services/mac-metering';

const fastify = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    transport: process.env.NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined,
    redact: ['req.headers.authorization', 'body.card_number', 'body.cvv'],
  },
});

const PORT = Number(process.env.PORT ?? 3001);
const NATS_URL = process.env.NATS_URL ?? 'nats://localhost:4222';
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://responio:dev_password_change_in_prod@localhost:5432/responio_development';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const JWT_SECRET = process.env.JWT_SECRET ?? 'dev_jwt_secret_change_in_prod';
// Reconcile MAC counters to DB every hour
const MAC_RECONCILE_INTERVAL_MS = Number(process.env.MAC_RECONCILE_INTERVAL_MS ?? 60 * 60 * 1000);

async function start(): Promise<void> {
  // ── Infrastructure connections ─────────────────────────────────────────────
  const nc = await createNatsConnection(NATS_URL);
  await initializeStreams(nc);
  const publisher = new EventPublisher(nc);

  const db = knex({
    client: 'pg',
    connection: DATABASE_URL,
    pool: { min: 2, max: 10 },
  });

  const redis = new Redis(REDIS_URL, { lazyConnect: false });
  redis.on('error', (err) => fastify.log.error({ err }, 'Redis error'));

  // ── Fastify plugins ────────────────────────────────────────────────────────
  await fastify.register(fcors, {
    origin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
    credentials: true,
  });

  await fastify.register(fjwt, { secret: JWT_SECRET });

  // JWT auth for all /api/v1 routes (not webhooks — those use Stripe signatures)
  fastify.addHook('preHandler', async (request, reply) => {
    if (request.url.startsWith('/webhooks/') || request.url === '/health' || request.url === '/metrics') return;

    try {
      await request.jwtVerify();
      const payload = request.user as { tenant_id: string };
      (request as unknown as { tenantId: string }).tenantId = payload.tenant_id;
    } catch {
      return reply.status(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid or missing token' } });
    }
  });

  // ── Routes ─────────────────────────────────────────────────────────────────
  fastify.get('/health', async () => ({
    status: 'ok',
    service: 'billing',
    redis: redis.status === 'ready' ? 'connected' : 'disconnected',
  }));

  fastify.get('/metrics', async (_, reply) => {
    reply.type('text/plain');
    return '# responio-billing metrics\n';
  });

  registerCheckoutRoutes(fastify, db);
  registerWebhookRoutes(fastify, db, publisher);
  registerUsageRoutes(fastify, db, redis);

  // ── NATS MAC metering listener ─────────────────────────────────────────────
  startMacListener(nc, db, redis);

  // ── Hourly MAC reconciliation cron ────────────────────────────────────────
  setInterval(async () => {
    try {
      await reconcileMacCounters(redis, db);
      fastify.log.info('MAC counters reconciled to DB');
    } catch (err) {
      fastify.log.error({ err }, 'MAC reconciliation failed');
    }
  }, MAC_RECONCILE_INTERVAL_MS);

  await fastify.listen({ port: PORT, host: '0.0.0.0' });
  fastify.log.info(`Billing service listening on :${PORT}`);
}

process.on('SIGTERM', async () => { await fastify.close(); process.exit(0); });
start().catch((err) => { console.error('Fatal error starting billing service:', err); process.exit(1); });
