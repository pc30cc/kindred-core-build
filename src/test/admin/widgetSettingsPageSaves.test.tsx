/**
 * Super Admin → Widget settings (src/pages/admin/WidgetSettingsPage.tsx) over
 * a stubbed GET / PATCH /api/widget-settings/platform/config:
 *
 *   - the controls nothing read are gone: no feature locks, no Deployment
 *     tab (domain policy), no message length or per-minute limit; the
 *     Features tab points to Plans instead;
 *   - a typed field saves once the typing stops, in one PATCH, without a
 *     "Settings saved" toast per keystroke; the status line says it;
 *   - a tuning number saves only a whole number in its range: emptying it
 *     saves nothing (no default is written) and says the range, which is
 *     filled in (no raw {{min}}), in its own unit;
 *   - a refused save toasts the reason and the field goes back;
 *   - "Last updated" names the date.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { I18nProvider } from '@/i18n';

const toastMock = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/use-toast', () => ({ toast: toastMock, useToast: () => ({ toasts: [], toast: toastMock }) }));
vi.mock('@/hooks/useWorkspace', async (orig) => ({
  ...(await orig<typeof import('@/hooks/useWorkspace')>()),
  useWorkspaces: () => ({ data: [], isLoading: false }),
}));

import AdminWidgetSettingsPage from '@/pages/admin/WidgetSettingsPage';

type Row = Record<string, unknown>;

const ROW: Row = {
  id: '66666666-6666-4666-8666-666666666666',
  prechat_name_policy: 'default_on',
  prechat_email_policy: 'default_on',
  prechat_phone_policy: 'default_off',
  default_debug_mode: false,
  admin_notes: null,
  default_welcome_message: '',
  widget_loader_base_url: null,
  widget_asset_base_url: null,
  widget_public_base_url: null,
  widget_api_base_url: null,
  embed_header_comment: null,
  embed_footer_comment: null,
  powered_by_enabled: true,
  powered_by_text: '',
  powered_by_brand_text: null,
  powered_by_url: null,
  typing_rate_limit_enabled: true,
  typing_rate_limit_window_ms: 2000,
  typing_rate_limit_max_events: 2,
  realtime_reconnect_jitter_pct: 20,
  realtime_token_ttl_seconds: 1800,
  realtime_pending_max: 256,
  realtime_message_dedupe_enabled: true,
  realtime_message_dedupe_window: 200,
  // Columns the page no longer edits (still in the row).
  force_chat_enabled: 'allow',
  max_message_length: 5000,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-10-20T08:30:00.000Z',
  updated_by: null,
};

let row: Row;
let patches: Row[];
let refuse: boolean;

beforeEach(() => {
  row = { ...ROW };
  patches = [];
  refuse = false;
  toastMock.mockReset();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes('/api/widget-settings/platform/config')) {
      if (init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as Row;
        patches.push(body);
        if (refuse) return new Response(JSON.stringify({ error: 'Invalid input' }), { status: 400 });
        const { id: _id, ...updates } = body;
        row = { ...row, ...updates };
      }
      return new Response(JSON.stringify({ settings: row }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 404 });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <I18nProvider>
          <AdminWidgetSettingsPage />
        </I18nProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  await screen.findByRole('tab', { name: /Features/ });
}

const openTab = (name: RegExp) => fireEvent.mouseDown(screen.getByRole('tab', { name }), { button: 0 });
const savedToasts = () => toastMock.mock.calls.filter(([arg]) => (arg as { title?: string }).title === 'Settings saved');

describe('Super Admin → Widget settings', () => {
  it('offers no control that changes nothing', async () => {
    await mount();
    const tabs = screen.getAllByRole('tab').map((tab) => tab.textContent?.trim());
    expect(tabs).not.toContain('Deployment');
    expect(tabs).not.toContain('Limits');
    expect(tabs).toContain('Notes');

    openTab(/Features/);
    await screen.findByText('Set per plan, then by each workspace');
    expect(screen.queryByText('Platform locked')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByRole('link', { name: /Open plans/ }).getAttribute('href')).toBe('/admin/plans');

    openTab(/Notes/);
    await screen.findByLabelText('Administrator notes');
    expect(screen.queryByText('Maximum message length')).toBeNull();
    expect(screen.queryByText('Messages per minute')).toBeNull();
    expect(screen.queryByText('Maximum domains per workspace')).toBeNull();
    // The date, not the raw placeholder.
    expect(screen.queryByText(/\{\{date\}\}/)).toBeNull();
    expect(screen.getByText(/^Last updated .*2026/)).toBeTruthy();

    openTab(/Realtime/);
    await screen.findByText('Realtime token lifetime');
    expect(screen.queryByText('Stale-socket guard')).toBeNull();
    expect(screen.queryByText(/Idle connection disposal/)).toBeNull();
  });

  it('a typed text saves once the typing stops, in one PATCH and without a toast per keystroke', async () => {
    await mount();
    openTab(/Notes/);
    const notes = await screen.findByLabelText('Administrator notes');
    for (const value of ['N', 'No', 'Not', 'Note']) fireEvent.change(notes, { target: { value } });
    expect((notes as HTMLTextAreaElement).value).toBe('Note');
    expect(patches).toHaveLength(0);
    expect(screen.getByRole('status').textContent).toContain('Saving');

    await waitFor(() => expect(patches).toHaveLength(1), { timeout: 2000 });
    expect(patches[0]).toEqual({ id: ROW.id, admin_notes: 'Note' });
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('All changes saved'));
    expect(savedToasts()).toHaveLength(0);
    expect((notes as HTMLTextAreaElement).value).toBe('Note');
  });

  it('a tuning number saves only a whole number in its range, never a default for an empty field', async () => {
    await mount();
    openTab(/Realtime/);
    const jitter = (await screen.findByLabelText('Spread (%)')) as HTMLInputElement;
    expect(jitter.value).toBe('20');
    // The range in the field's own unit, filled in.
    expect(screen.getByText('0–50 %')).toBeTruthy();
    expect(screen.queryByText(/\{\{min\}\}/)).toBeNull();

    fireEvent.focus(jitter);
    fireEvent.change(jitter, { target: { value: '' } });
    expect(jitter.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('alert').textContent).toBe('Enter a whole number from 0 to 50. Nothing is saved until then.');
    fireEvent.change(jitter, { target: { value: '75' } });
    expect(screen.getByRole('alert')).toBeTruthy();
    await new Promise((r) => setTimeout(r, 1000));
    expect(patches).toHaveLength(0);

    fireEvent.change(jitter, { target: { value: '30' } });
    expect(screen.queryByRole('alert')).toBeNull();
    await waitFor(() => expect(patches).toHaveLength(1), { timeout: 2000 });
    expect(patches[0]).toEqual({ id: ROW.id, realtime_reconnect_jitter_pct: 30 });
  });

  it('leaving an emptied number field puts the stored value back', async () => {
    await mount();
    openTab(/Flood protection/);
    const windowField = (await screen.findByLabelText('Window (milliseconds)')) as HTMLInputElement;
    expect(screen.getByText('250–60000 ms')).toBeTruthy();
    fireEvent.focus(windowField);
    fireEvent.change(windowField, { target: { value: '' } });
    fireEvent.blur(windowField);
    expect(windowField.value).toBe('2000');
    await new Promise((r) => setTimeout(r, 1000));
    expect(patches).toHaveLength(0);
  });

  it('a refused save says why and the field goes back to the stored value', async () => {
    refuse = true;
    await mount();
    openTab(/Notes/);
    const notes = await screen.findByLabelText('Administrator notes');
    fireEvent.change(notes, { target: { value: 'Too much' } });
    await waitFor(() => expect(patches).toHaveLength(1), { timeout: 2000 });
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Could not save settings',
      variant: 'destructive',
    })));
    await waitFor(() => expect((notes as HTMLTextAreaElement).value).toBe(''));
    expect(screen.getByRole('status').textContent).toContain('Not saved');
  });
});
