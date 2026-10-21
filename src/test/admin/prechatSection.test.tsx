/**
 * The workspace's pre-chat form panel (src/components/app/widget/PrechatSection.tsx):
 *
 *   - V-01: turning a field off sends `require_<field>: false` with it (it
 *     used to send only `ask_<field>`, leaving the hidden field required);
 *   - S-02: the Super Admin's locks come from the public platform projection
 *     (an owner is not a platform admin: /platform/config answered 403 and no
 *     lock ever showed), drawn as locked switches with their badge.
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
