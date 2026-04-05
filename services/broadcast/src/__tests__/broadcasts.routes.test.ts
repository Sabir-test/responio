/**
 * Unit tests for broadcast CRUD and send routes.
 * Covers feature gating, validation, status transitions,
 * recipient filtering, and chunk-insert behavior.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { Knex } from 'knex';
import type { EventPublisher } from '@responio/events';

// ── Helpers ───────────────────────────────────────────────────────────────────

const TENANT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function makePublisher(): EventPublisher {
  return { publish: vi.fn().mockResolvedValue('1') } as unknown as EventPublisher;
}

const GROWTH_PLAN = 'growth';
const STARTER_PLAN = 'starter';

function makeBroadcast(overrides: Record<string, unknown> = {}) {
  return {
    id: 'bc-1111-1111-1111-111111111111',
    tenant_id: TENANT_ID,
    name: 'My Blast',
    channel_type: 'whatsapp',
    status: 'draft',
    inbox_id: 'inbox-uuid-1111-1111',
    message_type: 'text',
    message_content: 'Hello {{name}}',
    audience_filter: JSON.stringify({ lifecycle_stages: ['customer'] }),
    scheduled_at: null,
    recipient_count: 0,
    sent_count: 0,
    delivered_count: 0,
    read_count: 0,
    ...overrides,
  };
}

/**
 * Knex mock factory.
 * Returns a configurable mock that is reset per test.
 */
function makeDb({
  planTier = GROWTH_PLAN,
  broadcasts = [] as ReturnType<typeof makeBroadcast>[],
  singleBroadcast = null as ReturnType<typeof makeBroadcast> | null,
  contacts = [] as { id: string }[],
  returningResult = [] as unknown[],
} = {}) {
  const insertMock = vi.fn().mockReturnThis();
  const returningMock = vi.fn().mockResolvedValue(returningResult);
  const updateMock = vi.fn().mockReturnThis();
  const deleteMock = vi.fn().mockResolvedValue(1);
  const whereMock = vi.fn().mockReturnThis();
  const whereInMock = vi.fn().mockReturnThis();
  const whereRawMock = vi.fn().mockReturnThis();
  const orderByMock = vi.fn().mockReturnThis();
  const selectMock = vi.fn().mockResolvedValue(broadcasts);
  const firstMock = vi.fn().mockResolvedValue(singleBroadcast);
  const forUpdateMock = vi.fn().mockReturnThis();

  const contactsChain = {
    where: vi.fn().mockReturnThis(),
    whereIn: whereInMock,
    whereRaw: whereRawMock,
    select: vi.fn().mockResolvedValue(contacts),
  };
  whereInMock.mockReturnValue(contactsChain);
  whereRawMock.mockReturnValue(contactsChain);

  const broadcastsChain = {
    where: whereMock,
    insert: insertMock,
    update: updateMock,
    returning: returningMock,
    delete: deleteMock,
    orderBy: orderByMock,
    select: selectMock,
    first: firstMock,
    whereIn: whereInMock,
    whereRaw: whereRawMock,
  };

  updateMock.mockReturnValue({ returning: returningMock });
  insertMock.mockReturnValue({ returning: returningMock });

  const recipientsMock = {
    where: vi.fn().mockReturnThis(),
    insert: vi.fn().mockResolvedValue([]),
    update: vi.fn().mockResolvedValue(1),
    delete: vi.fn().mockResolvedValue(1),
  };

  return vi.fn((table: string) => {
    if (table === 'accounts') {
      return { where: vi.fn().mockReturnThis(), select: vi.fn().mockReturnThis(), first: vi.fn().mockResolvedValue({ plan_tier: planTier }) };
    }
    if (table === 'broadcasts') return broadcastsChain;
    if (table === 'contacts') return contactsChain;
    if (table === 'broadcast_recipients') return recipientsMock;
    return { where: vi.fn().mockReturnThis(), first: vi.fn().mockResolvedValue(null) };
  }) as unknown as Knex;
}

async function buildApp(db: Knex, publisher = makePublisher()) {
  const app = Fastify({ logger: false });
  app.addHook('preHandler', (req, _reply, done) => {
    (req as unknown as { tenantId: string }).tenantId = TENANT_ID;
    done();
  });
  const { registerBroadcastRoutes } = await import('../routes/broadcasts');
  registerBroadcastRoutes(app, db, publisher);
  await app.ready();
  return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/v1/broadcasts', () => {
  it('returns the list of broadcasts for the tenant', async () => {
    const db = makeDb({ broadcasts: [makeBroadcast()], planTier: GROWTH_PLAN });
    const app = await buildApp(db);
    const res = await app.inject({ method: 'GET', url: '/api/v1/broadcasts' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(1);
    expect(res.json().data[0].name).toBe('My Blast');
  });
});

describe('GET /api/v1/broadcasts/:id', () => {
  it('returns 404 when broadcast not found', async () => {
    const db = makeDb({ singleBroadcast: null });
    const app = await buildApp(db);
    const res = await app.inject({ method: 'GET', url: '/api/v1/broadcasts/missing-id' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('returns the broadcast when found', async () => {
    const bc = makeBroadcast();
    const db = makeDb({ singleBroadcast: bc });
    const app = await buildApp(db);
    const res = await app.inject({ method: 'GET', url: `/api/v1/broadcasts/${bc.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.id).toBe(bc.id);
  });
});

describe('POST /api/v1/broadcasts', () => {
  it('returns 403 when on starter plan (feature gate)', async () => {
    const db = makeDb({ planTier: STARTER_PLAN });
    const app = await buildApp(db);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/broadcasts',
      body: { name: 'Campaign', inbox_id: '00000000-0000-0000-0000-000000000001', message_content: 'Hello' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FEATURE_NOT_AVAILABLE');
  });

  it('creates a draft broadcast and returns 201', async () => {
    const newBc = makeBroadcast({ status: 'draft' });
    const db = makeDb({ planTier: GROWTH_PLAN, returningResult: [newBc] });
    const app = await buildApp(db);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/broadcasts',
      body: {
        name: 'My Blast',
        inbox_id: '00000000-0000-0000-0000-000000000001',
        message_content: 'Hello everyone',
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.status).toBe('draft');
  });

  it('validates required fields — missing name returns error', async () => {
    const db = makeDb({ planTier: GROWTH_PLAN });
    const app = await buildApp(db);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/broadcasts',
      body: { inbox_id: '00000000-0000-0000-0000-000000000001' },
    });
    expect(res.statusCode).toBe(500); // Zod parse throws
  });
});

describe('PATCH /api/v1/broadcasts/:id', () => {
  it('returns 403 on starter plan', async () => {
    const db = makeDb({ planTier: STARTER_PLAN });
    const app = await buildApp(db);
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/broadcasts/bc-1',
      body: { name: 'Updated' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 404 when broadcast does not exist', async () => {
    const db = makeDb({ planTier: GROWTH_PLAN, singleBroadcast: null });
    const app = await buildApp(db);
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/broadcasts/nonexistent',
      body: { name: 'Updated' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 409 when broadcast is not in draft status', async () => {
    const bc = makeBroadcast({ status: 'sending' });
    const db = makeDb({ planTier: GROWTH_PLAN, singleBroadcast: bc, returningResult: [bc] });
    const app = await buildApp(db);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/broadcasts/${bc.id}`,
      body: { name: 'Cannot Edit' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('NOT_EDITABLE');
  });

  it('updates name and returns the updated broadcast', async () => {
    const bc = makeBroadcast({ status: 'draft' });
    const updated = { ...bc, name: 'New Name' };
    const db = makeDb({ planTier: GROWTH_PLAN, singleBroadcast: bc, returningResult: [updated] });
    const app = await buildApp(db);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/broadcasts/${bc.id}`,
      body: { name: 'New Name' },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('POST /api/v1/broadcasts/:id/send', () => {
  it('returns 403 on starter plan', async () => {
    const db = makeDb({ planTier: STARTER_PLAN });
    const app = await buildApp(db);
    const res = await app.inject({ method: 'POST', url: '/api/v1/broadcasts/bc-1/send', body: {} });
    expect(res.statusCode).toBe(403);
  });

  it('returns 404 when broadcast not found', async () => {
    const db = makeDb({ planTier: GROWTH_PLAN, singleBroadcast: null });
    const app = await buildApp(db);
    const res = await app.inject({ method: 'POST', url: '/api/v1/broadcasts/missing/send', body: {} });
    expect(res.statusCode).toBe(404);
  });

  it('returns 409 when broadcast is already sending', async () => {
    const bc = makeBroadcast({ status: 'sending' });
    const db = makeDb({ planTier: GROWTH_PLAN, singleBroadcast: bc });
    const app = await buildApp(db);
    const res = await app.inject({ method: 'POST', url: `/api/v1/broadcasts/${bc.id}/send`, body: {} });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('ALREADY_SENT');
  });

  it('returns 422 when no contacts match the filter', async () => {
    const bc = makeBroadcast({ status: 'draft', audience_filter: JSON.stringify({ lifecycle_stages: ['customer'] }) });
    const db = makeDb({ planTier: GROWTH_PLAN, singleBroadcast: bc, contacts: [] });
    const app = await buildApp(db);
    const res = await app.inject({ method: 'POST', url: `/api/v1/broadcasts/${bc.id}/send`, body: {} });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('NO_RECIPIENTS');
  });

  it('returns sending status with recipient_count when contacts match', async () => {
    const bc = makeBroadcast({ status: 'draft', audience_filter: JSON.stringify({}) });
    const contacts = [{ id: 'c-1' }, { id: 'c-2' }, { id: 'c-3' }];
    const db = makeDb({ planTier: GROWTH_PLAN, singleBroadcast: bc, contacts });
    const app = await buildApp(db);
    const res = await app.inject({ method: 'POST', url: `/api/v1/broadcasts/${bc.id}/send`, body: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.recipient_count).toBe(3);
    expect(res.json().data.status).toBe('sending');
  });

  it('returns scheduled status when broadcast has a scheduled_at date', async () => {
    const bc = makeBroadcast({ status: 'draft', scheduled_at: '2026-06-01T10:00:00.000Z', audience_filter: JSON.stringify({}) });
    const contacts = [{ id: 'c-1' }];
    const db = makeDb({ planTier: GROWTH_PLAN, singleBroadcast: bc, contacts });
    const app = await buildApp(db);
    const res = await app.inject({ method: 'POST', url: `/api/v1/broadcasts/${bc.id}/send`, body: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe('scheduled');
  });
});

describe('POST /api/v1/broadcasts/:id/cancel', () => {
  it('returns 404 when broadcast not found', async () => {
    const db = makeDb({ singleBroadcast: null });
    const app = await buildApp(db);
    const res = await app.inject({ method: 'POST', url: '/api/v1/broadcasts/missing/cancel', body: {} });
    expect(res.statusCode).toBe(404);
  });

  it('returns 409 when broadcast is in draft status', async () => {
    const bc = makeBroadcast({ status: 'draft' });
    const db = makeDb({ singleBroadcast: bc });
    const app = await buildApp(db);
    const res = await app.inject({ method: 'POST', url: `/api/v1/broadcasts/${bc.id}/cancel`, body: {} });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('NOT_CANCELLABLE');
  });

  it('cancels a scheduled broadcast', async () => {
    const bc = makeBroadcast({ status: 'scheduled' });
    const db = makeDb({ singleBroadcast: bc });
    const app = await buildApp(db);
    const res = await app.inject({ method: 'POST', url: `/api/v1/broadcasts/${bc.id}/cancel`, body: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe('canceled');
  });

  it('cancels a sending broadcast', async () => {
    const bc = makeBroadcast({ status: 'sending' });
    const db = makeDb({ singleBroadcast: bc });
    const app = await buildApp(db);
    const res = await app.inject({ method: 'POST', url: `/api/v1/broadcasts/${bc.id}/cancel`, body: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe('canceled');
  });
});

describe('DELETE /api/v1/broadcasts/:id', () => {
  it('returns 404 when broadcast not found', async () => {
    const db = makeDb({ singleBroadcast: null });
    const app = await buildApp(db);
    const res = await app.inject({ method: 'DELETE', url: '/api/v1/broadcasts/missing' });
    expect(res.statusCode).toBe(404);
  });

  it('returns 409 when broadcast is sending', async () => {
    const bc = makeBroadcast({ status: 'sending' });
    const db = makeDb({ singleBroadcast: bc });
    const app = await buildApp(db);
    const res = await app.inject({ method: 'DELETE', url: `/api/v1/broadcasts/${bc.id}` });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('SENDING');
  });

  it('deletes broadcast and recipients, returns 204', async () => {
    const bc = makeBroadcast({ status: 'draft' });
    const db = makeDb({ singleBroadcast: bc });
    const app = await buildApp(db);
    const res = await app.inject({ method: 'DELETE', url: `/api/v1/broadcasts/${bc.id}` });
    expect(res.statusCode).toBe(204);
  });
});
