/**
 * NATS AI event listener.
 *
 * Subscribes to ai.agent_invoked events and generates AI responses.
 * Publishes ai.response_generated or ai.handoff_triggered depending on confidence.
 */

import type { NatsConnection } from 'nats';
import type { Knex } from 'knex';
import {
  EventSubscriber,
  EventPublisher,
  Subjects,
  type AiAgentInvokedPayload,
} from '@responio/events';
import { complete } from '../llm/client';

const SERVICE_NAME = 'ai';

export function startAgentListener(nc: NatsConnection, db: Knex): void {
  const sub = new EventSubscriber(nc);
  const publisher = new EventPublisher(nc);

  sub.subscribe<AiAgentInvokedPayload>(
    {
      consumerName: `${SERVICE_NAME}.agent-invoked`,
      streamName: 'AI',
      filterSubject: Subjects.AI_AGENT_INVOKED,
    },
    async (event, ack) => {
      const { ai_agent_id, conversation_id, contact_id } = event.payload;
      const tenantId = event.tenant_id;

      try {
        const agent = await db('ai_agents')
          .where({ id: ai_agent_id, tenant_id: tenantId, is_active: true })
          .first();

        if (!agent) {
          console.warn(`[agent-listener] Agent ${ai_agent_id} not found for tenant ${tenantId}`);
          ack();
          return;
        }

        // Fetch recent conversation messages for context (last 10)
        const messages = await db('messages')
          .where({ conversation_id, tenant_id: tenantId })
          .orderBy('created_at', 'desc')
          .limit(10)
          .select('sender_type', 'content');

        const chatHistory = messages
          .reverse()
          .filter((m: { content: string }) => m.content)
          .map((m: { sender_type: string; content: string }) => ({
            role: m.sender_type === 'contact' ? 'user' as const : 'assistant' as const,
            content: m.content,
          }));

        const result = await complete(
          [{ role: 'system', content: agent.system_prompt }, ...chatHistory],
          {
            model: agent.model,
            temperature: agent.temperature,
            max_tokens: agent.max_tokens,
            tenant_id: tenantId,
          }
        );

        const responseMessageId = crypto.randomUUID();

        await publisher.publish(Subjects.AI_RESPONSE_GENERATED, {
          tenant_id: tenantId,
          workspace_id: event.workspace_id,
          source_service: SERVICE_NAME,
          payload: {
            ai_agent_id,
            conversation_id,
            response_message_id: responseMessageId,
            confidence_score: 0.9,  // Placeholder — implement scoring in Phase 2
            model_used: result.model,
            latency_ms: result.latency_ms,
            retrieved_chunk_ids: [],
          },
        });

        // Check if we should hand off based on confidence threshold
        if (0.9 < agent.handoff_threshold) {
          await publisher.publish(Subjects.AI_HANDOFF_TRIGGERED, {
            tenant_id: tenantId,
            workspace_id: event.workspace_id,
            source_service: SERVICE_NAME,
            payload: {
              ai_agent_id,
              conversation_id,
              contact_id,
              confidence_score: 0.9,
              handoff_reason: 'low_confidence',
              context_summary: result.content.slice(0, 200),
            },
          });
        }
      } catch (err) {
        console.error(`[agent-listener] Error processing ai.agent_invoked:`, err);
      }

      ack();
    }
  );

  console.log('[agent-listener] Subscribed to ai.agent_invoked');
}
