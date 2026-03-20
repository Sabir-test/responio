import Fastify from 'fastify';
import { createNatsConnection, initializeStreams } from '@responio/events';

const fastify = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
const PORT = Number(process.env.PORT ?? 3003);
const NATS_URL = process.env.NATS_URL ?? 'nats://localhost:4222';

async function start(): Promise<void> {
  const nc = await createNatsConnection(NATS_URL);
  await initializeStreams(nc);
  fastify.get('/health', async () => ({ status: 'ok', service: 'ai' }));
  await fastify.listen({ port: PORT, host: '0.0.0.0' });
  fastify.log.info(`AI service listening on :${PORT}`);
}

process.on('SIGTERM', async () => { await fastify.close(); process.exit(0); });
start().catch((err) => { console.error(err); process.exit(1); });
