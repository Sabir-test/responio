/**
 * Unit tests for the analytics NATS → ClickHouse event writer.
 * Verifies data transformation and ClickHouse table routing for all 6 event types,
 * plus error resilience (ack even when ClickHouse write fails).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NatsConnection } from 'nats';

// ── Captured subscription handlers ───────────────────────────────────────────

type SubHandler = (event: Record<string, unknown>, ack: () => void, nack: () => void) => Promise<void>;
const subscribeHandlers: Map<string, SubHandler> = new Map();

// ── ClickHouse mock ───────────────────────────────────────────────────────────

const chInsertMock = vi.fn().mockResolvedValue(undefined);

vi.mock('../clickhouse/client', () => ({
  getClickHouseClient: vi.fn().mockReturnValue({
    insert: chInsertMock,
  }),
}));

vi.mock('@responio/events', () => ({
  EventSubscriber: vi.fn().mockImplementation(() => ({
    subscribe: vi.fn().mockImplementation((opts: { filterSubject: string }, handler: SubHandler) => {
      subscribeHandlers.set(opts.filterSubject, handler);
      return Promise.resolve();
    }),
  })),
  Subjects: {
    CONVERSATION_CREATED: 'conversation.created',
    CONVERSATION_RESOLVED: 'conversation.resolved',
    MESSAGE_INBOUND: 'message.inbound',
    MESSAGE_OUTBOUND: 'message.outbound',
    CONTACT_CREATED: 'contact.created',
    CONTACT_LIFECYCLE_CHANGED: 'contact.lifecycle_changed',
  },
}));

// ── Test constants ─────────────────────────────────────────────────────────────

const TENANT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const NOW_ISO = new Date().toISOString();

function makeEvent(subject: string, payload: Record<string, unknown>) {
  return {
    event_type: subject,
    tenant_id: TENANT_ID,
    workspace_id: 'ws-1',
    timestamp: NOW_ISO,
    correlation_id: 'corr-1',
    source_service: 'inbox',
    version: '1.0',
    payload,
  };
}

function makeNc() {
  return {} as NatsConnection;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('startEventWriter', () => {
  beforeEach(async () => {
    subscribeHandlers.clear();
    chInsertMock.mockReset();
    chInsertMock.mockResolvedValue(undefined);
    vi.resetModules();

    vi.mock('../clickhouse/client', () => ({
      getClickHouseClient: vi.fn().mockReturnValue({ insert: chInsertMock }),
    }));
    vi.mock('@responio/events', () => ({
      EventSubscriber: vi.fn().mockImplementation(() => ({
        subscribe: vi.fn().mockImplementation((opts: { filterSubject: string }, handler: SubHandler) => {
          subscribeHandlers.set(opts.filterSubject, handler);
          return Promise.resolve();
        }),
      })),
      Subjects: {
        CONVERSATION_CREATED: 'conversation.created',
        CONVERSATION_RESOLVED: 'conversation.resolved',
        MESSAGE_INBOUND: 'message.inbound',
        MESSAGE_OUTBOUND: 'message.outbound',
        CONTACT_CREATED: 'contact.created',
        CONTACT_LIFECYCLE_CHANGED: 'contact.lifecycle_changed',
      },
    }));

    const { startEventWriter } = await import('../nats/event-writer');
    startEventWriter(makeNc());
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('registers 6 subscriptions', () => {
    expect(subscribeHandlers.size).toBe(6);
  });

  describe('conversation.created', () => {
    it('writes to conversations_events with status=open', async () => {
      const handler = subscribeHandlers.get('conversation.created')!;
      const ack = vi.fn();

      await handler(makeEvent('conversation.created', {
        conversation_id: 'conv-1',
        contact_id: 'c-1',
        channel_type: 'whatsapp',
        inbox_id: 'inbox-1',
        assignee_id: 'agent-1',
        initial_message_id: null,
      }), ack, vi.fn());

      expect(chInsertMock).toHaveBeenCalledOnce();
      const { table, values } = chInsertMock.mock.calls[0][0];
      expect(table).toBe('conversations_events');
      expect(values[0].tenant_id).toBe(TENANT_ID);
      expect(values[0].conversation_id).toBe('conv-1');
      expect(values[0].status).toBe('open');
      expect(values[0].assignee_id).toBe('agent-1');
      expect(values[0].created_at).toBe(NOW_ISO);
      expect(ack).toHaveBeenCalledOnce();
    });

    it('uses empty string for null assignee_id', async () => {
      const handler = subscribeHandlers.get('conversation.created')!;
      await handler(makeEvent('conversation.created', {
        conversation_id: 'conv-1',
        contact_id: 'c-1',
        channel_type: 'whatsapp',
        inbox_id: 'inbox-1',
        assignee_id: null,
        initial_message_id: null,
      }), vi.fn(), vi.fn());

      const { values } = chInsertMock.mock.calls[0][0];
      expect(values[0].assignee_id).toBe('');
    });
  });

  describe('conversation.resolved', () => {
    it('writes to conversations_events with status=resolved and resolution_seconds', async () => {
      const handler = subscribeHandlers.get('conversation.resolved')!;
      const ack = vi.fn();

      await handler(makeEvent('conversation.resolved', {
        conversation_id: 'conv-2',
        contact_id: 'c-2',
        resolved_by: 'agent-2',
        resolution_time_seconds: 120,
      }), ack, vi.fn());

      const { table, values } = chInsertMock.mock.calls[0][0];
      expect(table).toBe('conversations_events');
      expect(values[0].status).toBe('resolved');
      expect(values[0].resolution_seconds).toBe(120);
      expect(values[0].assignee_id).toBe('agent-2');
      expect(values[0].resolved_at).toBe(NOW_ISO);
      expect(ack).toHaveBeenCalledOnce();
    });
  });

  describe('message.inbound', () => {
    it('writes to messages_events with direction=inbound', async () => {
      const handler = subscribeHandlers.get('message.inbound')!;
      const ack = vi.fn();

      await handler(makeEvent('message.inbound', {
        message_id: 'msg-1',
        conversation_id: 'conv-1',
        contact_id: 'c-1',
        channel_type: 'whatsapp',
        content_type: 'text',
        content: 'Hello!',
        channel_message_id: 'ch-1',
        metadata: {},
      }), ack, vi.fn());

      const { table, values } = chInsertMock.mock.calls[0][0];
      expect(table).toBe('messages_events');
      expect(values[0].direction).toBe('inbound');
      expect(values[0].message_id).toBe('msg-1');
      expect(values[0].content_type).toBe('text');
      expect(ack).toHaveBeenCalledOnce();
    });
  });

  describe('message.outbound', () => {
    it('writes to messages_events with direction=outbound', async () => {
      const handler = subscribeHandlers.get('message.outbound')!;

      await handler(makeEvent('message.outbound', {
        message_id: 'msg-2',
        conversation_id: 'conv-1',
        contact_id: 'c-1',
        channel_type: 'whatsapp',
        content_type: 'template',
        content: 'Hi {{1}}',
        sent_by: 'agent-1',
      }), vi.fn(), vi.fn());

      const { table, values } = chInsertMock.mock.calls[0][0];
      expect(table).toBe('messages_events');
      expect(values[0].direction).toBe('outbound');
    });
  });

  describe('contact.created', () => {
    it('writes to contact_events with event_type=created', async () => {
      const handler = subscribeHandlers.get('contact.created')!;
      const ack = vi.fn();

      await handler(makeEvent('contact.created', {
        contact_id: 'c-new',
        phone: '+1234567890',
        email: null,
        name: 'Alice',
        lifecycle_stage: 'new_lead',
        channel_type: 'whatsapp',
      }), ack, vi.fn());

      const { table, values } = chInsertMock.mock.calls[0][0];
      expect(table).toBe('contact_events');
      expect(values[0].event_type).toBe('created');
      expect(values[0].contact_id).toBe('c-new');
      expect(values[0].lifecycle_stage).toBe('new_lead');
      expect(ack).toHaveBeenCalledOnce();
    });
  });

  describe('contact.lifecycle_changed', () => {
    it('writes to contact_events with event_type=lifecycle_changed and new_stage', async () => {
      const handler = subscribeHandlers.get('contact.lifecycle_changed')!;

      await handler(makeEvent('contact.lifecycle_changed', {
        contact_id: 'c-1',
        old_stage: 'new_lead',
        new_stage: 'customer',
        workspace_id: 'ws-1',
        changed_by: 'workflow',
      }), vi.fn(), vi.fn());

      const { table, values } = chInsertMock.mock.calls[0][0];
      expect(table).toBe('contact_events');
      expect(values[0].event_type).toBe('lifecycle_changed');
      expect(values[0].lifecycle_stage).toBe('customer');
    });
  });

  describe('error resilience', () => {
    it('acks the NATS message even when ClickHouse insert throws', async () => {
      chInsertMock.mockRejectedValueOnce(new Error('ClickHouse connection lost'));
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const handler = subscribeHandlers.get('message.inbound')!;
      const ack = vi.fn();

      await handler(makeEvent('message.inbound', {
        message_id: 'msg-1',
        conversation_id: 'conv-1',
        contact_id: 'c-1',
        channel_type: 'whatsapp',
        content_type: 'text',
        content: 'Yo',
        channel_message_id: 'ch-1',
        metadata: {},
      }), ack, vi.fn());

      expect(ack).toHaveBeenCalledOnce();
      consoleSpy.mockRestore();
    });
  });
});
