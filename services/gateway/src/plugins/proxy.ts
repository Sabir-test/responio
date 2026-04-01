/**
 * Reverse proxy routing configuration.
 *
 * Routes incoming requests to the appropriate downstream service.
 * All services are addressed by their internal Docker hostnames.
 *
 * Route map:
 *   /api/v1/billing/*   → billing service  :3001
 *   /api/v1/workflows/* → workflow service :3002
 *   /api/v1/ai/*        → ai service       :3003
 *   /api/v1/broadcast/* → broadcast        :3004
 *   /api/v1/analytics/* → analytics        :3005
 *   /api/v1/inbox/*     → inbox (Chatwoot) :3000 (when initialized)
 */

import type { FastifyInstance } from 'fastify';
import { createProxyMiddleware } from 'http-proxy-middleware';

const SERVICE_URLS: Record<string, string> = {
  billing: process.env.BILLING_SERVICE_URL ?? 'http://billing:3001',
  workflow: process.env.WORKFLOW_SERVICE_URL ?? 'http://workflow:3002',
  ai: process.env.AI_SERVICE_URL ?? 'http://ai:3003',
  broadcast: process.env.BROADCAST_SERVICE_URL ?? 'http://broadcast:3004',
  analytics: process.env.ANALYTICS_SERVICE_URL ?? 'http://analytics:3005',
  inbox: process.env.INBOX_SERVICE_URL ?? 'http://inbox:3000',
};

interface RouteConfig {
  prefix: string;
  target: string;
  rewrite?: (path: string) => string;
}

const ROUTES: RouteConfig[] = [
  { prefix: '/api/v1/billing', target: SERVICE_URLS.billing },
  { prefix: '/api/v1/workflows', target: SERVICE_URLS.workflow },
  { prefix: '/api/v1/ai', target: SERVICE_URLS.ai },
  { prefix: '/api/v1/broadcast', target: SERVICE_URLS.broadcast },
  { prefix: '/api/v1/analytics', target: SERVICE_URLS.analytics },
  { prefix: '/api/v1/actions', target: SERVICE_URLS.workflow },
  {
    // Chatwoot REST API passthrough (when fork is initialized)
    prefix: '/api/v1/inbox',
    target: SERVICE_URLS.inbox,
    rewrite: (path) => path.replace(/^\/api\/v1\/inbox/, '/api/v1'),
  },
];

export function registerProxyRoutes(app: FastifyInstance): void {
  for (const route of ROUTES) {
    const proxy = createProxyMiddleware({
      target: route.target,
      changeOrigin: true,
      pathRewrite: route.rewrite ? { [`^${route.prefix}`]: '' } : undefined,
      on: {
        error: (err, req, res) => {
          app.log.error({ err, url: req.url, target: route.target }, 'Proxy error');
          if (!res.headersSent) {
            (res as import('http').ServerResponse).writeHead(502, { 'Content-Type': 'application/json' });
            (res as import('http').ServerResponse).end(JSON.stringify({
              error: { code: 'UPSTREAM_ERROR', message: 'Upstream service unavailable' },
            }));
          }
        },
        proxyReq: (proxyReq, req) => {
          // Forward tenant context headers set by auth middleware
          const r = req as unknown as { tenantId?: string; userId?: string; userRole?: string };
          if (r.tenantId) proxyReq.setHeader('X-Tenant-ID', r.tenantId);
          if (r.userId) proxyReq.setHeader('X-User-ID', r.userId);
          if (r.userRole) proxyReq.setHeader('X-User-Role', r.userRole);
        },
      },
    });

    // Register as a catch-all for this prefix
    app.all(`${route.prefix}`, (request, reply) => {
      proxy(request.raw, reply.raw, (err) => {
        if (err) app.log.error({ err }, 'Proxy middleware error');
      });
    });

    app.all(`${route.prefix}/*`, (request, reply) => {
      proxy(request.raw, reply.raw, (err) => {
        if (err) app.log.error({ err }, 'Proxy middleware error');
      });
    });
  }
}
