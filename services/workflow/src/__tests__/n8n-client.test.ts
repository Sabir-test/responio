/**
 * Unit tests for the n8n REST API client.
 * Verifies URL construction, request headers, error handling,
 * response parsing, and the health check endpoint.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { N8nClient, N8nApiError } from '../n8n/client';
import type { N8nWorkflow } from '../n8n/client';

// ── Mock helpers ──────────────────────────────────────────────────────────────

function makeWorkflow(id = 'wf-1'): N8nWorkflow {
  return {
    id,
    name: 'Test Workflow',
    active: false,
    nodes: [],
    connections: {},
  };
}

function makeJsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('N8nClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let client: N8nClient;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    client = new N8nClient('http://n8n:5678', 'test-api-key');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── URL construction ────────────────────────────────────────────────────────

  it('strips trailing slash from baseUrl', async () => {
    const clientWithSlash = new N8nClient('http://n8n:5678/', 'key');
    fetchMock.mockResolvedValueOnce(makeJsonResponse(makeWorkflow()));

    await clientWithSlash.getWorkflow('wf-1');

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('http://n8n:5678/api/v1/workflows/wf-1');
    expect(url).not.toContain('//api');
  });

  it('always includes X-N8N-API-KEY header', async () => {
    fetchMock.mockResolvedValueOnce(makeJsonResponse(makeWorkflow()));
    await client.getWorkflow('wf-1');

    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.headers['X-N8N-API-KEY']).toBe('test-api-key');
  });

  // ── Workflow CRUD ───────────────────────────────────────────────────────────

  it('createWorkflow POSTs to /api/v1/workflows with workflow body', async () => {
    const wf = makeWorkflow();
    fetchMock.mockResolvedValueOnce(makeJsonResponse({ ...wf, id: 'wf-new' }));

    const result = await client.createWorkflow(wf);

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('http://n8n:5678/api/v1/workflows');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toMatchObject({ name: 'Test Workflow' });
    expect(result.id).toBe('wf-new');
  });

  it('getWorkflow GETs /api/v1/workflows/:id', async () => {
    fetchMock.mockResolvedValueOnce(makeJsonResponse(makeWorkflow('wf-42')));
    const result = await client.getWorkflow('wf-42');

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('http://n8n:5678/api/v1/workflows/wf-42');
    expect(opts.method).toBe('GET');
    expect(result.id).toBe('wf-42');
  });

  it('updateWorkflow PATCHes /api/v1/workflows/:id', async () => {
    const updated = { ...makeWorkflow('wf-1'), active: true };
    fetchMock.mockResolvedValueOnce(makeJsonResponse(updated));

    const result = await client.updateWorkflow('wf-1', { active: true });

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('http://n8n:5678/api/v1/workflows/wf-1');
    expect(opts.method).toBe('PATCH');
    expect(result.active).toBe(true);
  });

  it('deleteWorkflow DELETEs /api/v1/workflows/:id', async () => {
    fetchMock.mockResolvedValueOnce(makeJsonResponse(null, 200));
    await client.deleteWorkflow('wf-1');

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('http://n8n:5678/api/v1/workflows/wf-1');
    expect(opts.method).toBe('DELETE');
  });

  it('activateWorkflow POSTs to /api/v1/workflows/:id/activate', async () => {
    fetchMock.mockResolvedValueOnce(makeJsonResponse({ ...makeWorkflow('wf-1'), active: true }));
    const result = await client.activateWorkflow('wf-1');

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('http://n8n:5678/api/v1/workflows/wf-1/activate');
    expect(opts.method).toBe('POST');
    expect(result.active).toBe(true);
  });

  it('deactivateWorkflow POSTs to /api/v1/workflows/:id/deactivate', async () => {
    fetchMock.mockResolvedValueOnce(makeJsonResponse({ ...makeWorkflow('wf-1'), active: false }));
    const result = await client.deactivateWorkflow('wf-1');

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('http://n8n:5678/api/v1/workflows/wf-1/deactivate');
    expect(result.active).toBe(false);
  });

  it('listWorkflows returns the data array', async () => {
    const wfs = [makeWorkflow('wf-1'), makeWorkflow('wf-2')];
    fetchMock.mockResolvedValueOnce(makeJsonResponse({ data: wfs }));

    const result = await client.listWorkflows();
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('wf-1');
  });

  it('listWorkflows passes tags as query param', async () => {
    fetchMock.mockResolvedValueOnce(makeJsonResponse({ data: [] }));
    await client.listWorkflows(['tenant-abc', 'v2']);

    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('?tags=tenant-abc,v2');
  });

  // ── Executions ──────────────────────────────────────────────────────────────

  it('getExecution GETs /api/v1/executions/:id', async () => {
    const exec = { id: 'exec-1', finished: true, mode: 'webhook', status: 'success', startedAt: new Date().toISOString(), workflowId: 'wf-1' };
    fetchMock.mockResolvedValueOnce(makeJsonResponse(exec));

    const result = await client.getExecution('exec-1');
    expect(result.id).toBe('exec-1');
    expect(result.status).toBe('success');
  });

  it('listExecutions passes workflowId and limit', async () => {
    fetchMock.mockResolvedValueOnce(makeJsonResponse({ data: [] }));
    await client.listExecutions('wf-1', 10);

    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('workflowId=wf-1');
    expect(url).toContain('limit=10');
  });

  it('deleteExecution DELETEs /api/v1/executions/:id', async () => {
    fetchMock.mockResolvedValueOnce(makeJsonResponse(null, 200));
    await client.deleteExecution('exec-1');

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('http://n8n:5678/api/v1/executions/exec-1');
    expect(opts.method).toBe('DELETE');
  });

  // ── Error handling ──────────────────────────────────────────────────────────

  it('throws N8nApiError with status and body when response is not ok', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: vi.fn().mockResolvedValue('Workflow not found'),
    });

    await expect(client.getWorkflow('missing')).rejects.toThrow(N8nApiError);
    await expect(client.getWorkflow('missing').catch((e) => { throw e; })).rejects.toMatchObject({
      status: 404,
      path: '/workflows/missing',
    });
  });

  it('wraps network errors with a descriptive message', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await expect(client.getWorkflow('wf-1')).rejects.toThrow(/n8n API call failed/);
  });

  it('N8nApiError.name is N8nApiError', () => {
    const err = new N8nApiError(500, '/test', 'body');
    expect(err.name).toBe('N8nApiError');
    expect(err.message).toContain('500');
  });

  // ── Health check ────────────────────────────────────────────────────────────

  it('healthCheck returns true when /healthz responds', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    const healthy = await client.healthCheck();
    expect(healthy).toBe(true);

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('http://n8n:5678/healthz');
  });

  it('healthCheck returns false when fetch throws', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Connection refused'));
    const healthy = await client.healthCheck();
    expect(healthy).toBe(false);
  });
});
