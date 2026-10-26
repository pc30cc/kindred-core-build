/**
 * Operator Activity → "Closed automatically" (migration 284): a conversation
 * the inactivity timer closed while it was open or pending is not the
 * operator's resolve (shared/inactivityClose.ts, conversationEndOf):
 *
 *   - the page draws its own column only while the window has any, each
 *     operator's count in the dashboard's digits; an older server, which
 *     does not split them out, reads 0 and draws no column;
 *   - the CSV carries `conversations_auto_closed` right after
 *     `conversations_resolved` (0 from an older server).
 *
 * The page renders with its data hooks stubbed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { OperatorActivityRow, OperatorActivityStats } from '@/lib/operator-activity-api';

const state = vi.hoisted(() => ({ stats: null as unknown }));

vi.mock('@/hooks/useWorkspace', () => ({ useActiveWorkspace: () => ({ workspace: { id: 'ws-1' } }) }));
vi.mock('@/hooks/useWorkspaceRole', () => ({ useWorkspaceRole: () => ({ data: 'owner' }), isWorkspaceAdmin: () => true }));
vi.mock('@/lib/operator-activity-api', async (orig) => ({
  ...(await orig<typeof import('@/lib/operator-activity-api')>()),
  fetchOperatorActivity: async () => state.stats,
}));

const { default: OperatorActivityPage } = await import('@/pages/app/settings/OperatorActivityPage');
const { summaryRows } = await import('@/lib/operator-activity-export');
const { I18nProvider } = await import('@/i18n');

afterEach(() => cleanup());

const row = (user_id: string, name: string, extra: Partial<OperatorActivityRow> = {}): OperatorActivityRow => ({
  user_id, role: 'agent', profile: { id: user_id, full_name: name, email: `${user_id}@x.test`, avatar_url: null },
  online_minutes: 0, present_minutes: 0, active_days: 0, avg_minutes_per_active_day: 0, last_seen: null, daily: {},
  conversations_assigned: 6, conversations_resolved: 3, replies_sent: 9, current_state: 'online', current_reason: '',
  presence_state: 'active', ...extra,
});

function report(operators: OperatorActivityRow[], totals: Partial<OperatorActivityStats['totals']> = {}): OperatorActivityStats {
  return {
    days: 7, since: '2026-10-19T00:00:00Z', online_time_tracked: false,
    totals: { operators: operators.length, online_minutes: 0, replies_sent: 9, conversations_assigned: 6, online_now: 1, ...totals },
    operators,
  };
}

async function mount(locale: 'en' | 'fa' = 'en') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const messages = locale === 'fa' ? (await import('@/i18n/locales/fa')).default : undefined;
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider initialLocale={locale} {...(messages ? { initialTranslations: messages } : {})}>
        <OperatorActivityPage />
      </I18nProvider>
    </QueryClientProvider>,
  );
  await screen.findByText('Sara');
}

describe('the Operator Activity page', () => {
  it('a column of automatic closes while the window has any, apart from the resolves', async () => {
    state.stats = report(
      [row('sara', 'Sara', { conversations_auto_closed: 1 }), row('reza', 'Reza', { conversations_auto_closed: 0 })],
      { conversations_auto_closed: 1 },
    );
    await mount();
    const cells = [...document.querySelectorAll('[data-auto-closed]')];
    expect(cells.map((c) => c.getAttribute('data-auto-closed'))).toEqual(['sara', 'reza']);
    expect(cells.map((c) => c.textContent)).toEqual(['Closed automatically1', 'Closed automatically0']);
    expect(cells[0].querySelector('[title]')!.getAttribute('title')).toContain('Not counted as resolved');
    // The resolves keep their own cell: 3 of 6, not 4.
    expect(screen.getAllByText('3/6')).toHaveLength(2);
  });

  it('none in the window, or an older server that does not split them out: no column', async () => {
    state.stats = report([row('sara', 'Sara', { conversations_auto_closed: 0 })], { conversations_auto_closed: 0 });
    await mount();
    expect(document.querySelector('[data-auto-closed]')).toBeNull();
    cleanup();
    state.stats = report([row('sara', 'Sara')]);
    await mount();
    expect(document.querySelector('[data-auto-closed]')).toBeNull();
  });

  it('in Persian, with Persian digits', async () => {
    state.stats = report([row('sara', 'Sara', { conversations_auto_closed: 12 })], { conversations_auto_closed: 12 });
    await mount('fa');
    expect(document.querySelector('[data-auto-closed]')!.textContent).toBe('بسته‌شدهٔ خودکار۱۲');
  });
});

describe('the CSV', () => {
  it('carries conversations_auto_closed right after conversations_resolved', () => {
    const [head, first] = summaryRows(report([row('sara', 'Sara', { conversations_auto_closed: 2 })]));
    const at = head.indexOf('conversations_resolved');
    expect(head.slice(at - 2, at + 2)).toEqual(['replies_sent', 'conversations_assigned', 'conversations_resolved', 'conversations_auto_closed']);
    expect(first.slice(at, at + 2)).toEqual([3, 2]);
    // Online time recorded: still right after the resolves.
    const tracked = summaryRows({ ...report([row('sara', 'Sara')]), online_time_tracked: true })[0];
    expect(tracked[tracked.indexOf('conversations_resolved') + 1]).toBe('conversations_auto_closed');
  });

  it('an older server reads 0', () => {
    const [head, first] = summaryRows(report([row('sara', 'Sara')]));
    expect(first[head.indexOf('conversations_auto_closed')]).toBe(0);
  });
});
