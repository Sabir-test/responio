import Fastify from 'fastify';
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
  },
});

const PORT = Number(process.env.PORT ?? 3002);
const NATS_URL = process.env.NATS_URL ?? 'nats://localhost:4222';
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://responio:dev_password_change_in_prod@localhost:5432/responio_development';
const N8N_BASE_URL = process.env.N8N_BASE_URL ?? 'http://localhost:5678';
const N8N_API_KEY = process.env.N8N_API_KEY ?? '';
const N8N_WEBHOOK_SECRET = process.env.N8N_WEBHOOK_SECRET ?? 'dev_webhook_secret';

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

  startNatsBridge(nc, { n8nBaseUrl: N8N_BASE_URL, webhookSecret: N8N_WEBHOOK_SECRET });

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

  registerActionRoutes(fastify, publisher);
  registerWorkflowRoutes(fastify, db, n8n);

  await fastify.listen({ port: PORT, host: '0.0.0.0' });
  fastify.log.info(`Workflow service listening on :${PORT} (engine: n8n headless @ ${N8N_BASE_URL})`);
}

process.on('SIGTERM', async () => { await fastify.close(); process.exit(0); });
start().catch((err) => { console.error('Fatal:', err); process.exit(1); });
