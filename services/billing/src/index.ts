import Fastify from 'fastify';
import { createNatsConnection, initializeStreams } from '@responio/events';

const fastify = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    transport: process.env.NODE_ENV === 'development'
      ? { target: 'pino-pretty' }
      : undefined,
  },
});

const PORT = Number(process.env.PORT ?? 3001);
const NATS_URL = process.env.NATS_URL ?? 'nats://localhost:4222';

async function start(): Promise<void> {
  // Connect to NATS
  const nc = await createNatsConnection(NATS_URL);
  await initializeStreams(nc);

  // Health check
  fastify.get('/health', async () => ({ status: 'ok', service: 'billing' }));

  // Metrics endpoint (Prometheus scraping)
  fastify.get('/metrics', async (_, reply) => {
    reply.type('text/plain');
    // TODO: integrate prom-client
    return '# responio-billing metrics\n';
  });

  // Register routes
  // TODO: import and register billing routes

  await fastify.listen({ port: PORT, host: '0.0.0.0' });
  fastify.log.info(`Billing service listening on :${PORT}`);
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  await fastify.close();
  process.exit(0);
});

start().catch((err) => {
  console.error('Fatal error starting billing service:', err);
  process.exit(1);
});
