/**
 * Unit tests for AuthProvider and useAuth hook.
 *
 * Tests cover:
 *  - JWT parsing (valid token → user fields populated)
 *  - Hydration from localStorage on mount
 *  - login() / logout() state transitions
 *  - setToken / clearToken side-effects on localStorage
 *  - Auto-logout timer when token is already expired
 *  - useAuth throws when used outside provider
 */

import React from 'react';
import { render, screen, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuthProvider, useAuth } from '../contexts/auth-context';

// ── JWT helpers ────────────────────────────────────────────────────────────────

function makeJwtPayload(overrides: Record<string, unknown> = {}) {
  return {
    sub: 'user-123',
    tenant_id: 'tenant-abc',
    email: 'alice@example.com',
    role: 'admin',
    workspace_ids: ['ws-1', 'ws-2'],
    exp: Math.floor(Date.now() / 1000) + 3600, // expires in 1 hour
    ...overrides,
  };
}

/**
 * Minimal fake JWT: header.payload.signature (signature not verified by client).
 */
function makeToken(payload: Record<string, unknown> = makeJwtPayload()): string {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = btoa(JSON.stringify(payload));
  return `${header}.${body}.fakesignature`;
}

// ── Probe component ────────────────────────────────────────────────────────────

function AuthProbe() {
  const { user, isAuthenticated, login, logout } = useAuth();
  return (
    <div>
      <span data-testid="authenticated">{String(isAuthenticated)}</span>
      <span data-testid="email">{user?.email ?? 'none'}</span>
      <span data-testid="role">{user?.role ?? 'none'}</span>
      <span data-testid="tenant">{user?.tenant_id ?? 'none'}</span>
      <button onClick={() => login(makeToken())} data-testid="login-btn">Login</button>
      <button onClick={logout} data-testid="logout-btn">Logout</button>
    </div>
  );
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('AuthProvider', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  it('starts unauthenticated when localStorage is empty', () => {
    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>
    );
    expect(screen.getByTestId('authenticated').textContent).toBe('false');
    expect(screen.getByTestId('email').textContent).toBe('none');
  });

  it('hydrates user from a valid stored token on mount', () => {
    const token = makeToken();
    localStorage.setItem('responio_token', token);

    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>
    );

    expect(screen.getByTestId('authenticated').textContent).toBe('true');
    expect(screen.getByTestId('email').textContent).toBe('alice@example.com');
    expect(screen.getByTestId('role').textContent).toBe('admin');
    expect(screen.getByTestId('tenant').textContent).toBe('tenant-abc');
  });

  it('login() sets isAuthenticated=true and populates user fields', async () => {
    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>
    );

    expect(screen.getByTestId('authenticated').textContent).toBe('false');

    act(() => {
      screen.getByTestId('login-btn').click();
    });

    expect(screen.getByTestId('authenticated').textContent).toBe('true');
    expect(screen.getByTestId('email').textContent).toBe('alice@example.com');
  });

  it('login() stores the token in localStorage', () => {
    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>
    );

    act(() => {
      screen.getByTestId('login-btn').click();
    });

    expect(localStorage.getItem('responio_token')).not.toBeNull();
  });

  it('logout() clears user and sets isAuthenticated=false', async () => {
    const token = makeToken();
    localStorage.setItem('responio_token', token);

    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>
    );

    expect(screen.getByTestId('authenticated').textContent).toBe('true');

    act(() => {
      screen.getByTestId('logout-btn').click();
    });

    expect(screen.getByTestId('authenticated').textContent).toBe('false');
    expect(screen.getByTestId('email').textContent).toBe('none');
  });

  it('logout() removes token from localStorage', () => {
    const token = makeToken();
    localStorage.setItem('responio_token', token);

    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>
    );

    act(() => {
      screen.getByTestId('logout-btn').click();
    });

    expect(localStorage.getItem('responio_token')).toBeNull();
  });

  it('auto-logout fires when token exp is in the past', async () => {
    // Token already expired — exp 10 seconds ago
    const expiredPayload = makeJwtPayload({ exp: Math.floor(Date.now() / 1000) - 10 });
    const token = makeToken(expiredPayload);
    localStorage.setItem('responio_token', token);

    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>
    );

    // Provider should detect expiresIn <= 0 and immediately logout
    await waitFor(() => {
      expect(screen.getByTestId('authenticated').textContent).toBe('false');
    });
  });

  it('auto-logout fires after the expiry delay', async () => {
    // Token expires in 5 seconds
    const payload = makeJwtPayload({ exp: Math.floor(Date.now() / 1000) + 5 });
    const token = makeToken(payload);
    localStorage.setItem('responio_token', token);

    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>
    );

    expect(screen.getByTestId('authenticated').textContent).toBe('true');

    // Advance fake timers past expiry
    act(() => {
      vi.advanceTimersByTime(6_000);
    });

    await waitFor(() => {
      expect(screen.getByTestId('authenticated').textContent).toBe('false');
    });
  });

  it('renders null user gracefully when stored token is malformed', () => {
    localStorage.setItem('responio_token', 'not-a-jwt');

    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>
    );

    expect(screen.getByTestId('authenticated').textContent).toBe('false');
  });

  it('workspace_ids defaults to empty array when missing from payload', async () => {
    const payload = makeJwtPayload({ workspace_ids: undefined });
    const token = makeToken(payload);

    let capturedUser: ReturnType<typeof useAuth>['user'] = null;
    function Capture() {
      const { user } = useAuth();
      capturedUser = user;
      return null;
    }

    act(() => {
      render(
        <AuthProvider>
          <Capture />
        </AuthProvider>
      );
      // Trigger login
      const loginFn = (capturedUser as unknown as null); // just render with token in storage
    });

    localStorage.setItem('responio_token', token);
    const { unmount } = render(
      <AuthProvider>
        <Capture />
      </AuthProvider>
    );

    expect(capturedUser?.workspace_ids).toEqual([]);
    unmount();
  });
});

describe('useAuth outside provider', () => {
  it('throws an error when used outside AuthProvider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    function BadComponent() {
      useAuth();
      return null;
    }

    expect(() => render(<BadComponent />)).toThrow('useAuth must be used within AuthProvider');
    spy.mockRestore();
  });
});
