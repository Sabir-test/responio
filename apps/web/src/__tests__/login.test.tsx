/**
 * Unit tests for the LoginPage component.
 *
 * Tests cover:
 *  - Renders email + password inputs and submit button
 *  - Shows loading state while request is in-flight
 *  - Calls login() and navigates to /dashboard on success
 *  - Displays server-provided error message on bad credentials
 *  - Displays generic fallback error when response has no message
 *  - Form validation — HTML required attributes present
 *  - Submit button is disabled while loading
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { LoginPage } from '../pages/login';
import { AuthProvider } from '../contexts/auth-context';

// ── Mocks ──────────────────────────────────────────────────────────────────────

const navigateMock = vi.fn();

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

// ── JWT helpers ────────────────────────────────────────────────────────────────

function makeToken() {
  const payload = {
    sub: 'user-1',
    tenant_id: 'tenant-1',
    email: 'alice@example.com',
    role: 'admin',
    workspace_ids: [],
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = btoa(JSON.stringify(payload));
  return `${header}.${body}.sig`;
}

// ── Render helper ─────────────────────────────────────────────────────────────

function renderLogin() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <LoginPage />
      </AuthProvider>
    </MemoryRouter>
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('LoginPage', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    navigateMock.mockReset();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    localStorage.clear();
  });

  it('renders email input, password input, and submit button', () => {
    renderLogin();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
  });

  it('renders the page heading', () => {
    renderLogin();
    expect(screen.getByText(/sign in to your account/i)).toBeInTheDocument();
  });

  it('email and password fields are required', () => {
    renderLogin();
    const emailInput = screen.getByLabelText(/email/i);
    const passwordInput = screen.getByLabelText(/password/i);
    expect(emailInput).toHaveAttribute('required');
    expect(passwordInput).toHaveAttribute('required');
  });

  it('does not show an error message initially', () => {
    renderLogin();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    // No red text
    const form = screen.getByRole('button', { name: /sign in/i }).closest('form')!;
    expect(form.querySelector('.text-red-600')).toBeNull();
  });

  it('disables submit button while the request is in-flight', async () => {
    // Never resolves — keeps the component in loading state
    fetchMock.mockReturnValueOnce(new Promise(() => {}));

    renderLogin();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    await user.type(screen.getByLabelText(/email/i), 'alice@example.com');
    await user.type(screen.getByLabelText(/password/i), 'password123');
    fireEvent.submit(screen.getByRole('button', { name: /sign in/i }).closest('form')!);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /signing in/i })).toBeDisabled();
    });
  });

  it('navigates to /dashboard on successful login', async () => {
    const token = makeToken();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({ token }),
    });

    renderLogin();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    await user.type(screen.getByLabelText(/email/i), 'alice@example.com');
    await user.type(screen.getByLabelText(/password/i), 'password123');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith('/dashboard', { replace: true });
    });
  });

  it('calls /api/v1/auth/login with email and password in body', async () => {
    const token = makeToken();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({ token }),
    });

    renderLogin();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    await user.type(screen.getByLabelText(/email/i), 'bob@example.com');
    await user.type(screen.getByLabelText(/password/i), 'secret');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/v1/auth/login');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body);
    expect(body.email).toBe('bob@example.com');
    expect(body.password).toBe('secret');
  });

  it('shows server error message when login fails', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: vi.fn().mockResolvedValue({ error: { message: 'Invalid credentials' } }),
    });

    renderLogin();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    await user.type(screen.getByLabelText(/email/i), 'alice@example.com');
    await user.type(screen.getByLabelText(/password/i), 'wrong-pass');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => {
      expect(screen.getByText('Invalid credentials')).toBeInTheDocument();
    });
  });

  it('shows generic fallback error when server returns no message', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: vi.fn().mockResolvedValue({}),
    });

    renderLogin();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    await user.type(screen.getByLabelText(/email/i), 'alice@example.com');
    await user.type(screen.getByLabelText(/password/i), 'bad');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => {
      expect(screen.getByText('Login failed')).toBeInTheDocument();
    });
  });

  it('shows error when fetch throws a network error', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Network error'));

    renderLogin();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    await user.type(screen.getByLabelText(/email/i), 'alice@example.com');
    await user.type(screen.getByLabelText(/password/i), 'password');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeInTheDocument();
    });
  });

  it('re-enables submit button after a failed request', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: vi.fn().mockResolvedValue({ error: { message: 'Bad creds' } }),
    });

    renderLogin();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    await user.type(screen.getByLabelText(/email/i), 'alice@example.com');
    await user.type(screen.getByLabelText(/password/i), 'wrong');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => {
      // After failure, button should be enabled again and show "Sign in"
      expect(screen.getByRole('button', { name: /sign in/i })).not.toBeDisabled();
    });
  });

  it('clears previous error message on new submission attempt', async () => {
    // First attempt fails
    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: vi.fn().mockResolvedValue({ error: { message: 'Bad creds' } }),
    });
    // Second attempt in-flight (never resolves)
    fetchMock.mockReturnValueOnce(new Promise(() => {}));

    renderLogin();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    await user.type(screen.getByLabelText(/email/i), 'alice@example.com');
    await user.type(screen.getByLabelText(/password/i), 'wrong');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => {
      expect(screen.getByText('Bad creds')).toBeInTheDocument();
    });

    // Submit again
    fireEvent.submit(screen.getByRole('button').closest('form')!);

    await waitFor(() => {
      expect(screen.queryByText('Bad creds')).not.toBeInTheDocument();
    });
  });
});
