import { connect, NatsConnection, JetStreamManager, StreamConfig, RetentionPolicy, StorageType } from 'nats';

/**
 * NATS JetStream stream definitions.
 * These must be created before any services publish/consume events.
 *
 * NATS_REPLICAS: set to 1 for local dev, 3 for production NATS cluster.
 * Example: NATS_REPLICAS=3 for a 3-node JetStream cluster.
 */
const NATS_REPLICAS = Math.max(1, Number(process.env.NATS_REPLICAS ?? '1'));

export const STREAM_CONFIGS: StreamConfig[] = [
  {
    name: 'CONVERSATION',
    subjects: ['conversation.*'],
    retention: RetentionPolicy.Limits,
    storage: StorageType.File,
    max_age: 7 * 24 * 60 * 60 * 1e9, // 7 days in nanoseconds
    max_msgs: 10_000_000,
    max_bytes: 2 * 1024 * 1024 * 1024, // 2 GB
    replicas: NATS_REPLICAS,
    description: 'Conversation lifecycle events',
  },
  {
    name: 'MESSAGE',
    subjects: ['message.*'],
    retention: RetentionPolicy.Limits,
    storage: StorageType.File,
    max_age: 7 * 24 * 60 * 60 * 1e9,
    max_msgs: 50_000_000,
    max_bytes: 10 * 1024 * 1024 * 1024, // 10 GB
    replicas: NATS_REPLICAS,
    description: 'Message inbound/outbound/delivery events',
  },
  {
    name: 'CONTACT',
    subjects: ['contact.*'],
    retention: RetentionPolicy.Limits,
    storage: StorageType.File,
    max_age: 14 * 24 * 60 * 60 * 1e9,
    max_msgs: 10_000_000,
    max_bytes: 2 * 1024 * 1024 * 1024,
    replicas: NATS_REPLICAS,
    description: 'Contact CRUD and lifecycle events',
  },
  {
    name: 'WORKFLOW',
    subjects: ['workflow.*'],
    retention: RetentionPolicy.Limits,
    storage: StorageType.File,
    max_age: 3 * 24 * 60 * 60 * 1e9,
    max_msgs: 5_000_000,
    max_bytes: 1 * 1024 * 1024 * 1024,
    replicas: NATS_REPLICAS,
    description: 'Workflow execution lifecycle events',
  },
  {
    name: 'AI',
    subjects: ['ai.*'],
    retention: RetentionPolicy.Limits,
    storage: StorageType.File,
    max_age: 7 * 24 * 60 * 60 * 1e9,
    max_msgs: 20_000_000,
    max_bytes: 5 * 1024 * 1024 * 1024,
    replicas: NATS_REPLICAS,
    description: 'AI agent invocation and handoff events',
  },
  {
    name: 'BILLING',
    subjects: ['billing.*'],
    retention: RetentionPolicy.Limits,
    storage: StorageType.File,
    max_age: 90 * 24 * 60 * 60 * 1e9, // 90 days — billing data kept longer
    max_msgs: 50_000_000,
    max_bytes: 5 * 1024 * 1024 * 1024,
    replicas: NATS_REPLICAS,
    description: 'MAC metering, threshold warnings, overage events',
  },
];

/**
 * Event subject constants — use these instead of string literals.
 */
export const Subjects = {
  // Conversation
  CONVERSATION_CREATED: 'conversation.created',
  CONVERSATION_ASSIGNED: 'conversation.assigned',
  CONVERSATION_RESOLVED: 'conversation.resolved',
  CONVERSATION_REOPENED: 'conversation.reopened',

  // Message
  MESSAGE_INBOUND: 'message.inbound',
  MESSAGE_OUTBOUND: 'message.outbound',
  MESSAGE_DELIVERED: 'message.delivered',
  MESSAGE_READ: 'message.read',
  MESSAGE_FAILED: 'message.failed',

  // Contact
  CONTACT_CREATED: 'contact.created',
  CONTACT_UPDATED: 'contact.field_updated',
  CONTACT_LIFECYCLE_CHANGED: 'contact.lifecycle_changed',
  CONTACT_MERGED: 'contact.merged',

  // AI
  AI_AGENT_INVOKED: 'ai.agent_invoked',
  AI_RESPONSE_GENERATED: 'ai.response_generated',
  AI_HANDOFF_TRIGGERED: 'ai.handoff_triggered',
  AI_CONFIDENCE_LOW: 'ai.confidence_low',

  // Workflow
  WORKFLOW_TRIGGERED: 'workflow.triggered',
  WORKFLOW_STEP_COMPLETED: 'workflow.step_completed',
  WORKFLOW_COMPLETED: 'workflow.completed',
  WORKFLOW_FAILED: 'workflow.failed',

  // Billing
  BILLING_MAC_INCREMENTED: 'billing.mac_incremented',
  BILLING_THRESHOLD_WARNING: 'billing.threshold_warning',
  BILLING_OVERAGE_TRIGGERED: 'billing.overage_triggered',
} as const;

export type Subject = (typeof Subjects)[keyof typeof Subjects];

/**
 * Initialize all NATS JetStream streams.
 * Run once on service startup (idempotent — skips existing streams).
 */
export async function initializeStreams(nc: NatsConnection): Promise<void> {
  const jsm: JetStreamManager = await nc.jetstreamManager();

  for (const config of STREAM_CONFIGS) {
    try {
      await jsm.streams.info(config.name);
      // Stream already exists — skip silently
    } catch {
      await jsm.streams.add(config);
    }
  }
}

/**
 * Create a NATS connection with reconnection logic.
 */
export async function createNatsConnection(natsUrl: string): Promise<NatsConnection> {
  const nc = await connect({
    servers: natsUrl,
    reconnect: true,
    maxReconnectAttempts: -1, // Infinite retries
    reconnectTimeWait: 2000,
    pingInterval: 30000,
    maxPingOut: 3,
    name: process.env.SERVICE_NAME ?? 'responio-service',
  });

  return nc;
}
