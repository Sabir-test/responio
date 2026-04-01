-- Services Schema — Phase 1
-- AI agents, broadcasts, and supporting tables.
--
-- All tenant-scoped tables have:
--   1. tenant_id UUID referencing accounts.id
--   2. RLS enabled with FORCE ROW LEVEL SECURITY
--   3. tenant isolation policy
--   4. tenant_id first in any composite index

-- ─── AI Agents ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ai_agents (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  description         TEXT,
  system_prompt       TEXT NOT NULL,
  model               TEXT NOT NULL DEFAULT 'gpt-4o-mini',
  temperature         NUMERIC(3,2) NOT NULL DEFAULT 0.7,
  max_tokens          INTEGER NOT NULL DEFAULT 512,
  handoff_threshold   NUMERIC(3,2) NOT NULL DEFAULT 0.6,
  fallback_message    TEXT,
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_agents_tenant_id ON ai_agents(tenant_id);
CREATE INDEX IF NOT EXISTS idx_ai_agents_active ON ai_agents(tenant_id, is_active);

ALTER TABLE ai_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_agents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_agents
  USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON ai_agents TO responio_app;

-- ─── Users: add password_hash column (if not exists) ─────────────────────────
-- Used by the internal auth handler until Authentik SSO is deployed.

ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;

-- ─── Broadcasts ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS broadcasts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  workspace_id        UUID REFERENCES workspaces(id) ON DELETE SET NULL,
  inbox_id            UUID NOT NULL REFERENCES inboxes(id) ON DELETE RESTRICT,
  name                TEXT NOT NULL,
  channel_type        TEXT NOT NULL DEFAULT 'whatsapp',
  message_type        TEXT NOT NULL DEFAULT 'text'
                        CHECK (message_type IN ('text', 'template')),
  message_content     TEXT,
  template_name       TEXT,
  template_language   TEXT DEFAULT 'en',
  template_variables  JSONB,
  audience_filter     JSONB NOT NULL DEFAULT '{}',
  status              TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'canceled', 'failed')),
  recipient_count     INTEGER NOT NULL DEFAULT 0,
  sent_count          INTEGER NOT NULL DEFAULT 0,
  delivered_count     INTEGER NOT NULL DEFAULT 0,
  read_count          INTEGER NOT NULL DEFAULT 0,
  failed_count        INTEGER NOT NULL DEFAULT 0,
  scheduled_at        TIMESTAMPTZ,
  sent_at             TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_broadcasts_tenant_id ON broadcasts(tenant_id);
CREATE INDEX IF NOT EXISTS idx_broadcasts_tenant_status ON broadcasts(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_broadcasts_scheduled ON broadcasts(scheduled_at)
  WHERE status = 'scheduled' AND scheduled_at IS NOT NULL;

ALTER TABLE broadcasts ENABLE ROW LEVEL SECURITY;
ALTER TABLE broadcasts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON broadcasts
  USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON broadcasts TO responio_app;

-- ─── Broadcast Recipients ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS broadcast_recipients (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  broadcast_id        UUID NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
  contact_id          UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'sent', 'delivered', 'read', 'failed', 'canceled', 'opted_out')),
  channel_message_id  TEXT,
  error_message       TEXT,
  sent_at             TIMESTAMPTZ,
  delivered_at        TIMESTAMPTZ,
  read_at             TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_tenant ON broadcast_recipients(tenant_id);
CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_broadcast ON broadcast_recipients(broadcast_id, status);
CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_contact ON broadcast_recipients(contact_id);

ALTER TABLE broadcast_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE broadcast_recipients FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON broadcast_recipients
  USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::uuid);

GRANT SELECT, INSERT, UPDATE ON broadcast_recipients TO responio_app;

-- ─── Update sequence grants ───────────────────────────────────────────────────

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO responio_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO responio_admin;
