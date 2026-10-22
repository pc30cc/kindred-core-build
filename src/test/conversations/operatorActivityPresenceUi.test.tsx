/**
 * Operator Activity, the page (R-25, client side; the server side is
 * operatorActivityPresence.test.ts):
 *
 *   - each operator's badge is live presence — Active, Away, Not connected,
 *     Offline — the reading chat routing uses (an older server without
 *     presence_state: their availability, as before);
 *   - while the server does not record online time (online_time_tracked:
 *     false) the page leaves the online-time tile, bar and per-day columns
 *     out instead of showing zeros as accurate, shows how many are available
 *     to visitors instead, and says why; the CSV exports leave those columns
 *     out too and carry the presence;
 *   - a server that records online time (online_time_tracked: true): the
 *     online-time report. A server that does not say records none either
 *     (migration 223), so it reads as not recorded (presenceDashboards.test.tsx).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const state = vi.hoisted(() => ({ stats: null as unknown }));

vi.mock('@/hooks/useWorkspace', () => ({ useActiveWorkspace: () => ({ workspace: { id: 'ws-1' } }) }));
vi.mock('@/hooks/useWorkspaceRole', () => ({ useWorkspaceRole: () => ({ data: 'owner' }), isWorkspaceAdmin: () => true }));
vi.mock('@/lib/operator-activity-api', async (orig) => ({
  ...(await orig<typeof import('@/lib/operator-activity-api')>()),
  fetchOperatorActivity: async () => state.stats,
}));

const { default: OperatorActivityPage } = await import('@/pages/app/settings/OperatorActivityPage');
const { exportSummaryCsv, exportDetailedCsv } = await import('@/lib/operator-activity-export');
const { I18nProvider } = await import('@/i18n');

type Row = Record<string, unknown>;

const row = (user_id: string, name: string, extra: Row = {}) => ({
  user_id, role: 'agent', profile: { id: user_id, full_name: name, email: `${user_id}@x.test`, avatar_url: null },
  online_minutes: 0, present_minutes: 0, active_days: 0, avg_minutes_per_active_day: 0, last_seen: null, daily: {},
  conversations_assigned: 3, conversations_resolved: 2, replies_sent: 5, current_state: 'online', current_reason: '', ...extra,
});

function untracked() {
  return {
    days: 7,
    since: '2026-10-15T00:00:00Z',
    online_time_tracked: false,
    totals: { operators: 3, online_minutes: 0, replies_sent: 15, conversations_assigned: 9, online_now: 2, available_now: 3 },
    operators: [
      row('sara', 'Sara', { presence_state: 'active' }),
      row('reza', 'Reza', { presence_state: 'away' }),
      row('nima', 'Nima', { presence_state: 'disconnected' }),
    ],
  };
}

async function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider initialLocale="en">
        <OperatorActivityPage />
      </I18nProvider>
    </QueryClientProvider>,
  );
  await screen.findAllByText('Sara');
}

let csv: string[];
beforeEach(() => {
  csv = [];
  // The download link's click would navigate (jsdom does not implement it).
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  vi.stubGlobal('URL', Object.assign(URL, {
    createObjectURL: (blob: Blob) => {
      // jsdom's Blob has no text().
      const reader = new FileReader();
      reader.onload = () => csv.push(String(reader.result));
      reader.readAsText(blob);
      return 'blob:x';
    },
    revokeObjectURL: () => undefined,
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Operator Activity page — live presence, no fake online time', () => {
  it('online time not recorded: no online-time tile or columns, availability instead, and the badges are live presence', async () => {
    state.stats = untracked();
    await mount();
    expect(screen.queryByText('Total online time')).toBeNull();
    expect(screen.getByText('Available now')).toBeTruthy();
    expect(document.querySelectorAll('[data-online-time]')).toHaveLength(0);
    expect(screen.queryByText('Active days')).toBeNull();
    expect(screen.queryByText(/Last activity/)).toBeNull();
    const badges = [...document.querySelectorAll('[data-presence]')].map((b) => [b.getAttribute('data-presence'), b.textContent]);
    expect(badges).toEqual([['active', 'Active'], ['away', 'Away'], ['disconnected', 'Not in the panel']]);
    expect(screen.getByText(/Online time is not recorded\./)).toBeTruthy();
  });

  it('online time recorded: the online-time tile, bar and last activity come back', async () => {
    state.stats = {
      ...untracked(),
      online_time_tracked: true,
      totals: { operators: 1, online_minutes: 90, replies_sent: 5, conversations_assigned: 3, online_now: 1 },
      operators: [row('sara', 'Sara', { online_minutes: 90, last_seen: '2026-10-21T09:00:00Z' })],
    };
    await mount();
    expect(screen.getByText('Total online time')).toBeTruthy();
    expect(document.querySelectorAll('[data-online-time]')).toHaveLength(1);
    // No live presence from the server: available by settings, nothing open.
    expect(document.querySelector('[data-presence]')!.textContent).toBe('Not in the panel');
    expect(screen.getByText(/Last activity/)).toBeTruthy();
  });

  it('the CSV exports leave the unrecorded columns out and carry the presence', async () => {
    const data = untracked() as unknown as Parameters<typeof exportSummaryCsv>[0];
    exportSummaryCsv(data);
    exportDetailedCsv(data);
    await vi.waitFor(() => expect(csv).toHaveLength(2));
    for (const file of csv) {
      expect(file).toContain('presence_state');
      expect(file).not.toContain('online_minutes');
      expect(file).toContain('Sara,sara@x.test,agent,online,active,5,3,2');
    }
  });
});
