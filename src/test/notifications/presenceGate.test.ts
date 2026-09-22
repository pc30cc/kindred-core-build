/**
 * "Only tell my phone when I am away from my desk."
 *
 * Two switches carried that promise on the settings page for as long as the
 * page has existed, and nothing anywhere read them: `push_when_online` and
 * `push_when_offline` were saved to the row and consulted by nobody. An
 * operator who turned the first off went on being buzzed beside a browser
 * they were already answering in.
 *
 * The answer is not the phone's to give — the phone cannot see a browser
 * connected somewhere else — so the server decides it, from the same
 * presence the team list is drawn from. Which makes the failure mode the
 * important part: presence can be degraded, and a degraded read reports a
 * whole workspace as disconnected. Silence is the expensive mistake here.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

type Row = Record<string, any>;
const db: Record<string, Row[]> = {};

const presence = vi.hoisted(() => ({
  connected: new Set<string>(),
  degraded: false,
  throws: false,
  calls: 0,
}));

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from(table: string) {
      const rows: Row[] = db[table] || (db[table] = []);
      const filters: Array<(r: Row) => boolean> = [];
      const builder: any = {
        select: () => builder,
        eq(col: string, val: any) { filters.push((r: Row) => r[col] === val); return builder; },
        is(col: string, val: null) { filters.push((r: Row) => (r[col] ?? null) === val); return builder; },
        in(col: string, vals: any[]) { filters.push((r: Row) => vals.includes(r[col])); return builder; },
        then(resolve: any) {
          return resolve({ data: rows.filter((r) => filters.every((f) => f(r))), error: null });
        },
      };
      return builder;
    },
  }),
}));

vi.mock('../../../server/services/widget/operatorPresenceSource.js', () => ({
  getConnectedOperators: async () => {
    presence.calls += 1;
    if (presence.throws) throw new Error('centrifugo unreachable');
    return { mode: 'realtime', connected: presence.connected, lastSeen: new Map(), degraded: presence.degraded };
  },
}));

const { resolveRecipients } = await import('../../../server/services/push/recipients.js');

const CONFIG = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k' } as any;
const WORKSPACE = 'ws-1';
const AT_DESK = 'user-at-desk';
const AWAY = 'user-away';

/** A preferences row, defaults filled in, for the phone. */
function prefs(userId: string, overrides: Row = {}, platform = 'mobile'): Row {
  return {
    user_id: userId,
    workspace_id: null,
    platform,
    disable_all: false,
    play_sound: true,
    push_scope: 'all',
    push_preview: true,
    push_internal_notes: true,
    push_when_online: true,
    push_when_offline: true,
    quiet_hours_enabled: false,
    quiet_hours_start: null,
    quiet_hours_end: null,
    quiet_hours_timezone: null,
    ...overrides,
  };
}

function ctx(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: WORKSPACE,
    conversationId: 'conv-1',
    assignedTo: null,
    eventType: 'new_message' as const,
    actorId: null,
    ...overrides,
  };
}

beforeEach(() => {
  for (const key of Object.keys(db)) delete db[key];
  db.workspace_members = [
    { workspace_id: WORKSPACE, user_id: AT_DESK, suspended_at: null },
    { workspace_id: WORKSPACE, user_id: AWAY, suspended_at: null },
  ];
  db.profiles = [
    { id: AT_DESK, preferred_locale: 'en' },
    { id: AWAY, preferred_locale: 'fa' },
  ];
  db.user_notification_prefs = [];
  presence.connected = new Set([AT_DESK]);
  presence.degraded = false;
  presence.throws = false;
  presence.calls = 0;
});

describe('where the operator is', () => {
  it('nobody has asked, so presence is never even read', async () => {
    db.user_notification_prefs = [prefs(AT_DESK), prefs(AWAY)];
    const out = await resolveRecipients(CONFIG, ctx());
    expect(out.map((r) => r.userId).sort()).toEqual([AT_DESK, AWAY].sort());
    expect(presence.calls).toBe(0);
  });

  it('keeps the phone quiet while the operator is answering in the browser', async () => {
    db.user_notification_prefs = [prefs(AT_DESK, { push_when_online: false }), prefs(AWAY)];
    const out = await resolveRecipients(CONFIG, ctx());
    expect(out.map((r) => r.userId)).toEqual([AWAY]);
  });

  it('and the other way round: the phone is for desk hours only', async () => {
    db.user_notification_prefs = [prefs(AT_DESK), prefs(AWAY, { push_when_offline: false })];
    const out = await resolveRecipients(CONFIG, ctx());
    expect(out.map((r) => r.userId)).toEqual([AT_DESK]);
  });

  it('a degraded presence read never silences anybody', async () => {
    // Degraded reports a whole workspace as disconnected. An operator who
    // asked not to be told while offline would be the one to lose the
    // message, on the day the realtime layer was already having trouble.
    presence.degraded = true;
    db.user_notification_prefs = [prefs(AT_DESK, { push_when_online: false }), prefs(AWAY, { push_when_offline: false })];
    const out = await resolveRecipients(CONFIG, ctx());
    expect(out.map((r) => r.userId).sort()).toEqual([AT_DESK, AWAY].sort());
  });

  it('nor does presence failing outright', async () => {
    presence.throws = true;
    db.user_notification_prefs = [prefs(AT_DESK, { push_when_online: false })];
    const out = await resolveRecipients(CONFIG, ctx());
    expect(out.map((r) => r.userId).sort()).toEqual([AT_DESK, AWAY].sort());
  });
});

describe('which row the phone is sent by', () => {
  it('reads the phone\'s preferences, not the browser\'s', async () => {
    // The browser is silenced and narrowed; the phone is not. Before the
    // surfaces were split there was one row and this was impossible to say.
    db.user_notification_prefs = [
      prefs(AT_DESK, { disable_all: true, push_scope: 'none' }, 'web'),
      prefs(AT_DESK),
      prefs(AWAY),
    ];
    const out = await resolveRecipients(CONFIG, ctx());
    expect(out.map((r) => r.userId).sort()).toEqual([AT_DESK, AWAY].sort());
  });

  it('and silencing the phone does not need the browser silenced too', async () => {
    db.user_notification_prefs = [
      prefs(AT_DESK, {}, 'web'),
      prefs(AT_DESK, { disable_all: true }),
      prefs(AWAY),
    ];
    const out = await resolveRecipients(CONFIG, ctx());
    expect(out.map((r) => r.userId)).toEqual([AWAY]);
  });

  it('an operator with no row of their own still gets notified', async () => {
    const out = await resolveRecipients(CONFIG, ctx());
    expect(out.map((r) => r.userId).sort()).toEqual([AT_DESK, AWAY].sort());
    expect(out.every((r) => r.preview && r.sound)).toBe(true);
  });
});

describe('what the resolver already promised, still promised', () => {
  it('never notifies the operator who caused the event', async () => {
    const out = await resolveRecipients(CONFIG, ctx({ actorId: AT_DESK }));
    expect(out.map((r) => r.userId)).toEqual([AWAY]);
  });

  it('a suspended member is not a recipient', async () => {
    db.workspace_members[1].suspended_at = '2026-01-01T00:00:00Z';
    const out = await resolveRecipients(CONFIG, ctx());
    expect(out.map((r) => r.userId)).toEqual([AT_DESK]);
  });

  it('renders in the recipient\'s own language, not the sender\'s', async () => {
    const out = await resolveRecipients(CONFIG, ctx());
    expect(out.find((r) => r.userId === AWAY)?.locale).toBe('fa');
    expect(out.find((r) => r.userId === AT_DESK)?.locale).toBe('en');
  });

  it('an assigned thread is its assignee\'s', async () => {
    const out = await resolveRecipients(CONFIG, ctx({ assignedTo: AWAY }));
    expect(out.map((r) => r.userId)).toEqual([AWAY]);
  });
});
