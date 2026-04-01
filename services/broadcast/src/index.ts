import Fastify from 'fastify';
import fjwt from '@fastify/jwt';
import knex from 'knex';
import { createNatsConnection, initializeStreams, EventPublisher } from '@responio/events';
import { registerBroadcastRoutes } from './routes/broadcasts';

const fastify = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    transport: process.env.NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined,
  },
});

const PORT = Number(process.env.PORT ?? 3004);
const NATS_URL = process.env.NATS_URL ?? 'nats://localhost:4222';
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://responio:dev_password_change_in_prod@localhost:5432/responio_development';
const JWT_SECRET = process.env.JWT_SECRET ?? 'dev_jwt_secret_change_in_prod';

async function start(): Promise<void> {
  const nc = await createNatsConnection(NATS_URL);
  await initializeStreams(nc);
  const publisher = new EventPublisher(nc);

  const db = knex({
    client: 'pg',
    connection: DATABASE_URL,
    pool: { min: 2, max: 10 },
  });

  await fastify.register(fjwt, { secret: JWT_SECRET });

  // Trust X-Tenant-ID from gateway; fallback to direct JWT verification
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

  fastify.get('/health', async () => ({ status: 'ok', service: 'broadcast' }));
  fastify.get('/metrics', async (_, reply) => {
    reply.type('text/plain');
    return '# responio-broadcast metrics\n';
  });

  registerBroadcastRoutes(fastify, db, publisher);

  await fastify.listen({ port: PORT, host: '0.0.0.0' });
  fastify.log.info(`Broadcast service listening on :${PORT}`);
}

process.on('SIGTERM', async () => { await fastify.close(); process.exit(0); });
start().catch((err) => { console.error('Fatal:', err); process.exit(1); });
