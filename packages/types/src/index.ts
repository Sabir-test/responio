/**
 * @responio/types — Shared TypeScript types across all services.
 */

// Re-export feature flags
export { PLAN_FEATURES, type FeatureFlags } from './features';

// Re-export event types
export type {
  NatsEvent,
  ChannelType,
  MessageContentType,
  MessageDeliveryStatus,
  LifecycleStage,
  PlanTier,
  WorkflowTriggerType,
} from '@responio/events';

// ─── API Response Types ───────────────────────────────────────────────────────

export interface ApiResponse<T> {
  data: T;
  meta?: {
    page?: number;
    per_page?: number;
    total?: number;
  };
}

export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

// ─── Auth / JWT ───────────────────────────────────────────────────────────────

export interface JwtPayload {
  sub: string;           // User UUID
  tenant_id: string;     // Account/tenant UUID
  workspace_ids: string[]; // Accessible workspace UUIDs
  role: 'owner' | 'admin' | 'agent';
  email: string;
  iat: number;
  exp: number;
}

// ─── Plan Feature Gates ───────────────────────────────────────────────────────

export interface PlanFeatureGate {
  plan_tier: PlanTier;
  feature: keyof import('./features').FeatureFlags;
  allowed: boolean;
}

// ─── Pagination ───────────────────────────────────────────────────────────────

export interface PaginationParams {
  page?: number;
  per_page?: number;
  cursor?: string;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  per_page: number;
  has_next: boolean;
  next_cursor?: string;
}

// ─── Webhook ──────────────────────────────────────────────────────────────────

export interface WebhookDelivery {
  id: string;
  tenant_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  attempts: number;
  last_attempt_at: string | null;
  next_retry_at: string | null;
  status: 'pending' | 'delivered' | 'failed' | 'exhausted';
}

// ─── Action API Types (called by workflow engine) ─────────────────────────────

export interface SendMessageAction {
  conversation_id: string;
  content: string;
  content_type: MessageContentType;
  template_id?: string;
  variables?: Record<string, string>;
  media_url?: string;
}

export interface UpdateContactAction {
  contact_id: string;
  fields: {
    name?: string;
    email?: string;
    phone?: string;
    lifecycle_stage?: LifecycleStage;
    custom_fields?: Record<string, unknown>;
    tags_add?: string[];
    tags_remove?: string[];
  };
}

export interface AssignConversationAction {
  conversation_id: string;
  assignment_type: 'agent' | 'team' | 'round_robin' | 'least_busy';
  target_id?: string;
}

export interface ChangeLifecycleAction {
  contact_id: string;
  new_stage: LifecycleStage;
  reason?: string;
}
