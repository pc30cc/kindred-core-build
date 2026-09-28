/**
 * The notification log cleans itself up, the badge is one query, and a
 * handoff is looked up once.
 *
 * `push_dispatch_log` gained a row per notification per operator — iPhone
 * and Android alike — and nothing ever removed one, while Super Admin showed
 * a retention setting that nothing read. The cleanup runs on its own while
 * the switch is on, and on demand from "Clean up now"; both remove only what
 * is older than the retention, in batches.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ServerConfig } from '../../../server/config';

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  rpcBatches: [] as number[],
  rpcCalls: [] as { fn: string; args: Record<string, unknown> }[],
  rpcFails: false,
  plainDeleteCount: 0,
  deletes: [] as { table: string; lt?: [string, unknown] }[],
  updates: [] as { table: string; values: Row }[],
  settings: { id: 's1', dispatch_log_retention_days: 30, dispatch_log_auto_purge: true } as Row,
  badge: 7 as number | null,
}));

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    rpc(fn: string, args: Record<string, unknown>) {
      state.rpcCalls.push({ fn, args });
      if (state.rpcFails) return Promise.resolve({ data: null, error: { message: 'function does not exist' } });
      if (fn === 'push_unread_badge') return Promise.resolve({ data: state.badge, error: null });
      const next = state.rpcBatches.shift() ?? 0;
      return Promise.resolve({ data: next, error: null });
    },
    from(table: string) {
      const op: { kind: string; lt?: [string, unknown]; values?: Row } = { kind: 'select' };
      const builder: Record<string, unknown> = {
        select: () => builder,
        order: () => builder,
        limit: () => builder,
        eq: () => builder,
        is: () => builder,
        in: () => builder,
        or: () => builder,
        maybeSingle: () => builder,
        delete: () => { op.kind = 'delete'; return builder; },
        update: (values: Row) => { op.kind = 'update'; op.values = values; return builder; },
        lt: (col: string, val: unknown) => { op.lt = [col, val]; return builder; },
        then(resolve: (value: unknown) => unknown) {
          if (op.kind === 'delete') {
            state.deletes.push({ table, lt: op.lt });
            return resolve({ count: state.plainDeleteCount, error: null });
          }
          if (op.kind === 'update') {
            state.updates.push({ table, values: op.values ?? {} });
            return resolve({ data: null, error: null });
          }
          if (table === 'push_platform_settings') return resolve({ data: state.settings, error: null });
          return resolve({ data: [], count: 0, error: null });
        },
      };
      return builder;
    },
  }),
}));

vi.mock('../../../server/services/push/platformSettings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/services/push/platformSettings')>();
  return {
    ...actual,
    loadPushPlatformSettings: async () => ({
      ...actual.PUSH_PLATFORM_DEFAULTS,
      dispatch_log_retention_days: Number(state.settings.dispatch_log_retention_days),
      dispatch_log_auto_purge: state.settings.dispatch_log_auto_purge !== false,
    }),
  };
});

const retention = await import('../../../server/services/push/logRetention.js');
const { unreadBadgeCount } = await import('../../../server/services/push/recipients.js');
const { handoffPushStamp } = await import('../../../server/services/chatRouting.js');

const CONFIG = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k' } as unknown as ServerConfig;

beforeEach(() => {
  state.rpcBatches = [];
  state.rpcCalls = [];
  state.rpcFails = false;
  state.plainDeleteCount = 0;
  state.deletes = [];
  state.updates = [];
  state.settings = { id: 's1', dispatch_log_retention_days: 30, dispatch_log_auto_purge: true };
  state.badge = 7;
});

describe('the retention', () => {
  it('is 1 to 365 whole days, whatever arrives', () => {
    expect(retention.clampRetentionDays(0)).toBe(1);
    expect(retention.clampRetentionDays(9999)).toBe(365);
    expect(retention.clampRetentionDays('45')).toBe(45);
    expect(retention.clampRetentionDays('nonsense')).toBe(30);
  });

  it('cuts off exactly that many days back', () => {
    const now = Date.parse('2026-09-28T12:00:00Z');
    expect(retention.retentionCutoff(30, now)).toBe('2026-08-29T12:00:00.000Z');
  });
});

describe('cleaning up', () => {
  it('removes in batches until one comes back short, and records the run', async () => {
    state.rpcBatches = [5000, 5000, 1200];
    const removed = await retention.purgeDispatchLog(CONFIG, 30);
    expect(removed).toBe(11200);
    expect(state.rpcCalls.filter((c) => c.fn === 'purge_push_dispatch_log')).toHaveLength(3);
    const record = state.updates.find((u) => u.table === 'push_platform_settings');
    expect(record?.values.dispatch_log_purged_count).toBe(11200);
    expect(typeof record?.values.dispatch_log_purged_at).toBe('string');
  });

  it('only ever removes what is older than the retention', async () => {
    await retention.purgeDispatchLog(CONFIG, 7);
    const before = state.rpcCalls[0].args.p_before as string;
    const age = Date.now() - Date.parse(before);
    expect(Math.round(age / 86_400_000)).toBe(7);
  });

  it('a database without migration 236 gets one plain delete instead', async () => {
    state.rpcFails = true;
    state.plainDeleteCount = 42;
    expect(await retention.purgeDispatchLog(CONFIG, 30)).toBe(42);
    expect(state.deletes).toHaveLength(1);
    expect(state.deletes[0].table).toBe('push_dispatch_log');
    expect(state.deletes[0].lt?.[0]).toBe('created_at');
  });
});

describe('the automatic cleanup', () => {
  it('runs at the saved retention while the switch is on', async () => {
    state.settings.dispatch_log_retention_days = 90;
    state.rpcBatches = [3];
    expect(await retention.runDispatchLogJanitorOnce(CONFIG)).toBe(3);
    const age = Date.now() - Date.parse(state.rpcCalls[0].args.p_before as string);
    expect(Math.round(age / 86_400_000)).toBe(90);
  });

  it('does nothing at all while it is off', async () => {
    state.settings.dispatch_log_auto_purge = false;
    expect(await retention.runDispatchLogJanitorOnce(CONFIG)).toBeNull();
    expect(state.rpcCalls).toHaveLength(0);
    expect(state.deletes).toHaveLength(0);
  });

  it('never throws out of the server process', async () => {
    state.rpcFails = true;
    state.plainDeleteCount = 0;
    await expect(retention.runDispatchLogJanitorOnce(CONFIG)).resolves.toBe(0);
  });
});

describe('the number on the app icon', () => {
  it('is one statement when the database has it', async () => {
    expect(await unreadBadgeCount(CONFIG, 'u1', 'w1')).toBe(7);
    expect(state.rpcCalls).toEqual([{ fn: 'push_unread_badge', args: { p_user_id: 'u1', p_workspace_id: 'w1' } }]);
  });

  it('is counted the long way when it does not', async () => {
    state.rpcFails = true;
    // The long way finds no membership in this mock, which is 0 — the point
    // is that it answers rather than failing the notification.
    await expect(unreadBadgeCount(CONFIG, 'u1', 'w1')).resolves.toBe(0);
  });
});

describe('a handoff is looked up once', () => {
  it('the first run after the AI lets go notifies, stamped with the handoff', () => {
    expect(handoffPushStamp({ ai_handoff_at: '2026-09-28T10:00:00Z' }, false)).toBe('2026-09-28T10:00:00Z');
  });

  it('a later run for the same handoff does not even look', () => {
    expect(
      handoffPushStamp({ ai_handoff_at: '2026-09-28T10:00:00Z', handoff_push_at: '2026-09-28T10:00:00Z' }, false),
    ).toBeNull();
  });

  it('a new handoff of the same conversation notifies again', () => {
    expect(
      handoffPushStamp({ ai_handoff_at: '2026-09-28T12:00:00Z', handoff_push_at: '2026-09-28T10:00:00Z' }, false),
    ).toBe('2026-09-28T12:00:00Z');
  });

  it('without a stamp, only the run that sends the visitor notice does', () => {
    expect(handoffPushStamp({}, true)).toEqual(expect.any(String));
    expect(handoffPushStamp({}, false)).toBeNull();
  });
});
