/**
 * Super Admin → Providers → Email, in the browser (src/features/providers/
 * AdminEmailProvidersPanel.tsx):
 *
 *   - the page opens on the saved provider (SMTP), also when it is opened
 *     again with the answer already cached: it used to land on Resend's
 *     empty form, one "Save & activate" away from switching the platform;
 *   - the relay password is never in the page: it shows as saved, and a save
 *     that leaves it blank does not send it; a typed one goes exactly as
 *     typed (spaces, "**"), and nothing blocks it;
 *   - SMTP has an encryption choice (no "Use TLS" switch), TLS server name,
 *     events token and Reply-To; vendors without a server adapter are listed
 *     as not available and cannot be saved;
 *   - a refusal names its field; Test connection and Send test email show
 *     the server's real answer; the notification slot is optional;
 *   - the change history says who changed what.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@/i18n';
import en from '@/i18n/locales/en';
import type { EmailProvidersState } from '@/features/providers/emailProviderApi';

vi.mock('@/lib/apiBase', () => ({ API_BASE: '' }));
vi.mock('@/hooks/useEdition', () => ({ useEdition: () => ({ edition: 'iran' }) }));
vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn(), useToast: () => ({ toast: vi.fn() }) }));

import { AdminEmailProvidersPanel } from '@/features/providers/AdminEmailProvidersPanel';

const e = en.adminProviders.email;

function state(overrides: Partial<EmailProvidersState> = {}): EmailProvidersState {
  return {
    slots: {
      default: {
        provider_name: 'smtp',
        config: { smtp_host: 'mail-relay', smtp_port: '587', smtp_user: 'noreply@webyar.ai', from_email: 'noreply@webyar.ai', from_name: 'Webyar' },
        secretKeysSet: ['smtp_pass'],
        readiness: 'configured',
        problems: [],
        lastChange: null,
      },
      notification: { provider_name: null, config: {}, secretKeysSet: [], readiness: 'unconfigured', problems: [], lastChange: null },
    },
    adapters: ['resend', 'sendgrid', 'smtp'],
    history: [],
    testRecipient: 'owner@webyar.ai',
    encryptionAvailable: true,
    legacyReplyTo: null,
    ...overrides,
  };
}

type Reply = { status: number; body: unknown };
let replies: Array<(url: string, init?: RequestInit) => Reply | null>;
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  for (const [i, reply] of replies.entries()) {
    const r = reply(url, init);
    if (r) {
      replies.splice(i, 1);
      return { ok: r.status < 400, status: r.status, json: async () => r.body };
    }
  }
  return { ok: false, status: 500, json: async () => ({ error: 'no_reply' }) };
});
const on = (method: string, path: string, body: unknown, status = 200) =>
  (url: string, init?: RequestInit) => ((init?.method ?? 'GET') === method && url === path ? { status, body } : null);

const calls = (method: string) => fetchMock.mock.calls
  .filter(([, init]) => (init?.method ?? 'GET') === method)
  .map(([url, init]) => ({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined }));

function renderPanel(qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider initialLocale="en" initialTranslations={en}>
        <AdminEmailProvidersPanel />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return qc;
}

const slot = (name: 'default' | 'notification') => within(document.querySelector(`[data-email-slot="${name}"]`) as HTMLElement);
/** A field's label: its text, then "*" or "optional". */
const labelOf = (s: ReturnType<typeof slot>, label: string) =>
  s.getAllByText((_, node) => node?.tagName === 'LABEL' && (node.textContent ?? '').startsWith(label))[0];
const input = (s: ReturnType<typeof slot>, label: string) =>
  labelOf(s, label).parentElement!.querySelector('input') as HTMLInputElement;

beforeEach(() => {
  replies = [];
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the Email panel', () => {
  it('opens on the saved provider, never shows the password, and again when opened from cache', async () => {
    replies.push(on('GET', '/api/admin/providers/email', state()));
    const qc = renderPanel();
    await waitFor(() => expect(document.querySelector('[data-email-slot="default"]')).toBeTruthy());
    const d = slot('default');
    expect(input(d, e.fields.smtp_host.label).value).toBe('mail-relay');
    const pass = input(d, e.fields.smtp_pass.label);
    expect(pass.type).toBe('password');
    expect(pass.value).toBe('');
    expect(d.getByText(en.adminProviders.form.savedSecret)).toBeTruthy();
    // the 2026-10 fields, and no "Use TLS" switch
    for (const f of ['encryption', 'tls_servername', 'events_token', 'reply_to'] as const) {
      expect(labelOf(d, e.fields[f].label)).toBeTruthy();
    }
    expect(screen.queryByText('Use TLS')).toBeNull();

    // Reopened with the answer cached (the panel remounts per provider type).
    cleanup();
    renderPanel(qc);
    expect(input(slot('default'), e.fields.smtp_host.label).value).toBe('mail-relay');
  });

  it('a save leaves a blank password out, and sends a typed one exactly as typed', async () => {
    replies.push(on('GET', '/api/admin/providers/email', state()));
    renderPanel();
    await waitFor(() => expect(document.querySelector('[data-email-slot="default"]')).toBeTruthy());
    const d = slot('default');

    replies.push(on('PUT', '/api/admin/providers/email/default', state()));
    fireEvent.click(d.getByRole('button', { name: en.adminProviders.panel.saveChanges }));
    await waitFor(() => expect(calls('PUT')).toHaveLength(1));
    expect(calls('PUT')[0].body).toEqual({
      provider_name: 'smtp',
      config: {
        smtp_host: 'mail-relay', smtp_port: '587', smtp_user: 'noreply@webyar.ai', from_email: 'noreply@webyar.ai', from_name: 'Webyar',
        encryption: 'auto',
      },
    });

    const password = '  pa ss**word  ';
    fireEvent.change(input(slot('default'), e.fields.smtp_pass.label), { target: { value: password } });
    const save = slot('default').getByRole('button', { name: en.adminProviders.panel.saveChanges }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    replies.push(on('PUT', '/api/admin/providers/email/default', state()));
    fireEvent.click(save);
    await waitFor(() => expect(calls('PUT')).toHaveLength(2));
    expect(calls('PUT')[1].body.config.smtp_pass).toBe(password);
  });

  it('a refusal names its field', async () => {
    replies.push(on('GET', '/api/admin/providers/email', state()));
    renderPanel();
    await waitFor(() => expect(document.querySelector('[data-email-slot="default"]')).toBeTruthy());
    replies.push(on('PUT', '/api/admin/providers/email/default', { error: 'invalid_field', field: 'reply_to' }, 400));
    fireEvent.click(slot('default').getByRole('button', { name: en.adminProviders.panel.saveChanges }));
    await waitFor(() => expect(slot('default').getByText(`${e.fields.reply_to.label} is not valid.`)).toBeTruthy());
  });

  it('vendors without a server adapter are listed but cannot be saved', async () => {
    replies.push(on('GET', '/api/admin/providers/email', state()));
    renderPanel();
    await waitFor(() => expect(document.querySelector('[data-email-slot="default"]')).toBeTruthy());
    const d = slot('default');
    fireEvent.click(d.getByRole('tab', { name: /Mailgun/ }));
    expect(d.getByText(e.notAvailableDesc)).toBeTruthy();
    expect(d.queryByRole('button', { name: en.adminProviders.panel.saveActivate })).toBeNull();
    // An adapter vendor that is not the saved one opens empty, its tests off until it is saved.
    fireEvent.click(d.getByRole('tab', { name: /Resend/ }));
    expect(input(d, e.fields.api_key.label).value).toBe('');
    expect((d.getByRole('button', { name: e.sendTest }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('Test connection and Send test email show the real answer', async () => {
    replies.push(on('GET', '/api/admin/providers/email', state()));
    renderPanel();
    await waitFor(() => expect(document.querySelector('[data-email-slot="default"]')).toBeTruthy());
    const d = slot('default');
    expect(d.getByText(/owner@webyar\.ai/)).toBeTruthy();

    replies.push(on('POST', '/api/admin/providers/email/default/verify', { ok: true, detail: 'signed in to mail-relay:587; encryption: auto' }));
    fireEvent.click(d.getByRole('button', { name: e.testConnection }));
    await waitFor(() => expect(d.getByText('signed in to mail-relay:587; encryption: auto')).toBeTruthy());
    expect(d.getByText(e.testOk)).toBeTruthy();

    replies.push(on('POST', '/api/admin/providers/email/default/test-send', {
      success: false, provider: 'smtp', errorCode: 'auth', error: 'auth: the SMTP server refused the sign-in (535)', to: 'owner@webyar.ai',
    }));
    fireEvent.click(d.getByRole('button', { name: e.sendTest }));
    await waitFor(() => expect(d.getByText(e.sendErrors.auth)).toBeTruthy());
    expect(d.getByText('auth: the SMTP server refused the sign-in (535)')).toBeTruthy();

    replies.push(on('POST', '/api/admin/providers/email/default/test-send', {
      success: true, provider: 'smtp', id: '<m1@relay>', serverMessageId: '4ABCD', to: 'owner@webyar.ai',
    }));
    fireEvent.click(d.getByRole('button', { name: e.sendTest }));
    await waitFor(() => expect(d.getByText('Test email sent to owner@webyar.ai')).toBeTruthy());
    expect(d.getByText('Message id: 4ABCD')).toBeTruthy();
    expect(calls('POST').map((c) => c.body)).toEqual([{}, {}, {}]);
  });

  it('the notification slot is optional, and the history says who changed what', async () => {
    replies.push(on('GET', '/api/admin/providers/email', state({
      history: [{
        at: '2026-10-29T15:11:00Z', slot: 'default', provider_name: 'smtp', previous_provider: 'resend',
        changed_fields: ['provider_name', 'smtp_host', 'smtp_pass'],
        actor: { id: 'u1', name: 'Owner', email: 'owner@webyar.ai' },
      }],
    })));
    renderPanel();
    await waitFor(() => expect(document.querySelector('[data-email-slot="notification"]')).toBeTruthy());
    expect(slot('notification').getByText(e.notSetNotification)).toBeTruthy();
    expect(slot('notification').queryByRole('button', { name: e.remove })).toBeNull();
    const history = within(document.querySelector('[data-email-history]') as HTMLElement);
    expect(history.getByText('Owner')).toBeTruthy();
    expect(history.getByText('resend → smtp')).toBeTruthy();
    expect(history.getByText(`Changed: ${e.fields.smtp_host.label}, ${e.fields.smtp_pass.label}`)).toBeTruthy();
  });

  it('removing a provider asks first', async () => {
    replies.push(on('GET', '/api/admin/providers/email', state()));
    renderPanel();
    await waitFor(() => expect(document.querySelector('[data-email-slot="default"]')).toBeTruthy());
    fireEvent.click(slot('default').getByRole('button', { name: e.remove }));
    expect(screen.getByText(e.removeDescDefault)).toBeTruthy();
    replies.push(on('DELETE', '/api/admin/providers/email/default', state({
      slots: { ...state().slots, default: { ...state().slots.default, provider_name: null, config: {}, secretKeysSet: [], readiness: 'unconfigured' } },
    })));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: e.remove }));
    await waitFor(() => expect(calls('DELETE')).toHaveLength(1));
    await waitFor(() => expect(slot('default').getByText(e.notSetDefault)).toBeTruthy());
  });
});
