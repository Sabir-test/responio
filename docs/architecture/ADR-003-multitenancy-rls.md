# ADR-003: Multi-Tenancy with PostgreSQL Row-Level Security

**Status**: ACCEPTED
**Date**: 2026-03-20

---

## Decision

Use **shared schema + PostgreSQL Row-Level Security (RLS)** for multi-tenant isolation.

Every table includes a `tenant_id` (UUID) column. RLS policies enforce that application users can only access their own tenant's rows. Application-level filtering is a secondary defense, NOT the primary.

---

## RLS Implementation

### Session Variable Pattern
```sql
-- Set at the beginning of every database connection/transaction
SET app.current_tenant_id = '<uuid>';

-- RLS policy on every tenant-scoped table
CREATE POLICY tenant_isolation ON conversations
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);
```

### Connection Helper (TypeScript services)
```typescript
// packages/db/src/tenant-connection.ts
export async function withTenantContext<T>(
  tenantId: string,
  fn: (db: Knex) => Promise<T>
): Promise<T> {
  return db.transaction(async (trx) => {
    await trx.raw("SET LOCAL app.current_tenant_id = ?", [tenantId]);
    return fn(trx);
  });
}
```

### Cross-Tenant Operations (Admin/Billing only)
```typescript
// Use a separate superuser connection that bypasses RLS
// MUST be in isolated code paths with explicit audit logging
const adminDb = createAdminConnection(); // uses BYPASSRLS role
await auditLog.record({ action: 'cross_tenant_query', reason: 'billing_mac_count' });
```

---

## Table Design Rules

```sql
-- Every tenant-scoped table
CREATE TABLE conversations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- ... other columns
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index on tenant_id (always first in composite indexes)
CREATE INDEX idx_conversations_tenant_id ON conversations(tenant_id);
CREATE INDEX idx_conversations_tenant_status ON conversations(tenant_id, status);

-- Enable RLS
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations FORCE ROW LEVEL SECURITY;

-- Policy
CREATE POLICY tenant_isolation ON conversations
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid);
```

---

## Workspace Model

```
Account (tenant)
  └── Workspace (brand/location — Advanced+ plan)
        ├── Inbox (channel connection)
        ├── Agent (user with workspace access)
        ├── Workflow
        └── AI Agent
```

- `account_id` = `tenant_id` throughout the codebase
- Workspaces share the account's billing pool
- RLS is at the account level; workspace isolation is enforced at the application layer

---

## Testing

Every PR touching database models must include:
```typescript
it('enforces tenant isolation', async () => {
  const tenantA = await createTestTenant();
  const tenantB = await createTestTenant();

  const conv = await createConversation({ tenantId: tenantA.id });

  // Querying as Tenant B must return nothing
  await withTenantContext(tenantB.id, async (db) => {
    const result = await db('conversations').where({ id: conv.id });
    expect(result).toHaveLength(0);
  });
});
```
