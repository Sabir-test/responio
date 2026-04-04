/**
 * Broadcast campaign CRUD and send routes.
 *
 * Broadcasts are bulk messages sent to a filtered segment of contacts.
 * Growth+ plan required (feature gate: broadcasts).
 *
 * GET    /api/v1/broadcasts             — list campaigns
 * GET    /api/v1/broadcasts/:id         — get campaign + stats
 * POST   /api/v1/broadcasts             — create draft campaign
 * PATCH  /api/v1/broadcasts/:id         — update draft
 * POST   /api/v1/broadcasts/:id/send    — schedule/send immediately
 * POST   /api/v1/broadcasts/:id/cancel  — cancel scheduled/running campaign
 * DELETE /api/v1/broadcasts/:id         — delete draft
 */

import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';
import type { EventPublisher } from '@responio/events';
import { Subjects } from '@responio/events';
import { PLAN_FEATURES } from '@responio/types';
import { z } from 'zod';

async function checkFeatureGate(
  db: Knex,
  tenantId: string,
  feature: keyof typeof PLAN_FEATURES['starter']
): Promise<boolean> {
  const account = await db('accounts').where({ id: tenantId }).select('plan_tier').first();
  const flags = PLAN_FEATURES[account?.plan_tier ?? 'starter'];
  return flags?.[feature] ?? false;
}

const broadcastSchema = z.object({
  name: z.string().min(1).max(255),
  channel_type: z.enum(['whatsapp', 'sms', 'email']).default('whatsapp'),
  inbox_id: z.string().uuid(),
  message_type: z.enum(['text', 'template']).default('text'),
  message_content: z.string().min(1).max(4096).optional(),
  template_name: z.string().optional(),
  template_language: z.string().default('en').optional(),
  template_variables: z.record(z.string()).optional(),
  /** Contact filter: lifecycle_stage, tags, custom_fields */
  audience_filter: z.object({
    lifecycle_stages: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
    contact_ids: z.array(z.string().uuid()).optional(),
  }).default({}),
  scheduled_at: z.string().datetime().optional(),
});

export function registerBroadcastRoutes(
  app: FastifyInstance,
  db: Knex,
  publisher: EventPublisher
): void {
  // ── GET /api/v1/broadcasts ────────────────────────────────────────────────
  app.get('/api/v1/broadcasts', async (request, reply) => {
    const tenantId = (request as unknown as { tenantId: string }).tenantId;

    const broadcasts = await db('broadcasts')
      .where({ tenant_id: tenantId })
      .orderBy('created_at', 'desc')
      .select(
        'id', 'name', 'channel_type', 'status',
        'recipient_count', 'sent_count', 'delivered_count', 'read_count',
        'scheduled_at', 'sent_at', 'created_at', 'updated_at'
      );

    return reply.send({ data: broadcasts });
  });

  // ── GET /api/v1/broadcasts/:id ────────────────────────────────────────────
  app.get('/api/v1/broadcasts/:id', async (request, reply) => {
    const tenantId = (request as unknown as { tenantId: string }).tenantId;
    const { id } = request.params as { id: string };

    const broadcast = await db('broadcasts').where({ id, tenant_id: tenantId }).first();
    if (!broadcast) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Broadcast not found' } });

    return reply.send({ data: broadcast });
  });

  // ── POST /api/v1/broadcasts ───────────────────────────────────────────────
  app.post('/api/v1/broadcasts', async (request, reply) => {
    const tenantId = (request as unknown as { tenantId: string }).tenantId;
    if (!(await checkFeatureGate(db, tenantId, 'broadcasts'))) {
      return reply.status(403).send({ error: { code: 'FEATURE_NOT_AVAILABLE', message: 'Broadcasts require the Growth plan or above' } });
    }
    const body = broadcastSchema.parse(request.body);

    const id = crypto.randomUUID();
    const [broadcast] = await db('broadcasts')
      .insert({
        id,
        tenant_id: tenantId,
        name: body.name,
        channel_type: body.channel_type,
        inbox_id: body.inbox_id,
        message_type: body.message_type,
        message_content: body.message_content,
        template_name: body.template_name,
        template_language: body.template_language,
        template_variables: body.template_variables ? JSON.stringify(body.template_variables) : null,
        audience_filter: JSON.stringify(body.audience_filter),
        scheduled_at: body.scheduled_at ?? null,
        status: 'draft',
        recipient_count: 0,
        sent_count: 0,
        delivered_count: 0,
        read_count: 0,
      })
      .returning('*');

    return reply.status(201).send({ data: broadcast });
  });

  // ── PATCH /api/v1/broadcasts/:id ──────────────────────────────────────────
  app.patch('/api/v1/broadcasts/:id', async (request, reply) => {
    const tenantId = (request as unknown as { tenantId: string }).tenantId;
    const { id } = request.params as { id: string };
    if (!(await checkFeatureGate(db, tenantId, 'broadcasts'))) {
      return reply.status(403).send({ error: { code: 'FEATURE_NOT_AVAILABLE', message: 'Broadcasts require the Growth plan or above' } });
    }
    const body = broadcastSchema.partial().parse(request.body);

    const existing = await db('broadcasts').where({ id, tenant_id: tenantId }).first();
    if (!existing) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Broadcast not found' } });

    if (!['draft'].includes(existing.status)) {
      return reply.status(409).send({ error: { code: 'NOT_EDITABLE', message: 'Only draft broadcasts can be edited' } });
    }

    const updates: Record<string, unknown> = { updated_at: new Date() };
    if (body.name !== undefined) updates.name = body.name;
    if (body.message_content !== undefined) updates.message_content = body.message_content;
    if (body.template_name !== undefined) updates.template_name = body.template_name;
    if (body.audience_filter !== undefined) updates.audience_filter = JSON.stringify(body.audience_filter);
    if (body.scheduled_at !== undefined) updates.scheduled_at = body.scheduled_at;

    const [updated] = await db('broadcasts').where({ id, tenant_id: tenantId }).update(updates).returning('*');
    return reply.send({ data: updated });
  });

  // ── POST /api/v1/broadcasts/:id/send ─────────────────────────────────────
  app.post('/api/v1/broadcasts/:id/send', async (request, reply) => {
    const tenantId = (request as unknown as { tenantId: string }).tenantId;
    const { id } = request.params as { id: string };
    if (!(await checkFeatureGate(db, tenantId, 'broadcasts'))) {
      return reply.status(403).send({ error: { code: 'FEATURE_NOT_AVAILABLE', message: 'Broadcasts require the Growth plan or above' } });
    }

    const broadcast = await db('broadcasts').where({ id, tenant_id: tenantId }).first();
    if (!broadcast) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Broadcast not found' } });

    if (broadcast.status !== 'draft') {
      return reply.status(409).send({ error: { code: 'ALREADY_SENT', message: 'Broadcast is not in draft status' } });
    }

    // Resolve recipient contacts from audience filter
    let filter: { lifecycle_stages?: string[]; tags?: string[]; contact_ids?: string[] };
    try {
      filter = JSON.parse(broadcast.audience_filter ?? '{}') as typeof filter;
    } catch {
      filter = {};
    }

    let query = db('contacts').where({ tenant_id: tenantId, do_not_contact: false });

    if (filter.lifecycle_stages?.length) {
      query = query.whereIn('lifecycle_stage', filter.lifecycle_stages);
    }
    if (filter.tags?.length) {
      query = query.whereRaw('tags && ?', [filter.tags]);
    }
    if (filter.contact_ids?.length) {
      query = query.whereIn('id', filter.contact_ids);
    }

    const contacts = await query.select('id') as Array<{ id: string }>;
    const recipientCount = contacts.length;

    if (recipientCount === 0) {
      return reply.status(422).send({ error: { code: 'NO_RECIPIENTS', message: 'No contacts match the audience filter' } });
    }

    // Mark as sending and update count
    await db('broadcasts').where({ id, tenant_id: tenantId }).update({
      status: broadcast.scheduled_at ? 'scheduled' : 'sending',
      recipient_count: recipientCount,
      sent_at: broadcast.scheduled_at ? null : new Date(),
      updated_at: new Date(),
    });

    // Insert recipient rows for tracking
    const recipientRows = contacts.map((c) => ({
      id: crypto.randomUUID(),
      tenant_id: tenantId,
      broadcast_id: id,
      contact_id: c.id,
      status: 'pending',
    }));

    // Batch insert in chunks to avoid oversized queries
    const CHUNK = 500;
    for (let i = 0; i < recipientRows.length; i += CHUNK) {
      await db('broadcast_recipients').insert(recipientRows.slice(i, i + CHUNK));
    }

    // Emit event for the sender worker to pick up
    await publisher.publish(Subjects.BILLING_MAC_INCREMENTED, {
      tenant_id: tenantId,
      workspace_id: '',
      source_service: 'broadcast',
      payload: {
        contact_id: '',  // Per-contact tracking handled by sender
        billing_period: currentBillingPeriod(),
        current_mac_count: recipientCount,
      },
    });

    return reply.send({
      data: {
        broadcast_id: id,
        status: broadcast.scheduled_at ? 'scheduled' : 'sending',
        recipient_count: recipientCount,
        scheduled_at: broadcast.scheduled_at ?? null,
      },
    });
  });

  // ── POST /api/v1/broadcasts/:id/cancel ────────────────────────────────────
  app.post('/api/v1/broadcasts/:id/cancel', async (request, reply) => {
    const tenantId = (request as unknown as { tenantId: string }).tenantId;
    const { id } = request.params as { id: string };

    const broadcast = await db('broadcasts').where({ id, tenant_id: tenantId }).first();
    if (!broadcast) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Broadcast not found' } });

    if (!['scheduled', 'sending'].includes(broadcast.status)) {
      return reply.status(409).send({ error: { code: 'NOT_CANCELLABLE', message: 'Only scheduled or sending broadcasts can be canceled' } });
    }

    await db('broadcasts').where({ id, tenant_id: tenantId }).update({
      status: 'canceled',
      updated_at: new Date(),
    });

    // Cancel pending recipients
    await db('broadcast_recipients')
      .where({ broadcast_id: id, status: 'pending' })
      .update({ status: 'canceled' });

    return reply.send({ data: { broadcast_id: id, status: 'canceled' } });
  });

  // ── DELETE /api/v1/broadcasts/:id ─────────────────────────────────────────
  app.delete('/api/v1/broadcasts/:id', async (request, reply) => {
    const tenantId = (request as unknown as { tenantId: string }).tenantId;
    const { id } = request.params as { id: string };

    const broadcast = await db('broadcasts').where({ id, tenant_id: tenantId }).first();
    if (!broadcast) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Broadcast not found' } });

    if (broadcast.status === 'sending') {
      return reply.status(409).send({ error: { code: 'SENDING', message: 'Cannot delete a broadcast that is currently sending' } });
    }

    await db('broadcast_recipients').where({ broadcast_id: id }).delete();
    await db('broadcasts').where({ id, tenant_id: tenantId }).delete();
    return reply.status(204).send();
  });
}

function currentBillingPeriod(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}
