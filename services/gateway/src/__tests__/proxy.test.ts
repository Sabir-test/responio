/**
 * Unit tests for the reverse proxy route registration.
 * Verifies that all expected route prefixes are registered,
 * that tenant context headers are forwarded, and that upstream
 * errors produce 502 responses.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

// ── Capture proxy middleware calls ────────────────────────────────────────────

interface ProxyCall {
  target: string;
  pathRewrite?: Record<string, string>;
}

const proxyCalls: ProxyCall[] = [];
let proxyErrorHandler: ((err: Error, req: unknown, res: unknown) => void) | null = null;
let proxyReqHandler: ((proxyReq: { setHeader: ReturnType<typeof vi.fn> }, req: unknown) => void) | null = null;

vi.mock('http-proxy-middleware', () => ({
  createProxyMiddleware: vi.fn().mockImplementation((opts: {
    target: string;
    pathRewrite?: Record<string, string>;
    on?: {
      error?: (err: Error, req: unknown, res: unknown) => void;
      proxyReq?: (proxyReq: unknown, req: unknown) => void;
    };
  }) => {
    proxyCalls.push({ target: opts.target, pathRewrite: opts.pathRewrite });
    proxyErrorHandler = opts.on?.error ?? null;
    proxyReqHandler = opts.on?.proxyReq ?? null;
    // Return a middleware function that does nothing (proxy itself is not tested here)
    return vi.fn();
  }),
}));

async function buildApp() {
  proxyCalls.length = 0;
  proxyErrorHandler = null;
  proxyReqHandler = null;

  const app = Fastify({ logger: false });
  const { registerProxyRoutes } = await import('../plugins/proxy');
  registerProxyRoutes(app);
  await app.ready();
  return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('registerProxyRoutes', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.mock('http-proxy-middleware', () => ({
      createProxyMiddleware: vi.fn().mockImplementation((opts: {
        target: string;
        pathRewrite?: Record<string, string>;
        on?: {
          error?: (err: Error, req: unknown, res: unknown) => void;
          proxyReq?: (proxyReq: unknown, req: unknown) => void;
        };
      }) => {
        proxyCalls.push({ target: opts.target, pathRewrite: opts.pathRewrite });
        proxyErrorHandler = opts.on?.error ?? null;
        proxyReqHandler = opts.on?.proxyReq ?? null;
        return vi.fn();
      }),
    }));
  });

  it('creates a proxy for each of the 7 route configs', async () => {
    await buildApp();
    // 7 routes: billing, workflows, ai, broadcast, analytics, actions (→workflow), inbox
    const { createProxyMiddleware } = await import('http-proxy-middleware');
    expect((createProxyMiddleware as ReturnType<typeof vi.fn>).mock.calls.length).toBe(7);
  });

  it('routes /api/v1/billing to the billing service', async () => {
    await buildApp();
    const billingProxy = proxyCalls.find((p) => p.target.includes('billing') || p.target.includes('3001'));
    expect(billingProxy).toBeDefined();
  });

  it('routes /api/v1/workflows to the workflow service', async () => {
    await buildApp();
    const workflowProxy = proxyCalls.find((p) => p.target.includes('workflow') || p.target.includes('3002'));
    expect(workflowProxy).toBeDefined();
  });

  it('routes /api/v1/ai to the AI service', async () => {
    await buildApp();
    const aiProxy = proxyCalls.find((p) => p.target.includes(':3003') || p.target.includes('ai:'));
    expect(aiProxy).toBeDefined();
  });

  it('uses path rewrite for /api/v1/inbox (Chatwoot passthrough)', async () => {
    await buildApp();
    const inboxProxy = proxyCalls.find((p) => p.target.includes('inbox') || p.target.includes('3000'));
    expect(inboxProxy?.pathRewrite).toBeDefined();
  });

  it('respects BILLING_SERVICE_URL env override', async () => {
    process.env.BILLING_SERVICE_URL = 'http://custom-billing:9001';
    vi.resetModules();
    vi.mock('http-proxy-middleware', () => ({
      createProxyMiddleware: vi.fn().mockImplementation((opts: { target: string }) => {
        proxyCalls.push({ target: opts.target });
        return vi.fn();
      }),
    }));
    await buildApp();
    const billing = proxyCalls.find((p) => p.target.includes('custom-billing'));
    expect(billing).toBeDefined();
    delete process.env.BILLING_SERVICE_URL;
  });

  describe('proxyReq header forwarding', () => {
    it('forwards X-Tenant-ID, X-User-ID and X-User-Role from request context', async () => {
      await buildApp();
      expect(proxyReqHandler).not.toBeNull();

      const setHeader = vi.fn();
      const proxyReqMock = { setHeader };
      const reqMock = { tenantId: 'tenant-abc', userId: 'user-123', userRole: 'admin' };

      proxyReqHandler!(proxyReqMock as never, reqMock);

      expect(setHeader).toHaveBeenCalledWith('X-Tenant-ID', 'tenant-abc');
      expect(setHeader).toHaveBeenCalledWith('X-User-ID', 'user-123');
      expect(setHeader).toHaveBeenCalledWith('X-User-Role', 'admin');
    });

    it('does NOT set headers when context is empty', async () => {
      await buildApp();
      const setHeader = vi.fn();
      const proxyReqMock = { setHeader };
      const reqMock = {};

      proxyReqHandler!(proxyReqMock as never, reqMock);
      expect(setHeader).not.toHaveBeenCalled();
    });
  });

  describe('proxy error handler', () => {
    it('writes 502 JSON response when upstream fails and headers not sent', async () => {
      await buildApp();
      expect(proxyErrorHandler).not.toBeNull();

      const writeHead = vi.fn();
      const end = vi.fn();
      const resMock = { headersSent: false, writeHead, end };

      proxyErrorHandler!(new Error('ECONNREFUSED'), {}, resMock);

      expect(writeHead).toHaveBeenCalledWith(502, { 'Content-Type': 'application/json' });
      const body = JSON.parse(end.mock.calls[0][0]);
      expect(body.error.code).toBe('UPSTREAM_ERROR');
    });

    it('does NOT write headers when headersSent is true', async () => {
      await buildApp();
      const writeHead = vi.fn();
      const end = vi.fn();
      const resMock = { headersSent: true, writeHead, end };

      proxyErrorHandler!(new Error('timeout'), {}, resMock);
      expect(writeHead).not.toHaveBeenCalled();
      expect(end).not.toHaveBeenCalled();
    });
  });
});
