/**
 * The plan mails after a plan or period changed (afterPlanChange,
 * services/billing/account/plans.ts) are queued for the email outbox, one
 * per event (its dedupe key names it), and billing_change_scheduled, marked
 * before its mail so two requests cannot both send it, gives the mark back
 * when the mail neither went nor was queued: it used to stay marked, so the
 * same change chosen again never mailed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const WS = '11111111-1111-4111-8111-111111111111';

const h = vi.hoisted(() => ({
  rpcs: [] as Array<{ name: string; args: Record<string, unknown> }>,
  mails: [] as Array<{ slug: string; options: Record<string, unknown> }>,
  result: { sent: false, queued: true } as { sent: boolean; queued?: boolean; error?: string },
}));

vi.mock('../../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      h.rpcs.push({ name, args });
      return { data: name === 'billing_account_mark_notice' ? true : null, error: null };
    },
  }),
}));
vi.mock('../../../../server/services/billing/entitlementChange.js', () => ({ handleWorkspaceEntitlementChanged: async () => undefined }));
vi.mock('../../../../server/services/billing/edition.js', () => ({
  getBillingRegion: async () => ({ edition: 'international', regionMode: 'multi', currency: 'USD' }),
}));
vi.mock('../../../../server/services/billing/locks/state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../server/services/billing/locks/state.js')>()),
  locksEnabled: async () => false,
}));
vi.mock('../../../../server/services/billing/account/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../server/services/billing/account/index.js')>()),
  readAccount: async () => ({ workspace_id: WS, currency: 'USD', balance_minor: 0 }),
}));
vi.mock('../../../../server/services/billing/account/notify.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../server/services/billing/account/notify.js')>()),
  planNamesFor: async () => new Map(),
  sendBillingEmail: async (_c: unknown, _ws: string, slug: string, _build: unknown, options: Record<string, unknown> = {}) => {
    h.mails.push({ slug, options });
    return h.result;
  },
}));

const { afterPlanChange } = await import('../../../../server/services/billing/account/plans.js');
const CONFIG = {} as never;
const SCHEDULED = {
  action: 'change_scheduled', plan_id: 'plan-b', billing_interval: 'monthly', previous_plan_id: 'plan-a',
  previous_interval: 'monthly', effective_at: '2026-11-01T00:00:00Z',
};

beforeEach(() => {
  h.rpcs.length = 0;
  h.mails.length = 0;
  h.result = { sent: false, queued: true };
});

describe('plan mails', () => {
  it('a renewal is queued once per ledger row; a prepaid period\'s start is a mail of its own', async () => {
    const period = { plan_id: 'plan-a', previous_plan_id: 'plan-a', period_start: '2026-11-01T00:00:00Z', period_end: '2026-12-01T00:00:00Z' };
    // Paid early from the balance (a debit), then started at the due moment (none).
    await afterPlanChange(CONFIG, WS, { action: 'prepaid', ledger_id: 'ledger-9', ...period, amount_minor: 2900, balance_minor: 0 });
    await afterPlanChange(CONFIG, WS, { action: 'renewed', prepaid: true, ...period, amount_minor: 2900, balance_minor: 0 });
    expect(h.mails).toEqual([
      { slug: 'billing_renewed', options: { queue: true, dedupeKey: `billing_renewed:${WS}:ledger-9` } },
      { slug: 'billing_renewed', options: { queue: true, dedupeKey: undefined } },
    ]);
  });

  it('a scheduled change that is queued keeps its mark', async () => {
    await afterPlanChange(CONFIG, WS, SCHEDULED);
    expect(h.mails.map((m) => m.slug)).toEqual(['billing_change_scheduled']);
    expect(h.rpcs.map((r) => r.name)).toEqual(['billing_account_mark_notice']);
  });

  it('a scheduled change whose mail neither went nor was queued gives the mark back', async () => {
    h.result = { sent: false, error: 'no_recipient' };
    await afterPlanChange(CONFIG, WS, SCHEDULED);
    expect(h.rpcs.map((r) => r.name)).toEqual(['billing_account_mark_notice', 'billing_account_unmark_notice']);
    expect(h.rpcs[1].args).toEqual({
      p_workspace_id: WS,
      p_key: 'change:2026-11-01T00:00:00.000Z',
      p_notice: 'plan-b:monthly',
    });
  });
});
