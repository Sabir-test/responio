-- ClickHouse Analytics Schema
-- Phase 1 tables for conversations, messages, and contacts analytics.
--
-- Uses MergeTree engine family with tenant_id as the first partition/sort key.
-- All tables use ReplacingMergeTree to handle duplicate events (at-least-once delivery).

CREATE DATABASE IF NOT EXISTS responio_analytics;

USE responio_analytics;

-- ─── Conversations Events ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS conversations_events (
  tenant_id           String,
  conversation_id     String,
  contact_id          String,
  channel_type        String,
  inbox_id            String,
  assignee_id         String,
  status              String,
  first_reply_seconds UInt32 DEFAULT 0,
  resolution_seconds  UInt32 DEFAULT 0,
  created_at          DateTime64(3),
  resolved_at         Nullable(DateTime64(3))
)
ENGINE = ReplacingMergeTree(created_at)
PARTITION BY toYYYYMM(created_at)
ORDER BY (tenant_id, conversation_id, created_at)
SETTINGS index_granularity = 8192;

-- ─── Messages Events ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS messages_events (
  tenant_id           String,
  message_id          String,
  conversation_id     String,
  contact_id          String,
  channel_type        String,
  content_type        String,
  direction           String,   -- 'inbound' | 'outbound'
  created_at          DateTime64(3)
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(created_at)
ORDER BY (tenant_id, created_at, message_id)
SETTINGS index_granularity = 8192;

-- ─── Contact Events ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS contact_events (
  tenant_id           String,
  contact_id          String,
  event_type          String,   -- 'created' | 'lifecycle_changed' | 'merged'
  lifecycle_stage     String,
  channel_type        String,
  created_at          DateTime64(3)
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(created_at)
ORDER BY (tenant_id, created_at, contact_id)
SETTINGS index_granularity = 8192;
