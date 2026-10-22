/**
 * The workspace's pre-chat form panel (src/components/app/widget/PrechatSection.tsx):
 *
 *   - V-01: turning a field off sends `require_<field>: false` with it (it
 *     used to send only `ask_<field>`, leaving the hidden field required);
 *   - S-02: the Super Admin's locks come from the public platform projection
 *     (an owner is not a platform admin: /platform/config answered 403 and no
 *     lock ever showed), drawn as locked switches with their badge;
 *   - P-01: the forms' privacy line (shown once the database has its
 *     columns): its switch, its text and link saved when the field is left
 *     (a link that is not https is said, never sent), its consent box.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@/i18n';

vi.mock('@/hooks/use-toast', () => ({ toast: () => {}, useToast: () => ({ toasts: [], toast: () => {} }) }));

import { PrechatSection } from '@/components/app/widget/PrechatSection';

const WS = '55555555-5555-4555-8555-555555555555';
let platform: Record<string, unknown> | null;
let stored: Record<string, unknown> | null;
const requests: Array<{ url: string; method: string; body: unknown }> = [];

beforeEach(() => {
  requests.length = 0;
  platform = { id: 'p1', prechat_name_policy: 'default_on', prechat_email_policy: 'default_on', prechat_phone_policy: 'default_off' };
  stored = { workspace_id: WS, ask_name: true, ask_email: true, ask_phone: false, require_name: true, require_email: true, require_phone: false, verify_email: false, verify_phone: false, prechat_timing: 'after_handoff', history_continue_window_hours: 24 };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method || 'GET';
    requests.push({ url: String(url), method, body: init?.body ? JSON.parse(String(init.body)) : null });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (String(url).endsWith('/platform/config')) return json({ error: 'platform_admin_required' }, 403);
    if (String(url).endsWith('/platform/public')) return json({ settings: platform });
    if (String(url).endsWith(`/${WS}/prechat`)) {
      if (method === 'PUT') { stored = { ...stored, ...(JSON.parse(String(init!.body)) as Record<string, unknown>) }; return json({ settings: stored }); }
      return json({ settings: stored });
    }
    return json({}, 404);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider initialLocale="en">
        <PrechatSection workspaceId={WS} />
      </I18nProvider>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(document.querySelectorAll('[role="switch"]').length).toBeGreaterThan(0));
}
/** The ask switch of the field whose label is `label` (Name, Email, Phone). */
function askSwitch(label: string): HTMLButtonElement {
  const box = Array.from(document.querySelectorAll('.rounded-lg.border')).find((el) => el.querySelector('label')?.textContent === label)!;
  return box.querySelector('[role="switch"]') as HTMLButtonElement;
}

describe('PrechatSection', () => {
  it('turning a field off clears its "required" in the same save (V-01)', async () => {
    await mount();
    fireEvent.click(askSwitch('Name'));
    await waitFor(() => expect(requests.some((r) => r.method === 'PUT')).toBe(true));
    expect(requests.filter((r) => r.method === 'PUT').map((r) => r.body)).toEqual([{ ask_name: false, require_name: false }]);
  });

  it('turning a field on asks it and leaves "required" to its own switch', async () => {
    await mount();
    fireEvent.click(askSwitch('Phone'));
    await waitFor(() => expect(requests.some((r) => r.method === 'PUT')).toBe(true));
    expect(requests.filter((r) => r.method === 'PUT').map((r) => r.body)).toEqual([{ ask_phone: true }]);
  });

  it('the Super Admin\'s locks, read from the public projection (never the admin-only route): locked switches with their badge (S-02)', async () => {
    platform = { ...platform, prechat_email_policy: 'force_on', prechat_phone_policy: 'force_off' };
    await mount();
    await waitFor(() => expect(askSwitch('Email').disabled).toBe(true));
    expect(askSwitch('Email').getAttribute('aria-checked')).toBe('true');
    expect(askSwitch('Phone').disabled).toBe(true);
    expect(askSwitch('Phone').getAttribute('aria-checked')).toBe('false');
    expect(askSwitch('Name').disabled).toBe(false);
    expect(requests.some((r) => r.url.endsWith('/platform/public'))).toBe(true);
    expect(requests.some((r) => r.url.endsWith('/platform/config'))).toBe(false);
  });
});

describe('PrechatSection: the privacy notice in the form (P-01)', () => {
  const privacyStored = { privacy_notice_enabled: false, privacy_notice_text: null, privacy_policy_url: null, privacy_consent_required: false };
  const puts = () => requests.filter((r) => r.method === 'PUT').map((r) => r.body);

  it('a database before 281 (no such columns): the card is not shown', async () => {
    await mount();
    expect(document.getElementById('prechat-privacy-enabled')).toBeNull();
  });

  it('the switch, then the text and link saved when left, an http link said and not sent, the consent box', async () => {
    stored = { ...stored, ...privacyStored };
    await mount();
    const enable = document.getElementById('prechat-privacy-enabled') as HTMLButtonElement;
    expect(document.getElementById('prechat-privacy-text')).toBeNull();
    fireEvent.click(enable);
    await waitFor(() => expect(puts()).toEqual([{ privacy_notice_enabled: true }]));
    await waitFor(() => expect(document.getElementById('prechat-privacy-text')).not.toBeNull());

    const text = document.getElementById('prechat-privacy-text') as HTMLInputElement;
    fireEvent.change(text, { target: { value: '  We use   your details to reply. ' } });
    fireEvent.blur(text);
    await waitFor(() => expect(puts()).toHaveLength(2));
    expect(puts()[1]).toEqual({ privacy_notice_text: 'We use your details to reply.' });

    const url = document.getElementById('prechat-privacy-url') as HTMLInputElement;
    fireEvent.change(url, { target: { value: 'http://shop.example/privacy' } });
    fireEvent.blur(url);
    expect(url.getAttribute('aria-invalid')).toBe('true');
    expect(document.body.textContent).toContain('Enter an address that starts with https://');
    fireEvent.change(url, { target: { value: 'https://shop.example/privacy' } });
    fireEvent.blur(url);
    await waitFor(() => expect(puts()).toHaveLength(3));
    expect(puts()[2]).toEqual({ privacy_policy_url: 'https://shop.example/privacy' });

    fireEvent.click(document.getElementById('prechat-privacy-consent') as HTMLButtonElement);
    await waitFor(() => expect(puts()).toHaveLength(4));
    expect(puts()[3]).toEqual({ privacy_consent_required: true });
  });
});
