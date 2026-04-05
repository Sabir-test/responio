/**
 * Unit tests for the NATS → n8n trigger bridge.
 * Verifies webhook firing, WORKFLOW_TRIGGERED event publishing,
 * 404/error handling, and that NATS messages are always acked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NatsConnection } from 'nats';

// ── Captured subscription handlers ───────────────────────────────────────────

type SubHandler = (event: Record<string, unknown>, ack: () => void, nack: () => void) => Promise<void>;
const subscribeHandlers: Map<string, SubHandler> = new Map();

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('@responio/events', () => ({
  EventSubscriber: vi.fn().mockImplementation(() => ({
    subscribe: vi.fn().mockImplementation((opts: { filterSubject: string }, handler: SubHandler) => {
      subscribeHandlers.set(opts.filterSubject, handler);
      return Promise.resolve();
    }),
  })),
  EventPublisher: vi.fn().mockImplementation(() => ({
    publish: vi.fn().mockResolvedValue('1'),
  })),
  Subjects: {
    CONVERSATION_CREATED: 'conversation.created',
    MESSAGE_INBOUND: 'message.inbound',
    CONTACT_UPDATED: 'contact.field_updated',
    CONTACT_LIFECYCLE_CHANGED: 'contact.lifecycle_changed',
    CONVERSATION_ASSIGNED: 'conversation.assigned',
    CONVERSATION_RESOLVED: 'conversation.resolved',
    AI_HANDOFF_TRIGGERED: 'ai.handoff_triggered',
    WORKFLOW_TRIGGERED: 'workflow.triggered',
  },
}));

// ── Test constants ────────────────────────────────────────────────────────────

const TENANT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const WS_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const CONFIG = { n8nBaseUrl: 'http://n8n:5678', webhookSecret: 'test-secret' };

function makeNc() {
  return {} as NatsConnection;
}

function makeEvent(subject: string, payload: Record<string, unknown>) {
  return {
    event_type: subject,
    tenant_id: TENANT_ID,
    workspace_id: WS_ID,
    timestamp: new Date().toISOString(),
    correlation_id: 'corr-1',
    source_service: 'inbox',
    version: '1.0',
    payload,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('startNatsBridge', () => {
  let globalFetchMock: ReturnType<typeof vi.fn>;
  let publishMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    subscribeHandlers.clear();

    publishMock = vi.fn().mockResolvedValue('1');
    const { EventPublisher, EventSubscriber } = await import('@responio/events');
    (EventSubscriber as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      subscribe: vi.fn().mockImplementation((opts: { filterSubject: string }, handler: SubHandler) => {
        subscribeHandlers.set(opts.filterSubject, handler);
        return Promise.resolve();
      }),
    }));
    (EventPublisher as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      publish: publishMock,
    }));

    globalFetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', globalFetchMock);

    const { startNatsBridge } = await import('../bridge/nats-bridge');
    startNatsBridge(makeNc(), CONFIG);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('registers 7 NATS subscriptions', () => {
    expect(subscribeHandlers.size).toBe(7);
  });

  it('fires webhook to correct URL for conversation.created', async () => {
    const handler = subscribeHandlers.get('conversation.created')!;
    const ack = vi.fn();

    await handler(makeEvent('conversation.created', {
      conversation_id: 'conv-1',
      contact_id: 'c-1',
      channel_type: 'whatsapp',
      inbox_id: 'inbox-1',
      initial_message_id: null,
    }), ack, vi.fn());

    expect(globalFetchMock).toHaveBeenCalledOnce();
    const [url, opts] = globalFetchMock.mock.calls[0];
    expect(url).toBe(`http://n8n:5678/webhook/${TENANT_ID}/conversation-created`);
    expect(opts.method).toBe('POST');
    expect(opts.headers['X-Responio-Secret']).toBe('test-secret');
    expect(ack).toHaveBeenCalledOnce();
  });

  it('fires webhook for message.inbound', async () => {
    const handler = subscribeHandlers.get('message.inbound')!;
    const ack = vi.fn();

    await handler(makeEvent('message.inbound', {
      message_id: 'msg-1',
      conversation_id: 'conv-1',
      contact_id: 'c-1',
      content: 'Hello',
      channel_type: 'whatsapp',
      content_type: 'text',
      channel_message_id: 'ch-1',
      metadata: {},
    }), ack, vi.fn());

    const [url] = globalFetchMock.mock.calls[0];
    expect(url).toBe(`http://n8n:5678/webhook/${TENANT_ID}/message-inbound`);
    expect(ack).toHaveBeenCalledOnce();
  });

  it('publishes WORKFLOW_TRIGGERED after a successful webhook call', async () => {
    const handler = subscribeHandlers.get('conversation.created')!;
    const ack = vi.fn();

    await handler(makeEvent('conversation.created', {
      conversation_id: 'conv-1',
      contact_id: 'c-1',
      channel_type: 'whatsapp',
      inbox_id: 'inbox-1',
      initial_message_id: null,
    }), ack, vi.fn());

    expect(publishMock).toHaveBeenCalledOnce();
    const [subject, params] = publishMock.mock.calls[0];
    expect(subject).toBe('workflow.triggered');
    expect(params.tenant_id).toBe(TENANT_ID);
    expect(params.payload.trigger_type).toBe('conversation_created');
    expect(params.payload.execution_id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('skips WORKFLOW_TRIGGERED when n8n returns 404 (no active workflow)', async () => {
    globalFetchMock.mockResolvedValueOnce({ ok: false, status: 404 });

    const handler = subscribeHandlers.get('conversation.created')!;
    const ack = vi.fn();

    await handler(makeEvent('conversation.created', {
      conversation_id: 'conv-1',
      contact_id: 'c-1',
      channel_type: 'whatsapp',
      inbox_id: 'inbox-1',
      initial_message_id: null,
    }), ack, vi.fn());

    expect(publishMock).not.toHaveBeenCalled();
    // Still acks the NATS message
    expect(ack).toHaveBeenCalledOnce();
  });

  it('still acks the NATS message when fetch throws (network error)', async () => {
    globalFetchMock.mockRejectedValueOnce(new Error('Network error'));
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const handler = subscribeHandlers.get('message.inbound')!;
    const ack = vi.fn();

    await handler(makeEvent('message.inbound', {
      message_id: 'msg-1',
      conversation_id: 'conv-1',
      contact_id: 'c-1',
      content: 'Hi',
      channel_type: 'whatsapp',
      content_type: 'text',
      channel_message_id: 'ch-1',
      metadata: {},
    }), ack, vi.fn());

    expect(ack).toHaveBeenCalledOnce();
    stderrSpy.mockRestore();
  });

  it('includes _execution_id in the webhook body', async () => {
    const handler = subscribeHandlers.get('conversation.assigned')!;
    const ack = vi.fn();

    await handler(makeEvent('conversation.assigned', {
      conversation_id: 'conv-1',
      assignee_id: 'agent-1',
      previous_assignee_id: null,
      assignment_method: 'manual',
    }), ack, vi.fn());

    const [, opts] = globalFetchMock.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body._execution_id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('fires all 7 webhook paths for all trigger types', async () => {
    const scenarios: Array<[string, string, Record<string, unknown>]> = [
      ['conversation.created', 'conversation-created', { conversation_id: 'c', contact_id: 'x', channel_type: 'whatsapp', inbox_id: 'i', initial_message_id: null }],
      ['message.inbound', 'message-inbound', { message_id: 'm', conversation_id: 'c', contact_id: 'x', content: 'hi', channel_type: 'whatsapp', content_type: 'text', channel_message_id: 'ch', metadata: {} }],
      ['contact.field_updated', 'contact-updated', { contact_id: 'x', field_name: 'name', old_value: 'a', new_value: 'b', updated_by: 'user' }],
      ['contact.lifecycle_changed', 'lifecycle-changed', { contact_id: 'x', old_stage: 'new_lead', new_stage: 'customer', workspace_id: WS_ID, changed_by: 'system' }],
      ['conversation.assigned', 'conversation-assigned', { conversation_id: 'c', assignee_id: 'a', previous_assignee_id: null, assignment_method: 'manual' }],
      ['conversation.resolved', 'conversation-resolved', { conversation_id: 'c', resolved_by: 'agent', resolution_time_seconds: 60, contact_id: 'x' }],
      ['ai.handoff_triggered', 'ai-handoff', { conversation_id: 'c', ai_agent_id: 'ai-1', confidence_score: 0.3, handoff_reason: 'low_confidence', context_summary: 'summary', contact_id: 'x' }],
    ];

    for (const [subject, path, payload] of scenarios) {
      globalFetchMock.mockClear();
      const handler = subscribeHandlers.get(subject)!;
      await handler(makeEvent(subject, payload), vi.fn(), vi.fn());
      const [url] = globalFetchMock.mock.calls[0];
      expect(url).toContain(path);
    }
  });
});
