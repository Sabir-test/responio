import Fastify from 'fastify';
import fjwt from '@fastify/jwt';
import knex from 'knex';
import { createNatsConnection, initializeStreams, EventPublisher } from '@responio/events';
import { N8nClient } from './n8n/client';
import { startNatsBridge } from './bridge/nats-bridge';
import { registerActionRoutes } from './actions/handlers';
import { registerWorkflowRoutes } from './routes/workflows';

const fastify = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    transport: process.env.NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined,
    redact: ['req.headers.authorization', 'req.headers["x-internal-api-key"]'],
  },
});

const PORT = Number(process.env.PORT ?? 3002);
const NATS_URL = process.env.NATS_URL ?? 'nats://localhost:4222';
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://responio:dev_password_change_in_prod@localhost:5432/responio_development';
const N8N_BASE_URL = process.env.N8N_BASE_URL ?? 'http://localhost:5678';
const N8N_API_KEY = process.env.N8N_API_KEY ?? '';
const N8N_WEBHOOK_SECRET = process.env.N8N_WEBHOOK_SECRET ?? 'dev_webhook_secret';
const JWT_SECRET = process.env.JWT_SECRET ?? 'dev_jwt_secret_change_in_prod';
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY ?? '';

async function start(): Promise<void> {
  const nc = await createNatsConnection(NATS_URL);
  await initializeStreams(nc);
  const publisher = new EventPublisher(nc);

  const db = knex({
    client: 'pg',
    connection: DATABASE_URL,
    pool: { min: 2, max: 10 },
  });

  const n8n = new N8nClient(N8N_BASE_URL, N8N_API_KEY);

  await fastify.register(fjwt, { secret: JWT_SECRET });

  startNatsBridge(nc, { n8nBaseUrl: N8N_BASE_URL, webhookSecret: N8N_WEBHOOK_SECRET });

  // ── JWT auth for /api/v1/workflows routes (tenant-facing) ─────────────────
  // Action routes (/api/v1/actions/*) use X-Internal-API-Key validated inside registerActionRoutes.
  fastify.addHook('preHandler', async (request, reply) => {
    if (
      request.url === '/health' ||
      request.url === '/metrics' ||
      request.url.startsWith('/api/v1/actions/')
    ) return;

    // Trust X-Tenant-ID forwarded by gateway (gateway already verified JWT)
    const gatewayTenantId = request.headers['x-tenant-id'] as string | undefined;
    if (gatewayTenantId) {
      (request as unknown as { tenantId: string }).tenantId = gatewayTenantId;
      return;
    }

    // Direct calls (dev/testing): verify JWT
    if (request.headers['authorization']) {
      try {
        await request.jwtVerify();
        const payload = request.user as { tenant_id: string };
        (request as unknown as { tenantId: string }).tenantId = payload.tenant_id;
        return;
      } catch {
        return reply.status(401).send({ error: { code: 'INVALID_TOKEN', message: 'Token is invalid or expired' } });
      }
    }

    // Reject if neither gateway header nor JWT present
    if (request.url.startsWith('/api/v1/workflows')) {
      return reply.status(401).send({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    }
  });

  fastify.get('/health', async () => ({
    status: 'ok',
    service: 'workflow',
    engine: 'n8n-headless',
    n8n_healthy: await n8n.healthCheck(),
  }));

  fastify.get('/metrics', async (_, reply) => {
    reply.type('text/plain');
    return '# responio-workflow metrics\n';
  });

  // Validate INTERNAL_API_KEY is set in production
  if (!INTERNAL_API_KEY && process.env.NODE_ENV === 'production') {
    throw new Error('INTERNAL_API_KEY must be set in production');
  }

  registerActionRoutes(fastify, publisher);
  registerWorkflowRoutes(fastify, db, n8n);

  await fastify.listen({ port: PORT, host: '0.0.0.0' });
  fastify.log.info(`Workflow service listening on :${PORT} (engine: n8n headless @ ${N8N_BASE_URL})`);
}

process.on('SIGTERM', async () => { await fastify.close(); process.exit(0); });
start().catch((err) => { console.error('Fatal:', err); process.exit(1); });
