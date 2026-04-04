/**
 * Integration tests for workflow CRUD routes.
 * Tests DSL schema validation, feature gates, publish lifecycle.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import fjwt from '@fastify/jwt';
import type { Knex } from 'knex';
import { registerWorkflowRoutes } from '../routes/workflows';
import type { N8nClient } from '../n8n/client';

const TENANT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const WF_ID     = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const JWT_SECRET = 'test-secret';

// ── Valid minimal DSL graph ───────────────────────────────────────────────────
const validGraph = {
  nodes: [
    { id: 'n1', type: 'trigger', position: { x: 0, y: 0 }, data: { trigger_type: 'conversation_created' } },
    { id: 'n2', type: 'action', position: { x: 100, y: 0 }, data: { action_type: 'send_message', params: { content: 'hi' } } },
  ],
  edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
};

// ── Mocks ─────────────────────────────────────────────────────────────────────

function makeDb(workflow: Record<string, unknown> | null = null, planTier = 'growth') {
  const wfRow = workflow ?? {
    id: WF_ID, tenant_id: TENANT_ID, name: 'Test WF',
    trigger_type: 'conversation_created', graph_json: JSON.stringify(validGraph),
    version: 1, status: 'draft', n8n_workflow_id: null,
  };

  const chain = {
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    select: vi.fn().mockResolvedValue([wfRow]),
    first: vi.fn().mockResolvedValue(wfRow),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    delete: vi.fn().mockResolvedValue(1),
    returning: vi.fn().mockResolvedValue([wfRow]),
  };

  return vi.fn((table: string) => {
    if (table === 'accounts') {
      return {
        where: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        first: vi.fn().mockResolvedValue({ plan_tier: planTier }),
      };
    }
    return chain;
  }) as unknown as Knex;
}

function makeN8n() {
  return {
    createWorkflow: vi.fn().mockResolvedValue({ id: 'n8n-wf-1' }),
    activateWorkflow: vi.fn().mockResolvedValue({}),
    deactivateWorkflow: vi.fn().mockResolvedValue({}),
    deleteWorkflow: vi.fn().mockResolvedValue({}),
    listExecutions: vi.fn().mockResolvedValue([]),
    healthCheck: vi.fn().mockResolvedValue(true),
  } as unknown as N8nClient;
}

async function buildApp(db: Knex, n8n: N8nClient) {
  process.env.INTERNAL_API_KEY = 'test-key';
  const app = Fastify({ logger: false });
  await app.register(fjwt, { secret: JWT_SECRET });

  // JWT auth for routes
  app.addHook('preHandler', async (request) => {
    (request as unknown as { tenantId: string }).tenantId = TENANT_ID;
  });

  registerWorkflowRoutes(app, db, n8n);
  await app.ready();
  return app;
}

// ── GET /api/v1/workflows ─────────────────────────────────────────────────────

describe('GET /api/v1/workflows', () => {
  it('returns list of workflows for tenant', async () => {
    const app = await buildApp(makeDb(), makeN8n());
    const res = await app.inject({ method: 'GET', url: '/api/v1/workflows' });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().data)).toBe(true);
    await app.close();
  });
});

// ── POST /api/v1/workflows ────────────────────────────────────────────────────

describe('POST /api/v1/workflows', () => {
  it('returns 403 for starter plan (feature gate)', async () => {
    const app = await buildApp(makeDb(null, 'starter'), makeN8n());
    const res = await app.inject({
      method: 'POST', url: '/api/v1/workflows',
      payload: { name: 'My WF', trigger_type: 'conversation_created', graph_json: validGraph },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FEATURE_NOT_AVAILABLE');
    await app.close();
  });

  it('returns 400 for graph with no trigger node', async () => {
    const invalidGraph = {
      nodes: [
        { id: 'n1', type: 'action', position: { x: 0, y: 0 }, data: { action_type: 'send_message', params: {} } },
      ],
      edges: [],
    };
    const app = await buildApp(makeDb(), makeN8n());
    const res = await app.inject({
      method: 'POST', url: '/api/v1/workflows',
      payload: { name: 'Bad WF', trigger_type: 'conversation_created', graph_json: invalidGraph },
    });
    expect(res.statusCode).toBe(400); // Zod validation
    await app.close();
  });

  it('returns 201 for valid DSL on growth plan', async () => {
    const app = await buildApp(makeDb(), makeN8n());
    const res = await app.inject({
      method: 'POST', url: '/api/v1/workflows',
      payload: { name: 'Valid WF', trigger_type: 'conversation_created', graph_json: validGraph },
    });
    expect(res.statusCode).toBe(201);
    await app.close();
  });
});

// ── POST /api/v1/workflows/:id/publish ────────────────────────────────────────

describe('POST /api/v1/workflows/:id/publish', () => {
  it('returns 404 when workflow not found', async () => {
    const db = makeDb();
    (db('workflows') as ReturnType<typeof vi.fn>);
    const noWfDb = vi.fn((table: string) => {
      if (table === 'accounts') return { where: vi.fn().mockReturnThis(), select: vi.fn().mockReturnThis(), first: vi.fn().mockResolvedValue({ plan_tier: 'growth' }) };
      return { where: vi.fn().mockReturnThis(), first: vi.fn().mockResolvedValue(null), update: vi.fn().mockReturnThis(), returning: vi.fn().mockResolvedValue([]) };
    }) as unknown as Knex;

    const app = await buildApp(noWfDb, makeN8n());
    const res = await app.inject({ method: 'POST', url: `/api/v1/workflows/${WF_ID}/publish` });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('calls n8n createWorkflow + activateWorkflow on publish', async () => {
    const n8n = makeN8n();
    const app = await buildApp(makeDb(), n8n);
    const res = await app.inject({ method: 'POST', url: `/api/v1/workflows/${WF_ID}/publish` });
    expect(res.statusCode).toBe(200);
    expect(n8n.createWorkflow).toHaveBeenCalledOnce();
    expect(n8n.activateWorkflow).toHaveBeenCalledWith('n8n-wf-1');
    await app.close();
  });

  it('returns 422 when graph_json is corrupted in DB', async () => {
    const corruptDb = vi.fn((table: string) => {
      if (table === 'accounts') return { where: vi.fn().mockReturnThis(), select: vi.fn().mockReturnThis(), first: vi.fn().mockResolvedValue({ plan_tier: 'growth' }) };
      return {
        where: vi.fn().mockReturnThis(),
        first: vi.fn().mockResolvedValue({ id: WF_ID, tenant_id: TENANT_ID, graph_json: 'NOT_JSON', version: 1, n8n_workflow_id: null }),
        update: vi.fn().mockReturnThis(),
      };
    }) as unknown as Knex;

    const app = await buildApp(corruptDb, makeN8n());
    const res = await app.inject({ method: 'POST', url: `/api/v1/workflows/${WF_ID}/publish` });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('INVALID_GRAPH_JSON');
    await app.close();
  });
});

// ── POST /api/v1/workflows/:id/publish — connectivity validation ───────────────

describe('publish — graph connectivity validation', () => {
  it('returns 422 when edge references non-existent node', async () => {
    const badGraph = {
      nodes: [{ id: 'n1', type: 'trigger', position: { x: 0, y: 0 }, data: { trigger_type: 'conversation_created' } }],
      edges: [{ id: 'e1', source: 'n1', target: 'MISSING_NODE' }],
    };
    const badDb = vi.fn((table: string) => {
      if (table === 'accounts') return { where: vi.fn().mockReturnThis(), select: vi.fn().mockReturnThis(), first: vi.fn().mockResolvedValue({ plan_tier: 'growth' }) };
      return {
        where: vi.fn().mockReturnThis(),
        first: vi.fn().mockResolvedValue({ id: WF_ID, tenant_id: TENANT_ID, graph_json: JSON.stringify(badGraph), version: 1, n8n_workflow_id: null }),
        update: vi.fn().mockReturnThis(),
      };
    }) as unknown as Knex;

    const app = await buildApp(badDb, makeN8n());
    const res = await app.inject({ method: 'POST', url: `/api/v1/workflows/${WF_ID}/publish` });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('INVALID_GRAPH_SCHEMA');
    await app.close();
  });
});
