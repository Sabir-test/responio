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

import type { NatsConnection } from 'nats';
import {
  EventSubscriber,
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

  // ── conversation.created → New Conversation trigger ───────────────────────
  sub.subscribe<ConversationCreatedPayload>(
    {
      consumerName: `${SERVICE_NAME}.conversation-created`,
      streamName: 'CONVERSATION',
      filterSubject: Subjects.CONVERSATION_CREATED,
    },
    async (event, ack) => {
      await fireWebhook(config, event.tenant_id, 'conversation-created', {
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
      await fireWebhook(config, event.tenant_id, 'message-inbound', payload);

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
      await fireWebhook(config, event.tenant_id, 'contact-updated', {
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
      await fireWebhook(config, event.tenant_id, 'lifecycle-changed', {
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
      await fireWebhook(config, event.tenant_id, 'conversation-assigned', {
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
      await fireWebhook(config, event.tenant_id, 'conversation-resolved', {
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
      await fireWebhook(config, event.tenant_id, 'ai-handoff', {
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

  console.log(`[nats-bridge] Subscribed to ${7} NATS event streams → n8n webhooks`);
}

/**
 * Fire an n8n webhook for a specific tenant + trigger.
 * n8n webhook path: /webhook/{tenantId}/{triggerPath}
 * Errors are logged but NOT re-thrown — we ack the NATS message regardless
 * to avoid blocking the event bus. Failed webhooks = no workflow execution.
 */
async function fireWebhook(
  config: BridgeConfig,
  tenantId: string,
  triggerPath: string,
  payload: Record<string, unknown>
): Promise<void> {
  const url = `${config.n8nBaseUrl}/webhook/${tenantId}/${triggerPath}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Responio-Secret': config.webhookSecret,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000), // 10s timeout
    });

    if (!res.ok && res.status !== 404) {
      // 404 = no active workflow registered for this trigger — that's fine
      console.warn(`[nats-bridge] n8n webhook ${url} returned ${res.status}`);
    }
  } catch (err) {
    // Network error, timeout, etc. — log and continue
    console.error(`[nats-bridge] Failed to fire webhook ${url}:`, err);
  }
}
