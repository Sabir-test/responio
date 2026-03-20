import { randomUUID } from 'crypto';

/**
 * Standard NATS JetStream event envelope.
 * All cross-service events MUST use this structure.
 * See CLAUDE.md and ADR-003 for multi-tenancy rules.
 */
export interface NatsEvent<P = Record<string, unknown>> {
  /** Dot-notation event type, e.g. "conversation.created" */
  event_type: string;
  /** Account/tenant UUID */
  tenant_id: string;
  /** Workspace UUID (subset of tenant) */
  workspace_id: string;
  /** ISO 8601 UTC timestamp */
  timestamp: string;
  /** UUID for idempotency/deduplication */
  correlation_id: string;
  /** Originating service name, e.g. "inbox" */
  source_service: string;
  /** Schema version for forward compatibility */
  version: string;
  /** Event-specific payload */
  payload: P;
}

export function createEvent<P>(
  params: Omit<NatsEvent<P>, 'timestamp' | 'correlation_id' | 'version'> & {
    version?: string;
  }
): NatsEvent<P> {
  return {
    ...params,
    version: params.version ?? '1.0',
    timestamp: new Date().toISOString(),
    correlation_id: randomUUID(),
  };
}

// ─── Conversation Events ──────────────────────────────────────────────────────

export interface ConversationCreatedPayload {
  conversation_id: string;
  contact_id: string;
  inbox_id: string;
  channel_type: ChannelType;
  assignee_id: string | null;
  initial_message_id: string | null;
}

export interface ConversationAssignedPayload {
  conversation_id: string;
  assignee_id: string;
  previous_assignee_id: string | null;
  assignment_method: 'manual' | 'round_robin' | 'least_busy' | 'ai_routing';
}

export interface ConversationResolvedPayload {
  conversation_id: string;
  resolved_by: string;
  resolution_time_seconds: number;
  contact_id: string;
}

export interface ConversationReopenedPayload {
  conversation_id: string;
  reopened_by: string;
  contact_id: string;
}

// ─── Message Events ───────────────────────────────────────────────────────────

export interface MessageInboundPayload {
  message_id: string;
  conversation_id: string;
  contact_id: string;
  channel_type: ChannelType;
  content: string;
  content_type: MessageContentType;
  channel_message_id: string;
  metadata: Record<string, unknown>;
}

export interface MessageOutboundPayload {
  message_id: string;
  conversation_id: string;
  contact_id: string;
  channel_type: ChannelType;
  content: string;
  content_type: MessageContentType;
  sent_by: string | 'ai_agent';
}

export interface MessageDeliveryPayload {
  message_id: string;
  conversation_id: string;
  channel_message_id: string;
  status: MessageDeliveryStatus;
  timestamp: string;
}

// ─── Contact Events ───────────────────────────────────────────────────────────

export interface ContactCreatedPayload {
  contact_id: string;
  phone: string | null;
  email: string | null;
  name: string | null;
  lifecycle_stage: LifecycleStage;
  channel_type: ChannelType;
}

export interface ContactFieldUpdatedPayload {
  contact_id: string;
  field_name: string;
  old_value: unknown;
  new_value: unknown;
  updated_by: string | 'system';
}

export interface ContactLifecycleChangedPayload {
  contact_id: string;
  old_stage: LifecycleStage;
  new_stage: LifecycleStage;
  workspace_id: string;
  changed_by: string | 'workflow' | 'ai_agent';
}

export interface ContactMergedPayload {
  primary_contact_id: string;
  merged_contact_ids: string[];
  merge_reason: 'phone_match' | 'email_match' | 'manual';
}

// ─── AI Events ────────────────────────────────────────────────────────────────

export interface AiAgentInvokedPayload {
  ai_agent_id: string;
  conversation_id: string;
  contact_id: string;
  input_message_id: string;
}

export interface AiResponseGeneratedPayload {
  ai_agent_id: string;
  conversation_id: string;
  response_message_id: string;
  confidence_score: number;
  model_used: string;
  latency_ms: number;
  retrieved_chunk_ids: string[];
}

export interface AiHandoffTriggeredPayload {
  ai_agent_id: string;
  conversation_id: string;
  contact_id: string;
  confidence_score: number;
  handoff_reason: 'low_confidence' | 'explicit_request' | 'topic_boundary' | 'error';
  context_summary: string;
}

// ─── Billing Events ───────────────────────────────────────────────────────────

export interface BillingMacIncrementedPayload {
  contact_id: string;
  billing_period: string; // "2026-03"
  current_mac_count: number;
}

export interface BillingThresholdWarningPayload {
  threshold_pct: 80 | 90 | 100;
  current_mac_count: number;
  mac_limit: number;
  plan_tier: PlanTier;
}

// ─── Workflow Events ──────────────────────────────────────────────────────────

export interface WorkflowTriggeredPayload {
  workflow_id: string;
  execution_id: string;
  trigger_type: WorkflowTriggerType;
  trigger_event?: NatsEvent;
}

export interface WorkflowStepCompletedPayload {
  workflow_id: string;
  execution_id: string;
  step_id: string;
  step_type: string;
  duration_ms: number;
  output: Record<string, unknown>;
}

export interface WorkflowFailedPayload {
  workflow_id: string;
  execution_id: string;
  step_id: string;
  error_message: string;
  retry_count: number;
}

// ─── Enums & Shared Types ─────────────────────────────────────────────────────

export type ChannelType =
  | 'whatsapp'
  | 'telegram'
  | 'email'
  | 'sms'
  | 'facebook_messenger'
  | 'instagram_dm'
  | 'web_chat'
  | 'line'
  | 'viber'
  | 'tiktok_dm'
  | 'custom';

export type MessageContentType =
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'document'
  | 'location'
  | 'sticker'
  | 'template'
  | 'interactive';

export type MessageDeliveryStatus = 'sent' | 'delivered' | 'read' | 'failed';

export type LifecycleStage =
  | 'new_lead'
  | 'qualified'
  | 'hot_lead'
  | 'customer'
  | 'churned'
  | string; // Allow custom stages

export type PlanTier = 'starter' | 'growth' | 'advanced' | 'enterprise';

export type WorkflowTriggerType =
  | 'conversation_created'
  | 'message_inbound'
  | 'keyword_match'
  | 'contact_field_updated'
  | 'lifecycle_changed'
  | 'conversation_assigned'
  | 'conversation_resolved'
  | 'broadcast_reply'
  | 'ai_handoff'
  | 'scheduled'
  | 'external_webhook';
