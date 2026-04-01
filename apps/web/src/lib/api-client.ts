/**
 * Typed API client for the Responio gateway.
 * All requests go through /api (proxied to gateway by Vite in dev, Traefik in prod).
 */

import { ApiError } from './query-client';

const BASE = '/api/v1';

function getToken(): string | null {
  return localStorage.getItem('responio_token');
}

export function setToken(token: string): void {
  localStorage.setItem('responio_token', token);
}

export function clearToken(): void {
  localStorage.removeItem('responio_token');
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: { code: 'UNKNOWN', message: res.statusText } }));
    throw new ApiError(res.status, data.error?.code ?? 'UNKNOWN', data.error?.message ?? res.statusText);
  }

  return res.json() as Promise<T>;
}

// ── Billing ───────────────────────────────────────────────────────────────────

export const billingApi = {
  getSubscription: () => request<{ data: SubscriptionData }>('GET', '/billing/subscription'),
  getUsage: () => request<{ data: UsageData }>('GET', '/billing/usage'),
  createCheckout: (planId: string, billingInterval: 'monthly' | 'annual') =>
    request<{ checkout_url: string }>('POST', '/billing/checkout', { plan_id: planId, billing_interval: billingInterval }),
  openPortal: () => request<{ portal_url: string }>('POST', '/billing/portal'),
};

// ── Workflows ─────────────────────────────────────────────────────────────────

export const workflowsApi = {
  list: () => request<{ data: WorkflowSummary[] }>('GET', '/workflows'),
  get: (id: string) => request<{ data: Workflow }>('GET', `/workflows/${id}`),
  create: (payload: { name: string; trigger_type: string; graph_json: unknown }) =>
    request<{ data: Workflow }>('POST', '/workflows', payload),
  update: (id: string, payload: { name?: string; graph_json?: unknown }) =>
    request<{ data: Workflow }>('PATCH', `/workflows/${id}`, payload),
  publish: (id: string) =>
    request<{ data: { workflow_id: string; n8n_workflow_id: string; status: string } }>('POST', `/workflows/${id}/publish`),
  unpublish: (id: string) => request<{ data: { status: string } }>('POST', `/workflows/${id}/unpublish`),
  delete: (id: string) => request<void>('DELETE', `/workflows/${id}`),
  getExecutions: (id: string) => request<{ data: WorkflowExecution[] }>('GET', `/workflows/${id}/executions`),
};

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SubscriptionData {
  plan_id: string;
  plan_name: string;
  billing_status: string;
  stripe_subscription_id: string | null;
  seat_count: number;
  mac_limit: number | null;
  current_period: string;
  mac_count: number;
  overage_amount_usd: number;
}

export interface UsageData {
  billing_period: string;
  mac_count: number;
  mac_limit: number | null;
  overage_units: number;
  projected_overage_usd: number;
  usage_pct: number | null;
}

export interface WorkflowSummary {
  id: string;
  name: string;
  trigger_type: string;
  version: number;
  status: 'draft' | 'published' | 'archived';
  created_at: string;
  updated_at: string;
}

export interface Workflow extends WorkflowSummary {
  graph_json: unknown;
  n8n_workflow_id: string | null;
  published_at: string | null;
}

export interface WorkflowExecution {
  id: string;
  finished: boolean;
  mode: string;
  status: 'running' | 'success' | 'error' | 'waiting' | 'canceled';
  startedAt: string;
  stoppedAt?: string;
  workflowId: string;
}
