/**
 * Internal AI endpoints — called only by the workflow service via X-Internal-API-Key.
 *
 * POST /internal/classify  — classify text into one of N categories
 * POST /internal/extract   — extract structured fields from text
 * POST /internal/respond   — generate an AI reply for a conversation
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { complete } from '../llm/client';

const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY ?? '';

export function registerInternalRoutes(app: FastifyInstance): void {
  // Auth guard for all /internal/* routes
  app.addHook('preHandler', async (request, reply) => {
    if (!request.url.startsWith('/internal/')) return;
    const key = request.headers['x-internal-api-key'];
    if (!key || key !== INTERNAL_API_KEY) {
      return reply.status(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid internal API key' } });
    }
  });

  // ── POST /internal/classify ───────────────────────────────────────────────
  const classifySchema = z.object({
    text: z.string().min(1).max(4096),
    categories: z.array(z.string()).min(1).max(20),
    model: z.string().optional(),
  });

  app.post('/internal/classify', async (request, reply) => {
    const body = classifySchema.parse(request.body);
    const tenantId = request.headers['x-tenant-id'] as string | undefined;

    const categoriesList = body.categories.map((c, i) => `${i + 1}. ${c}`).join('\n');

    const result = await complete(
      [
        {
          role: 'system',
          content: `You are a text classifier. Given a text message, classify it into EXACTLY ONE of the following categories:\n${categoriesList}\n\nRespond with ONLY the category name, nothing else.`,
        },
        { role: 'user', content: body.text },
      ],
      { model: body.model, temperature: 0, tenant_id: tenantId }
    );

    const rawCategory = result.content.trim();
    // Fuzzy match back to the provided category list
    const matched = body.categories.find(
      (c) => c.toLowerCase() === rawCategory.toLowerCase()
    ) ?? rawCategory;

    return reply.send({
      category: matched,
      confidence: 1.0,  // LiteLLM doesn't expose token probabilities by default
      model: result.model,
      latency_ms: result.latency_ms,
      usage: result.usage,
    });
  });

  // ── POST /internal/extract ────────────────────────────────────────────────
  const extractSchema = z.object({
    text: z.string().min(1).max(4096),
    schema: z.record(z.string()),  // { field_name: "description of what to extract" }
    model: z.string().optional(),
  });

  app.post('/internal/extract', async (request, reply) => {
    const body = extractSchema.parse(request.body);
    const tenantId = request.headers['x-tenant-id'] as string | undefined;

    const fieldList = Object.entries(body.schema)
      .map(([k, desc]) => `- "${k}": ${desc}`)
      .join('\n');

    const result = await complete(
      [
        {
          role: 'system',
          content: `You are a structured data extractor. Extract the following fields from the text and respond with a JSON object:\n${fieldList}\n\nIf a field cannot be found, use null. Respond ONLY with valid JSON, no explanation.`,
        },
        { role: 'user', content: body.text },
      ],
      { model: body.model, temperature: 0, max_tokens: 1024, tenant_id: tenantId }
    );

    let extracted: Record<string, unknown>;
    try {
      extracted = JSON.parse(result.content) as Record<string, unknown>;
    } catch {
      // If model returned non-JSON, return empty extraction
      extracted = Object.fromEntries(Object.keys(body.schema).map((k) => [k, null]));
    }

    return reply.send({
      extracted,
      model: result.model,
      latency_ms: result.latency_ms,
      usage: result.usage,
    });
  });

  // ── POST /internal/respond ────────────────────────────────────────────────
  const respondSchema = z.object({
    ai_agent_id: z.string().uuid(),
    conversation_id: z.string().uuid(),
    system_prompt: z.string(),
    messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() })),
    model: z.string().optional(),
  });

  app.post('/internal/respond', async (request, reply) => {
    const body = respondSchema.parse(request.body);
    const tenantId = request.headers['x-tenant-id'] as string | undefined;

    const result = await complete(
      [
        { role: 'system', content: body.system_prompt },
        ...body.messages,
      ],
      { model: body.model, temperature: 0.7, max_tokens: 1024, tenant_id: tenantId }
    );

    return reply.send({
      response: result.content,
      model: result.model,
      latency_ms: result.latency_ms,
      usage: result.usage,
      conversation_id: body.conversation_id,
    });
  });
}
