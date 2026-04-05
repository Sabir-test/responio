/**
 * Unit tests for EventPublisher.
 * Verifies event serialization, subject routing, and JetStream ack handling.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventPublisher } from '../publisher';
import { Subjects } from '../streams';
import type { NatsConnection, JetStreamClient } from 'nats';

// ── Mock helpers ──────────────────────────────────────────────────────────────

function makeJsClient(ackSeq = 42) {
  return {
    publish: vi.fn().mockResolvedValue({ seq: ackSeq, duplicate: false }),
  } as unknown as JetStreamClient;
}

function makeNatsConnection(js: JetStreamClient) {
  return {
    jetstream: vi.fn().mockReturnValue(js),
  } as unknown as NatsConnection;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('EventPublisher', () => {
  let js: ReturnType<typeof makeJsClient>;
  let nc: NatsConnection;
  let publisher: EventPublisher;

  beforeEach(() => {
    js = makeJsClient();
    nc = makeNatsConnection(js);
    publisher = new EventPublisher(nc);
  });

  it('calls jetstream() on construction', () => {
    expect((nc.jetstream as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('publishes to the correct subject', async () => {
    await publisher.publish(Subjects.CONVERSATION_CREATED, {
      tenant_id: 'tenant-1',
      workspace_id: 'ws-1',
      source_service: 'inbox',
      payload: { conversation_id: 'conv-1', contact_id: 'c-1', inbox_id: 'i-1', channel_type: 'whatsapp', assignee_id: null, initial_message_id: null },
    });

    const [subject] = (js.publish as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(subject).toBe(Subjects.CONVERSATION_CREATED);
  });

  it('encodes payload as UTF-8 JSON', async () => {
    await publisher.publish(Subjects.MESSAGE_INBOUND, {
      tenant_id: 'tenant-1',
      workspace_id: 'ws-1',
      source_service: 'gateway',
      payload: { message_id: 'msg-1', conversation_id: 'conv-1', contact_id: 'c-1', channel_type: 'whatsapp', content: 'Hello', content_type: 'text', channel_message_id: 'ch-1', metadata: {} },
    });

    const [, encodedData] = (js.publish as ReturnType<typeof vi.fn>).mock.calls[0];
    const decoded = JSON.parse(new TextDecoder().decode(encodedData));
    expect(decoded.event_type).toBe(Subjects.MESSAGE_INBOUND);
    expect(decoded.tenant_id).toBe('tenant-1');
    expect(decoded.workspace_id).toBe('ws-1');
    expect(decoded.source_service).toBe('gateway');
    expect(decoded.version).toBe('1.0');
    expect(decoded.correlation_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(decoded.timestamp).toBeTruthy();
  });

  it('returns the JetStream ack sequence as a string', async () => {
    const seq = await publisher.publish(Subjects.CONTACT_CREATED, {
      tenant_id: 'tenant-1',
      workspace_id: 'ws-1',
      source_service: 'inbox',
      payload: { contact_id: 'c-1', phone: '+1234567890', email: null, name: 'Alice', lifecycle_stage: 'new_lead', channel_type: 'whatsapp' },
    });

    expect(seq).toBe('42');
  });

  it('each publish gets a unique correlation_id', async () => {
    await publisher.publish(Subjects.CONTACT_CREATED, {
      tenant_id: 'tenant-1',
      workspace_id: 'ws-1',
      source_service: 'inbox',
      payload: { contact_id: 'c-1', phone: null, email: null, name: null, lifecycle_stage: 'new_lead', channel_type: 'whatsapp' },
    });
    await publisher.publish(Subjects.CONTACT_CREATED, {
      tenant_id: 'tenant-1',
      workspace_id: 'ws-1',
      source_service: 'inbox',
      payload: { contact_id: 'c-2', phone: null, email: null, name: null, lifecycle_stage: 'new_lead', channel_type: 'whatsapp' },
    });

    const calls = (js.publish as ReturnType<typeof vi.fn>).mock.calls;
    const corr1 = JSON.parse(new TextDecoder().decode(calls[0][1])).correlation_id;
    const corr2 = JSON.parse(new TextDecoder().decode(calls[1][1])).correlation_id;
    expect(corr1).not.toBe(corr2);
  });

  it('propagates JetStream publish errors', async () => {
    (js.publish as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('JetStream unavailable'));

    await expect(
      publisher.publish(Subjects.WORKFLOW_TRIGGERED, {
        tenant_id: 'tenant-1',
        workspace_id: 'ws-1',
        source_service: 'workflow',
        payload: { workflow_id: 'wf-1', execution_id: 'exec-1', trigger_type: 'message_inbound' },
      })
    ).rejects.toThrow('JetStream unavailable');
  });

  it('uses a custom correlation_id when provided', async () => {
    await publisher.publish(Subjects.CONVERSATION_CREATED, {
      tenant_id: 'tenant-1',
      workspace_id: 'ws-1',
      source_service: 'inbox',
      correlation_id: 'my-custom-correlation-id',
      payload: { conversation_id: 'conv-1', contact_id: 'c-1', inbox_id: 'i-1', channel_type: 'whatsapp', assignee_id: null, initial_message_id: null },
    });

    const [, encodedData] = (js.publish as ReturnType<typeof vi.fn>).mock.calls[0];
    const decoded = JSON.parse(new TextDecoder().decode(encodedData));
    expect(decoded.correlation_id).toBe('my-custom-correlation-id');
  });
});
