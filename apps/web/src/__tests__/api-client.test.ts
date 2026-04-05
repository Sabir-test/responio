/**
 * Unit tests for the typed API client.
 *
 * Tests cover:
 *  - setToken / clearToken localStorage side-effects
 *  - Authorization header injected when token is present
 *  - No Authorization header when token is absent
 *  - Successful JSON response deserialization
 *  - ApiError thrown on non-OK response (status + code + message)
 *  - Graceful fallback when error response body is not valid JSON
 *  - billingApi, workflowsApi convenience method URL construction
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiError } from '../lib/query-client';

// ── Module reset between tests ────────────────────────────────────────────────

// We need to re-import the module fresh each test so token state is clean.
// Use dynamic import after setting/clearing localStorage.

function makeOkResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
    statusText: 'OK',
  };
}

function makeErrorResponse(status: number, body: unknown, statusText = 'Error') {
  return {
    ok: false,
    status,
    statusText,
    json: vi.fn().mockResolvedValue(body),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('setToken / clearToken', () => {
  beforeEach(() => localStorage.clear());

  it('setToken stores token in localStorage', async () => {
    const { setToken } = await import('../lib/api-client');
    setToken('my-token-abc');
    expect(localStorage.getItem('responio_token')).toBe('my-token-abc');
  });

  it('clearToken removes token from localStorage', async () => {
    localStorage.setItem('responio_token', 'existing');
    const { clearToken } = await import('../lib/api-client');
    clearToken();
    expect(localStorage.getItem('responio_token')).toBeNull();
  });
});

describe('request() — Authorization header', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('includes Bearer token when token is in localStorage', async () => {
    localStorage.setItem('responio_token', 'tok-xyz');
    fetchMock.mockResolvedValueOnce(makeOkResponse({ data: [] }));

    const { workflowsApi } = await import('../lib/api-client');
    await workflowsApi.list();

    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.headers['Authorization']).toBe('Bearer tok-xyz');
  });

  it('omits Authorization header when no token is stored', async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse({ data: [] }));

    const { workflowsApi } = await import('../lib/api-client');
    await workflowsApi.list();

    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.headers['Authorization']).toBeUndefined();
  });

  it('always sends Content-Type: application/json', async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse({ data: [] }));
    const { workflowsApi } = await import('../lib/api-client');
    await workflowsApi.list();

    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.headers['Content-Type']).toBe('application/json');
  });
});

describe('request() — URL construction', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.resetModules();
  });

  afterEach(() => vi.unstubAllGlobals());

  it('workflowsApi.list() requests GET /api/v1/workflows', async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse({ data: [] }));
    const { workflowsApi } = await import('../lib/api-client');
    await workflowsApi.list();

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/v1/workflows');
    expect(opts.method).toBe('GET');
  });

  it('workflowsApi.get(id) requests GET /api/v1/workflows/:id', async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse({ data: {} }));
    const { workflowsApi } = await import('../lib/api-client');
    await workflowsApi.get('wf-abc');

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/v1/workflows/wf-abc');
  });

  it('workflowsApi.publish(id) requests POST /api/v1/workflows/:id/publish', async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse({ data: { status: 'published' } }));
    const { workflowsApi } = await import('../lib/api-client');
    await workflowsApi.publish('wf-xyz');

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/v1/workflows/wf-xyz/publish');
    expect(opts.method).toBe('POST');
  });

  it('billingApi.getSubscription() requests GET /api/v1/billing/subscription', async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse({ data: {} }));
    const { billingApi } = await import('../lib/api-client');
    await billingApi.getSubscription();

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/v1/billing/subscription');
    expect(opts.method).toBe('GET');
  });

  it('billingApi.createCheckout() sends plan_id and billing_interval in body', async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse({ checkout_url: 'https://stripe.com/pay' }));
    const { billingApi } = await import('../lib/api-client');
    await billingApi.createCheckout('growth', 'annual');

    const [, opts] = fetchMock.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.plan_id).toBe('growth');
    expect(body.billing_interval).toBe('annual');
  });

  it('workflowsApi.delete(id) sends DELETE with no body', async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse(null, 204));
    const { workflowsApi } = await import('../lib/api-client');
    await workflowsApi.delete('wf-1');

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/v1/workflows/wf-1');
    expect(opts.method).toBe('DELETE');
    expect(opts.body).toBeUndefined();
  });
});

describe('request() — error handling', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.resetModules();
  });

  afterEach(() => vi.unstubAllGlobals());

  it('throws ApiError with status, code, and message on non-OK response', async () => {
    fetchMock.mockResolvedValueOnce(makeErrorResponse(404, {
      error: { code: 'NOT_FOUND', message: 'Workflow not found' },
    }));
    const { workflowsApi } = await import('../lib/api-client');

    let caught: unknown;
    try {
      await workflowsApi.get('missing');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ApiError);
    const err = caught as ApiError;
    expect(err.status).toBe(404);
    expect(err.code).toBe('NOT_FOUND');
    expect(err.message).toBe('Workflow not found');
  });

  it('falls back to UNKNOWN code when error body has no error object', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: vi.fn().mockResolvedValue({}),
    });
    const { workflowsApi } = await import('../lib/api-client');

    let caught: unknown;
    try {
      await workflowsApi.list();
    } catch (err) {
      caught = err;
    }

    const err = caught as ApiError;
    expect(err.code).toBe('UNKNOWN');
  });

  it('falls back to UNKNOWN when error response body is invalid JSON', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      json: vi.fn().mockRejectedValue(new SyntaxError('Unexpected token')),
    });
    const { billingApi } = await import('../lib/api-client');

    let caught: unknown;
    try {
      await billingApi.getSubscription();
    } catch (err) {
      caught = err;
    }

    const err = caught as ApiError;
    expect(err.status).toBe(502);
    expect(err.code).toBe('UNKNOWN');
  });
});

describe('ApiError class', () => {
  it('has name=ApiError', () => {
    const err = new ApiError(403, 'FORBIDDEN', 'Access denied');
    expect(err.name).toBe('ApiError');
    expect(err instanceof Error).toBe(true);
  });

  it('exposes status, code, and message', () => {
    const err = new ApiError(401, 'UNAUTHORIZED', 'Token expired');
    expect(err.status).toBe(401);
    expect(err.code).toBe('UNAUTHORIZED');
    expect(err.message).toBe('Token expired');
  });
});
