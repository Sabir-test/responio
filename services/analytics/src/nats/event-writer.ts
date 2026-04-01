/**
 * NATS → ClickHouse event writer.
 *
 * Subscribes to all core NATS streams and writes denormalized rows
 * to ClickHouse for analytics queries.
 *
 * Uses async inserts (fire-and-forget) for throughput. ClickHouse
 * buffers and flushes in batches automatically.
 */

import type { NatsConnection } from 'nats';
import {
  EventSubscriber,
  Subjects,
  type ConversationCreatedPayload,
  type ConversationResolvedPayload,
  type MessageInboundPayload,
  type MessageOutboundPayload,
  type ContactCreatedPayload,
  type ContactLifecycleChangedPayload,
} from '@responio/events';
import { getClickHouseClient } from '../clickhouse/client';

const SERVICE_NAME = 'analytics';

export function startEventWriter(nc: NatsConnection): void {
  const sub = new EventSubscriber(nc);

  // ── Conversations ─────────────────────────────────────────────────────────
  sub.subscribe<ConversationCreatedPayload>(
    { consumerName: `${SERVICE_NAME}.conv-created`, streamName: 'CONVERSATION', filterSubject: Subjects.CONVERSATION_CREATED },
    async (event, ack) => {
      await writeToClickHouse('conversations_events', {
        tenant_id: event.tenant_id,
        conversation_id: event.payload.conversation_id,
        contact_id: event.payload.contact_id,
        channel_type: event.payload.channel_type,
        inbox_id: event.payload.inbox_id,
        assignee_id: event.payload.assignee_id ?? '',
        status: 'open',
        first_reply_seconds: 0,
        resolution_seconds: 0,
        created_at: event.timestamp,
        resolved_at: null,
      });
      ack();
    }
  );

  sub.subscribe<ConversationResolvedPayload>(
    { consumerName: `${SERVICE_NAME}.conv-resolved`, streamName: 'CONVERSATION', filterSubject: Subjects.CONVERSATION_RESOLVED },
    async (event, ack) => {
      await writeToClickHouse('conversations_events', {
        tenant_id: event.tenant_id,
        conversation_id: event.payload.conversation_id,
        contact_id: event.payload.contact_id,
        channel_type: '',
        inbox_id: '',
        assignee_id: event.payload.resolved_by,
        status: 'resolved',
        first_reply_seconds: 0,
        resolution_seconds: event.payload.resolution_time_seconds,
        created_at: event.timestamp,
        resolved_at: event.timestamp,
      });
      ack();
    }
  );

  // ── Messages ──────────────────────────────────────────────────────────────
  sub.subscribe<MessageInboundPayload>(
    { consumerName: `${SERVICE_NAME}.msg-inbound`, streamName: 'MESSAGE', filterSubject: Subjects.MESSAGE_INBOUND },
    async (event, ack) => {
      await writeToClickHouse('messages_events', {
        tenant_id: event.tenant_id,
        message_id: event.payload.message_id,
        conversation_id: event.payload.conversation_id,
        contact_id: event.payload.contact_id,
        channel_type: event.payload.channel_type,
        content_type: event.payload.content_type,
        direction: 'inbound',
        created_at: event.timestamp,
      });
      ack();
    }
  );

  sub.subscribe<MessageOutboundPayload>(
    { consumerName: `${SERVICE_NAME}.msg-outbound`, streamName: 'MESSAGE', filterSubject: Subjects.MESSAGE_OUTBOUND },
    async (event, ack) => {
      await writeToClickHouse('messages_events', {
        tenant_id: event.tenant_id,
        message_id: event.payload.message_id,
        conversation_id: event.payload.conversation_id,
        contact_id: event.payload.contact_id,
        channel_type: event.payload.channel_type,
        content_type: event.payload.content_type,
        direction: 'outbound',
        created_at: event.timestamp,
      });
      ack();
    }
  );

  // ── Contacts ──────────────────────────────────────────────────────────────
  sub.subscribe<ContactCreatedPayload>(
    { consumerName: `${SERVICE_NAME}.contact-created`, streamName: 'CONTACT', filterSubject: Subjects.CONTACT_CREATED },
    async (event, ack) => {
      await writeToClickHouse('contact_events', {
        tenant_id: event.tenant_id,
        contact_id: event.payload.contact_id,
        event_type: 'created',
        lifecycle_stage: event.payload.lifecycle_stage,
        channel_type: event.payload.channel_type,
        created_at: event.timestamp,
      });
      ack();
    }
  );

  sub.subscribe<ContactLifecycleChangedPayload>(
    { consumerName: `${SERVICE_NAME}.lifecycle-changed`, streamName: 'CONTACT', filterSubject: Subjects.CONTACT_LIFECYCLE_CHANGED },
    async (event, ack) => {
      await writeToClickHouse('contact_events', {
        tenant_id: event.tenant_id,
        contact_id: event.payload.contact_id,
        event_type: 'lifecycle_changed',
        lifecycle_stage: event.payload.new_stage,
        channel_type: '',
        created_at: event.timestamp,
      });
      ack();
    }
  );

  console.log('[event-writer] Subscribed to 6 NATS streams → ClickHouse');
}

async function writeToClickHouse(
  table: string,
  row: Record<string, unknown>
): Promise<void> {
  const ch = getClickHouseClient();
  try {
    await ch.insert({
      table,
      values: [row],
      format: 'JSONEachRow',
    });
  } catch (err) {
    console.error(`[event-writer] Failed to write to ClickHouse table ${table}:`, err);
  }
}
