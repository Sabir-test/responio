/**
 * JWT authentication plugin.
 *
 * Verifies Bearer tokens on all /api/v1/* routes.
 * Extracts tenant_id from the JWT payload and attaches it to the request.
 * Webhook routes (/webhooks/*) bypass JWT — they use provider signatures.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

const BYPASS_PREFIXES = ['/health', '/metrics', '/webhooks/'];

export function registerAuthPlugin(app: FastifyInstance): void {
  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    // Skip auth for health checks and webhook endpoints
    if (BYPASS_PREFIXES.some((prefix) => request.url.startsWith(prefix))) return;

    const authHeader = request.headers['authorization'];
    if (!authHeader?.startsWith('Bearer ')) {
      return reply.status(401).send({ error: { code: 'UNAUTHORIZED', message: 'Missing or invalid Authorization header' } });
    }

    try {
      await (request as unknown as { jwtVerify: () => Promise<void> }).jwtVerify();
      const payload = (request as unknown as { user: { tenant_id: string; workspace_ids: string[]; role: string; sub: string } }).user;
      const req = request as unknown as { tenantId: string; userId: string; userRole: string; workspaceIds: string[] };
      req.tenantId = payload.tenant_id;
      req.userId = payload.sub;
      req.userRole = payload.role;
      req.workspaceIds = payload.workspace_ids;
    } catch {
      return reply.status(401).send({ error: { code: 'INVALID_TOKEN', message: 'Token is invalid or expired' } });
    }
  });
}
