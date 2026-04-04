/**
 * n8n REST API client.
 * Used by the workflow service to create, activate, and manage n8n workflows.
 * Customers never call n8n directly — they use our API which proxies to n8n.
 *
 * n8n API docs: https://docs.n8n.io/api/
 */

export interface N8nWorkflow {
  id?: string;
  name: string;
  active: boolean;
  nodes: N8nNode[];
  connections: N8nConnections;
  settings?: N8nWorkflowSettings;
  staticData?: Record<string, unknown> | null;
  tags?: Array<{ id?: string; name: string }>;
}

export interface N8nNode {
  id: string;
  name: string;
  type: string;
  typeVersion: number;
  position: [number, number];
  parameters: Record<string, unknown>;
  credentials?: Record<string, { id: string; name: string }>;
  disabled?: boolean;
  notes?: string;
  continueOnFail?: boolean;
  retryOnFail?: boolean;
  maxTries?: number;
  waitBetweenTries?: number;
  alwaysOutputData?: boolean;
}

export type N8nConnections = Record<
  string,
  {
    main?: Array<Array<{ node: string; type: 'main'; index: number }> | null>;
  }
>;

export interface N8nWorkflowSettings {
  executionOrder?: 'v0' | 'v1';
  saveManualExecutions?: boolean;
  callerPolicy?: 'workflowsFromSameOwner' | 'workflowsFromAList' | 'any' | 'none';
  errorWorkflow?: string;
  timezone?: string;
}

export interface N8nExecution {
  id: string;
  finished: boolean;
  mode: string;
  status: 'running' | 'success' | 'error' | 'waiting' | 'canceled';
  startedAt: string;
  stoppedAt?: string;
  workflowId: string;
  data?: Record<string, unknown>;
}

export interface N8nWebhookTrigger {
  webhookId: string;
  path: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
}

export class N8nClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/v1${path}`, {
        method,
        headers: {
          'X-N8N-API-KEY': this.apiKey,
          'Content-Type': 'application/json',
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000), // 15s timeout for all n8n API calls
      });
    } catch (err) {
      throw new Error(`n8n API call failed (${method} ${path}): ${String(err)}`);
    }

    if (!res.ok) {
      const text = await res.text();
      throw new N8nApiError(res.status, path, text);
    }

    return res.json() as Promise<T>;
  }

  // ── Workflows ──────────────────────────────────────────────────────────────

  async createWorkflow(workflow: N8nWorkflow): Promise<N8nWorkflow> {
    return this.request<N8nWorkflow>('POST', '/workflows', workflow);
  }

  async getWorkflow(id: string): Promise<N8nWorkflow> {
    return this.request<N8nWorkflow>('GET', `/workflows/${id}`);
  }

  async updateWorkflow(id: string, workflow: Partial<N8nWorkflow>): Promise<N8nWorkflow> {
    return this.request<N8nWorkflow>('PATCH', `/workflows/${id}`, workflow);
  }

  async deleteWorkflow(id: string): Promise<void> {
    await this.request<void>('DELETE', `/workflows/${id}`);
  }

  async activateWorkflow(id: string): Promise<N8nWorkflow> {
    return this.request<N8nWorkflow>('POST', `/workflows/${id}/activate`);
  }

  async deactivateWorkflow(id: string): Promise<N8nWorkflow> {
    return this.request<N8nWorkflow>('POST', `/workflows/${id}/deactivate`);
  }

  async listWorkflows(tags?: string[]): Promise<N8nWorkflow[]> {
    const params = tags?.length ? `?tags=${tags.join(',')}` : '';
    const result = await this.request<{ data: N8nWorkflow[] }>('GET', `/workflows${params}`);
    return result.data;
  }

  // ── Executions ─────────────────────────────────────────────────────────────

  async getExecution(id: string): Promise<N8nExecution> {
    return this.request<N8nExecution>('GET', `/executions/${id}`);
  }

  async listExecutions(workflowId?: string, limit = 50): Promise<N8nExecution[]> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (workflowId) params.set('workflowId', workflowId);
    const result = await this.request<{ data: N8nExecution[] }>('GET', `/executions?${params}`);
    return result.data;
  }

  async deleteExecution(id: string): Promise<void> {
    await this.request<void>('DELETE', `/executions/${id}`);
  }

  // ── Health ─────────────────────────────────────────────────────────────────

  async healthCheck(): Promise<boolean> {
    try {
      await fetch(`${this.baseUrl}/healthz`);
      return true;
    } catch {
      return false;
    }
  }
}

export class N8nApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    public readonly body: string
  ) {
    super(`n8n API error ${status} on ${path}: ${body}`);
    this.name = 'N8nApiError';
  }
}
