/**
 * Operator Activity → satisfaction (issue #340, contract §2): per operator,
 * the visitors' average rating after a chat (one decimal) and how many, in
 * the selected period, from conversation_ratings (migration 276):
 *
 *   - GET /api/operator-activity/:ws/stats adds `csat_avg` / `csat_count` to
 *     every operator and the totals; an operator without ratings reads null /
 *     0; only ratings of the workspace and of the period count;
 *   - before migration 276, or with the ratings unreadable, the report is
 *     unchanged (null / 0), never a 500;
 *   - the page shows the column only while the period has ratings, in the
 *     dashboard's digits.
 *
 * The REAL route runs against an in-memory data layer; the page renders with
 * its data hooks stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createFakeServiceDb, fakeServiceClient, type FakeServiceDb, type Row } from './fakeServiceDb';

/** A JSON answer, read field by field by the assertions. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- parsed JSON, asserted on its shape
type Body = Record<string, any>;

const state = vi.hoisted(() => ({
  db: null as unknown as FakeServiceDb,
  stats: null as unknown,
}));

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeServiceClient(state.db) }));
vi.mock('../../../server/lib/workspaceAuth.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/lib/workspaceAuth.js')>()),
  authorizeWorkspaceAccess: async () => ({ userId: 'owner', isAdmin: false, role: 'owner' }),
}));
vi.mock('../../../server/services/storage/urlResolver.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/storage/urlResolver.js')>()),
  hydrateUserAvatars: async (_c: unknown, rows: Row[]) => rows,
}));
vi.mock('@/hooks/useWorkspace', () => ({ useActiveWorkspace: () => ({ workspace: { id: 'ws-1' } }) }));
vi.mock('@/hooks/useWorkspaceRole', () => ({ useWorkspaceRole: () => ({ data: 'owner' }), isWorkspaceAdmin: () => true }));
vi.mock('@/lib/operator-activity-api', async (orig) => ({
  ...(await orig<typeof import('@/lib/operator-activity-api')>()),
  fetchOperatorActivity: async () => state.stats,
}));

const { operatorActivityRouter } = await import('../../../server/routes/operatorActivity.js');
const { default: OperatorActivityPage } = await import('@/pages/app/settings/OperatorActivityPage');
const { I18nProvider } = await import('@/i18n');

const app = express();
app.use((req, _res, next) => { Object.assign(req, { serverConfig: { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k' } }); next(); });
app.use('/api/operator-activity', operatorActivityRouter);
const server = http.createServer(app).listen(0);

const WS = randomUUID();
const SARA = randomUUID();
const REZA = randomUUID();
const NOW = Date.parse('2026-10-18T09:00:00Z');

function stats(days = 7): Promise<{ status: number; body: Body }> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: (server.address() as AddressInfo).port, path: `/api/operator-activity/${WS}/stats?days=${days}` }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode || 0, body: JSON.parse(d || '{}') }));
    }).on('error', reject);
  });
}

const rating = (operator_id: string | null, score: number, daysAgo: number, workspace_id = WS): Row => ({
  id: randomUUID(), workspace_id, conversation_id: randomUUID(), closed_message_id: randomUUID(), operator_id, score, comment: null,
  created_at: new Date(Date.parse(new Date().toISOString()) - daysAgo * 86_400_000).toISOString(),
});

beforeEach(() => {
  state.db = createFakeServiceDb();
  state.db.tables.workspace_members = [{ workspace_id: WS, user_id: SARA, role: 'agent' }, { workspace_id: WS, user_id: REZA, role: 'agent' }];
  state.db.tables.profiles = [{ id: SARA, full_name: 'Sara', email: 's@x.test' }, { id: REZA, full_name: 'Reza', email: 'r@x.test' }];
});
afterEach(() => cleanup());

describe('GET …/stats: satisfaction per operator', () => {
  it('average (one decimal) and count of the period\'s ratings, per rated operator and in total', async () => {
    state.db.tables.conversation_ratings = [
      rating(SARA, 5, 1), rating(SARA, 4, 2), rating(SARA, 4, 3),
      rating(SARA, 1, 10), // outside the 7 days
      rating(REZA, 2, 1, randomUUID()), // another workspace
      rating(null, 3, 1), // a closure that named nobody
    ];
    const res = await stats();
    expect(res.status).toBe(200);
    const byId = Object.fromEntries((res.body.operators as Row[]).map((o) => [o.user_id, o]));
    expect(byId[SARA]).toMatchObject({ csat_avg: 4.3, csat_count: 3 });
    expect(byId[REZA]).toMatchObject({ csat_avg: null, csat_count: 0 });
    expect(res.body.totals).toMatchObject({ csat_avg: 4.3, csat_count: 3 });
    const month = await stats(30);
    expect(month.body.totals).toMatchObject({ csat_avg: 3.5, csat_count: 4 });
  });

  it('an AI-only conversation\'s rating (subject ai, migration 284) is nobody\'s satisfaction, nor the team\'s; the totals carry it on its own line', async () => {
    state.db.tables.conversation_ratings = [
      rating(SARA, 5, 1),
      { ...rating(null, 2, 1), subject: 'ai' },
      { ...rating(null, 4, 2), subject: 'ai' },
      { ...rating(null, 1, 10), subject: 'ai' }, // outside the 7 days
      { ...rating(null, 5, 1, randomUUID()), subject: 'ai' }, // another workspace
    ];
    const res = await stats();
    const byId = Object.fromEntries((res.body.operators as Row[]).map((o) => [o.user_id, o]));
    expect(byId[SARA]).toMatchObject({ csat_avg: 5, csat_count: 1 });
    expect(byId[REZA]).toMatchObject({ csat_avg: null, csat_count: 0 });
    expect(res.body.totals).toMatchObject({ csat_avg: 5, csat_count: 1, csat_ai_avg: 3, csat_ai_count: 2 });
    // None, or before 284 (no subject to read): null and 0.
    state.db.tables.conversation_ratings = [rating(SARA, 4, 1)];
    expect((await stats()).body.totals).toMatchObject({ csat_ai_avg: null, csat_ai_count: 0 });
  });

  it('without ratings, and before migration 276: null and 0, the rest of the report as before', async () => {
    expect((await stats()).body.totals).toMatchObject({ csat_avg: null, csat_count: 0, operators: 2 });
    state.db.missing.add('conversation_ratings');
    const res = await stats();
    expect(res.status).toBe(200);
    expect(res.body.totals).toMatchObject({ csat_avg: null, csat_count: 0, operators: 2 });
    state.db.missing.clear();
    // Any other failed read of the ratings leaves the column out, never the report.
    state.db.failing.add('conversation_ratings');
    const failed = await stats();
    expect(failed.status).toBe(200);
    expect(failed.body.totals).toMatchObject({ csat_avg: null, csat_count: 0, operators: 2 });
    expect(failed.body.operators).toHaveLength(2);
  });
});

describe('the Operator Activity page', () => {
  const row = (user_id: string, name: string, extra: Row = {}) => ({
    user_id, role: 'agent', profile: { id: user_id, full_name: name, email: null, avatar_url: null },
    online_minutes: 0, present_minutes: 0, active_days: 0, avg_minutes_per_active_day: 0, last_seen: null, daily: {},
    conversations_assigned: 3, conversations_resolved: 2, replies_sent: 5, current_state: 'offline', current_reason: '', ...extra,
  });
  const totals = (extra: Row = {}) => ({ operators: 2, online_minutes: 0, replies_sent: 10, conversations_assigned: 6, online_now: 0, ...extra });

  async function mount(locale: 'en' | 'fa') {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const messages = locale === 'fa' ? (await import('@/i18n/locales/fa')).default : undefined;
    render(
      <QueryClientProvider client={qc}>
        <I18nProvider initialLocale={locale} {...(messages ? { initialTranslations: messages } : {})}>
          <OperatorActivityPage />
        </I18nProvider>
      </QueryClientProvider>,
    );
    await screen.findAllByText(locale === 'fa' ? 'Sara' : 'Sara');
  }

  it('shows the satisfaction column only while the period has ratings, "—" for an operator without', async () => {
    state.stats = { days: 7, since: new Date(NOW).toISOString(), totals: totals({ csat_avg: 4.6, csat_count: 12 }),
      operators: [row(SARA, 'Sara', { csat_avg: 4.6, csat_count: 12 }), row(REZA, 'Reza', { csat_avg: null, csat_count: 0 })] };
    await mount('en');
    const cells = document.querySelectorAll('[data-satisfaction]');
    expect(cells).toHaveLength(2);
    expect(cells[0].textContent).toBe('Satisfaction4.6 (12)');
    expect(cells[1].textContent).toBe('Satisfaction—');
  });

  it('in Persian, with Persian digits', async () => {
    state.stats = { days: 7, since: new Date(NOW).toISOString(), totals: totals({ csat_avg: 4, csat_count: 3 }),
      operators: [row(SARA, 'Sara', { csat_avg: 4, csat_count: 3 })] };
    await mount('fa');
    expect(document.querySelector('[data-satisfaction]')!.textContent).toBe('رضایت۴٫۰ (۳)');
  });

  it('hidden without ratings (and with an older server that sends none)', async () => {
    state.stats = { days: 7, since: new Date(NOW).toISOString(), totals: totals({ csat_avg: null, csat_count: 0 }), operators: [row(SARA, 'Sara')] };
    await mount('en');
    expect(document.querySelector('[data-satisfaction]')).toBeNull();
    cleanup();
    state.stats = { days: 7, since: new Date(NOW).toISOString(), totals: totals(), operators: [row(SARA, 'Sara')] };
    await mount('en');
    expect(document.querySelector('[data-satisfaction]')).toBeNull();
  });
});
