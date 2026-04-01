/**
 * LLM client — thin wrapper around LiteLLM proxy.
 *
 * All LLM calls go through LiteLLM so we can:
 *   - Switch models without code changes
 *   - Rate-limit and budget per tenant
 *   - Log all completions for compliance
 *
 * LiteLLM proxy docs: https://docs.litellm.ai/docs/proxy/quick_start
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompletionOptions {
  model?: string;
  temperature?: number;
  max_tokens?: number;
  /** Tenant ID for per-tenant budgeting and logging */
  tenant_id?: string;
}

export interface CompletionResult {
  content: string;
  model: string;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  latency_ms: number;
}

const LITELLM_BASE = process.env.LITELLM_API_BASE ?? 'http://localhost:4000';
const LITELLM_KEY = process.env.LITELLM_MASTER_KEY ?? '';
const DEFAULT_MODEL = process.env.DEFAULT_LLM_MODEL ?? 'gpt-4o-mini';

export async function complete(
  messages: ChatMessage[],
  options: CompletionOptions = {}
): Promise<CompletionResult> {
  const start = Date.now();

  const res = await fetch(`${LITELLM_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${LITELLM_KEY}`,
      ...(options.tenant_id ? { 'x-litellm-user': options.tenant_id } : {}),
    },
    body: JSON.stringify({
      model: options.model ?? DEFAULT_MODEL,
      messages,
      temperature: options.temperature ?? 0.1,
      max_tokens: options.max_tokens ?? 512,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new LlmError(res.status, text);
  }

  const data = await res.json() as {
    choices: Array<{ message: { content: string } }>;
    model: string;
    usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  };

  return {
    content: data.choices[0].message.content,
    model: data.model,
    usage: data.usage,
    latency_ms: Date.now() - start,
  };
}

export class LlmError extends Error {
  constructor(public readonly status: number, public readonly body: string) {
    super(`LLM API error ${status}: ${body}`);
    this.name = 'LlmError';
  }
}
