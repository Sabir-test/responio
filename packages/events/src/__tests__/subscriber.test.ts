/**
 * Unit tests for EventSubscriber.
 * Verifies consumer config, message deserialization, ack/nak behavior,
 * and error handling (NAK on handler exception).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventSubscriber } from '../subscriber';
import { Subjects } from '../streams';
import type { NatsConnection, JetStreamClient } from 'nats';
import { DeliverPolicy, AckPolicy, ReplayPolicy } from 'nats';

// ── Mock message builder ──────────────────────────────────────────────────────

function makeMsg(payload: unknown) {
  const data = new TextEncoder().encode(JSON.stringify(payload));
  return {
    data,
    ack: vi.fn(),
    nak: vi.fn(),
  };
}

// ── Mock NATS JetStream that captures subscription config and drives messages ─

interface MockSubscription {
  config: Record<string, unknown>;
  [Symbol.asyncIterator](): AsyncIterator<ReturnType<typeof makeMsg>>;
}

function makeJsClient(messages: ReturnType<typeof makeMsg>[] = []): {
  js: JetStreamClient;
  capturedSub: MockSubscription | null;
} {
  let capturedSub: MockSubscription | null = null;

  const sub: MockSubscription = {
    config: {},
    [Symbol.asyncIterator]() {
      let idx = 0;
      return {
        async next() {
          if (idx < messages.length) {
            return { value: messages[idx++], done: false };
          }
          return { value: undefined as unknown as ReturnType<typeof makeMsg>, done: true };
        },
      };
    },
  };

  const js = {
    subscribe: vi.fn().mockImplementation((_subject: string, opts: { config: Record<string, unknown> }) => {
      sub.config = opts.config;
      capturedSub = sub;
      return Promise.resolve(sub);
    }),
  } as unknown as JetStreamClient;

  return { js, capturedSub };
}

function makeNatsConnection(js: JetStreamClient) {
  return {
    jetstream: vi.fn().mockReturnValue(js),
  } as unknown as NatsConnection;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('EventSubscriber', () => {
  describe('subscribe() consumer config', () => {
    it('sets durable_name from consumerName option', async () => {
      const { js } = makeJsClient();
      const nc = makeNatsConnection(js);
      const sub = new EventSubscriber(nc);

      await sub.subscribe(
        { consumerName: 'my-consumer', streamName: 'CONVERSATION', filterSubject: Subjects.CONVERSATION_CREATED },
        vi.fn().mockResolvedValue(undefined)
      );

      const subscribeCall = (js.subscribe as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(subscribeCall[1].config.durable_name).toBe('my-consumer');
    });

    it('sets filter_subject from option', async () => {
      const { js } = makeJsClient();
      const nc = makeNatsConnection(js);
      const sub = new EventSubscriber(nc);

      await sub.subscribe(
        { consumerName: 'test', streamName: 'MESSAGE', filterSubject: Subjects.MESSAGE_INBOUND },
        vi.fn().mockResolvedValue(undefined)
      );

      const subscribeCall = (js.subscribe as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(subscribeCall[1].config.filter_subject).toBe(Subjects.MESSAGE_INBOUND);
    });

    it('defaults to DeliverPolicy.New', async () => {
      const { js } = makeJsClient();
      const nc = makeNatsConnection(js);
      const sub = new EventSubscriber(nc);

      await sub.subscribe(
        { consumerName: 'test', streamName: 'MESSAGE', filterSubject: Subjects.MESSAGE_INBOUND },
        vi.fn().mockResolvedValue(undefined)
      );

      const subscribeCall = (js.subscribe as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(subscribeCall[1].config.deliver_policy).toBe(DeliverPolicy.New);
    });

    it('respects a custom deliverPolicy', async () => {
      const { js } = makeJsClient();
      const nc = makeNatsConnection(js);
      const sub = new EventSubscriber(nc);

      await sub.subscribe(
        {
          consumerName: 'test',
          streamName: 'MESSAGE',
          filterSubject: Subjects.MESSAGE_INBOUND,
          deliverPolicy: DeliverPolicy.All,
        },
        vi.fn().mockResolvedValue(undefined)
      );

      const subscribeCall = (js.subscribe as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(subscribeCall[1].config.deliver_policy).toBe(DeliverPolicy.All);
    });

    it('uses explicit ack policy and max_deliver=5', async () => {
      const { js } = makeJsClient();
      const nc = makeNatsConnection(js);
      const sub = new EventSubscriber(nc);

      await sub.subscribe(
        { consumerName: 'test', streamName: 'AI', filterSubject: Subjects.AI_AGENT_INVOKED },
        vi.fn().mockResolvedValue(undefined)
      );

      const subscribeCall = (js.subscribe as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(subscribeCall[1].config.ack_policy).toBe(AckPolicy.Explicit);
      expect(subscribeCall[1].config.max_deliver).toBe(5);
      expect(subscribeCall[1].config.replay_policy).toBe(ReplayPolicy.Instant);
    });
  });

  describe('message handling', () => {
    it('deserializes JSON and calls handler with event, ack, and nack', async () => {
      const event = {
        event_type: Subjects.CONVERSATION_CREATED,
        tenant_id: 'tenant-1',
        workspace_id: 'ws-1',
        timestamp: new Date().toISOString(),
        correlation_id: 'corr-1',
        source_service: 'inbox',
        version: '1.0',
        payload: { conversation_id: 'conv-1' },
      };

      const msg = makeMsg(event);
      const { js } = makeJsClient([msg]);
      const nc = makeNatsConnection(js);
      const sub = new EventSubscriber(nc);

      const handler = vi.fn().mockResolvedValue(undefined);
      await sub.subscribe(
        { consumerName: 'test', streamName: 'CONVERSATION', filterSubject: Subjects.CONVERSATION_CREATED },
        handler
      );

      // Allow the async iterator loop to run
      await new Promise((r) => setTimeout(r, 10));

      expect(handler).toHaveBeenCalledOnce();
      const [receivedEvent, ackFn, nakFn] = handler.mock.calls[0];
      expect(receivedEvent.tenant_id).toBe('tenant-1');
      expect(receivedEvent.payload.conversation_id).toBe('conv-1');
      expect(typeof ackFn).toBe('function');
      expect(typeof nakFn).toBe('function');
    });

    it('calling the ack callback acks the NATS message', async () => {
      const event = {
        event_type: Subjects.MESSAGE_INBOUND,
        tenant_id: 'tenant-1',
        workspace_id: 'ws-1',
        timestamp: new Date().toISOString(),
        correlation_id: 'corr-1',
        source_service: 'gateway',
        version: '1.0',
        payload: {},
      };

      const msg = makeMsg(event);
      const { js } = makeJsClient([msg]);
      const nc = makeNatsConnection(js);
      const sub = new EventSubscriber(nc);

      const handler = vi.fn().mockImplementation(async (_e, ack) => { ack(); });
      await sub.subscribe(
        { consumerName: 'test', streamName: 'MESSAGE', filterSubject: Subjects.MESSAGE_INBOUND },
        handler
      );

      await new Promise((r) => setTimeout(r, 10));
      expect(msg.ack).toHaveBeenCalledOnce();
      expect(msg.nak).not.toHaveBeenCalled();
    });

    it('calling the nack callback naks the NATS message', async () => {
      const event = {
        event_type: Subjects.AI_AGENT_INVOKED,
        tenant_id: 'tenant-1',
        workspace_id: 'ws-1',
        timestamp: new Date().toISOString(),
        correlation_id: 'corr-1',
        source_service: 'ai',
        version: '1.0',
        payload: {},
      };

      const msg = makeMsg(event);
      const { js } = makeJsClient([msg]);
      const nc = makeNatsConnection(js);
      const sub = new EventSubscriber(nc);

      const handler = vi.fn().mockImplementation(async (_e, _ack, nack) => { nack(); });
      await sub.subscribe(
        { consumerName: 'test', streamName: 'AI', filterSubject: Subjects.AI_AGENT_INVOKED },
        handler
      );

      await new Promise((r) => setTimeout(r, 10));
      expect(msg.nak).toHaveBeenCalledOnce();
      expect(msg.ack).not.toHaveBeenCalled();
    });

    it('NAKs the message and does NOT throw when the handler throws', async () => {
      const event = {
        event_type: Subjects.WORKFLOW_TRIGGERED,
        tenant_id: 'tenant-1',
        workspace_id: 'ws-1',
        timestamp: new Date().toISOString(),
        correlation_id: 'corr-1',
        source_service: 'workflow',
        version: '1.0',
        payload: {},
      };

      const msg = makeMsg(event);
      const { js } = makeJsClient([msg]);
      const nc = makeNatsConnection(js);
      const sub = new EventSubscriber(nc);

      const handler = vi.fn().mockRejectedValue(new Error('processing failed'));
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      await sub.subscribe(
        { consumerName: 'test', streamName: 'WORKFLOW', filterSubject: Subjects.WORKFLOW_TRIGGERED },
        handler
      );

      await new Promise((r) => setTimeout(r, 20));

      expect(msg.nak).toHaveBeenCalledOnce();
      expect(msg.ack).not.toHaveBeenCalled();
      stderrSpy.mockRestore();
    });

    it('NAKs the message when JSON parsing fails', async () => {
      const badData = new TextEncoder().encode('not-valid-json');
      const msg = { data: badData, ack: vi.fn(), nak: vi.fn() };

      const { js } = makeJsClient([msg as ReturnType<typeof makeMsg>]);
      const nc = makeNatsConnection(js);
      const sub = new EventSubscriber(nc);

      const handler = vi.fn();
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      await sub.subscribe(
        { consumerName: 'test', streamName: 'CONVERSATION', filterSubject: Subjects.CONVERSATION_CREATED },
        handler
      );

      await new Promise((r) => setTimeout(r, 20));

      expect(msg.nak).toHaveBeenCalledOnce();
      expect(handler).not.toHaveBeenCalled();
      stderrSpy.mockRestore();
    });
  });
});
