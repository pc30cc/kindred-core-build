/**
 * signOut() must not report a false "signed out" state for an
 * HttpOnly-cookie session — the browser cannot revoke/delete the
 * server-side session itself, so only a server-confirmed outcome may be
 * treated as success.
 *
 * Covers both layers:
 *  - src/providers/selfHosted/auth.ts's signOut() — the actual fetch/
 *    response-interpretation logic.
 *  - src/features/auth/AuthContext.tsx's handleSignOut() — must not clear
 *    local session state (and therefore must not present the app as
 *    "signed out") when the provider reports a failure.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

describe('selfHostedAuthProvider.signOut()', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.resetModules();
  });

  it('200 from the server: reports success', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { success: true }));
    const { selfHostedAuthProvider } = await import('@/providers/selfHosted/auth');
    const result = await selfHostedAuthProvider.signOut();
    expect(result.error).toBeNull();
  });

  it('200 for an already-invalid/missing session (this endpoint is idempotent): still reports success', async () => {
    // server/routes/auth.ts's /logout 200s even when there was no valid
    // session to revoke — that IS this backend's "already logged out"
    // signal, not a 401.
    fetchMock.mockResolvedValue(jsonResponse(200, { success: true }));
    const { selfHostedAuthProvider } = await import('@/providers/selfHosted/auth');
    const result = await selfHostedAuthProvider.signOut();
    expect(result.error).toBeNull();
  });

  it('403 (e.g. CSRF/Origin check failed): reports an error, does NOT claim success', async () => {
    fetchMock.mockResolvedValue(jsonResponse(403, { error: 'Origin not allowed' }));
    const { selfHostedAuthProvider } = await import('@/providers/selfHosted/auth');
    const result = await selfHostedAuthProvider.signOut();
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error!.message).toMatch(/Origin not allowed/);
  });

  it('500 from the server: reports an error, does NOT claim success', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { error: 'Internal error' }));
    const { selfHostedAuthProvider } = await import('@/providers/selfHosted/auth');
    const result = await selfHostedAuthProvider.signOut();
    expect(result.error).toBeInstanceOf(Error);
  });

  it('network failure: reports an error, does NOT claim success (does not swallow the failure)', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const { selfHostedAuthProvider } = await import('@/providers/selfHosted/auth');
    const result = await selfHostedAuthProvider.signOut();
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error!.message).toMatch(/Failed to fetch/);
  });
});

describe('AuthContext handleSignOut — cannot produce a fake signed-out UI state', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.resetModules();
  });

  async function renderHarness() {
    const { AuthContextProvider, useAuth } = await import('@/features/auth/AuthContext');
    let latestSession: unknown;
    function Probe() {
      const { session, signOut } = useAuth();
      latestSession = session;
      return (
        <div>
          <span data-testid="session-state">{session ? 'signed-in' : 'signed-out'}</span>
          <button onClick={() => signOut()}>Sign out</button>
        </div>
      );
    }
    render(
      <AuthContextProvider>
        <Probe />
      </AuthContextProvider>,
    );
    return { getSession: () => latestSession };
  }

  it('successful server logout (200): local state clears to signed-out', async () => {
    // getSession() (mounted on load) then logout — both need a response.
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/api/auth/session')) {
        return Promise.resolve(jsonResponse(200, { user: { id: 'u1', email: 'a@example.com' } }));
      }
      return Promise.resolve(jsonResponse(200, { success: true }));
    });
    await renderHarness();
    await waitFor(() => expect(screen.getByTestId('session-state').textContent).toBe('signed-in'));

    fireEvent.click(screen.getByText('Sign out'));
    await waitFor(() => expect(screen.getByTestId('session-state').textContent).toBe('signed-out'));
  });

  it('failed server logout (500): local state stays signed-in — no fake signed-out UI while the real session may still be valid', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/api/auth/session')) {
        return Promise.resolve(jsonResponse(200, { user: { id: 'u1', email: 'a@example.com' } }));
      }
      return Promise.resolve(jsonResponse(500, { error: 'Internal error' }));
    });
    await renderHarness();
    await waitFor(() => expect(screen.getByTestId('session-state').textContent).toBe('signed-in'));

    fireEvent.click(screen.getByText('Sign out'));
    // Give the async handler a tick to (not) resolve, then assert the UI
    // never flipped to signed-out.
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByTestId('session-state').textContent).toBe('signed-in');
  });

  it('network failure on logout: local state stays signed-in', async () => {
    let sessionCallDone = false;
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/api/auth/session')) {
        sessionCallDone = true;
        return Promise.resolve(jsonResponse(200, { user: { id: 'u1', email: 'a@example.com' } }));
      }
      return Promise.reject(new TypeError('Failed to fetch'));
    });
    await renderHarness();
    await waitFor(() => expect(sessionCallDone).toBe(true));
    await waitFor(() => expect(screen.getByTestId('session-state').textContent).toBe('signed-in'));

    fireEvent.click(screen.getByText('Sign out'));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByTestId('session-state').textContent).toBe('signed-in');
  });
});
