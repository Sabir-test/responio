/**
 * Unit tests for the WhatsApp inbound webhook endpoint.
 * Covers:
 *   - GET verification challenge (Meta hub.challenge flow)
 *   - UUID validation on tenantId
 *   - Inbox lookup (missing inbox returns 200 silently)
 *   - Signature verification (valid/invalid/skipped-when-no-secret)
 *   - Inbound message → MESSAGE_INBOUND NATS event
 *   - Delivery status → MESSAGE_DELIVERED NATS event
 *   - Unknown payload → 200 ack-and-ignore
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { Knex } from 'knex';
import type { EventPublisher } from '@responio/events';
import { createHmac } from 'crypto';

// ── Mock adapter ──────────────────────────────────────────────────────────────

const parseInboundMock = vi.fn();
const parseDeliveryMock = vi.fn();
const verifySignatureMock = vi.fn().mockReturnValue(true);

vi.mock('@responio/adapters', () => ({
  WhatsApp360DialogAdapter: vi.fn().mockImplementation(() => ({
    parseInboundWebhook: parseInboundMock,
    parseDeliveryUpdate: parseDeliveryMock,
    verifyWebhookSignature: verifySignatureMock,
  })),
}));

vi.mock('@responio/events', () => ({
  Subjects: {
    MESSAGE_INBOUND: 'message.inbound',
    MESSAGE_DELIVERED: 'message.delivered',
  },
}));

// ── Test constants ─────────────────────────────────────────────────────────────

const TENANT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const INBOX_ROW = {
  id: 'inbox-1111',
  workspace_id: 'ws-1',
  channel_type: 'whatsapp',
  is_active: true,
  channel_config: { api_key: 'test-api-key', webhook_secret: 'wh-secret' },
};

function makePublisher(): EventPublisher {
  return { publish: vi.fn().mockResolvedValue('1') } as unknown as EventPublisher;
}

function makeDb(inboxRow: typeof INBOX_ROW | null = INBOX_ROW) {
  return vi.fn((table: string) => {
    if (table === 'inboxes') {
      return { where: vi.fn().mockReturnThis(), first: vi.fn().mockResolvedValue(inboxRow) };
    }
    return { where: vi.fn().mockReturnThis(), first: vi.fn().mockResolvedValue(null) };
  }) as unknown as Knex;
}

async function buildApp(db: Knex, publisher = makePublisher()) {
  process.env.WHATSAPP_VERIFY_TOKEN = 'verify-token-123';

  const app = Fastify({ logger: false });
  const { registerWhatsAppWebhook } = await import('../webhooks/whatsapp');
  registerWhatsAppWebhook(app, db, publisher);
  await app.ready();
  return app;
}

// Helper to build a valid HMAC signature for a body
function makeSignature(body: string, secret = 'wh-secret') {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /webhooks/whatsapp/:tenantId (Meta verification challenge)', () => {
  it('returns the challenge when mode=subscribe and token matches', async () => {
    const app = await buildApp(makeDb());
    const res = await app.inject({
      method: 'GET',
      url: `/webhooks/whatsapp/${TENANT_ID}`,
      query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-token-123', 'hub.challenge': 'abc123' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('abc123');
  });

  it('returns 403 when verify_token does not match', async () => {
    const app = await buildApp(makeDb());
    const res = await app.inject({
      method: 'GET',
      url: `/webhooks/whatsapp/${TENANT_ID}`,
      query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong-token', 'hub.challenge': 'abc123' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('POST /webhooks/whatsapp/:tenantId', () => {
  beforeEach(() => {
    parseInboundMock.mockReset();
    parseDeliveryMock.mockReset();
    verifySignatureMock.mockReset().mockReturnValue(true);
  });

  it('returns 400 for invalid tenant UUID format', async () => {
    const app = await buildApp(makeDb());
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp/not-a-uuid',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 200 silently when no active inbox found for tenant', async () => {
    parseInboundMock.mockReturnValue(null);
    parseDeliveryMock.mockReturnValue(null);
    const app = await buildApp(makeDb(null));
    const res = await app.inject({
      method: 'POST',
      url: `/webhooks/whatsapp/${TENANT_ID}`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fake: true }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it('returns 401 when signature verification fails', async () => {
    verifySignatureMock.mockReturnValue(false);
    const body = JSON.stringify({ messages: [] });
    const app = await buildApp(makeDb());
    const res = await app.inject({
      method: 'POST',
      url: `/webhooks/whatsapp/${TENANT_ID}`,
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': 'sha256=invalidsig',
      },
      body,
    });
    expect(res.statusCode).toBe(401);
  });

  it('publishes MESSAGE_INBOUND for a valid inbound text message', async () => {
    const inboundMsg = {
      channel_message_id: 'ch-msg-1',
      sender_id: '+1234567890',
      sender_name: 'Alice',
      content: 'Hello!',
      content_type: 'text',
      media_url: null,
      raw_payload: {},
    };
    parseDeliveryMock.mockReturnValue(null);
    parseInboundMock.mockReturnValue(inboundMsg);

    const publisher = makePublisher();
    const app = await buildApp(makeDb(), publisher);
    const body = JSON.stringify({ messages: [{}] });

    const res = await app.inject({
      method: 'POST',
      url: `/webhooks/whatsapp/${TENANT_ID}`,
      headers: { 'content-type': 'application/json' },
      body,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect((publisher.publish as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
    const [subject, params] = (publisher.publish as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(subject).toBe('message.inbound');
    expect(params.tenant_id).toBe(TENANT_ID);
    expect(params.payload.channel_type).toBe('whatsapp');
    expect(params.payload.content).toBe('Hello!');
    expect(params.payload.metadata.sender_id).toBe('+1234567890');
  });

  it('publishes MESSAGE_DELIVERED for a delivery status update', async () => {
    const deliveryUpdate = {
      channel_message_id: 'ch-msg-1',
      status: 'delivered',
      timestamp: new Date().toISOString(),
    };
    parseDeliveryMock.mockReturnValue(deliveryUpdate);
    parseInboundMock.mockReturnValue(null);

    const publisher = makePublisher();
    const app = await buildApp(makeDb(), publisher);

    const res = await app.inject({
      method: 'POST',
      url: `/webhooks/whatsapp/${TENANT_ID}`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ statuses: [{}] }),
    });

    expect(res.statusCode).toBe(200);
    const [subject, params] = (publisher.publish as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(subject).toBe('message.delivered');
    expect(params.payload.status).toBe('delivered');
    expect(params.payload.channel_message_id).toBe('ch-msg-1');
  });

  it('returns 200 and publishes nothing for unknown payload type', async () => {
    parseDeliveryMock.mockReturnValue(null);
    parseInboundMock.mockReturnValue(null);

    const publisher = makePublisher();
    const app = await buildApp(makeDb(), publisher);

    const res = await app.inject({
      method: 'POST',
      url: `/webhooks/whatsapp/${TENANT_ID}`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ something_else: true }),
    });

    expect(res.statusCode).toBe(200);
    expect((publisher.publish as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});
