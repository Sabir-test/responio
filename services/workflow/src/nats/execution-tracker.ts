/**
 * Workflow Execution Tracker
 *
 * Listens to WORKFLOW_TRIGGERED and WORKFLOW_FAILED NATS events and writes
 * execution records to the workflow_executions table for audit and retry tracking.
 *
 * This decouples execution recording from the bridge — the bridge fires the
 * webhook and emits an event; this subscriber persists it to the DB.
 */

import type { NatsConnection } from 'nats';
import type { Knex } from 'knex';
import {
  EventSubscriber,
  Subjects,
  type WorkflowTriggeredPayload,
  type WorkflowFailedPayload,
} from '@responio/events';

const SERVICE_NAME = 'workflow-execution-tracker';

export function startExecutionTracker(nc: NatsConnection, db: Knex): void {
  const sub = new EventSubscriber(nc);

  // ── workflow.triggered → INSERT execution row as 'running' ───────────────
  sub.subscribe<WorkflowTriggeredPayload>(
    {
      consumerName: `${SERVICE_NAME}.triggered`,
      streamName: 'WORKFLOW',
      filterSubject: Subjects.WORKFLOW_TRIGGERED,
    },
    async (event, ack) => {
      try {
        await db('workflow_executions').insert({
          id: event.payload.execution_id,
          tenant_id: event.tenant_id,
          workflow_id: event.payload.workflow_id,
          trigger_type: event.payload.trigger_type,
          trigger_payload: JSON.stringify(event.payload.trigger_event ?? {}),
          status: 'running',
          started_at: new Date(event.timestamp),
        });
      } catch (err) {
        // Log but still ack — duplicate execution_id on re-delivery is non-fatal
        process.stderr.write(JSON.stringify({ level: 'error', msg: 'Failed to insert workflow_execution', err: String(err) }) + '\n');
      }
      ack();
    }
  );

  // ── workflow.failed → UPDATE execution row to 'error' ────────────────────
  sub.subscribe<WorkflowFailedPayload>(
    {
      consumerName: `${SERVICE_NAME}.failed`,
      streamName: 'WORKFLOW',
      filterSubject: Subjects.WORKFLOW_FAILED,
    },
    async (event, ack) => {
      try {
        await db('workflow_executions')
          .where({ id: event.payload.execution_id, tenant_id: event.tenant_id })
          .update({
            status: 'error',
            finished_at: new Date(),
            error_message: event.payload.error_message,
          });
      } catch (err) {
        process.stderr.write(JSON.stringify({ level: 'error', msg: 'Failed to update workflow_execution on failure', err: String(err) }) + '\n');
      }
      ack();
    }
  );

  // ── workflow.completed → UPDATE execution row to 'success' ───────────────
  sub.subscribe<WorkflowTriggeredPayload>(
    {
      consumerName: `${SERVICE_NAME}.completed`,
      streamName: 'WORKFLOW',
      filterSubject: Subjects.WORKFLOW_COMPLETED,
    },
    async (event, ack) => {
      try {
        await db('workflow_executions')
          .where({ id: event.payload.execution_id, tenant_id: event.tenant_id })
          .update({
            status: 'success',
            finished_at: new Date(),
          });
      } catch (err) {
        process.stderr.write(JSON.stringify({ level: 'error', msg: 'Failed to update workflow_execution on completion', err: String(err) }) + '\n');
      }
      ack();
    }
  );
}
