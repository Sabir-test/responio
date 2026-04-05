/**
 * Unit tests for the AI agent NATS listener.
 * Verifies agent lookup, conversation context fetching, LLM invocation,
 * response/handoff event publishing, and error resilience.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NatsConnection } from 'nats';
import type { Knex } from 'knex';

// ── Captured subscription handler ─────────────────────────────────────────────

type SubHandler = (event: Record<string, unknown>, ack: () => void, nack: () => void) => Promise<void>;
let capturedHandler: SubHandler | null = null;

// ── LLM complete mock ─────────────────────────────────────────────────────────

const completeMock = vi.fn();

vi.mock('../llm/client', () => ({
  complete: completeMock,
}));

vi.mock('@responio/events', () => ({
  EventSubscriber: vi.fn().mockImplementation(() => ({
    subscribe: vi.fn().mockImplementation((_opts: unknown, handler: SubHandler) => {
      capturedHandler = handler;
      return Promise.resolve();
    }),
  })),
  EventPublisher: vi.fn().mockImplementation(() => ({
    publish: vi.fn().mockResolvedValue('1'),
  })),
  Subjects: {
    AI_AGENT_INVOKED: 'ai.agent_invoked',
    AI_RESPONSE_GENERATED: 'ai.response_generated',
    AI_HANDOFF_TRIGGERED: 'ai.handoff_triggered',
  },
}));

// ── Test constants ─────────────────────────────────────────────────────────────

const TENANT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const AI_AGENT_ID = 'agent-1111-1111-1111-111111111111';
const CONV_ID = 'conv-2222-2222-2222-222222222222';
const CONTACT_ID = 'c-3333-3333-3333-333333333333';

function makeEvent(payload: Record<string, unknown>) {
  return {
    event_type: 'ai.agent_invoked',
    tenant_id: TENANT_ID,
    workspace_id: 'ws-1',
    timestamp: new Date().toISOString(),
    correlation_id: 'corr-1',
    source_service: 'inbox',
    version: '1.0',
    payload,
  };
}

const DEFAULT_AGENT = {
  id: AI_AGENT_ID,
  tenant_id: TENANT_ID,
  is_active: true,
  system_prompt: 'You are a helpful assistant.',
  model: 'gpt-4o-mini',
  temperature: 0.1,
  max_tokens: 512,
  handoff_threshold: 0.5, // confidence of 0.9 > 0.5, so NO handoff by default
};

const DEFAULT_MESSAGES = [
  { sender_type: 'contact', content: 'Hello!' },
  { sender_type: 'agent', content: 'Hi there!' },
];

const DEFAULT_LLM_RESULT = {
  content: 'How can I help you today?',
  model: 'gpt-4o-mini',
  usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  latency_ms: 120,
};

function makeNc() {
  return {} as NatsConnection;
}

// ── DB mock factory ───────────────────────────────────────────────────────────

function makeDb(agentRow = DEFAULT_AGENT, messages = DEFAULT_MESSAGES) {
  const firstMock = vi.fn().mockResolvedValue(agentRow);
  const selectMock = vi.fn().mockResolvedValue(messages);
  const orderByMock = vi.fn().mockReturnThis();
  const limitMock = vi.fn().mockReturnThis();
  const selectFieldsMock = vi.fn().mockResolvedValue(messages);
  const whereMock = vi.fn().mockReturnThis();

  const messagesChain = {
    where: whereMock,
    orderBy: orderByMock,
    limit: limitMock,
    select: selectFieldsMock,
  };

  orderByMock.mockReturnValue({ limit: limitMock });
  limitMock.mockReturnValue({ select: selectFieldsMock });

  return vi.fn((table: string) => {
    if (table === 'ai_agents') {
      return { where: vi.fn().mockReturnThis(), first: firstMock };
    }
    if (table === 'messages') {
      return messagesChain;
    }
    return { where: vi.fn().mockReturnThis(), first: vi.fn().mockResolvedValue(null) };
  }) as unknown as Knex;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('startAgentListener', () => {
  let publishMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    capturedHandler = null;
    completeMock.mockReset();
    completeMock.mockResolvedValue(DEFAULT_LLM_RESULT);

    publishMock = vi.fn().mockResolvedValue('1');
    const { EventPublisher, EventSubscriber } = await import('@responio/events');
    (EventSubscriber as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      subscribe: vi.fn().mockImplementation((_opts: unknown, handler: SubHandler) => {
        capturedHandler = handler;
        return Promise.resolve();
      }),
    }));
    (EventPublisher as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      publish: publishMock,
    }));
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('subscribes to ai.agent_invoked', async () => {
    const { startAgentListener } = await import('../nats/agent-listener');
    startAgentListener(makeNc(), makeDb());
    expect(capturedHandler).not.toBeNull();
  });

  it('publishes AI_RESPONSE_GENERATED after a successful LLM call', async () => {
    const { startAgentListener } = await import('../nats/agent-listener');
    const db = makeDb();
    startAgentListener(makeNc(), db);

    const ack = vi.fn();
    await capturedHandler!(makeEvent({
      ai_agent_id: AI_AGENT_ID,
      conversation_id: CONV_ID,
      contact_id: CONTACT_ID,
      input_message_id: 'msg-1',
    }), ack, vi.fn());

    expect(publishMock).toHaveBeenCalledOnce();
    const [subject, params] = publishMock.mock.calls[0];
    expect(subject).toBe('ai.response_generated');
    expect(params.tenant_id).toBe(TENANT_ID);
    expect(params.payload.ai_agent_id).toBe(AI_AGENT_ID);
    expect(params.payload.conversation_id).toBe(CONV_ID);
    expect(params.payload.model_used).toBe('gpt-4o-mini');
    expect(params.payload.confidence_score).toBe(0.9);
    expect(ack).toHaveBeenCalledOnce();
  });

  it('calls complete() with the system prompt and reversed chat history', async () => {
    const { startAgentListener } = await import('../nats/agent-listener');
    const db = makeDb(DEFAULT_AGENT, [
      { sender_type: 'contact', content: 'Hello!' },
      { sender_type: 'agent', content: 'Hi there!' },
    ]);
    startAgentListener(makeNc(), db);

    await capturedHandler!(makeEvent({
      ai_agent_id: AI_AGENT_ID,
      conversation_id: CONV_ID,
      contact_id: CONTACT_ID,
      input_message_id: 'msg-1',
    }), vi.fn(), vi.fn());

    expect(completeMock).toHaveBeenCalledOnce();
    const [messages, options] = completeMock.mock.calls[0];
    expect(messages[0]).toEqual({ role: 'system', content: 'You are a helpful assistant.' });
    expect(messages[1]).toEqual({ role: 'user', content: 'Hello!' });
    expect(messages[2]).toEqual({ role: 'assistant', content: 'Hi there!' });
    expect(options.tenant_id).toBe(TENANT_ID);
    expect(options.model).toBe('gpt-4o-mini');
  });

  it('publishes AI_HANDOFF_TRIGGERED when confidence < handoff_threshold', async () => {
    const { startAgentListener } = await import('../nats/agent-listener');
    // handoff_threshold = 0.95 means our confidence of 0.9 triggers handoff
    const agentWithLowThreshold = { ...DEFAULT_AGENT, handoff_threshold: 0.95 };
    const db = makeDb(agentWithLowThreshold);
    startAgentListener(makeNc(), db);

    const ack = vi.fn();
    await capturedHandler!(makeEvent({
      ai_agent_id: AI_AGENT_ID,
      conversation_id: CONV_ID,
      contact_id: CONTACT_ID,
      input_message_id: 'msg-1',
    }), ack, vi.fn());

    // Both response and handoff should be published
    expect(publishMock).toHaveBeenCalledTimes(2);
    const subjects = publishMock.mock.calls.map((c: unknown[]) => c[0]);
    expect(subjects).toContain('ai.response_generated');
    expect(subjects).toContain('ai.handoff_triggered');

    const handoffCall = publishMock.mock.calls.find((c: unknown[]) => c[0] === 'ai.handoff_triggered')!;
    expect(handoffCall[1].payload.handoff_reason).toBe('low_confidence');
    expect(handoffCall[1].payload.contact_id).toBe(CONTACT_ID);
  });

  it('does NOT publish handoff when confidence >= handoff_threshold', async () => {
    const { startAgentListener } = await import('../nats/agent-listener');
    // threshold=0.5: confidence of 0.9 is NOT < 0.5 so no handoff
    const db = makeDb(DEFAULT_AGENT);
    startAgentListener(makeNc(), db);

    await capturedHandler!(makeEvent({
      ai_agent_id: AI_AGENT_ID,
      conversation_id: CONV_ID,
      contact_id: CONTACT_ID,
      input_message_id: 'msg-1',
    }), vi.fn(), vi.fn());

    expect(publishMock).toHaveBeenCalledOnce();
    expect(publishMock.mock.calls[0][0]).toBe('ai.response_generated');
  });

  it('acks without calling LLM when agent is not found', async () => {
    const { startAgentListener } = await import('../nats/agent-listener');
    const db = makeDb(undefined as unknown as typeof DEFAULT_AGENT);
    startAgentListener(makeNc(), db);

    const ack = vi.fn();
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await capturedHandler!(makeEvent({
      ai_agent_id: AI_AGENT_ID,
      conversation_id: CONV_ID,
      contact_id: CONTACT_ID,
      input_message_id: 'msg-1',
    }), ack, vi.fn());

    expect(completeMock).not.toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledOnce();
    consoleSpy.mockRestore();
  });

  it('acks even when the LLM call throws', async () => {
    const { startAgentListener } = await import('../nats/agent-listener');
    completeMock.mockRejectedValueOnce(new Error('LLM timeout'));
    const db = makeDb();
    startAgentListener(makeNc(), db);

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ack = vi.fn();

    await capturedHandler!(makeEvent({
      ai_agent_id: AI_AGENT_ID,
      conversation_id: CONV_ID,
      contact_id: CONTACT_ID,
      input_message_id: 'msg-1',
    }), ack, vi.fn());

    expect(ack).toHaveBeenCalledOnce();
    consoleSpy.mockRestore();
  });
});
