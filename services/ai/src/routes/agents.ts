/**
 * AI Agent CRUD API — tenant-facing.
 *
 * Agents are named LLM configurations with system prompts and knowledge bases.
 * They are invoked by workflows (via invoke_ai_agent action) or auto-reply rules.
 *
 * GET    /api/v1/ai/agents           — list agents
 * GET    /api/v1/ai/agents/:id       — get agent
 * POST   /api/v1/ai/agents           — create agent
 * PATCH  /api/v1/ai/agents/:id       — update agent
 * DELETE /api/v1/ai/agents/:id       — delete agent
 * POST   /api/v1/ai/agents/:id/test  — test agent with a sample message
 */

import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';
import { z } from 'zod';
import { complete } from '../llm/client';

const agentSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  system_prompt: z.string().min(1),
  model: z.string().default('gpt-4o-mini'),
  temperature: z.number().min(0).max(2).default(0.7),
  max_tokens: z.number().int().min(64).max(4096).default(512),
  /** Feature gate: only Growth+ plans can create AI agents */
  handoff_threshold: z.number().min(0).max(1).default(0.6),
  fallback_message: z.string().optional(),
});

export function registerAgentRoutes(app: FastifyInstance, db: Knex): void {
  // ── GET /api/v1/ai/agents ─────────────────────────────────────────────────
  app.get('/api/v1/ai/agents', async (request, reply) => {
    const tenantId = (request as unknown as { tenantId: string }).tenantId;
    const agents = await db('ai_agents')
      .where({ tenant_id: tenantId })
      .orderBy('created_at', 'desc')
      .select('id', 'name', 'description', 'model', 'is_active', 'created_at', 'updated_at');

    return reply.send({ data: agents });
  });

  // ── GET /api/v1/ai/agents/:id ─────────────────────────────────────────────
  app.get('/api/v1/ai/agents/:id', async (request, reply) => {
    const tenantId = (request as unknown as { tenantId: string }).tenantId;
    const { id } = request.params as { id: string };

    const agent = await db('ai_agents').where({ id, tenant_id: tenantId }).first();
    if (!agent) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Agent not found' } });

    return reply.send({ data: agent });
  });

  // ── POST /api/v1/ai/agents ────────────────────────────────────────────────
  app.post('/api/v1/ai/agents', async (request, reply) => {
    const tenantId = (request as unknown as { tenantId: string }).tenantId;
    const body = agentSchema.parse(request.body);

    const id = crypto.randomUUID();
    const [agent] = await db('ai_agents')
      .insert({
        id,
        tenant_id: tenantId,
        ...body,
        is_active: true,
      })
      .returning('*');

    return reply.status(201).send({ data: agent });
  });

  // ── PATCH /api/v1/ai/agents/:id ───────────────────────────────────────────
  app.patch('/api/v1/ai/agents/:id', async (request, reply) => {
    const tenantId = (request as unknown as { tenantId: string }).tenantId;
    const { id } = request.params as { id: string };
    const body = agentSchema.partial().parse(request.body);

    const agent = await db('ai_agents').where({ id, tenant_id: tenantId }).first();
    if (!agent) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Agent not found' } });

    const [updated] = await db('ai_agents')
      .where({ id, tenant_id: tenantId })
      .update({ ...body, updated_at: new Date() })
      .returning('*');

    return reply.send({ data: updated });
  });

  // ── DELETE /api/v1/ai/agents/:id ──────────────────────────────────────────
  app.delete('/api/v1/ai/agents/:id', async (request, reply) => {
    const tenantId = (request as unknown as { tenantId: string }).tenantId;
    const { id } = request.params as { id: string };

    const deleted = await db('ai_agents').where({ id, tenant_id: tenantId }).delete();
    if (!deleted) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Agent not found' } });

    return reply.status(204).send();
  });

  // ── POST /api/v1/ai/agents/:id/test ──────────────────────────────────────
  const testSchema = z.object({
    message: z.string().min(1).max(1000),
  });

  app.post('/api/v1/ai/agents/:id/test', async (request, reply) => {
    const tenantId = (request as unknown as { tenantId: string }).tenantId;
    const { id } = request.params as { id: string };
    const body = testSchema.parse(request.body);

    const agent = await db('ai_agents').where({ id, tenant_id: tenantId }).first();
    if (!agent) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Agent not found' } });

    const result = await complete(
      [
        { role: 'system', content: agent.system_prompt },
        { role: 'user', content: body.message },
      ],
      {
        model: agent.model,
        temperature: agent.temperature,
        max_tokens: agent.max_tokens,
        tenant_id: tenantId,
      }
    );

    return reply.send({
      response: result.content,
      model: result.model,
      latency_ms: result.latency_ms,
      usage: result.usage,
    });
  });
}
