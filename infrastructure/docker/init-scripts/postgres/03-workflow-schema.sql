-- Workflow Engine Schema (Phase 2)
-- Stores workflow DSL graphs and maps them to n8n workflow IDs.

CREATE TABLE IF NOT EXISTS workflows (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  workspace_id          UUID REFERENCES workspaces(id) ON DELETE SET NULL,
  name                  TEXT NOT NULL,
  trigger_type          TEXT NOT NULL,
  graph_json            JSONB NOT NULL DEFAULT '{}',
  version               INTEGER NOT NULL DEFAULT 1,
  status                TEXT NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft', 'published', 'archived')),
  -- n8n integration
  n8n_workflow_id       TEXT UNIQUE,
  -- Versioning chain
  previous_version_id   UUID REFERENCES workflows(id),
  published_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workflows_tenant_id ON workflows(tenant_id);
CREATE INDEX IF NOT EXISTS idx_workflows_tenant_status ON workflows(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_workflows_n8n_id ON workflows(n8n_workflow_id) WHERE n8n_workflow_id IS NOT NULL;

ALTER TABLE workflows ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflows FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workflows
  USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::uuid);

-- Workflow executions log (for execution history UI)
-- Populated by the NATS workflow.* events emitted by the workflow service
CREATE TABLE IF NOT EXISTS workflow_executions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  workflow_id         UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  n8n_execution_id    TEXT,
  trigger_type        TEXT NOT NULL,
  trigger_payload     JSONB NOT NULL DEFAULT '{}',
  status              TEXT NOT NULL DEFAULT 'running'
                        CHECK (status IN ('running', 'success', 'error', 'waiting', 'canceled')),
  started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at         TIMESTAMPTZ,
  error_message       TEXT,
  steps_completed     INTEGER NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workflow_executions_tenant ON workflow_executions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_workflow_executions_workflow ON workflow_executions(workflow_id, started_at DESC);

ALTER TABLE workflow_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_executions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workflow_executions
  USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::uuid);

GRANT SELECT, INSERT, UPDATE ON workflows TO responio_app;
GRANT SELECT, INSERT, UPDATE ON workflow_executions TO responio_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO responio_app;
