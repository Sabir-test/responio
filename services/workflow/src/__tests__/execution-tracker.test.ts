/**
 * Unit tests for the workflow execution tracker.
 * Verifies DB insert/update on triggered/completed/failed events,
 * error resilience (always acks), and duplicate-key handling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NatsConnection } from 'nats';
import type { Knex } from 'knex';

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
  Subjects: {
    WORKFLOW_TRIGGERED: 'workflow.triggered',
    WORKFLOW_COMPLETED: 'workflow.completed',
    WORKFLOW_FAILED: 'workflow.failed',
  },
}));

// ── Test constants ────────────────────────────────────────────────────────────

const TENANT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const EXEC_ID = 'exec-1111-1111-1111-111111111111';
const WF_ID = 'wf-2222-2222-2222-222222222222';
const NOW_ISO = new Date().toISOString();

function makeEvent(subject: string, payload: Record<string, unknown>) {
  return {
    event_type: subject,
    tenant_id: TENANT_ID,
    workspace_id: 'ws-1',
    timestamp: NOW_ISO,
    correlation_id: 'corr-1',
    source_service: 'workflow-bridge',
    version: '1.0',
    payload,
  };
}

function makeNc() {
  return {} as NatsConnection;
}

// ── DB mock factory ───────────────────────────────────────────────────────────

function makeDb() {
  const insertMock = vi.fn().mockResolvedValue([]);
  const updateMock = vi.fn().mockResolvedValue(1);
  const whereMock = vi.fn().mockReturnThis();

  const tableMock = {
    insert: insertMock,
    where: whereMock,
    update: updateMock,
  };

  const db = vi.fn().mockReturnValue(tableMock) as unknown as Knex;

  return { db, insertMock, updateMock, whereMock };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('startExecutionTracker', () => {
  beforeEach(async () => {
    subscribeHandlers.clear();
    vi.resetModules();
    vi.mock('@responio/events', () => ({
      EventSubscriber: vi.fn().mockImplementation(() => ({
        subscribe: vi.fn().mockImplementation((opts: { filterSubject: string }, handler: SubHandler) => {
          subscribeHandlers.set(opts.filterSubject, handler);
          return Promise.resolve();
        }),
      })),
      Subjects: {
        WORKFLOW_TRIGGERED: 'workflow.triggered',
        WORKFLOW_COMPLETED: 'workflow.completed',
        WORKFLOW_FAILED: 'workflow.failed',
      },
    }));
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('registers 3 subscriptions (triggered, completed, failed)', async () => {
    const { startExecutionTracker } = await import('../nats/execution-tracker');
    const { db } = makeDb();
    startExecutionTracker(makeNc(), db);

    expect(subscribeHandlers.size).toBe(3);
    expect(subscribeHandlers.has('workflow.triggered')).toBe(true);
    expect(subscribeHandlers.has('workflow.completed')).toBe(true);
    expect(subscribeHandlers.has('workflow.failed')).toBe(true);
  });

  describe('workflow.triggered', () => {
    it('inserts an execution row with status=running', async () => {
      const { startExecutionTracker } = await import('../nats/execution-tracker');
      const { db, insertMock } = makeDb();
      startExecutionTracker(makeNc(), db);

      const handler = subscribeHandlers.get('workflow.triggered')!;
      const ack = vi.fn();

      await handler(makeEvent('workflow.triggered', {
        execution_id: EXEC_ID,
        workflow_id: WF_ID,
        trigger_type: 'message_inbound',
        trigger_event: { foo: 'bar' },
      }), ack, vi.fn());

      expect(insertMock).toHaveBeenCalledOnce();
      const row = insertMock.mock.calls[0][0];
      expect(row.id).toBe(EXEC_ID);
      expect(row.tenant_id).toBe(TENANT_ID);
      expect(row.workflow_id).toBe(WF_ID);
      expect(row.trigger_type).toBe('message_inbound');
      expect(row.status).toBe('running');
      expect(row.trigger_payload).toBe(JSON.stringify({ foo: 'bar' }));
      expect(ack).toHaveBeenCalledOnce();
    });

    it('still acks when DB insert throws (duplicate execution_id)', async () => {
      const { startExecutionTracker } = await import('../nats/execution-tracker');
      const { db, insertMock } = makeDb();
      insertMock.mockRejectedValueOnce(new Error('duplicate key value'));
      startExecutionTracker(makeNc(), db);

      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const handler = subscribeHandlers.get('workflow.triggered')!;
      const ack = vi.fn();

      await handler(makeEvent('workflow.triggered', {
        execution_id: EXEC_ID,
        workflow_id: WF_ID,
        trigger_type: 'message_inbound',
      }), ack, vi.fn());

      expect(ack).toHaveBeenCalledOnce();
      stderrSpy.mockRestore();
    });

    it('serializes trigger_payload as empty JSON when trigger_event is undefined', async () => {
      const { startExecutionTracker } = await import('../nats/execution-tracker');
      const { db, insertMock } = makeDb();
      startExecutionTracker(makeNc(), db);

      const handler = subscribeHandlers.get('workflow.triggered')!;
      await handler(makeEvent('workflow.triggered', {
        execution_id: EXEC_ID,
        workflow_id: WF_ID,
        trigger_type: 'scheduled',
      }), vi.fn(), vi.fn());

      const row = insertMock.mock.calls[0][0];
      expect(row.trigger_payload).toBe('{}');
    });
  });

  describe('workflow.completed', () => {
    it('updates execution row to status=success', async () => {
      const { startExecutionTracker } = await import('../nats/execution-tracker');
      const { db, updateMock, whereMock } = makeDb();
      startExecutionTracker(makeNc(), db);

      const handler = subscribeHandlers.get('workflow.completed')!;
      const ack = vi.fn();

      await handler(makeEvent('workflow.completed', {
        execution_id: EXEC_ID,
        workflow_id: WF_ID,
        duration_ms: 1200,
        steps_executed: 3,
      }), ack, vi.fn());

      expect(whereMock).toHaveBeenCalledWith({ id: EXEC_ID, tenant_id: TENANT_ID });
      const updateArg = updateMock.mock.calls[0][0];
      expect(updateArg.status).toBe('success');
      expect(updateArg.finished_at).toBeInstanceOf(Date);
      expect(ack).toHaveBeenCalledOnce();
    });

    it('still acks when DB update throws', async () => {
      const { startExecutionTracker } = await import('../nats/execution-tracker');
      const { db, updateMock } = makeDb();
      updateMock.mockRejectedValueOnce(new Error('connection lost'));
      startExecutionTracker(makeNc(), db);

      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const handler = subscribeHandlers.get('workflow.completed')!;
      const ack = vi.fn();

      await handler(makeEvent('workflow.completed', {
        execution_id: EXEC_ID,
        workflow_id: WF_ID,
        duration_ms: 500,
        steps_executed: 1,
      }), ack, vi.fn());

      expect(ack).toHaveBeenCalledOnce();
      stderrSpy.mockRestore();
    });
  });

  describe('workflow.failed', () => {
    it('updates execution row to status=error with error_message', async () => {
      const { startExecutionTracker } = await import('../nats/execution-tracker');
      const { db, updateMock, whereMock } = makeDb();
      startExecutionTracker(makeNc(), db);

      const handler = subscribeHandlers.get('workflow.failed')!;
      const ack = vi.fn();

      await handler(makeEvent('workflow.failed', {
        execution_id: EXEC_ID,
        workflow_id: WF_ID,
        step_id: 'step-1',
        error_message: 'Action HTTP request failed',
        retry_count: 2,
      }), ack, vi.fn());

      expect(whereMock).toHaveBeenCalledWith({ id: EXEC_ID, tenant_id: TENANT_ID });
      const updateArg = updateMock.mock.calls[0][0];
      expect(updateArg.status).toBe('error');
      expect(updateArg.error_message).toBe('Action HTTP request failed');
      expect(updateArg.finished_at).toBeInstanceOf(Date);
      expect(ack).toHaveBeenCalledOnce();
    });

    it('still acks when DB update throws', async () => {
      const { startExecutionTracker } = await import('../nats/execution-tracker');
      const { db, updateMock } = makeDb();
      updateMock.mockRejectedValueOnce(new Error('timeout'));
      startExecutionTracker(makeNc(), db);

      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const handler = subscribeHandlers.get('workflow.failed')!;
      const ack = vi.fn();

      await handler(makeEvent('workflow.failed', {
        execution_id: EXEC_ID,
        workflow_id: WF_ID,
        step_id: 'step-1',
        error_message: 'timeout',
        retry_count: 5,
      }), ack, vi.fn());

      expect(ack).toHaveBeenCalledOnce();
      stderrSpy.mockRestore();
    });
  });
});
