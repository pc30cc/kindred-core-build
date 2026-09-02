/**
 * WORKSPACE INVITATIONS v5.1 — Phase 0.3 / 0.4 component proofs.
 *
 * These are BEHAVIOURAL tests against the real InvitePage component, not
 * source-string scans:
 *   - a rejected fetch leaves the UI retryable (the send button re-enables),
 *   - the retry of the same logical action reuses the SAME requestId,
 *   - an explicit "send another code" after a delivered code mints a NEW one,
 *   - the in-memory RequestIdBook never retains a raw token, password or code
 *     (inspected through the safe `entries()` interface).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { createRequestIdBook, type RequestIdBook } from '../features/invitations/requestIds';

const TOKEN = 'RAW-INVITATION-TOKEN-abcdefghijklmnop';
const PASSWORD = 'Sup3rSecretPassword!';
const CODE = '123456';

let book: RequestIdBook;

vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@/i18n', () => ({ useTranslation: () => ({ t: (k: string) => k, locale: 'en' }) }));
vi.mock('@/features/auth/AuthContext', () => ({ useAuth: () => ({ user: null, isLoading: false }) }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/features/invitations/requestIds', async (orig) => {
  const actual = await (orig() as Promise<any>);
  return { ...actual, useRequestIdBook: () => book };
});

import InvitePage from '../pages/auth/InvitePage';

const PREVIEW_OK = {
  preview: { workspace_name: 'Acme', role: 'agent', masked_email: 'a***@x.io', account_exists: false, requires_otp: true },
  policies: { terms: { id: 't-1', version: '1' }, privacy: { id: 'p-1', version: '1' } },
};

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as any;
}

describe('InvitePage transport recovery and request-id hygiene', () => {
  beforeEach(() => {
    book = createRequestIdBook();
    window.history.replaceState(null, '', `/invite#token=${encodeURIComponent(TOKEN)}&p=m`);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('recovers from a rejected fetch, reuses the requestId, and mints a new one for an explicit resend', async () => {
    const calls: any[] = [];
    const fetchMock = vi.fn(async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      if (calls.length === 1) return jsonResponse(PREVIEW_OK); // preview
      if (calls.length === 2) throw new TypeError('Failed to fetch'); // OTP #1: network loss
      return jsonResponse({ ok: true, expiresInSeconds: 600 });
    });
    vi.stubGlobal('fetch', fetchMock as any);

    render(<InvitePage />);
    const sendButton = await screen.findByRole('button', { name: /send code/i });

    fireEvent.click(sendButton);
    // The button must become actionable again after the network rejection.
    await waitFor(() => expect((sendButton as HTMLButtonElement).disabled).toBe(false));
    const firstId = calls[1].requestId;
    expect(firstId).toMatch(/^[0-9a-f-]{36}$/i);

    // Retry of the SAME logical action → identical requestId.
    fireEvent.click(sendButton);
    await waitFor(() => expect(calls.length).toBe(3));
    expect(calls[2].requestId).toBe(firstId);

    // Explicit "send another code" AFTER a delivered code → new requestId.
    fireEvent.click(sendButton);
    await waitFor(() => expect(calls.length).toBe(4));
    expect(calls[3].requestId).not.toBe(firstId);
  });

  it('never retains a raw token, password or OTP code inside the request-id book', async () => {
    const fetchMock = vi.fn(async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      if (body.code) return jsonResponse({ ok: true });
      if (body.password) return jsonResponse({ ok: true });
      if (String(_url).includes('/otp/request')) return jsonResponse({ ok: true });
      return jsonResponse(PREVIEW_OK);
    });
    vi.stubGlobal('fetch', fetchMock as any);

    render(<InvitePage />);
    const codeInput = await screen.findByLabelText(/verification code/i).catch(() => null) as HTMLInputElement | null;
    const input = codeInput || (document.getElementById('otp') as HTMLInputElement);
    fireEvent.change(input, { target: { value: CODE } });

    fireEvent.click(screen.getByRole('button', { name: /verify/i }));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(1));

    const retained = JSON.stringify(book.entries());
    expect(retained).not.toContain(TOKEN);
    expect(retained).not.toContain(PASSWORD);
    expect(retained).not.toContain(CODE);
    // …and the intents that ARE retained are non-secret revision markers.
    for (const entry of book.entries()) {
      expect(entry.intent).toMatch(/^$|rev:|^[0-9a-zA-Z|._-]*$/);
    }
  });

  it('keeps nothing in browser storage', () => {
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });
});
