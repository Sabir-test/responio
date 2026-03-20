-- Responio Core Schema
-- Phase 1 tables with RLS policies.
--
-- IMPORTANT: Every tenant-scoped table MUST:
--   1. Have a tenant_id (UUID) column referencing accounts.id
--   2. Have RLS enabled with FORCE ROW LEVEL SECURITY
--   3. Have a tenant isolation policy
--   4. Have an index on tenant_id (first in any composite index)
--
-- See docs/architecture/ADR-003-multitenancy-rls.md

-- ─── Accounts (Tenants) ───────────────────────────────────────────────────────
-- Accounts are NOT RLS-protected (they ARE the isolation boundary)

CREATE TABLE IF NOT EXISTS accounts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  subdomain       TEXT UNIQUE,
  plan_tier       TEXT NOT NULL DEFAULT 'starter'
                    CHECK (plan_tier IN ('starter', 'growth', 'advanced', 'enterprise')),
  billing_status  TEXT NOT NULL DEFAULT 'trialing'
                    CHECK (billing_status IN ('trialing', 'active', 'past_due', 'canceled', 'paused')),
  stripe_customer_id      TEXT UNIQUE,
  stripe_subscription_id  TEXT UNIQUE,
  settings        JSONB NOT NULL DEFAULT '{}',
  mac_limit       INTEGER,
  seat_count      INTEGER NOT NULL DEFAULT 1,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_accounts_subdomain ON accounts(subdomain);
CREATE INDEX IF NOT EXISTS idx_accounts_stripe_customer ON accounts(stripe_customer_id);

-- ─── Workspaces ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS workspaces (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  avatar_url      TEXT,
  timezone        TEXT NOT NULL DEFAULT 'UTC',
  settings        JSONB NOT NULL DEFAULT '{}',
  is_default      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workspaces_tenant_id ON workspaces(tenant_id);
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workspaces
  USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::uuid);

-- ─── Users (Agents) ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  email           TEXT NOT NULL,
  name            TEXT,
  avatar_url      TEXT,
  role            TEXT NOT NULL DEFAULT 'agent'
                    CHECK (role IN ('owner', 'admin', 'agent')),
  status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'inactive', 'invited')),
  auth_provider   TEXT DEFAULT 'email',
  external_id     TEXT,            -- SSO/Authentik user ID
  settings        JSONB NOT NULL DEFAULT '{}',
  last_active_at  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, email)
);

CREATE INDEX IF NOT EXISTS idx_users_tenant_id ON users(tenant_id);
CREATE INDEX IF NOT EXISTS idx_users_tenant_email ON users(tenant_id, email);
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON users
  USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::uuid);

-- ─── Contacts ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS contacts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  phone               TEXT,            -- E.164 format, e.g. +14155552671
  email               TEXT,
  name                TEXT,
  avatar_url          TEXT,
  language            TEXT,
  timezone            TEXT,
  lifecycle_stage     TEXT NOT NULL DEFAULT 'new_lead',
  tags                TEXT[] NOT NULL DEFAULT '{}',
  custom_fields       JSONB NOT NULL DEFAULT '{}',
  merged_from_ids     UUID[] NOT NULL DEFAULT '{}',
  primary_contact_id  UUID REFERENCES contacts(id),   -- Set when this contact is merged
  do_not_contact      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT at_least_one_identifier CHECK (phone IS NOT NULL OR email IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_contacts_tenant_id ON contacts(tenant_id);
CREATE INDEX IF NOT EXISTS idx_contacts_tenant_phone ON contacts(tenant_id, phone) WHERE phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_tenant_email ON contacts(tenant_id, email) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_lifecycle ON contacts(tenant_id, lifecycle_stage);
CREATE INDEX IF NOT EXISTS idx_contacts_tags ON contacts USING GIN(tags);
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON contacts
  USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::uuid);

-- ─── Contact Identities (Channel-specific IDs) ───────────────────────────────

CREATE TABLE IF NOT EXISTS contact_identities (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id          UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  channel_type        TEXT NOT NULL,
  channel_identifier  TEXT NOT NULL,   -- Phone number, user ID, etc.
  display_name        TEXT,
  metadata            JSONB NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, channel_type, channel_identifier)
);

CREATE INDEX IF NOT EXISTS idx_contact_identities_tenant ON contact_identities(tenant_id);
CREATE INDEX IF NOT EXISTS idx_contact_identities_contact ON contact_identities(contact_id);
ALTER TABLE contact_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_identities FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON contact_identities
  USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::uuid);

-- ─── Inboxes (Channel Connections) ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS inboxes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  channel_type    TEXT NOT NULL,
  channel_config  JSONB NOT NULL DEFAULT '{}',  -- API keys, webhook URLs, etc. (encrypted)
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inboxes_tenant_id ON inboxes(tenant_id);
CREATE INDEX IF NOT EXISTS idx_inboxes_workspace ON inboxes(workspace_id);
ALTER TABLE inboxes ENABLE ROW LEVEL SECURITY;
ALTER TABLE inboxes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON inboxes
  USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::uuid);

-- ─── Conversations ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS conversations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  workspace_id        UUID NOT NULL REFERENCES workspaces(id),
  contact_id          UUID NOT NULL REFERENCES contacts(id),
  inbox_id            UUID NOT NULL REFERENCES inboxes(id),
  assignee_id         UUID REFERENCES users(id),
  status              TEXT NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open', 'pending', 'snoozed', 'resolved')),
  snoozed_until       TIMESTAMPTZ,
  sla_policy_id       UUID,
  sla_breach_at       TIMESTAMPTZ,
  first_reply_at      TIMESTAMPTZ,
  resolved_at         TIMESTAMPTZ,
  labels              TEXT[] NOT NULL DEFAULT '{}',
  custom_attributes   JSONB NOT NULL DEFAULT '{}',
  meta                JSONB NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversations_tenant_id ON conversations(tenant_id);
CREATE INDEX IF NOT EXISTS idx_conversations_tenant_status ON conversations(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_conversations_contact ON conversations(tenant_id, contact_id);
CREATE INDEX IF NOT EXISTS idx_conversations_assignee ON conversations(tenant_id, assignee_id) WHERE assignee_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_conversations_sla ON conversations(sla_breach_at) WHERE sla_breach_at IS NOT NULL AND status != 'resolved';
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON conversations
  USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::uuid);

-- ─── Messages ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS messages (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id     UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_type         TEXT NOT NULL CHECK (sender_type IN ('contact', 'agent', 'ai_agent', 'system')),
  sender_id           UUID,           -- NULL for contact messages (they use contact_id)
  contact_id          UUID REFERENCES contacts(id),
  content             TEXT,
  content_type        TEXT NOT NULL DEFAULT 'text',
  media_url           TEXT,
  media_metadata      JSONB,
  channel_message_id  TEXT,           -- Provider's message ID for deduplication
  delivery_status     TEXT NOT NULL DEFAULT 'sent'
                        CHECK (delivery_status IN ('pending', 'sent', 'delivered', 'read', 'failed')),
  delivered_at        TIMESTAMPTZ,
  read_at             TIMESTAMPTZ,
  is_internal_note    BOOLEAN NOT NULL DEFAULT FALSE,
  metadata            JSONB NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, channel_message_id) NULLS NOT DISTINCT  -- Deduplication
);

CREATE INDEX IF NOT EXISTS idx_messages_tenant_id ON messages(tenant_id);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_channel_msg_id ON messages(tenant_id, channel_message_id) WHERE channel_message_id IS NOT NULL;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON messages
  USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::uuid);

-- ─── Billing Usage ────────────────────────────────────────────────────────────
-- Reconciled from Redis HyperLogLog counters hourly

CREATE TABLE IF NOT EXISTS billing_usage (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  billing_period      TEXT NOT NULL,   -- "2026-03"
  mac_count           INTEGER NOT NULL DEFAULT 0,
  overage_units       INTEGER NOT NULL DEFAULT 0,
  overage_amount_usd  NUMERIC(10, 2) NOT NULL DEFAULT 0,
  invoiced            BOOLEAN NOT NULL DEFAULT FALSE,
  reconciled_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, billing_period)
);

CREATE INDEX IF NOT EXISTS idx_billing_usage_tenant ON billing_usage(tenant_id, billing_period);

-- Billing is exempt from per-tenant RLS (accessed by admin role for invoicing)
-- The responio_admin role has BYPASSRLS and handles all cross-tenant billing queries

-- ─── Audit Log ────────────────────────────────────────────────────────────────
-- Immutable log of admin actions, data exports, and sensitive operations

CREATE TABLE IF NOT EXISTS audit_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID REFERENCES accounts(id),
  user_id     UUID,
  action      TEXT NOT NULL,
  resource    TEXT,
  resource_id TEXT,
  details     JSONB NOT NULL DEFAULT '{}',
  ip_address  INET,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_tenant ON audit_log(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id, created_at DESC);

-- Audit log: no UPDATE or DELETE allowed (immutable)
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_log
  USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::uuid);
CREATE POLICY no_update ON audit_log FOR UPDATE USING (FALSE);
CREATE POLICY no_delete ON audit_log FOR DELETE USING (FALSE);

-- ─── Grant table permissions to app role ─────────────────────────────────────

GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO responio_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO responio_admin;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO responio_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO responio_admin;
