/**
 * Tests for AI internal routes.
 * Mocks the LLM client — no real API calls made.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { registerInternalRoutes } from '../routes/internal';

// Mock the LLM client before importing routes
vi.mock('../llm/client', () => ({
  complete: vi.fn(),
}));

import { complete } from '../llm/client';
const mockComplete = complete as ReturnType<typeof vi.fn>;

const API_KEY = 'test-ai-key';
const authHeaders = { 'x-internal-api-key': API_KEY, 'x-tenant-id': 'tenant-123' };

async function buildApp() {
  process.env.INTERNAL_API_KEY = API_KEY;
  const app = Fastify({ logger: false });
  registerInternalRoutes(app);
  await app.ready();
  return app;
}

// ── Auth guard ─────────────────────────────────────────────────────────────────

describe('auth guard', () => {
  it('returns 401 for missing API key', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST', url: '/internal/classify',
      payload: { text: 'hello', categories: ['a', 'b'] },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('returns 401 for wrong API key', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST', url: '/internal/classify',
      headers: { 'x-internal-api-key': 'wrong' },
      payload: { text: 'hello', categories: ['a', 'b'] },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

// ── POST /internal/classify ───────────────────────────────────────────────────

describe('POST /internal/classify', () => {
  beforeEach(() => mockComplete.mockReset());

  it('returns 400 when categories is empty', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST', url: '/internal/classify',
      headers: authHeaders,
      payload: { text: 'hello', categories: [] },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns 400 for text exceeding 4096 chars', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST', url: '/internal/classify',
      headers: authHeaders,
      payload: { text: 'a'.repeat(4097), categories: ['billing', 'support'] },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns matched category from LLM response', async () => {
    mockComplete.mockResolvedValueOnce({
      content: 'billing',
      model: 'gpt-4o-mini',
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      latency_ms: 200,
    });

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST', url: '/internal/classify',
      headers: authHeaders,
      payload: { text: 'I need help with my invoice', categories: ['billing', 'support', 'other'] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.category).toBe('billing');
    expect(body.confidence).toBe(1.0);
    await app.close();
  });

  it('returns raw LLM response when category not in list (fuzzy fallback)', async () => {
    mockComplete.mockResolvedValueOnce({
      content: 'BILLING',  // uppercase — fuzzy match should find 'billing'
      model: 'gpt-4o-mini',
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      latency_ms: 150,
    });

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST', url: '/internal/classify',
      headers: authHeaders,
      payload: { text: 'invoice question', categories: ['billing', 'support'] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().category).toBe('billing');  // case-insensitive match
    await app.close();
  });

  it('propagates LlmError as 500', async () => {
    const { LlmError } = await import('../llm/client');
    mockComplete.mockRejectedValueOnce(new LlmError(503, 'Service unavailable'));

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST', url: '/internal/classify',
      headers: authHeaders,
      payload: { text: 'hello', categories: ['billing'] },
    });
    expect(res.statusCode).toBe(500);
    await app.close();
  });
});

// ── POST /internal/extract ────────────────────────────────────────────────────

describe('POST /internal/extract', () => {
  beforeEach(() => mockComplete.mockReset());

  it('returns extracted fields from valid JSON LLM response', async () => {
    mockComplete.mockResolvedValueOnce({
      content: JSON.stringify({ name: 'Alice', email: 'alice@example.com' }),
      model: 'gpt-4o-mini',
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      latency_ms: 300,
    });

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST', url: '/internal/extract',
      headers: authHeaders,
      payload: {
        text: 'My name is Alice and my email is alice@example.com',
        schema: { name: 'The person name', email: 'Email address' },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().extracted.name).toBe('Alice');
    await app.close();
  });

  it('returns null-filled object when LLM returns non-JSON', async () => {
    mockComplete.mockResolvedValueOnce({
      content: 'Sorry, I cannot extract that.',
      model: 'gpt-4o-mini',
      usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
      latency_ms: 100,
    });

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST', url: '/internal/extract',
      headers: authHeaders,
      payload: { text: 'no data here', schema: { name: 'name', phone: 'phone number' } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.extracted.name).toBeNull();
    expect(body.extracted.phone).toBeNull();
    await app.close();
  });
});

// ── POST /internal/respond ────────────────────────────────────────────────────

describe('POST /internal/respond', () => {
  beforeEach(() => mockComplete.mockReset());

  it('returns AI response with metadata', async () => {
    mockComplete.mockResolvedValueOnce({
      content: 'Hello! How can I help you today?',
      model: 'gpt-4o-mini',
      usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
      latency_ms: 400,
    });

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST', url: '/internal/respond',
      headers: authHeaders,
      payload: {
        ai_agent_id: '11111111-1111-1111-1111-111111111111',
        conversation_id: '22222222-2222-2222-2222-222222222222',
        system_prompt: 'You are a helpful assistant.',
        messages: [{ role: 'user', content: 'Hi' }],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.response).toBe('Hello! How can I help you today?');
    expect(body.conversation_id).toBe('22222222-2222-2222-2222-222222222222');
    await app.close();
  });
});
