import Fastify from 'fastify';
import fjwt from '@fastify/jwt';
import { createNatsConnection, initializeStreams } from '@responio/events';
import { registerMetricsRoutes } from './routes/metrics';
import { startEventWriter } from './nats/event-writer';

const fastify = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    transport: process.env.NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined,
  },
});

const PORT = Number(process.env.PORT ?? 3005);
const NATS_URL = process.env.NATS_URL ?? 'nats://localhost:4222';
const JWT_SECRET = process.env.JWT_SECRET ?? 'dev_jwt_secret_change_in_prod';

async function start(): Promise<void> {
  const nc = await createNatsConnection(NATS_URL);
  await initializeStreams(nc);

  await fastify.register(fjwt, { secret: JWT_SECRET });

  // Trust X-Tenant-ID from gateway; fallback to JWT
  fastify.addHook('preHandler', async (request, reply) => {
    if (request.url === '/health' || request.url === '/metrics') return;

    const gatewayTenantId = request.headers['x-tenant-id'] as string | undefined;
    if (gatewayTenantId) {
      (request as unknown as { tenantId: string }).tenantId = gatewayTenantId;
      return;
    }

    if (request.headers['authorization']) {
      try {
        await request.jwtVerify();
        const payload = request.user as { tenant_id: string };
        (request as unknown as { tenantId: string }).tenantId = payload.tenant_id;
        return;
      } catch {
        return reply.status(401).send({ error: { code: 'INVALID_TOKEN', message: 'Token invalid or expired' } });
      }
    }

    return reply.status(401).send({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
  });

  fastify.get('/health', async () => ({
    status: 'ok',
    service: 'analytics',
    clickhouse: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
  }));

  fastify.get('/metrics', async (_, reply) => {
    reply.type('text/plain');
    return '# responio-analytics metrics\n';
  });

  registerMetricsRoutes(fastify);
  startEventWriter(nc);

  await fastify.listen({ port: PORT, host: '0.0.0.0' });
  fastify.log.info(`Analytics service listening on :${PORT}`);
}

process.on('SIGTERM', async () => { await fastify.close(); process.exit(0); });
start().catch((err) => { console.error('Fatal:', err); process.exit(1); });
