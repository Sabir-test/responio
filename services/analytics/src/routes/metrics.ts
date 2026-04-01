/**
 * Analytics metrics endpoints.
 *
 * All queries are scoped to tenant_id — RLS enforced at ClickHouse level via query params.
 *
 * GET /api/v1/analytics/conversations  — conversation volume over time
 * GET /api/v1/analytics/messages       — message volume by channel
 * GET /api/v1/analytics/response-times — first-reply and resolution time stats
 * GET /api/v1/analytics/agents         — agent performance (conversations resolved, avg time)
 * GET /api/v1/analytics/contacts       — new contacts over time, lifecycle distribution
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getClickHouseClient, type TimeGranularity } from '../clickhouse/client';

const periodSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  granularity: z.enum(['hour', 'day', 'week', 'month']).default('day'),
});

export function registerMetricsRoutes(app: FastifyInstance): void {
  // ── GET /api/v1/analytics/conversations ───────────────────────────────────
  app.get('/api/v1/analytics/conversations', async (request, reply) => {
    const tenantId = (request as unknown as { tenantId: string }).tenantId;
    const query = periodSchema.parse(request.query);
    const ch = getClickHouseClient();

    const from = query.from ?? daysAgo(30);
    const to = query.to ?? today();

    const result = await ch.query({
      query: `
        SELECT
          toStartOf${capitalize(query.granularity)}(created_at) AS period,
          countIf(status = 'open') AS opened,
          countIf(status = 'resolved') AS resolved,
          countIf(status = 'pending') AS pending,
          count() AS total
        FROM conversations_events
        WHERE tenant_id = {tenantId:String}
          AND created_at >= {from:Date}
          AND created_at <= {to:Date}
        GROUP BY period
        ORDER BY period ASC
      `,
      query_params: { tenantId, from, to },
      format: 'JSONEachRow',
    });

    const rows = await result.json();
    return reply.send({ data: rows, meta: { from, to, granularity: query.granularity } });
  });

  // ── GET /api/v1/analytics/messages ────────────────────────────────────────
  app.get('/api/v1/analytics/messages', async (request, reply) => {
    const tenantId = (request as unknown as { tenantId: string }).tenantId;
    const query = periodSchema.parse(request.query);
    const ch = getClickHouseClient();

    const from = query.from ?? daysAgo(30);
    const to = query.to ?? today();

    const result = await ch.query({
      query: `
        SELECT
          toStartOf${capitalize(query.granularity)}(created_at) AS period,
          channel_type,
          countIf(direction = 'inbound') AS inbound,
          countIf(direction = 'outbound') AS outbound,
          count() AS total
        FROM messages_events
        WHERE tenant_id = {tenantId:String}
          AND created_at >= {from:Date}
          AND created_at <= {to:Date}
        GROUP BY period, channel_type
        ORDER BY period ASC, channel_type ASC
      `,
      query_params: { tenantId, from, to },
      format: 'JSONEachRow',
    });

    const rows = await result.json();
    return reply.send({ data: rows, meta: { from, to, granularity: query.granularity } });
  });

  // ── GET /api/v1/analytics/response-times ─────────────────────────────────
  app.get('/api/v1/analytics/response-times', async (request, reply) => {
    const tenantId = (request as unknown as { tenantId: string }).tenantId;
    const query = periodSchema.parse(request.query);
    const ch = getClickHouseClient();

    const from = query.from ?? daysAgo(30);
    const to = query.to ?? today();

    const result = await ch.query({
      query: `
        SELECT
          toStartOf${capitalize(query.granularity)}(resolved_at) AS period,
          round(avg(first_reply_seconds), 0) AS avg_first_reply_seconds,
          round(median(first_reply_seconds), 0) AS p50_first_reply_seconds,
          round(quantile(0.95)(first_reply_seconds), 0) AS p95_first_reply_seconds,
          round(avg(resolution_seconds), 0) AS avg_resolution_seconds,
          count() AS conversations_resolved
        FROM conversations_events
        WHERE tenant_id = {tenantId:String}
          AND resolved_at >= {from:Date}
          AND resolved_at <= {to:Date}
          AND first_reply_seconds > 0
        GROUP BY period
        ORDER BY period ASC
      `,
      query_params: { tenantId, from, to },
      format: 'JSONEachRow',
    });

    const rows = await result.json();
    return reply.send({ data: rows, meta: { from, to, granularity: query.granularity } });
  });

  // ── GET /api/v1/analytics/agents ─────────────────────────────────────────
  app.get('/api/v1/analytics/agents', async (request, reply) => {
    const tenantId = (request as unknown as { tenantId: string }).tenantId;
    const query = periodSchema.parse(request.query);
    const ch = getClickHouseClient();

    const from = query.from ?? daysAgo(30);
    const to = query.to ?? today();

    const result = await ch.query({
      query: `
        SELECT
          assignee_id,
          count() AS conversations_handled,
          countIf(status = 'resolved') AS conversations_resolved,
          round(avg(resolution_seconds), 0) AS avg_resolution_seconds,
          countIf(first_reply_seconds < 300) AS replied_within_5min
        FROM conversations_events
        WHERE tenant_id = {tenantId:String}
          AND created_at >= {from:Date}
          AND created_at <= {to:Date}
          AND assignee_id != ''
        GROUP BY assignee_id
        ORDER BY conversations_resolved DESC
        LIMIT 50
      `,
      query_params: { tenantId, from, to },
      format: 'JSONEachRow',
    });

    const rows = await result.json();
    return reply.send({ data: rows, meta: { from, to } });
  });

  // ── GET /api/v1/analytics/contacts ───────────────────────────────────────
  app.get('/api/v1/analytics/contacts', async (request, reply) => {
    const tenantId = (request as unknown as { tenantId: string }).tenantId;
    const query = periodSchema.parse(request.query);
    const ch = getClickHouseClient();

    const from = query.from ?? daysAgo(30);
    const to = query.to ?? today();

    const [newContacts, lifecycle] = await Promise.all([
      ch.query({
        query: `
          SELECT
            toStartOf${capitalize(query.granularity)}(created_at) AS period,
            count() AS new_contacts
          FROM contact_events
          WHERE tenant_id = {tenantId:String}
            AND event_type = 'created'
            AND created_at >= {from:Date}
            AND created_at <= {to:Date}
          GROUP BY period
          ORDER BY period ASC
        `,
        query_params: { tenantId, from, to },
        format: 'JSONEachRow',
      }),
      ch.query({
        query: `
          SELECT lifecycle_stage, count() AS count
          FROM contact_events
          WHERE tenant_id = {tenantId:String}
            AND event_type = 'lifecycle_changed'
            AND created_at >= {from:Date}
            AND created_at <= {to:Date}
          GROUP BY lifecycle_stage
          ORDER BY count DESC
        `,
        query_params: { tenantId, from, to },
        format: 'JSONEachRow',
      }),
    ]);

    return reply.send({
      data: {
        new_contacts_over_time: await newContacts.json(),
        lifecycle_distribution: await lifecycle.json(),
      },
      meta: { from, to, granularity: query.granularity },
    });
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function capitalize(s: TimeGranularity): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
