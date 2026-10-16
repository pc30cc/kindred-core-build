/**
 * The server lock core of simple billing phase 4 (server/services/billing/locks),
 * without a database:
 *
 *   - timestamps compared to the microsecond, in every form the data layer
 *     returns, '-infinity' included;
 *   - isRowLocked: ties on created_at broken by id, NULL created_at ranks
 *     first, limit 0 (cut '-infinity'), chats by last activity, members by
 *     the locked user list, nothing while the state is disabled;
 *   - the query filters as the engine receives them;
 *   - a locked contact keeps only its id and creation time;
 *   - the lock state: cached 60 s, cleared per workspace and by the
 *     entitlement funnel, fail-open on any error, nothing read while the
 *     switch is off or billing is unlimited;
 *   - the deletion date of a clock, the report's parsing and when a downgrade
 *     must be acknowledged;
 *   - the Super Admin's plan fields (locked_data_retention_days, is_hidden,
 *     ai_allowance).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  calls: [] as Array<{ name: string; args: unknown }>,
}));

vi.mock('../../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    rpc: (name: string, args?: unknown) => {
      h.calls.push({ name, args });
      const result = Promise.resolve().then(() => h.rpc(name, args));
      return Object.assign(result, { range: () => result });
    },
  }),
}));

import {
  clearLockStateCache,
  clockDeadline,
  hasAnyLock,
  parseCutoffRow,
  resolveLockState,
  unlockedState,
  NIL_UUID,
  type LockState,
} from '../../../../server/services/billing/locks/state';
import {
  applyConversationLockedFilter,
  applyConversationUnlockedFilter,
  applyLockedFilter,
  applyUnlockedFilter,
  isMemberLocked,
  isRowLocked,
  lockedErrorBody,
  tsMicros,
} from '../../../../server/services/billing/locks/predicates';
import { contactForPanel, maskVisitorCode, redactContact } from '../../../../server/services/billing/locks/redact';
import {
  parseSqlLockReport,
  reportForViewer,
  reportHasLocks,
  reportNeedsAcknowledgement,
  type LockReport,
} from '../../../../server/services/billing/locks/report';
import { cleanPlanExtras } from '../../../../server/routes/plans';

const config = { supabaseUrl: 'http://stub', supabaseServiceRoleKey: 'key', selfHostBillingUnlimited: false } as never;
const WS = '11111111-1111-4111-8111-111111111111';

function enabled(over: Partial<LockState> = {}): LockState {
  return { enabled: true, kb: null, contact: null, member: null, conversation: null, ...over };
}

describe('tsMicros', () => {
  it('keeps microseconds in every form the data layer returns', () => {
    const base = Date.parse('2026-01-02T03:04:05Z') * 1000;
    expect(tsMicros('2026-01-02T03:04:05.123456+00:00')).toBe(base + 123456);
    expect(tsMicros('2026-01-02 03:04:05.123456+00')).toBe(base + 123456);
    expect(tsMicros('2026-01-02T03:04:05.1Z')).toBe(base + 100000);
    expect(tsMicros('2026-01-02T06:34:05.000001+03:30')).toBe(base + 1);
    expect(tsMicros('2026-01-02T03:04:05Z')).toBe(base);
    expect(tsMicros(new Date('2026-01-02T03:04:05.123Z'))).toBe(base + 123000);
  });

  it('reads infinities and nothing', () => {
    expect(tsMicros('-infinity')).toBe(-Infinity);
    expect(tsMicros('infinity')).toBe(Infinity);
    expect(tsMicros(null)).toBeNull();
    expect(tsMicros('')).toBeNull();
    expect(tsMicros('not a date')).toBeNull();
  });
});

describe('isRowLocked', () => {
  const cut = { ts: '2026-01-02T03:04:05.123456+00:00', id: '55555555-5555-4555-8555-555555555555' };
  const state = enabled({ kb: { limit: 2, total: 5, locked: 3, cut, ids: [] }, contact: { limit: 2, total: 4, locked: 2, cut } });

  it('ranks by created_at, then by id on a tie', () => {
    expect(isRowLocked(state, 'kb_article', { id: '11111111-1111-4111-8111-111111111111', created_at: '2026-01-02T03:04:05.123455+00:00' })).toBe(false);
    expect(isRowLocked(state, 'kb_article', { id: '11111111-1111-4111-8111-111111111111', created_at: '2026-01-02T03:04:05.123457+00:00' })).toBe(true);
    // Same microsecond: the uuid decides, as Postgres orders it.
    expect(isRowLocked(state, 'kb_article', { id: '44444444-4444-4444-8444-444444444444', created_at: cut.ts })).toBe(false);
    expect(isRowLocked(state, 'kb_article', { id: cut.id, created_at: cut.ts })).toBe(false);
    expect(isRowLocked(state, 'kb', { id: '66666666-6666-4666-8666-666666666666', created_at: '2026-01-02 03:04:05.123456+00' })).toBe(true);
    expect(isRowLocked(state, 'contact', { id: 'AAAAAAAA-0000-4000-8000-000000000000', created_at: cut.ts })).toBe(true);
  });

  it('a NULL created_at ranks first', () => {
    expect(isRowLocked(state, 'kb_article', { id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', created_at: null })).toBe(false);
  });

  it('limit 0 locks every row, NULL created_at included', () => {
    const zero = enabled({ kb: { limit: 0, total: 2, locked: 2, cut: { ts: '-infinity', id: NIL_UUID } } });
    expect(isRowLocked(zero, 'kb_article', { id: '00000000-0000-4000-8000-000000000001', created_at: null })).toBe(true);
    expect(isRowLocked(zero, 'kb_article', { id: '00000000-0000-4000-8000-000000000001', created_at: '1970-01-01T00:00:00Z' })).toBe(true);
  });

  it('chats lock by last activity before the cutoff', () => {
    const chats = enabled({ conversation: { limit: 30, total: 3, locked: 1, cut: { ts: '2026-09-11T00:00:00+00:00', id: null } } });
    expect(isRowLocked(chats, 'conversation', { created_at: '2026-01-01T00:00:00Z', updated_at: '2026-09-10T23:59:59.999999Z' })).toBe(true);
    expect(isRowLocked(chats, 'conversation', { created_at: '2026-01-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' })).toBe(false);
    expect(isRowLocked(chats, 'conversation', { created_at: '2026-01-01T00:00:00Z', updated_at: null })).toBe(true);
    expect(isRowLocked(chats, 'conversation', { created_at: null, updated_at: null })).toBe(false);
  });

  it('members by the locked user list only', () => {
    const members = enabled({ member: { limit: 1, total: 3, locked: 2, cut: { ts: '2026-01-01T00:00:00Z', id: 'x' }, ids: ['aaaaaaaa-0000-4000-8000-000000000001'] } });
    expect(isMemberLocked(members, 'AAAAAAAA-0000-4000-8000-000000000001')).toBe(true);
    expect(isMemberLocked(members, 'bbbbbbbb-0000-4000-8000-000000000001')).toBe(false);
    expect(isMemberLocked(members, null)).toBe(false);
  });

  it('nothing is locked while the state is disabled or the kind has no cutoff', () => {
    expect(isRowLocked({ ...state, enabled: false }, 'kb_article', { id: 'f', created_at: '2027-01-01T00:00:00Z' })).toBe(false);
    expect(isRowLocked(enabled({ kb: { limit: 5, total: 2, locked: 0, cut: null } }), 'kb_article', { id: 'f', created_at: '2027-01-01T00:00:00Z' })).toBe(false);
    expect(isRowLocked(state, 'contact', null)).toBe(false);
    expect(hasAnyLock(state)).toBe(true);
    expect(hasAnyLock(unlockedState())).toBe(false);
  });
});

describe('query filters', () => {
  const recorder = () => {
    const seen: string[] = [];
    const q = {
      or(f: string) { seen.push(`or:${f}`); return q; },
      is(c: string, v: null) { seen.push(`is:${c}:${v}`); return q; },
    };
    return { q, seen };
  };
  const cut = { ts: '2026-01-02T03:04:05.123456+00:00', id: '55555555-5555-4555-8555-555555555555' };

  it('count kinds: unlocked and locked, quoted timestamps', () => {
    const a = recorder();
    applyUnlockedFilter(a.q, cut);
    expect(a.seen).toEqual([`or:created_at.is.null,created_at.lt."${cut.ts}",and(created_at.eq."${cut.ts}",id.lte.${cut.id})`]);
    const b = recorder();
    applyLockedFilter(b.q, cut);
    expect(b.seen).toEqual([`or:created_at.gt."${cut.ts}",and(created_at.eq."${cut.ts}",id.gt.${cut.id})`]);
  });

  it("a '-infinity' cut and no cut", () => {
    const a = recorder();
    applyUnlockedFilter(a.q, { ts: '-infinity', id: NIL_UUID });
    expect(a.seen).toEqual([`or:and(created_at.is.null,id.lte.${NIL_UUID})`]);
    const b = recorder();
    applyLockedFilter(b.q, { ts: '-infinity', id: NIL_UUID });
    expect(b.seen).toEqual([`or:created_at.not.is.null,and(created_at.is.null,id.gt.${NIL_UUID})`]);
    const c = recorder();
    applyUnlockedFilter(c.q, null);
    expect(c.seen).toEqual([]);
    const d = recorder();
    applyLockedFilter(d.q, null);
    expect(d.seen).toEqual(['is:id:null']);
  });

  it('chats by activity', () => {
    const c = { ts: '2026-09-11T00:00:00+00:00', id: null };
    const a = recorder();
    applyConversationUnlockedFilter(a.q, c);
    expect(a.seen[0]).toBe(`or:updated_at.gte."${c.ts}",and(updated_at.is.null,created_at.gte."${c.ts}"),and(updated_at.is.null,created_at.is.null)`);
    const b = recorder();
    applyConversationLockedFilter(b.q, c);
    expect(b.seen[0]).toBe(`or:updated_at.lt."${c.ts}",and(updated_at.is.null,created_at.lt."${c.ts}")`);
  });

  it('the 403 body', () => {
    expect(lockedErrorBody('contact_locked')).toEqual({ error: 'contact_locked', upgrade_required: true });
  });
});

describe('redactContact', () => {
  it('keeps the id and creation time; blanks everything else, new fields included', () => {
    const row = {
      id: 'c1', workspace_id: WS, created_at: '2026-01-01T00:00:00Z', name: 'Ada', email: 'ada@x.test', phone: '+1',
      notes: 'vip', metadata: { ip: '1.2.3.4' }, tags: ['a'], avatar_url: 'u', avatar_storage_key: 'k',
      visitor_code: 'V8KQ2Z', last_ip: '1.2.3.4', updated_at: '2026-02-01T00:00:00Z',
    };
    expect(redactContact(row)).toEqual({
      id: 'c1', workspace_id: WS, created_at: '2026-01-01T00:00:00Z', name: null, email: null, phone: null,
      notes: null, metadata: {}, tags: [], avatar_url: null, avatar_storage_key: null,
      visitor_code: 'V8••••', last_ip: null, updated_at: null, locked: true,
    });
    expect(maskVisitorCode(null)).toBeNull();
    expect(contactForPanel(row, false)).toEqual({ ...row, locked: false });
    expect(contactForPanel(row, true).email).toBeNull();
  });
});

describe('resolveLockState', () => {
  beforeEach(() => {
    h.rpc.mockReset();
    h.calls.length = 0;
    clearLockStateCache();
  });

  const cutoffs = (name: string, args: unknown) => {
    if (name === 'billing_locks_enabled') return { data: true, error: null };
    const kind = (args as { p_kind?: string }).p_kind;
    if (name === 'billing_lock_cutoff') {
      if (kind === 'kb_article') return { data: [{ lim: 1, total: '3', locked: 2, cut_ts: '2026-01-01T00:00:00+00:00', cut_id: 'A1' }], error: null };
      if (kind === 'member') return { data: [{ lim: 1, total: 1, locked: 0, cut_ts: null, cut_id: null }], error: null };
      return { data: [{ lim: null, total: null, locked: 0, cut_ts: null, cut_id: null }], error: null };
    }
    if (name === 'billing_locked_ids') return { data: ['K2', 'K3'], error: null };
    return { data: null, error: { message: `unexpected ${name}` } };
  };

  it('reads the cutoffs once, then serves them from the cache until cleared', async () => {
    h.rpc.mockImplementation(cutoffs);
    const first = await resolveLockState(config, WS);
    expect(first.enabled).toBe(true);
    expect(first.kb).toEqual({ limit: 1, total: 3, locked: 2, cut: { ts: '2026-01-01T00:00:00+00:00', id: 'a1' }, ids: ['k2', 'k3'] });
    expect(first.member).toEqual({ limit: 1, total: 1, locked: 0, cut: null, ids: [] });
    expect(first.contact).toEqual({ limit: null, total: 0, locked: 0, cut: null });
    const reads = h.calls.length;
    await resolveLockState(config, WS);
    expect(h.calls.length).toBe(reads);
    expect(h.calls.find((c) => c.name === 'billing_lock_cutoff')?.args).toEqual({ p_workspace_id: WS, p_kind: 'kb_article', p_plan_id: null });
    clearLockStateCache(WS);
    await resolveLockState(config, WS);
    expect(h.calls.length).toBeGreaterThan(reads);
  });

  it('the entitlement funnel clears it', async () => {
    h.rpc.mockImplementation(cutoffs);
    await resolveLockState(config, WS, ['kb_article']);
    const reads = h.calls.length;
    vi.resetModules();
    const { handleWorkspaceEntitlementChanged } = await import('../../../../server/services/billing/entitlementChange');
    const stateMod = await import('../../../../server/services/billing/locks/state');
    await stateMod.resolveLockState(config, WS, ['kb_article']);
    const afterFresh = h.calls.length;
    await stateMod.resolveLockState(config, WS, ['kb_article']);
    expect(h.calls.length).toBe(afterFresh);
    await handleWorkspaceEntitlementChanged(config, { workspaceId: WS, source: 'subscription_canceled' });
    await stateMod.resolveLockState(config, WS, ['kb_article']);
    expect(h.calls.length).toBeGreaterThan(afterFresh);
    expect(reads).toBeGreaterThan(0);
  });

  it('switch off: nothing past the switch is read', async () => {
    h.rpc.mockImplementation((name: string) => (name === 'billing_locks_enabled' ? { data: false, error: null } : { data: null, error: { message: 'no' } }));
    expect(await resolveLockState(config, WS)).toEqual(unlockedState());
    expect(h.calls.map((c) => c.name)).toEqual(['billing_locks_enabled']);
  });

  it('fails open: an unreadable switch or cutoff locks nothing; an unreadable cutoff is not cached', async () => {
    h.rpc.mockImplementation(() => ({ data: null, error: { message: 'down' } }));
    expect(await resolveLockState(config, WS)).toEqual(unlockedState());
    clearLockStateCache();
    h.rpc.mockImplementation((name: string) => (name === 'billing_locks_enabled' ? { data: true, error: null } : { data: null, error: { message: 'down' } }));
    expect(await resolveLockState(config, WS)).toEqual(unlockedState());
    h.rpc.mockImplementation(cutoffs);
    expect((await resolveLockState(config, WS)).kb?.locked).toBe(2);
  });

  it('an unreadable switch reads as off for 30 s: one failing query and one warning per window, not per request', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      vi.setSystemTime(new Date('2026-10-11T10:00:00Z'));
      h.rpc.mockImplementation(() => ({ data: null, error: { message: 'function billing_locks_enabled() does not exist' } }));
      for (let i = 0; i < 5; i += 1) expect(await resolveLockState(config, WS)).toEqual(unlockedState());
      expect(h.calls.filter((c) => c.name === 'billing_locks_enabled')).toHaveLength(1);
      expect(warn).toHaveBeenCalledTimes(1);
      // The window over, the switch is read again (and now it answers).
      vi.setSystemTime(new Date('2026-10-11T10:00:31Z'));
      h.rpc.mockImplementation(cutoffs);
      expect((await resolveLockState(config, WS)).kb?.locked).toBe(2);
      expect(h.calls.filter((c) => c.name === 'billing_locks_enabled')).toHaveLength(2);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('self-host unlimited billing never locks and reads nothing', async () => {
    h.rpc.mockImplementation(cutoffs);
    expect(await resolveLockState({ ...(config as object), selfHostBillingUnlimited: true } as never, WS)).toEqual(unlockedState());
    expect(h.calls).toEqual([]);
  });

  it('parses a cutoff given as one record or a set', () => {
    expect(parseCutoffRow({ lim: '5', total: '7', locked: '2', cut_ts: '-infinity', cut_id: NIL_UUID }))
      .toEqual({ limit: 5, total: 7, locked: 2, cut: { ts: '-infinity', id: NIL_UUID } });
    expect(parseCutoffRow([])).toEqual({ limit: null, total: 0, locked: 0, cut: null });
  });
});

describe('clockDeadline', () => {
  const DAY = 86_400_000;
  const now = Date.parse('2026-10-11T00:00:00Z');

  it('count kinds: since + L, pushed so both notices run their full time', () => {
    const since = '2026-06-01T00:00:00Z';
    const clock = { kind: 'contact', episode_key: since, since, notice_30_at: null, notice_7_at: null, deleted_at: null };
    // since + 200 d is far ahead: the notices fit before it.
    expect(clockDeadline(clock, 200, now)?.toISOString()).toBe(new Date(Date.parse(since) + 200 * DAY).toISOString());
    // since + 90 d is already close (2026-08-30 < now): no notice yet, so now + 30 d + … at least.
    expect(clockDeadline(clock, 90, now)!.getTime()).toBeGreaterThanOrEqual(now + 30 * DAY);
    // A late 30-day notice pushes it.
    const late = { ...clock, notice_30_at: '2026-10-01T00:00:00Z', notice_7_at: '2026-10-25T00:00:00Z' };
    expect(clockDeadline(late, 90, now)?.toISOString()).toBe('2026-11-01T00:00:00.000Z');
  });

  it('chats: the batch date; forever and closed episodes have none', () => {
    const chat = { kind: 'conversation', episode_key: '2026-12-01', since: '2026-10-05T00:00:00Z', notice_30_at: '2026-11-01T00:00:00Z', notice_7_at: '2026-11-24T00:00:00Z', deleted_at: null };
    expect(clockDeadline(chat, 60, now)?.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(clockDeadline(chat, null, now)).toBeNull();
    expect(clockDeadline({ ...chat, deleted_at: '2026-12-01T01:00:00Z' }, 60, now)).toBeNull();
  });
});

describe('the downgrade report', () => {
  const sql = {
    plan_id: 'p', locks_enabled: true, has_locks: true,
    kb_article: { limit: 2, total: 5, locked: 3, items: [{ id: 'a', title: 'A' }] },
    contact: { limit: 100, total: 412, locked: 312 },
    member: { limit: 2, total: 4, locked: 2, items: [{ user_id: 'u', name: 'N', email: 'e@x' }] },
    conversation: { retention_days: 30, total: 9, locked: 4, cutoff: '2026-09-11T00:00:00+00:00', oldest_kept: null },
    conversation_quota: { limit: 50, used_this_month: 71, full: true },
    storage: { limit_gb: 1, used_gb: 3.4, uploads_blocked: true },
    locked_data_retention_days: 90,
    first_deletion_not_before: '2027-01-09T00:00:00+00:00',
  };
  const extras = {
    modules_lost: [], channels_lost: [], channels_stop_messages: false,
    ai_credits: { current: null, target: null, unit: 'IRR', currency: null, current_minor: null, target_minor: null },
  };

  it('parses the SQL leniently', () => {
    const r = parseSqlLockReport(sql, 'p');
    expect(r.kb_article).toEqual({ limit: 2, total: 5, locked: 3, items: [{ id: 'a', title: 'A' }] });
    expect(r.member.items).toEqual([{ user_id: 'u', name: 'N', email: 'e@x' }]);
    expect(r.conversation.cutoff).toBe('2026-09-11T00:00:00+00:00');
    // 265's GB answer reads in MB; 271's MB answer as it is.
    expect(r.storage).toEqual({ limit_mb: 1024, used_mb: 3.4 * 1024, uploads_blocked: true });
    expect(parseSqlLockReport({ ...sql, storage: { limit_mb: 0, used_mb: 0.5, uploads_blocked: true, limit_gb: 0, used_gb: 0 } }, 'p').storage)
      .toEqual({ limit_mb: 0, used_mb: 0.5, uploads_blocked: true });
    expect(parseSqlLockReport({ ...sql, storage: { limit_mb: null, used_mb: 1 } }, 'p').storage.limit_mb).toBeNull();
    const empty = parseSqlLockReport(null, 'p');
    expect(empty).toMatchObject({ locks_enabled: false, kb_article: { locked: 0, items: [] }, conversation_quota: { full: false } });
    expect(reportHasLocks({ ...empty, ...extras })).toBe(false);
  });

  it('anything listed needs the acknowledgement, only while the switch is on', () => {
    const base = { ...parseSqlLockReport(null, 'p'), ...extras };
    expect(reportHasLocks({ ...base, channels_lost: [{ key: 'telegram', in_use: true }] })).toBe(true);
    expect(reportHasLocks({ ...base, storage: { limit_mb: 1024, used_mb: 2048, uploads_blocked: true } })).toBe(true);
    const full = { ...parseSqlLockReport(sql, 'p'), ...extras, has_locks: true } as LockReport;
    expect(reportNeedsAcknowledgement(full)).toBe(true);
    expect(reportNeedsAcknowledgement({ ...full, locks_enabled: false })).toBe(false);
    expect(reportNeedsAcknowledgement({ ...full, has_locks: false })).toBe(false);
    expect(reportNeedsAcknowledgement(null)).toBe(false);
    expect(reportForViewer(full, false).member.items).toEqual([]);
    expect(reportForViewer(full, true).member.items).toHaveLength(1);
  });
});

describe('cleanPlanExtras (Super Admin plan fields)', () => {
  it('locked_data_retention_days: empty is never, a whole number of days above 0', () => {
    expect(cleanPlanExtras({ locked_data_retention_days: '' })).toEqual({ value: { locked_data_retention_days: null } });
    expect(cleanPlanExtras({ locked_data_retention_days: null })).toEqual({ value: { locked_data_retention_days: null } });
    expect(cleanPlanExtras({ locked_data_retention_days: 90 })).toEqual({ value: { locked_data_retention_days: 90 } });
    expect(cleanPlanExtras({ locked_data_retention_days: ' 30 ' })).toEqual({ value: { locked_data_retention_days: 30 } });
    for (const bad of [0, -1, 1.5, 'abc', true, 99999]) {
      expect(cleanPlanExtras({ locked_data_retention_days: bad }).field, String(bad)).toBe('locked_data_retention_days');
    }
    expect(cleanPlanExtras({})).toEqual({ value: {} });
  });

  it('is_hidden and ai_allowance', () => {
    expect(cleanPlanExtras({ is_hidden: true, ai_allowance: { USD: 5 } })).toEqual({ value: { is_hidden: true, ai_allowance: { USD: 5 } } });
    expect(cleanPlanExtras({ is_hidden: 'yes' }).field).toBe('is_hidden');
    expect(cleanPlanExtras({ ai_allowance: [1] }).field).toBe('ai_allowance');
    expect(cleanPlanExtras({ ai_allowance: null })).toEqual({ value: { ai_allowance: {} } });
  });
});
