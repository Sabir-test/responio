/**
 * Workflow CRUD API — tenant-facing
 *
 * Tenants interact with their workflows through this API.
 * We store the DSL graph in our DB, translate to n8n JSON,
 * push to n8n, and manage versioning ourselves.
 *
 * Checklist task #23: Workflow versioning & management
 */

import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';
import { z } from 'zod';
import { translateWorkflow, type DslWorkflowGraph } from '../n8n/translator';
import { N8nClient } from '../n8n/client';

const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY ?? '';

export function registerWorkflowRoutes(app: FastifyInstance, db: Knex, n8n: N8nClient): void {
  // ── GET /api/v1/workflows ──────────────────────────────────────────────────
  app.get('/api/v1/workflows', async (request, reply) => {
    const tenantId = (request as unknown as { tenantId: string }).tenantId;

    const workflows = await db('workflows')
      .where({ tenant_id: tenantId })
      .orderBy('updated_at', 'desc')
      .select('id', 'name', 'trigger_type', 'version', 'status', 'created_at', 'updated_at');

    return reply.send({ data: workflows });
  });

  // ── GET /api/v1/workflows/:id ──────────────────────────────────────────────
  app.get('/api/v1/workflows/:id', async (request, reply) => {
    const tenantId = (request as unknown as { tenantId: string }).tenantId;
    const { id } = request.params as { id: string };

    const workflow = await db('workflows').where({ id, tenant_id: tenantId }).first();
    if (!workflow) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Workflow not found' } });

    return reply.send({ data: workflow });
  });

  // ── POST /api/v1/workflows ─────────────────────────────────────────────────
  const createSchema = z.object({
    name: z.string().min(1).max(255),
    trigger_type: z.string().min(1),
    graph_json: z.object({
      nodes: z.array(z.unknown()),
      edges: z.array(z.unknown()),
    }),
  });

  app.post('/api/v1/workflows', async (request, reply) => {
    const tenantId = (request as unknown as { tenantId: string }).tenantId;
    const body = createSchema.parse(request.body);

    const id = crypto.randomUUID();
    const [workflow] = await db('workflows')
      .insert({
        id,
        tenant_id: tenantId,
        name: body.name,
        trigger_type: body.trigger_type,
        graph_json: JSON.stringify(body.graph_json),
        version: 1,
        status: 'draft',
      })
      .returning('*');

    return reply.status(201).send({ data: workflow });
  });

  // ── PATCH /api/v1/workflows/:id ───────────────────────────────────────────
  const updateSchema = z.object({
    name: z.string().min(1).max(255).optional(),
    graph_json: z.object({
      nodes: z.array(z.unknown()),
      edges: z.array(z.unknown()),
    }).optional(),
  });

  app.patch('/api/v1/workflows/:id', async (request, reply) => {
    const tenantId = (request as unknown as { tenantId: string }).tenantId;
    const { id } = request.params as { id: string };
    const body = updateSchema.parse(request.body);

    const existing = await db('workflows').where({ id, tenant_id: tenantId }).first();
    if (!existing) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Workflow not found' } });
    if (existing.status === 'published') {
      return reply.status(409).send({
        error: { code: 'CONFLICT', message: 'Published workflows are immutable. Create a new version.' },
      });
    }

    const updates: Record<string, unknown> = { updated_at: new Date() };
    if (body.name) updates.name = body.name;
    if (body.graph_json) updates.graph_json = JSON.stringify(body.graph_json);

    const [updated] = await db('workflows').where({ id, tenant_id: tenantId }).update(updates).returning('*');
    return reply.send({ data: updated });
  });

  // ── POST /api/v1/workflows/:id/publish ────────────────────────────────────
  // Translates DSL to n8n JSON, creates/activates n8n workflow, locks version.
  app.post('/api/v1/workflows/:id/publish', async (request, reply) => {
    const tenantId = (request as unknown as { tenantId: string }).tenantId;
    const { id } = request.params as { id: string };

    const workflow = await db('workflows').where({ id, tenant_id: tenantId }).first();
    if (!workflow) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Workflow not found' } });

    const dsl = JSON.parse(workflow.graph_json) as DslWorkflowGraph;

    const n8nWorkflow = translateWorkflow(dsl, {
      tenantId,
      workflowId: id,
      workflowName: workflow.name,
      version: workflow.version,
      internalApiKey: INTERNAL_API_KEY,
    });

    // If there's an existing n8n workflow, deactivate it first
    if (workflow.n8n_workflow_id) {
      try {
        await n8n.deactivateWorkflow(workflow.n8n_workflow_id);
        await n8n.deleteWorkflow(workflow.n8n_workflow_id);
      } catch {
        // Old workflow may already be deleted — continue
      }
    }

    const created = await n8n.createWorkflow(n8nWorkflow);
    await n8n.activateWorkflow(created.id!);

    await db('workflows').where({ id, tenant_id: tenantId }).update({
      status: 'published',
      n8n_workflow_id: created.id,
      published_at: new Date(),
      updated_at: new Date(),
    });

    return reply.send({ data: { workflow_id: id, n8n_workflow_id: created.id, status: 'published' } });
  });

  // ── POST /api/v1/workflows/:id/unpublish ──────────────────────────────────
  app.post('/api/v1/workflows/:id/unpublish', async (request, reply) => {
    const tenantId = (request as unknown as { tenantId: string }).tenantId;
    const { id } = request.params as { id: string };

    const workflow = await db('workflows').where({ id, tenant_id: tenantId }).first();
    if (!workflow) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Workflow not found' } });

    if (workflow.n8n_workflow_id) {
      await n8n.deactivateWorkflow(workflow.n8n_workflow_id);
    }

    await db('workflows').where({ id, tenant_id: tenantId }).update({
      status: 'draft',
      updated_at: new Date(),
    });

    return reply.send({ data: { workflow_id: id, status: 'draft' } });
  });

  // ── POST /api/v1/workflows/:id/new-version ────────────────────────────────
  // Clone published workflow into a new draft version for editing
  app.post('/api/v1/workflows/:id/new-version', async (request, reply) => {
    const tenantId = (request as unknown as { tenantId: string }).tenantId;
    const { id } = request.params as { id: string };

    const existing = await db('workflows').where({ id, tenant_id: tenantId }).first();
    if (!existing) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Workflow not found' } });

    const newId = crypto.randomUUID();
    const [newWorkflow] = await db('workflows')
      .insert({
        id: newId,
        tenant_id: tenantId,
        name: existing.name,
        trigger_type: existing.trigger_type,
        graph_json: existing.graph_json,
        version: existing.version + 1,
        status: 'draft',
        previous_version_id: id,
      })
      .returning('*');

    return reply.status(201).send({ data: newWorkflow });
  });

  // ── DELETE /api/v1/workflows/:id ──────────────────────────────────────────
  app.delete('/api/v1/workflows/:id', async (request, reply) => {
    const tenantId = (request as unknown as { tenantId: string }).tenantId;
    const { id } = request.params as { id: string };

    const workflow = await db('workflows').where({ id, tenant_id: tenantId }).first();
    if (!workflow) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Workflow not found' } });

    if (workflow.n8n_workflow_id) {
      await n8n.deactivateWorkflow(workflow.n8n_workflow_id).catch(() => {});
      await n8n.deleteWorkflow(workflow.n8n_workflow_id).catch(() => {});
    }

    await db('workflows').where({ id, tenant_id: tenantId }).delete();
    return reply.status(204).send();
  });

  // ── GET /api/v1/workflows/:id/executions ──────────────────────────────────
  app.get('/api/v1/workflows/:id/executions', async (request, reply) => {
    const tenantId = (request as unknown as { tenantId: string }).tenantId;
    const { id } = request.params as { id: string };

    const workflow = await db('workflows').where({ id, tenant_id: tenantId }).first();
    if (!workflow) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Workflow not found' } });

    if (!workflow.n8n_workflow_id) {
      return reply.send({ data: [] });
    }

    const executions = await n8n.listExecutions(workflow.n8n_workflow_id, 50);
    return reply.send({ data: executions });
  });
}
