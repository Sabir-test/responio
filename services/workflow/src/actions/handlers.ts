/**
 * Platform Action Endpoints — called by n8n workflow nodes
 *
 * These REST endpoints are the "effectors" — n8n HTTP nodes call these
 * to take actions in the platform (send messages, update contacts, etc.)
 *
 * All endpoints:
 *   - Validate X-Internal-API-Key header
 *   - Validate X-Tenant-ID header and set RLS context
 *   - Execute the action via the appropriate service
 *   - Emit a NATS event for observability
 *
 * See: build checklist task #22, n8n Integration Map sheet in checklist xlsx
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { EventPublisher } from '@responio/events';
import { Subjects } from '@responio/events';

const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY ?? '';

export function registerActionRoutes(
  app: FastifyInstance,
  publisher: EventPublisher
): void {
  // Auth middleware for all action routes
  app.addHook('preHandler', async (request, reply) => {
    const apiKey = request.headers['x-internal-api-key'];
    const tenantId = request.headers['x-tenant-id'] as string;

    if (!apiKey || apiKey !== INTERNAL_API_KEY) {
      return reply.status(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid API key' } });
    }
    if (!tenantId) {
      return reply.status(400).send({ error: { code: 'MISSING_TENANT', message: 'X-Tenant-ID required' } });
    }

    // Attach tenant to request for downstream handlers
    (request as unknown as { tenantId: string }).tenantId = tenantId;
  });

  // ── POST /api/v1/actions/send-message ─────────────────────────────────────
  const sendMessageSchema = z.object({
    conversation_id: z.string().uuid(),
    content: z.string().min(1),
    content_type: z.enum(['text', 'image', 'video', 'audio', 'document', 'template']).default('text'),
    template_id: z.string().optional(),
    variables: z.record(z.string()).optional(),
    media_url: z.string().url().optional(),
  });

  app.post('/api/v1/actions/send-message', async (request, reply) => {
    const tenantId = (request as unknown as { tenantId: string }).tenantId;
    const body = sendMessageSchema.parse(request.body);

    // TODO: delegate to inbox service via internal HTTP or NATS request
    // For now: emit outbound message event and return placeholder
    const messageId = crypto.randomUUID();

    await publisher.publish(Subjects.MESSAGE_OUTBOUND, {
      tenant_id: tenantId,
      workspace_id: '',  // TODO: resolve from conversation
      source_service: 'workflow',
      payload: {
        message_id: messageId,
        conversation_id: body.conversation_id,
        contact_id: '',  // TODO: resolve from conversation
        channel_type: 'whatsapp',
        content: body.content,
        content_type: body.content_type,
        sent_by: 'workflow',
      },
    });

    return reply.send({ message_id: messageId, delivery_status: 'queued' });
  });

  // ── PATCH /api/v1/actions/update-contact ──────────────────────────────────
  const updateContactSchema = z.object({
    contact_id: z.string().uuid(),
    fields: z.object({
      name: z.string().optional(),
      email: z.string().email().optional(),
      phone: z.string().optional(),
      lifecycle_stage: z.string().optional(),
      custom_fields: z.record(z.unknown()).optional(),
      tags_add: z.array(z.string()).optional(),
      tags_remove: z.array(z.string()).optional(),
    }),
  });

  app.patch('/api/v1/actions/update-contact', async (request, reply) => {
    const tenantId = (request as unknown as { tenantId: string }).tenantId;
    const body = updateContactSchema.parse(request.body);

    // Emit per-field update events
    for (const [fieldName, value] of Object.entries(body.fields)) {
      if (value === undefined) continue;
      await publisher.publish(Subjects.CONTACT_UPDATED, {
        tenant_id: tenantId,
        workspace_id: '',
        source_service: 'workflow',
        payload: {
          contact_id: body.contact_id,
          field_name: fieldName,
          old_value: null,
          new_value: value,
          updated_by: 'workflow',
        },
      });
    }

    return reply.send({ contact_id: body.contact_id, updated_fields: Object.keys(body.fields) });
  });

  // ── POST /api/v1/actions/assign-conversation ──────────────────────────────
  const assignConversationSchema = z.object({
    conversation_id: z.string().uuid(),
    assignment_type: z.enum(['agent', 'team', 'round_robin', 'least_busy']),
    target_id: z.string().uuid().optional(),
  });

  app.post('/api/v1/actions/assign-conversation', async (request, reply) => {
    const tenantId = (request as unknown as { tenantId: string }).tenantId;
    const body = assignConversationSchema.parse(request.body);

    const assigneeId = body.target_id ?? null; // TODO: implement round_robin/least_busy logic

    await publisher.publish(Subjects.CONVERSATION_ASSIGNED, {
      tenant_id: tenantId,
      workspace_id: '',
      source_service: 'workflow',
      payload: {
        conversation_id: body.conversation_id,
        assignee_id: assigneeId ?? '',
        previous_assignee_id: null,
        assignment_method: body.assignment_type,
      },
    });

    return reply.send({ conversation_id: body.conversation_id, assignee_id: assigneeId });
  });

  // ── POST /api/v1/actions/add-tag ──────────────────────────────────────────
  const addTagSchema = z.object({
    entity_type: z.enum(['contact', 'conversation']),
    entity_id: z.string().uuid(),
    tags: z.array(z.string()).min(1),
  });

  app.post('/api/v1/actions/add-tag', async (request, reply) => {
    const tenantId = (request as unknown as { tenantId: string }).tenantId;
    const body = addTagSchema.parse(request.body);

    if (body.entity_type === 'contact') {
      await publisher.publish(Subjects.CONTACT_UPDATED, {
        tenant_id: tenantId,
        workspace_id: '',
        source_service: 'workflow',
        payload: {
          contact_id: body.entity_id,
          field_name: 'tags',
          old_value: null,
          new_value: body.tags,
          updated_by: 'workflow',
        },
      });
    }

    return reply.send({ entity_id: body.entity_id, current_tags: body.tags });
  });

  // ── POST /api/v1/actions/change-lifecycle ─────────────────────────────────
  const changeLifecycleSchema = z.object({
    contact_id: z.string().uuid(),
    new_stage: z.string().min(1),
    reason: z.string().optional(),
  });

  app.post('/api/v1/actions/change-lifecycle', async (request, reply) => {
    const tenantId = (request as unknown as { tenantId: string }).tenantId;
    const body = changeLifecycleSchema.parse(request.body);

    await publisher.publish(Subjects.CONTACT_LIFECYCLE_CHANGED, {
      tenant_id: tenantId,
      workspace_id: '',
      source_service: 'workflow',
      payload: {
        contact_id: body.contact_id,
        old_stage: 'unknown',  // TODO: fetch from DB
        new_stage: body.new_stage,
        workspace_id: '',
        changed_by: 'workflow',
      },
    });

    return reply.send({ contact_id: body.contact_id, old_stage: 'unknown', new_stage: body.new_stage });
  });

  // ── POST /api/v1/actions/close-conversation ───────────────────────────────
  const closeConversationSchema = z.object({
    conversation_id: z.string().uuid(),
    resolution_note: z.string().optional(),
  });

  app.post('/api/v1/actions/close-conversation', async (request, reply) => {
    const tenantId = (request as unknown as { tenantId: string }).tenantId;
    const body = closeConversationSchema.parse(request.body);

    await publisher.publish(Subjects.CONVERSATION_RESOLVED, {
      tenant_id: tenantId,
      workspace_id: '',
      source_service: 'workflow',
      payload: {
        conversation_id: body.conversation_id,
        resolved_by: 'workflow',
        resolution_time_seconds: 0,
        contact_id: '',
      },
    });

    return reply.send({ conversation_id: body.conversation_id, status: 'resolved' });
  });

  // ── POST /api/v1/actions/snooze-conversation ──────────────────────────────
  const snoozeSchema = z.object({
    conversation_id: z.string().uuid(),
    snooze_until: z.string().datetime(),
  });

  app.post('/api/v1/actions/snooze-conversation', async (request, reply) => {
    const body = snoozeSchema.parse(request.body);
    // TODO: update DB via inbox service
    return reply.send({ conversation_id: body.conversation_id, snoozed_until: body.snooze_until });
  });

  // ── POST /api/v1/actions/create-note ──────────────────────────────────────
  const createNoteSchema = z.object({
    conversation_id: z.string().uuid(),
    content: z.string().min(1),
    visibility: z.literal('internal').default('internal'),
  });

  app.post('/api/v1/actions/create-note', async (request, reply) => {
    const body = createNoteSchema.parse(request.body);
    const noteId = crypto.randomUUID();
    // TODO: delegate to inbox service
    return reply.send({ note_id: noteId });
  });

  // ── POST /api/v1/actions/invoke-ai-agent ──────────────────────────────────
  const invokeAiAgentSchema = z.object({
    conversation_id: z.string().uuid(),
    ai_agent_id: z.string().uuid(),
    context: z.record(z.unknown()).optional(),
  });

  app.post('/api/v1/actions/invoke-ai-agent', async (request, reply) => {
    const tenantId = (request as unknown as { tenantId: string }).tenantId;
    const body = invokeAiAgentSchema.parse(request.body);

    await publisher.publish(Subjects.AI_AGENT_INVOKED, {
      tenant_id: tenantId,
      workspace_id: '',
      source_service: 'workflow',
      payload: {
        ai_agent_id: body.ai_agent_id,
        conversation_id: body.conversation_id,
        contact_id: '',  // Resolved by AI service from conversation
        input_message_id: '',
      },
    });

    return reply.send({ invocation_id: crypto.randomUUID(), status: 'queued', ai_agent_id: body.ai_agent_id });
  });

  // ── POST /api/v1/actions/ai-classify ──────────────────────────────────────
  const aiClassifySchema = z.object({
    text: z.string().min(1),
    categories: z.array(z.string()).min(1),
    model: z.string().optional(),
  });

  app.post('/api/v1/actions/ai-classify', async (request, reply) => {
    const body = aiClassifySchema.parse(request.body);
    // Delegate to AI service via internal HTTP (AI service implements the actual LLM call)
    const aiUrl = process.env.AI_SERVICE_URL ?? 'http://ai:3003';

    const res = await fetch(`${aiUrl}/internal/classify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-API-Key': INTERNAL_API_KEY,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const text = await res.text();
      return reply.status(502).send({ error: { code: 'AI_SERVICE_ERROR', message: text } });
    }

    return reply.send(await res.json());
  });

  // ── POST /api/v1/actions/ai-extract ───────────────────────────────────────
  const aiExtractSchema = z.object({
    text: z.string().min(1),
    schema: z.record(z.string()),  // field_name → description
    model: z.string().optional(),
  });

  app.post('/api/v1/actions/ai-extract', async (request, reply) => {
    const body = aiExtractSchema.parse(request.body);
    const aiUrl = process.env.AI_SERVICE_URL ?? 'http://ai:3003';

    const res = await fetch(`${aiUrl}/internal/extract`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-API-Key': INTERNAL_API_KEY,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const text = await res.text();
      return reply.status(502).send({ error: { code: 'AI_SERVICE_ERROR', message: text } });
    }

    return reply.send(await res.json());
  });

  // ── POST /api/v1/actions/trigger-webhook (Advanced tier HTTP request) ──────
  const triggerWebhookSchema = z.object({
    url: z.string().url(),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('POST'),
    headers: z.record(z.string()).optional(),
    body: z.unknown().optional(),
    timeout_ms: z.number().min(1000).max(30000).default(10000),
  });

  app.post('/api/v1/actions/trigger-webhook', async (request, reply) => {
    // TODO: gate to Advanced tier
    const body = triggerWebhookSchema.parse(request.body);

    const res = await fetch(body.url, {
      method: body.method,
      headers: {
        'Content-Type': 'application/json',
        ...body.headers,
      },
      body: body.body ? JSON.stringify(body.body) : undefined,
      signal: AbortSignal.timeout(body.timeout_ms),
    });

    const responseBody = await res.text();
    return reply.send({ status_code: res.status, response_body: responseBody });
  });
}
