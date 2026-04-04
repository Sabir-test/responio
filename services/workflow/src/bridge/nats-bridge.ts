/**
 * NATS → n8n Trigger Bridge
 *
 * Subscribes to NATS event streams and fires n8n webhook triggers.
 * This is what connects the platform event bus to the workflow engine.
 *
 * Each trigger type maps to a unique webhook path per tenant:
 *   POST http://n8n:5678/webhook/{tenantId}/{trigger-path}
 *
 * See: build checklist task #21, CLAUDE.md n8n Integration Architecture
 */

import { randomUUID } from 'crypto';
import type { NatsConnection } from 'nats';
import {
  EventSubscriber,
  EventPublisher,
  Subjects,
  type NatsEvent,
  type MessageInboundPayload,
  type ConversationCreatedPayload,
  type ContactFieldUpdatedPayload,
  type ContactLifecycleChangedPayload,
  type ConversationAssignedPayload,
  type ConversationResolvedPayload,
  type AiHandoffTriggeredPayload,
} from '@responio/events';

export interface BridgeConfig {
  n8nBaseUrl: string;
  /** Internal secret used when calling n8n webhooks — n8n validates this */
  webhookSecret: string;
}

const SERVICE_NAME = 'workflow-bridge';

export function startNatsBridge(nc: NatsConnection, config: BridgeConfig): void {
  const sub = new EventSubscriber(nc);
  const publisher = new EventPublisher(nc);

  // ── conversation.created → New Conversation trigger ───────────────────────
  sub.subscribe<ConversationCreatedPayload>(
    {
      consumerName: `${SERVICE_NAME}.conversation-created`,
      streamName: 'CONVERSATION',
      filterSubject: Subjects.CONVERSATION_CREATED,
    },
    async (event, ack) => {
      await fireWebhook(config, publisher, event.tenant_id, event.workspace_id, 'conversation_created', 'conversation-created', {
        conversation_id: event.payload.conversation_id,
        contact_id: event.payload.contact_id,
        channel_type: event.payload.channel_type,
        inbox_id: event.payload.inbox_id,
        initial_message_id: event.payload.initial_message_id,
        workspace_id: event.workspace_id,
      });
      ack();
    }
  );

  // ── message.inbound → Inbound Message trigger + Keyword Match filter ───────
  sub.subscribe<MessageInboundPayload>(
    {
      consumerName: `${SERVICE_NAME}.message-inbound`,
      streamName: 'MESSAGE',
      filterSubject: Subjects.MESSAGE_INBOUND,
    },
    async (event, ack) => {
      const payload = {
        message_id: event.payload.message_id,
        conversation_id: event.payload.conversation_id,
        contact_id: event.payload.contact_id,
        content: event.payload.content,
        channel_type: event.payload.channel_type,
        metadata: event.payload.metadata,
        workspace_id: event.workspace_id,
      };

      // Fire general inbound message trigger
      await fireWebhook(config, publisher, event.tenant_id, event.workspace_id, 'message_inbound', 'message-inbound', payload);

      ack();
    }
  );

  // ── contact.field_updated → Contact Field Updated trigger ─────────────────
  sub.subscribe<ContactFieldUpdatedPayload>(
    {
      consumerName: `${SERVICE_NAME}.contact-updated`,
      streamName: 'CONTACT',
      filterSubject: Subjects.CONTACT_UPDATED,
    },
    async (event, ack) => {
      await fireWebhook(config, publisher, event.tenant_id, event.workspace_id, 'contact_field_updated', 'contact-updated', {
        contact_id: event.payload.contact_id,
        field_name: event.payload.field_name,
        old_value: event.payload.old_value,
        new_value: event.payload.new_value,
        updated_by: event.payload.updated_by,
        workspace_id: event.workspace_id,
      });
      ack();
    }
  );

  // ── contact.lifecycle_changed → Lifecycle Stage Changed trigger ───────────
  sub.subscribe<ContactLifecycleChangedPayload>(
    {
      consumerName: `${SERVICE_NAME}.lifecycle-changed`,
      streamName: 'CONTACT',
      filterSubject: Subjects.CONTACT_LIFECYCLE_CHANGED,
    },
    async (event, ack) => {
      await fireWebhook(config, publisher, event.tenant_id, event.workspace_id, 'lifecycle_changed', 'lifecycle-changed', {
        contact_id: event.payload.contact_id,
        old_stage: event.payload.old_stage,
        new_stage: event.payload.new_stage,
        workspace_id: event.workspace_id,
        changed_by: event.payload.changed_by,
      });
      ack();
    }
  );

  // ── conversation.assigned → Conversation Assigned trigger ─────────────────
  sub.subscribe<ConversationAssignedPayload>(
    {
      consumerName: `${SERVICE_NAME}.conversation-assigned`,
      streamName: 'CONVERSATION',
      filterSubject: Subjects.CONVERSATION_ASSIGNED,
    },
    async (event, ack) => {
      await fireWebhook(config, publisher, event.tenant_id, event.workspace_id, 'conversation_assigned', 'conversation-assigned', {
        conversation_id: event.payload.conversation_id,
        assignee_id: event.payload.assignee_id,
        previous_assignee_id: event.payload.previous_assignee_id,
        assignment_method: event.payload.assignment_method,
        workspace_id: event.workspace_id,
      });
      ack();
    }
  );

  // ── conversation.resolved → Conversation Resolved trigger ─────────────────
  sub.subscribe<ConversationResolvedPayload>(
    {
      consumerName: `${SERVICE_NAME}.conversation-resolved`,
      streamName: 'CONVERSATION',
      filterSubject: Subjects.CONVERSATION_RESOLVED,
    },
    async (event, ack) => {
      await fireWebhook(config, publisher, event.tenant_id, event.workspace_id, 'conversation_resolved', 'conversation-resolved', {
        conversation_id: event.payload.conversation_id,
        resolved_by: event.payload.resolved_by,
        resolution_time_seconds: event.payload.resolution_time_seconds,
        contact_id: event.payload.contact_id,
        workspace_id: event.workspace_id,
      });
      ack();
    }
  );

  // ── ai.handoff_triggered → AI Handoff trigger ─────────────────────────────
  sub.subscribe<AiHandoffTriggeredPayload>(
    {
      consumerName: `${SERVICE_NAME}.ai-handoff`,
      streamName: 'AI',
      filterSubject: Subjects.AI_HANDOFF_TRIGGERED,
    },
    async (event, ack) => {
      await fireWebhook(config, publisher, event.tenant_id, event.workspace_id, 'ai_handoff', 'ai-handoff', {
        conversation_id: event.payload.conversation_id,
        ai_agent_id: event.payload.ai_agent_id,
        confidence_score: event.payload.confidence_score,
        handoff_reason: event.payload.handoff_reason,
        context_summary: event.payload.context_summary,
        contact_id: event.payload.contact_id,
        workspace_id: event.workspace_id,
      });
      ack();
    }
  );

  // Bridge subscriptions started — 7 NATS streams → n8n webhooks
}

/**
 * Fire an n8n webhook for a specific tenant + trigger, then emit a
 * WORKFLOW_TRIGGERED event so the execution tracker can persist the run.
 *
 * n8n webhook path: /webhook/{tenantId}/{triggerPath}
 * Errors are logged but NOT re-thrown — we ack the NATS message regardless.
 */
async function fireWebhook(
  config: BridgeConfig,
  publisher: EventPublisher,
  tenantId: string,
  workspaceId: string,
  triggerType: string,
  triggerPath: string,
  payload: Record<string, unknown>
): Promise<void> {
  const url = `${config.n8nBaseUrl}/webhook/${tenantId}/${triggerPath}`;
  const executionId = randomUUID();

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Responio-Secret': config.webhookSecret,
      },
      body: JSON.stringify({ ...payload, _execution_id: executionId }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok && res.status !== 404) {
      process.stderr.write(JSON.stringify({ level: 'warn', msg: 'n8n webhook non-OK', url, status: res.status }) + '\n');
      return;
    }

    if (res.status === 404) return; // No active workflow for this trigger — skip

    // Emit WORKFLOW_TRIGGERED so execution-tracker persists the execution row
    await publisher.publish(Subjects.WORKFLOW_TRIGGERED, {
      tenant_id: tenantId,
      workspace_id: workspaceId,
      source_service: SERVICE_NAME,
      payload: {
        execution_id: executionId,
        workflow_id: '',  // Resolved later by execution tracker from DB lookup
        trigger_type: triggerType,
        trigger_event: payload,
      },
    });
  } catch (err) {
    process.stderr.write(JSON.stringify({ level: 'error', msg: 'Failed to fire n8n webhook', url, err: String(err) }) + '\n');
  }
}
