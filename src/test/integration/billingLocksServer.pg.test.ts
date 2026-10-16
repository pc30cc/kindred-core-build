// @vitest-environment node
/**
 * Simple billing phase 4, the server side of computed locks (design §2, §9,
 * §10) against a database built by the whole chain (migration 265 included),
 * through the real data layer in postgres-only mode:
 *
 *   - the kill switch: off, nothing is locked and nothing is read past it;
 *     on, the cutoffs of migration 265 come back, cached until cleared;
 *   - isRowLocked agrees with billing_is_locked row by row, ties on
 *     created_at and NULL created_at included;
 *   - the query filters (nested and() inside or(), quoted timestamps) select
 *     exactly the unlocked and the locked rows through the engine;
 *   - members: the owner and suspended members never lock; the locked user
 *     ids; their open chats go back to the queue;
 *   - the contacts quota counts what the lock ranks (D1);
 *   - the downgrade report (SQL + modules/channels/AI credit), its place in
 *     the quote, and LOCKS_NOT_ACKNOWLEDGED only while the switch is on;
 *   - the /effective lock summary and the next deletion date.
 *
 * Driven by TEST_DATABASE_URL; skipped without it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createFullChainDatabase, type FullChainDatabase } from './fullChainDatabase';

const DSN = process.env.TEST_DATABASE_URL;
const suite = DSN ? describe : describe.skip;

type Row = Record<string, unknown>;

suite('billing locks: server lock core, report and quote against the real chain', () => {
  let chain: FullChainDatabase;
  let config: never;
  let state: typeof import('../../../server/services/billing/locks/state.js');
  let predicates: typeof import('../../../server/services/billing/locks/predicates.js');
  let report: typeof import('../../../server/services/billing/locks/report.js');
  let release: typeof import('../../../server/services/billing/locks/release.js');
  let plans: typeof import('../../../server/services/billing/account/plans.js');
  let usage: typeof import('../../../server/services/billing/usageResolvers.js');
  let supabase: typeof import('../../../server/supabase.js');
  const q = async (sql: string, p: unknown[] = []) => (await chain.db.query(sql, p)).rows as Row[];
  const one = async (sql: string, p: unknown[] = []) => (await q(sql, p))[0];

  let small = '';
  let big = '';
  let ws = '';
  let owner = '';

  async function profile(name: string): Promise<string> {
    const id = randomUUID();
    await q(`INSERT INTO public.profiles (id, email, full_name) VALUES ($1, $2, $3)`, [id, `${name}-${id.slice(0, 6)}@test.local`, name]);
    return id;
  }

  async function switchTo(on: boolean) {
    await q(`INSERT INTO public.billing_settings (edition, locks_enabled) VALUES ('international', $1)
             ON CONFLICT (edition) DO UPDATE SET locks_enabled = EXCLUDED.locks_enabled`, [on]);
    state.clearLockStateCache();
  }

  beforeAll(async () => {
    chain = await createFullChainDatabase(DSN!, `billing_locks_server_${Date.now()}`);
    Object.assign(process.env, {
      DATABASE_URL: chain.url,
      PLATFORM_SIGNING_SECRET: 'signing-secret-for-this-test-only-0123456789',
      SUPABASE_URL: 'https://legacy-project.supabase.co',
      SUPABASE_ANON_KEY: 'legacy-anon-key-value',
      SUPABASE_SERVICE_ROLE_KEY: 'legacy-service-role-key-value-at-least-32',
      APP_BASE_URL: 'http://127.0.0.1:5173',
    });
    delete process.env.DATABASE_MODE;
    await q(`UPDATE public.platform_settings SET region_mode = 'multi'`);
    small = String((await one(
      `INSERT INTO public.billing_plans (name, slug, prices, limits, entitlements, is_active, is_free, is_hidden, sort_order)
       VALUES ('Small', 'small-x', $1, $2, $3, true, false, false, 10) RETURNING id`,
      [
        JSON.stringify({ USD: { monthly: 900, yearly: 9000 } }),
        JSON.stringify({ max_kb_articles: 2, max_contacts: 2, max_agents: 2, data_retention_days: 30, ai_credits_per_month: 100 }),
        JSON.stringify({ telegram: false, seo: false }),
      ])).id);
    big = String((await one(
      `INSERT INTO public.billing_plans (name, slug, prices, limits, entitlements, is_active, is_free, is_hidden, sort_order, locked_data_retention_days)
       VALUES ('Big', 'big-x', $1, $2, $3, true, false, false, 20, 90) RETURNING id`,
      [
        JSON.stringify({ USD: { monthly: 4900, yearly: 49000 } }),
        JSON.stringify({ max_kb_articles: -1, max_contacts: -1, max_agents: -1, ai_credits_per_month: 1000 }),
        JSON.stringify({ telegram: true, seo: true }),
      ])).id);
    await q(`UPDATE public.billing_plans SET locked_data_retention_days = 60 WHERE id = $1`, [small]);

    owner = await profile('owner');
    ws = randomUUID();
    await q(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'Acme', $2, $3)`, [ws, `acme-${ws.slice(0, 8)}`, owner]);
    await q(`INSERT INTO public.workspace_members (workspace_id, user_id, role, created_at) VALUES ($1, $2, 'owner', now() - interval '400 days')
             ON CONFLICT (workspace_id, user_id) DO NOTHING`, [ws, owner]);
    await q(`INSERT INTO public.workspace_subscriptions (workspace_id, plan_id, status, billing_interval, provider_name, current_period_start, current_period_end)
             VALUES ($1, $2, 'active', 'monthly', 'account', now() - interval '10 days', now() + interval '20 days')
             ON CONFLICT (workspace_id) DO UPDATE SET plan_id = EXCLUDED.plan_id, status = 'active',
               current_period_start = EXCLUDED.current_period_start, current_period_end = EXCLUDED.current_period_end`, [ws, big]);

    // KB: five articles; two share a created_at (the tie breaks on id), one has none.
    const tie = '2026-01-02T03:04:05.123456Z';
    const ids = [randomUUID(), randomUUID()].sort();
    const kb: Array<[string, string | null]> = [
      [randomUUID(), null],
      [randomUUID(), '2026-01-01T00:00:00Z'],
      [ids[0], tie],
      [ids[1], tie],
      [randomUUID(), '2026-02-01T00:00:00Z'],
    ];
    for (const [i, [id, at]] of kb.entries()) {
      await q(`INSERT INTO public.knowledge_base_articles (id, workspace_id, slug, locale, title, content, status, created_at)
               VALUES ($1, $2, $3, 'en', $4, 'body', 'published', $5)`, [id, ws, `a-${i}`, `Article ${i}`, at]);
    }
    // Contacts: four real ones, a spam one and an empty anonymous visitor (neither counts, D1).
    for (let i = 0; i < 4; i++) {
      await q(`INSERT INTO public.contacts (workspace_id, name, email, created_at) VALUES ($1, $2, $3, now() - make_interval(days => $4))`,
        [ws, `Person ${i}`, `p${i}@acme.test`, 40 - i]);
    }
    await q(`INSERT INTO public.contacts (workspace_id, name, email, is_spam) VALUES ($1, 'Spam', 'spam@x.test', true)`, [ws]);
    await q(`INSERT INTO public.contacts (workspace_id, metadata) VALUES ($1, '{"anonymous":"true"}')`, [ws]);
  }, 600_000);

  afterAll(async () => {
    const { closeDataLayer } = await import('../../../server/db/index.js');
    await closeDataLayer().catch(() => undefined);
    await chain?.drop();
  });

  it('loads the server modules on the chain', async () => {
    const { loadConfig } = await import('../../../server/config.js');
    config = loadConfig() as never;
    state = await import('../../../server/services/billing/locks/state.js');
    predicates = await import('../../../server/services/billing/locks/predicates.js');
    report = await import('../../../server/services/billing/locks/report.js');
    release = await import('../../../server/services/billing/locks/release.js');
    plans = await import('../../../server/services/billing/account/plans.js');
    usage = await import('../../../server/services/billing/usageResolvers.js');
    supabase = await import('../../../server/supabase.js');
    expect(await state.readLocksEnabled(config)).toBe(false);
  });

  it('switch off: nothing is locked, on any plan', async () => {
    await q(`UPDATE public.workspace_subscriptions SET plan_id = $2 WHERE workspace_id = $1`, [ws, small]);
    await switchTo(false);
    const s = await state.resolveLockState(config, ws);
    expect(s).toEqual(state.unlockedState());
    expect(await predicates.kbLockedIds(config, ws)).toEqual(new Set());
    const summary = await state.lockSummary(config, ws);
    expect(summary).toMatchObject({ enabled: false, any_locked: false, next_deletion_at: null });
  });

  it('switch on: the cutoffs of 265, judged row by row exactly as billing_is_locked', async () => {
    await switchTo(true);
    const s = await state.resolveLockState(config, ws);
    expect(s.enabled).toBe(true);
    expect(s.kb).toMatchObject({ limit: 2, total: 5, locked: 3 });
    expect(s.kb?.ids).toHaveLength(3);
    expect(s.contact).toMatchObject({ limit: 2, total: 4, locked: 2 });
    for (const row of await q(`SELECT id, created_at FROM public.knowledge_base_articles WHERE workspace_id = $1`, [ws])) {
      const sql = (await one(`SELECT public.billing_is_locked($1, 'kb_article', $2) AS l`, [ws, row.id])).l;
      // created_at as the data layer returns it (JSON text, microseconds kept).
      const viaJson = (await one(`SELECT to_json(created_at)#>>'{}' AS t FROM public.knowledge_base_articles WHERE id = $1`, [row.id])).t;
      expect(predicates.isRowLocked(s, 'kb_article', { id: String(row.id), created_at: viaJson as string | null }), String(row.id)).toBe(sql);
      expect(s.kb?.ids?.includes(String(row.id))).toBe(sql);
    }
    for (const row of await q(`SELECT id, to_json(created_at)#>>'{}' AS created_at FROM public.contacts WHERE workspace_id = $1 AND NOT is_spam AND email IS NOT NULL`, [ws])) {
      const sql = (await one(`SELECT public.billing_is_locked($1, 'contact', $2) AS l`, [ws, row.id])).l;
      expect(predicates.isRowLocked(s, 'contact', row as never)).toBe(sql);
    }
  });

  it('the query filters select exactly the unlocked and the locked rows through the engine', async () => {
    const s = await state.resolveLockState(config, ws, ['kb_article', 'contact']);
    const sb = supabase.getServiceClient(config);
    const unlocked = await predicates.applyUnlockedFilter(
      sb.from('knowledge_base_articles').select('id').eq('workspace_id', ws), s.kb?.cut ?? null);
    expect(unlocked.error).toBeNull();
    const locked = await predicates.applyLockedFilter(
      sb.from('knowledge_base_articles').select('id').eq('workspace_id', ws), s.kb?.cut ?? null);
    expect(locked.error).toBeNull();
    expect(new Set((locked.data ?? []).map((r: Row) => String(r.id)))).toEqual(new Set(s.kb?.ids));
    expect((unlocked.data ?? []).length).toBe(2);
    // Contacts: the filter is the rank only (spam and anonymous rows are the caller's to show).
    // Typed loosely: the full chain's inferred type is too deep for tsc (TS2589).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contactsQuery = (sb.from('contacts') as any)
      .select('id, email').eq('workspace_id', ws).eq('is_spam', false).not('email', 'is', null);
    const lockedContacts = await predicates.applyLockedFilter(contactsQuery, s.contact?.cut ?? null);
    expect(lockedContacts.error).toBeNull();
    expect((lockedContacts.data ?? []).map((r: Row) => r.email).sort()).toEqual(['p2@acme.test', 'p3@acme.test']);
    // Nothing locked: the locked filter matches nothing, the unlocked one leaves the query as it is.
    const none = await predicates.applyLockedFilter(sb.from('knowledge_base_articles').select('id').eq('workspace_id', ws), null);
    expect(none.data).toEqual([]);
  });

  it('limit 0 locks every row, NULL created_at included (cut -infinity, the nil uuid)', async () => {
    await q(`INSERT INTO public.workspace_limit_overrides (workspace_id, limit_key, limit_value) VALUES ($1, 'max_kb_articles', 0)`, [ws]);
    state.clearLockStateCache(ws);
    const s = await state.resolveLockState(config, ws, ['kb_article']);
    expect(s.kb).toMatchObject({ limit: 0, locked: 5, cut: { ts: '-infinity', id: state.NIL_UUID } });
    const sb = supabase.getServiceClient(config);
    const unlocked = await predicates.applyUnlockedFilter(sb.from('knowledge_base_articles').select('id').eq('workspace_id', ws), s.kb!.cut);
    expect(unlocked.error).toBeNull();
    expect(unlocked.data).toEqual([]);
    const nullRow = await one(`SELECT id FROM public.knowledge_base_articles WHERE workspace_id = $1 AND created_at IS NULL`, [ws]);
    expect(predicates.isRowLocked(s, 'kb', { id: String(nullRow.id), created_at: null })).toBe(true);
    await q(`DELETE FROM public.workspace_limit_overrides WHERE workspace_id = $1`, [ws]);
    state.clearLockStateCache(ws);
  });

  it('the cache holds until cleared; a plan change through the funnel clears it', async () => {
    const before = await state.resolveLockState(config, ws, ['kb_article']);
    expect(before.kb?.locked).toBe(3);
    await q(`UPDATE public.workspace_subscriptions SET plan_id = $2 WHERE workspace_id = $1`, [ws, big]);
    expect((await state.resolveLockState(config, ws, ['kb_article'])).kb?.locked).toBe(3);
    const { handleWorkspaceEntitlementChanged } = await import('../../../server/services/billing/entitlementChange.js');
    await handleWorkspaceEntitlementChanged(config, { workspaceId: ws, source: 'admin_assign' });
    expect((await state.resolveLockState(config, ws, ['kb_article'])).kb).toMatchObject({ limit: null, locked: 0, cut: null });
    await q(`UPDATE public.workspace_subscriptions SET plan_id = $2 WHERE workspace_id = $1`, [ws, small]);
    state.clearLockStateCache(ws);
  });

  it('members: the owner and suspended members never lock; their open chats go back to the queue', async () => {
    // max_agents 2: the owner and one more. Three agents join; one is suspended.
    const a1 = await profile('agent1');
    const a2 = await profile('agent2');
    const a3 = await profile('agent3');
    await q(`INSERT INTO public.workspace_members (workspace_id, user_id, role, created_at) VALUES
             ($1, $2, 'agent', now() - interval '30 days'), ($1, $3, 'agent', now() - interval '20 days'),
             ($1, $4, 'agent', now() - interval '25 days')`, [ws, a1, a2, a3]);
    await q(`UPDATE public.workspace_members SET suspended_at = now() WHERE workspace_id = $1 AND user_id = $2`, [ws, a3]);
    state.clearLockStateCache(ws);
    const s = await state.resolveLockState(config, ws, ['member']);
    expect(s.member).toMatchObject({ limit: 1, total: 2, locked: 1 });
    expect(predicates.isMemberLocked(s, a2)).toBe(true);
    expect(predicates.isMemberLocked(s, a1)).toBe(false);
    expect(predicates.isMemberLocked(s, a3)).toBe(false);
    expect(predicates.isMemberLocked(s, owner)).toBe(false);
    expect(await predicates.memberLockedUserIds(config, ws)).toEqual(new Set([a2]));

    // Seat usage: suspended members hold no seat (D3); the owner does.
    const seats = await usage.resolveUsage(config, ws, 'max_agents');
    expect(seats).toMatchObject({ supported: true, value: 3 });
    // Switch off: every member holds a seat, as before 265 (and as
    // wi_resolve_seat_capacity counts then).
    await switchTo(false);
    try {
      expect(await usage.resolveUsage(config, ws, 'max_agents')).toMatchObject({ supported: true, value: 4 });
    } finally {
      await switchTo(true);
    }

    const open = String((await one(`INSERT INTO public.conversations (workspace_id, status, assigned_to) VALUES ($1, 'open', $2) RETURNING id`, [ws, a2])).id);
    const closed = String((await one(`INSERT INTO public.conversations (workspace_id, status, assigned_to) VALUES ($1, 'closed', $2) RETURNING id`, [ws, a2])).id);
    const kept = String((await one(`INSERT INTO public.conversations (workspace_id, status, assigned_to) VALUES ($1, 'open', $2) RETURNING id`, [ws, a1])).id);
    const released = await release.releaseLockedAgentChats(config, ws);
    expect(released).toEqual([open]);
    expect((await one(`SELECT assigned_to FROM public.conversations WHERE id = $1`, [open])).assigned_to).toBeNull();
    expect((await one(`SELECT assigned_to FROM public.conversations WHERE id = $1`, [closed])).assigned_to).toBe(a2);
    expect((await one(`SELECT assigned_to FROM public.conversations WHERE id = $1`, [kept])).assigned_to).toBe(a1);
  });

  it('chats: locked by last activity before the retention cutoff', async () => {
    const old = String((await one(
      `INSERT INTO public.conversations (workspace_id, status, created_at, updated_at) VALUES ($1, 'resolved', now() - interval '90 days', now() - interval '60 days') RETURNING id`, [ws])).id);
    const revived = String((await one(
      `INSERT INTO public.conversations (workspace_id, status, created_at, updated_at) VALUES ($1, 'open', now() - interval '90 days', now() - interval '1 day') RETURNING id`, [ws])).id);
    state.clearLockStateCache(ws);
    const s = await state.resolveLockState(config, ws, ['conversation']);
    expect(s.conversation?.limit).toBe(30);
    const rows = await q(`SELECT id, to_json(created_at)#>>'{}' AS created_at, to_json(updated_at)#>>'{}' AS updated_at FROM public.conversations WHERE id = ANY($1)`, [[old, revived]]);
    const byId = new Map(rows.map((r) => [String(r.id), r]));
    expect(predicates.isRowLocked(s, 'conversation', byId.get(old) as never)).toBe(true);
    expect(predicates.isRowLocked(s, 'conversation', byId.get(revived) as never)).toBe(false);
    const sb = supabase.getServiceClient(config);
    const locked = await predicates.applyConversationLockedFilter(sb.from('conversations').select('id').eq('workspace_id', ws), s.conversation!.cut);
    expect(locked.error).toBeNull();
    expect((locked.data ?? []).map((r: Row) => r.id)).toEqual([old]);
    const unlocked = await predicates.applyConversationUnlockedFilter(sb.from('conversations').select('id').eq('workspace_id', ws), s.conversation!.cut);
    expect((unlocked.data ?? []).map((r: Row) => String(r.id))).not.toContain(old);
    expect((unlocked.data ?? []).map((r: Row) => String(r.id))).toContain(revived);
  });

  it('the contacts quota counts what the lock ranks (spam and empty visitors excluded, D1)', async () => {
    const r = await usage.resolveUsage(config, ws, 'max_contacts');
    expect(r).toMatchObject({ supported: true, value: 4 });
    expect(r.note).toMatch(/billing_countable_count/);
  });

  it('the downgrade report: SQL counts plus modules, channels and AI credit', async () => {
    await q(`UPDATE public.workspace_subscriptions SET plan_id = $2 WHERE workspace_id = $1`, [ws, big]);
    await q(`INSERT INTO public.workspace_plugin_installations (workspace_id, plugin_id, instance_key, status) VALUES ($1, 'telegram', 'default', 'installed')`, [ws]);
    state.clearLockStateCache(ws);
    const r = await report.buildLockReport(config, ws, small);
    expect(r).toMatchObject({
      locks_enabled: true,
      plan_id: small,
      kb_article: { limit: 2, total: 5, locked: 3 },
      contact: { limit: 2, total: 4, locked: 2 },
      member: { limit: 2, locked: 1 },
      conversation: { retention_days: 30, locked: 1 },
      locked_data_retention_days: 60,
      channels_stop_messages: true,
      ai_credits: { current: 1000, target: 100 },
      has_locks: true,
    });
    expect(r.kb_article.items.map((i) => i.title)).toHaveLength(3);
    expect(r.member.items[0]).toMatchObject({ name: 'agent2' });
    expect(r.channels_lost).toEqual([{ key: 'telegram', in_use: true }]);
    expect(r.modules_lost).toEqual([{ key: 'seo', in_use: false }]);
    expect(r.first_deletion_not_before).toBeTruthy();
    expect(report.reportNeedsAcknowledgement(r)).toBe(true);
    expect(report.reportForViewer(r, false).member.items).toEqual([]);
    // Switch off: a channel the plan loses keeps receiving, so the report
    // does not say its messages stop.
    await switchTo(false);
    try {
      expect(await report.buildLockReport(config, ws, small)).toMatchObject({
        locks_enabled: false, channels_lost: [{ key: 'telegram', in_use: true }], channels_stop_messages: false,
      });
    } finally {
      await switchTo(true);
    }
    // Nothing changes on the plan in force: the report of the current plan locks nothing.
    const now = await report.buildLockReport(config, ws);
    expect(now).toMatchObject({ plan_id: big, has_locks: false, modules_lost: [], channels_lost: [] });
  });

  it('271: the monthly AI credit is what the grant gives, as money in the account currency; storage in MB', async () => {
    // Startup's shape: a legacy count of 0 next to the credit actually granted.
    await q(`UPDATE public.billing_plans SET ai_allowance = '{"IRR": 300000}',
               limits = limits || '{"ai_credits_per_month": 0, "storage_mb": 0}' WHERE id = $1`, [small]);
    await q(`UPDATE public.billing_plans SET ai_allowance = '{"IRR": 600000}',
               limits = limits || '{"storage_mb": 51200}' WHERE id = $1`, [big]);
    await q(`UPDATE public.workspace_subscriptions SET plan_id = $2 WHERE workspace_id = $1`, [ws, big]);
    state.clearLockStateCache(ws);
    await q(`UPDATE public.ai_exchange_rates SET effective_to = now() WHERE from_currency = 'USD' AND effective_to IS NULL`);

    // No rate: the wallet's own unit, never a guessed conversion.
    const noRate = await report.buildLockReport(config, ws, small);
    expect(noRate.ai_credits).toMatchObject({ current: 600000, target: 300000, unit: 'IRR', current_minor: null, target_minor: null });
    // storage_mb 0: no file storage, uploads blocked.
    expect(noRate.storage).toMatchObject({ limit_mb: 0, uploads_blocked: true });

    // With the rate the billing page converts with (60,000 Rial per dollar).
    await q(`INSERT INTO public.ai_exchange_rates (from_currency, to_currency, rate, effective_from) VALUES ('USD', 'IRR', 60000, now())`);
    const r = await report.buildLockReport(config, ws, small);
    expect(r.ai_credits.currency).toBe('USD');
    expect(r.ai_credits).toMatchObject({ current: 600000, target: 300000, current_minor: 1000, target_minor: 500 });

    // The plan cards show the same numbers, from the same function.
    const options = await plans.listPlanOptions(config, 'USD', ws);
    const smallCard = options.find((o) => o.id === small)!;
    const bigCard = options.find((o) => o.id === big)!;
    expect(smallCard).toMatchObject({ ai_credit_monthly: 300000, ai_credit_monthly_minor: 500 });
    expect(bigCard).toMatchObject({ ai_credit_monthly: 600000, ai_credit_monthly_minor: 1000 });
    expect(smallCard.limits.storage_mb).toBe(0);
    expect(bigCard.limits.storage_mb).toBe(51200);

    // Super Admin's override of the workspace's monthly credit is what is granted, whatever the plan.
    await q(`INSERT INTO public.workspace_limit_overrides (workspace_id, limit_key, limit_value) VALUES ($1, 'included_ai_allowance_irr', 120000)`, [ws]);
    try {
      expect((await report.buildLockReport(config, ws, small)).ai_credits).toMatchObject({ current: 120000, target: 120000 });
      expect((await plans.listPlanOptions(config, 'USD', ws)).find((o) => o.id === small)).toMatchObject({ ai_credit_monthly: 120000 });
    } finally {
      await q(`DELETE FROM public.workspace_limit_overrides WHERE workspace_id = $1 AND limit_key = 'included_ai_allowance_irr'`, [ws]);
    }

    // Uploads: the gate reads storage_mb only; a stray storage_gb (removed by 272) is not read.
    const { checkEntitlementFromDB, clearEntitlementCache } = await import('../../../server/middleware/featureGating.js');
    clearEntitlementCache();
    const cfg = config as unknown as { supabaseUrl: string; supabaseServiceRoleKey: string };
    expect(await checkEntitlementFromDB(cfg.supabaseUrl, cfg.supabaseServiceRoleKey, ws, 'storage_mb', { numeric: true }))
      .toMatchObject({ allowed: true, limit: 51200 });
    await q(`UPDATE public.billing_plans SET limits = (limits - 'storage_mb') || '{"storage_gb": 3}' WHERE id = $1`, [big]);
    clearEntitlementCache();
    try {
      // Not in the plan: the registry default (1,024 MB), never 3 GB.
      expect(await checkEntitlementFromDB(cfg.supabaseUrl, cfg.supabaseServiceRoleKey, ws, 'storage_mb', { numeric: true }))
        .toMatchObject({ allowed: true, limit: 1024 });
    } finally {
      await q(`UPDATE public.billing_plans SET limits = (limits - 'storage_gb') || '{"storage_mb": 51200}' WHERE id = $1`, [big]);
      clearEntitlementCache();
    }
  });

  it('the quote of a downgrade carries the report; scheduling it needs the acknowledgement while locks are on', async () => {
    const quote = await plans.quotePlanChange(config, ws, small, 'monthly', { withLockReport: true });
    expect(quote.kind).toBe('schedule');
    expect(quote.lock_report).toMatchObject({ plan_id: small, has_locks: true });
    // Without the option (assertQuote, the card): no report is built.
    expect((await plans.quotePlanChange(config, ws, small, 'monthly')).lock_report).toBeUndefined();
    // An interval change on the same plan carries none.
    expect((await plans.quotePlanChange(config, ws, big, 'yearly', { withLockReport: true })).lock_report).toBeUndefined();
    // Switch off: the customer's quote carries no report (nothing more locks than before).
    await switchTo(false);
    try {
      const offQuote = await plans.quotePlanChange(config, ws, small, 'monthly', { withLockReport: true });
      expect(offQuote.kind).toBe('schedule');
      expect(offQuote.lock_report).toBeUndefined();
    } finally {
      await switchTo(true);
    }

    await expect(plans.scheduleChange(config, ws, { planId: small, interval: null, actorId: owner }))
      .rejects.toMatchObject({ code: 'LOCKS_NOT_ACKNOWLEDGED', status: 409 });
    expect((await one(`SELECT scheduled_plan_id FROM public.billing_accounts WHERE workspace_id = $1`, [ws]))?.scheduled_plan_id ?? null).toBeNull();

    // The switch off: the change goes through as before, nothing asked.
    await switchTo(false);
    const off = await plans.scheduleChange(config, ws, { planId: small, interval: null, actorId: owner });
    expect(off.action).toBe('change_scheduled');
    // Cancel it, then with the switch on and the acknowledgement it goes through.
    await plans.scheduleChange(config, ws, { planId: big, interval: null, actorId: owner });
    await switchTo(true);
    const acked = await plans.scheduleChange(config, ws, { planId: small, interval: null, actorId: owner, acknowledgeLocks: true });
    expect(acked.action).toBe('change_scheduled');
    expect(String((await one(`SELECT scheduled_plan_id FROM public.billing_accounts WHERE workspace_id = $1`, [ws])).scheduled_plan_id)).toBe(small);
    // Cancelling (the plan in force) never needs it.
    const cancelled = await plans.scheduleChange(config, ws, { planId: big, interval: null, actorId: owner });
    expect(cancelled.action).not.toBe('change_scheduled');
  });

  it('buying a plan from Free (no paid period) carries the report and needs the acknowledgement while locks are on', async () => {
    const ws2 = randomUUID();
    await q(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'Trialer', $2, $3)`, [ws2, `trialer-${ws2.slice(0, 8)}`, owner]);
    for (let i = 0; i < 3; i++) {
      await q(`INSERT INTO public.knowledge_base_articles (workspace_id, slug, locale, title, content, status, created_at)
               VALUES ($1, $2, 'en', $3, 'body', 'published', now() - make_interval(days => $4))`, [ws2, `t-${i}`, `T ${i}`, 10 - i]);
    }
    const quote = await plans.quotePlanChange(config, ws2, small, 'monthly', { withLockReport: true });
    expect(quote.kind).toBe('purchase');
    expect(quote.lock_report).toMatchObject({ plan_id: small, locks_enabled: true, kb_article: { limit: 2, locked: 1 } });
    await expect(plans.buyPlan(config, ws2, { planId: small, interval: 'monthly', key: `${ws2}:k1`, actorId: owner }))
      .rejects.toMatchObject({ code: 'LOCKS_NOT_ACKNOWLEDGED', status: 409 });
    // Acknowledged, it goes on to the purchase itself (here refused for the balance, not for the locks).
    const acked = await plans.buyPlan(config, ws2, { planId: small, interval: 'monthly', key: `${ws2}:k2`, actorId: owner, acknowledgeLocks: true })
      .then(() => 'bought', (e: { code?: string }) => e.code);
    expect(acked).not.toBe('LOCKS_NOT_ACKNOWLEDGED');
    // Switch off: no report, nothing asked.
    await switchTo(false);
    try {
      expect((await plans.quotePlanChange(config, ws2, small, 'monthly', { withLockReport: true })).lock_report).toBeUndefined();
      const off = await plans.buyPlan(config, ws2, { planId: small, interval: 'monthly', key: `${ws2}:k3`, actorId: owner })
        .then(() => 'bought', (e: { code?: string }) => e.code);
      expect(off).not.toBe('LOCKS_NOT_ACKNOWLEDGED');
    } finally {
      await switchTo(true);
    }
  });

  it('the /effective summary and the next deletion date from the clock', async () => {
    await q(`UPDATE public.workspace_subscriptions SET plan_id = $2 WHERE workspace_id = $1`, [ws, small]);
    state.clearLockStateCache(ws);
    await q(`SELECT public.billing_lock_clock_observe($1)`, [ws]);
    const clocks = await q(`SELECT kind, since FROM public.billing_lock_clocks WHERE workspace_id = $1 AND kind <> 'conversation' ORDER BY kind`, [ws]);
    expect(clocks.map((c) => c.kind)).toEqual(['contact', 'kb_article']);
    const summary = await state.lockSummary(config, ws);
    expect(summary).toMatchObject({
      enabled: true,
      any_locked: true,
      kb_article: { limit: 2, total: 5, locked: 3 },
      contact: { limit: 2, locked: 2 },
      member: { locked: 1, cut: null },
      conversation: { limit: 30, locked: 1 },
    });
    // Small keeps locked data 60 days: since + 60 d (both notices still fit before it).
    const since = Date.parse(String((clocks[0].since as Date).toISOString()));
    const next = Date.parse(String(summary.next_deletion_at));
    expect(Math.abs(next - (since + 60 * 86_400_000))).toBeLessThan(5_000);
  });

  it('a workspace that is not active never locks', async () => {
    await q(`UPDATE public.workspaces SET status = 'deleting' WHERE id = $1`, [ws]);
    state.clearLockStateCache(ws);
    const s = await state.resolveLockState(config, ws);
    expect(s.enabled).toBe(true);
    expect(state.hasAnyLock(s)).toBe(false);
    await q(`UPDATE public.workspaces SET status = 'active' WHERE id = $1`, [ws]);
    state.clearLockStateCache(ws);
  });
});
