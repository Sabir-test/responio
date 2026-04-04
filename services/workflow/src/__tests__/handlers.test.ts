/**
 * Unit tests for workflow action handlers.
 * Verifies context resolution (workspace_id, contact_id) and 404 handling.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { Knex } from 'knex';
import type { EventPublisher } from '@responio/events';
import { registerActionRoutes } from '../actions/handlers';

const TENANT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CONV_ID   = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const CONTACT_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const WS_ID     = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

const API_KEY = 'test-internal-key';

// ── Mock helpers ──────────────────────────────────────────────────────────────

function makeDb(convRow: Record<string, string> | null, contactRow: Record<string, string> | null = null, wsRow: Record<string, string> | null = null, planTier = 'advanced') {
  const selectFirst = (row: unknown) => ({
    where: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(row),
    leftJoin: vi.fn().mockReturnThis(),
    groupBy: vi.fn().mockReturnThis(),
    orderByRaw: vi.fn().mockReturnThis(),
  });

  return vi.fn((table: string) => {
    if (table === 'conversations') return selectFirst(convRow);
    if (table === 'contacts') return selectFirst(contactRow);
    if (table === 'workspaces') return selectFirst(wsRow ?? { id: WS_ID });
    if (table === 'accounts') return selectFirst({ plan_tier: planTier });
    return selectFirst(null);
  }) as unknown as Knex;
}

function makePublisher() {
  return { publish: vi.fn().mockResolvedValue(undefined) } as unknown as EventPublisher;
}

async function buildApp(db: Knex, publisher: EventPublisher) {
  // Override env for test
  process.env.INTERNAL_API_KEY = API_KEY;
  const app = Fastify({ logger: false });
  registerActionRoutes(app, publisher, db);
  await app.ready();
  return app;
}

const authHeaders = {
  'x-internal-api-key': API_KEY,
  'x-tenant-id': TENANT_ID,
};

// ── Auth guard ────────────────────────────────────────────────────────────────

describe('action handler auth', () => {
  it('returns 401 for missing API key', async () => {
    const app = await buildApp(makeDb(null), makePublisher());
    const res = await app.inject({
      method: 'POST', url: '/api/v1/actions/send-message',
      headers: { 'x-tenant-id': TENANT_ID },
      payload: { conversation_id: CONV_ID, content: 'hi' },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('returns 401 for wrong API key', async () => {
    const app = await buildApp(makeDb(null), makePublisher());
    const res = await app.inject({
      method: 'POST', url: '/api/v1/actions/send-message',
      headers: { 'x-internal-api-key': 'wrong', 'x-tenant-id': TENANT_ID },
      payload: { conversation_id: CONV_ID, content: 'hi' },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('returns 400 for missing X-Tenant-ID', async () => {
    const app = await buildApp(makeDb(null), makePublisher());
    const res = await app.inject({
      method: 'POST', url: '/api/v1/actions/send-message',
      headers: { 'x-internal-api-key': API_KEY },
      payload: { conversation_id: CONV_ID, content: 'hi' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

// ── send-message ──────────────────────────────────────────────────────────────

describe('POST /api/v1/actions/send-message', () => {
  it('returns 404 when conversation not found', async () => {
    const app = await buildApp(makeDb(null), makePublisher());
    const res = await app.inject({
      method: 'POST', url: '/api/v1/actions/send-message',
      headers: authHeaders,
      payload: { conversation_id: CONV_ID, content: 'hello' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('publishes event with resolved workspace_id and contact_id', async () => {
    const conv = { workspace_id: WS_ID, contact_id: CONTACT_ID, inbox_id: 'inbox-1' };
    const publisher = makePublisher();
    const app = await buildApp(makeDb(conv), publisher);

    const res = await app.inject({
      method: 'POST', url: '/api/v1/actions/send-message',
      headers: authHeaders,
      payload: { conversation_id: CONV_ID, content: 'hello' },
    });

    expect(res.statusCode).toBe(200);
    expect(publisher.publish).toHaveBeenCalledOnce();

    const [, eventData] = (publisher.publish as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(eventData.workspace_id).toBe(WS_ID);
    expect(eventData.payload.contact_id).toBe(CONTACT_ID);
    expect(eventData.payload.conversation_id).toBe(CONV_ID);
    await app.close();
  });
});

// ── change-lifecycle ──────────────────────────────────────────────────────────

describe('POST /api/v1/actions/change-lifecycle', () => {
  it('fetches old_stage from DB and includes it in the published event', async () => {
    const contact = { lifecycle_stage: 'lead' };
    const publisher = makePublisher();
    const app = await buildApp(makeDb(null, contact), publisher);

    const res = await app.inject({
      method: 'POST', url: '/api/v1/actions/change-lifecycle',
      headers: authHeaders,
      payload: { contact_id: CONTACT_ID, new_stage: 'customer' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.old_stage).toBe('lead');
    expect(body.new_stage).toBe('customer');

    const [, eventData] = (publisher.publish as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(eventData.payload.old_stage).toBe('lead');
    await app.close();
  });

  it('uses "unknown" as old_stage when contact not found', async () => {
    const publisher = makePublisher();
    const app = await buildApp(makeDb(null, null), publisher);

    const res = await app.inject({
      method: 'POST', url: '/api/v1/actions/change-lifecycle',
      headers: authHeaders,
      payload: { contact_id: CONTACT_ID, new_stage: 'customer' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().old_stage).toBe('unknown');
    await app.close();
  });
});

// ── close-conversation ────────────────────────────────────────────────────────

describe('POST /api/v1/actions/close-conversation', () => {
  it('returns 404 when conversation not found', async () => {
    const app = await buildApp(makeDb(null), makePublisher());
    const res = await app.inject({
      method: 'POST', url: '/api/v1/actions/close-conversation',
      headers: authHeaders,
      payload: { conversation_id: CONV_ID },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('publishes CONVERSATION_RESOLVED with resolved contact_id', async () => {
    const conv = { workspace_id: WS_ID, contact_id: CONTACT_ID, inbox_id: 'inbox-1' };
    const publisher = makePublisher();
    const app = await buildApp(makeDb(conv), publisher);

    const res = await app.inject({
      method: 'POST', url: '/api/v1/actions/close-conversation',
      headers: authHeaders,
      payload: { conversation_id: CONV_ID },
    });

    expect(res.statusCode).toBe(200);
    const [, eventData] = (publisher.publish as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(eventData.payload.contact_id).toBe(CONTACT_ID);
    expect(eventData.workspace_id).toBe(WS_ID);
    await app.close();
  });
});

// ── trigger-webhook (feature gate) ───────────────────────────────────────────

describe('POST /api/v1/actions/trigger-webhook', () => {
  it('returns 403 for starter plan (feature gate)', async () => {
    const app = await buildApp(makeDb(null, null, null, 'starter'), makePublisher());
    const res = await app.inject({
      method: 'POST', url: '/api/v1/actions/trigger-webhook',
      headers: authHeaders,
      payload: { url: 'https://example.com/hook', method: 'POST' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FEATURE_NOT_AVAILABLE');
    await app.close();
  });
});
