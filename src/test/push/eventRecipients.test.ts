/**
 * Who a phone notification is for, for every event beyond a customer's
 * message.
 *
 * The native app used to hear about exactly one thing — a customer writing —
 * and nothing else: a colleague's direct message, a conversation handed to
 * the operator, the AI giving one up, a note on their conversation, a new
 * email all went unannounced until the operator happened to open the app.
 * Each now reaches a phone, and each reaches only the people it is for: a
 * direct message only its recipient, an assignment only the assignee, email
 * only the owners and admins whose screen it is — and every one of them can
 * be turned off on its own.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ServerConfig } from '../../../server/config';

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};
const state = vi.hoisted(() => ({ eventColumnsMissing: false }));

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from(table: string) {
      const rows: Row[] = db[table] || (db[table] = []);
      const filters: Array<(r: Row) => boolean> = [];
      let columns = '';
      const builder: Record<string, unknown> = {
        select: (cols: string) => { columns = cols; return builder; },
        eq(col: string, val: unknown) { filters.push((r: Row) => r[col] === val); return builder; },
        is(col: string, val: null) { filters.push((r: Row) => (r[col] ?? null) === val); return builder; },
        in(col: string, vals: unknown[]) { filters.push((r: Row) => vals.includes(r[col])); return builder; },
        then(resolve: (value: { data: Row[] | null; error: { code: string; message: string } | null }) => unknown) {
          // A database that has not run migration 234.
          if (state.eventColumnsMissing && table === 'user_notification_prefs' && columns.includes('push_team_chat')) {
            return resolve({ data: null, error: { code: '42703', message: 'column does not exist' } });
          }
          return resolve({ data: rows.filter((r) => filters.every((f) => f(r))), error: null });
        },
      };
      return builder;
    },
  }),
}));

vi.mock('../../../server/services/widget/operatorPresenceSource.js', () => ({
  getConnectedOperators: async () => ({ mode: 'realtime', connected: new Set(), lastSeen: new Map(), degraded: false }),
}));

const { resolveRecipients } = await import('../../../server/services/push/recipients.js');
type RecipientContext = Parameters<typeof resolveRecipients>[1];

const CONFIG = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k' } as unknown as ServerConfig;
const WS = 'ws-1';
const OWNER = 'owner';
const ADMIN = 'admin';
const AGENT = 'agent';
const OTHER = 'other-agent';

function prefs(userId: string, overrides: Row = {}): Row {
  return {
    user_id: userId,
    workspace_id: null,
    platform: 'mobile',
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
    push_team_chat: true,
    push_assignments: true,
    push_email: true,
    ...overrides,
  };
}

async function who(ctx: Record<string, unknown>): Promise<string[]> {
  const out = await resolveRecipients(CONFIG, {
    workspaceId: WS,
    conversationId: 'conv-1',
    assignedTo: null,
    actorId: null,
    ...ctx,
  } as RecipientContext);
  return out.map((r) => r.userId).sort();
}

beforeEach(() => {
  for (const key of Object.keys(db)) delete db[key];
  state.eventColumnsMissing = false;
  db.workspace_members = [
    { workspace_id: WS, user_id: OWNER, suspended_at: null, role: 'owner' },
    { workspace_id: WS, user_id: ADMIN, suspended_at: null, role: 'admin' },
    { workspace_id: WS, user_id: AGENT, suspended_at: null, role: 'agent' },
    { workspace_id: WS, user_id: OTHER, suspended_at: null, role: 'agent' },
  ];
  db.profiles = [OWNER, ADMIN, AGENT, OTHER].map((id) => ({ id, preferred_locale: 'en' }));
  db.user_notification_prefs = [prefs(OWNER), prefs(ADMIN), prefs(AGENT), prefs(OTHER)];
});

describe('a colleague\'s direct message', () => {
  const event = { eventType: 'team_message', conversationId: null, actorId: AGENT, targetUserIds: [OTHER] };

  it('reaches its recipient and nobody else', async () => {
    expect(await who(event)).toEqual([OTHER]);
  });

  it('is theirs, so a narrow scope does not hide it', async () => {
    db.user_notification_prefs = [prefs(OTHER, { push_scope: 'assigned' })];
    expect(await who(event)).toEqual([OTHER]);
  });

  it('has its own switch', async () => {
    db.user_notification_prefs = [prefs(OTHER, { push_team_chat: false })];
    expect(await who(event)).toEqual([]);
  });

  it('never reaches the sender, even addressed to themselves', async () => {
    expect(await who({ ...event, targetUserIds: [AGENT] })).toEqual([]);
  });

  it('stays silent under mute-all and quiet "nothing"', async () => {
    db.user_notification_prefs = [prefs(OTHER, { disable_all: true })];
    expect(await who(event)).toEqual([]);
    db.user_notification_prefs = [prefs(OTHER, { push_scope: 'none' })];
    expect(await who(event)).toEqual([]);
  });
});

describe('a conversation handed to an operator', () => {
  const event = { eventType: 'assigned', assignedTo: OTHER, actorId: AGENT, targetUserIds: [OTHER] };

  it('reaches the new assignee only', async () => {
    expect(await who(event)).toEqual([OTHER]);
  });

  it('whatever their scope', async () => {
    db.user_notification_prefs = [prefs(OTHER, { push_scope: 'mentions' })];
    expect(await who(event)).toEqual([OTHER]);
  });

  it('can be turned off', async () => {
    db.user_notification_prefs = [prefs(OTHER, { push_assignments: false })];
    expect(await who(event)).toEqual([]);
  });

  it('is not news to somebody who is no longer the assignee', async () => {
    expect(await who({ ...event, assignedTo: ADMIN })).toEqual([]);
  });
});

describe('the AI letting go of a conversation', () => {
  it('goes to the operator already holding it', async () => {
    expect(await who({ eventType: 'handoff', assignedTo: AGENT })).toEqual([AGENT]);
  });

  it('with nobody holding it, goes to everyone who watches the whole inbox', async () => {
    db.user_notification_prefs = [
      prefs(OWNER),
      prefs(ADMIN, { push_scope: 'assigned' }),
      prefs(AGENT, { push_assignments: false }),
      prefs(OTHER),
    ];
    expect(await who({ eventType: 'handoff' })).toEqual([OTHER, OWNER].sort());
  });
});

describe('a note on a conversation', () => {
  it('goes to whoever holds the conversation, never the author', async () => {
    expect(await who({ eventType: 'internal_note', assignedTo: OTHER, actorId: AGENT })).toEqual([OTHER]);
  });

  it('on an unheld conversation, to everyone who watches the whole inbox', async () => {
    db.user_notification_prefs = [prefs(OWNER), prefs(ADMIN, { push_scope: 'assigned' }), prefs(OTHER)];
    expect(await who({ eventType: 'internal_note', actorId: AGENT })).toEqual([OTHER, OWNER].sort());
  });

  it('respects the notes switch', async () => {
    db.user_notification_prefs = [prefs(OTHER, { push_internal_notes: false })];
    expect(await who({ eventType: 'internal_note', assignedTo: OTHER, actorId: AGENT })).toEqual([]);
  });
});

describe('a new email', () => {
  const event = { eventType: 'email', conversationId: null, roles: ['owner', 'admin'] };

  it('reaches the owners and admins — the only people whose screen it is', async () => {
    expect(await who(event)).toEqual([ADMIN, OWNER].sort());
  });

  it('has its own switch', async () => {
    db.user_notification_prefs = [prefs(OWNER, { push_email: false }), prefs(ADMIN)];
    expect(await who(event)).toEqual([ADMIN]);
  });

  it('is nobody\'s assignment, so only "everything" covers it', async () => {
    db.user_notification_prefs = [prefs(OWNER, { push_scope: 'assigned' }), prefs(ADMIN)];
    expect(await who(event)).toEqual([ADMIN]);
  });
});

describe('a database one migration behind', () => {
  it('still sends, with the switches it does not have treated as on', async () => {
    state.eventColumnsMissing = true;
    expect(await who({ eventType: 'team_message', conversationId: null, targetUserIds: [OTHER] })).toEqual([OTHER]);
    expect(await who({ eventType: 'email', conversationId: null, roles: ['owner'] })).toEqual([OWNER]);
  });

  it('and a customer\'s message reaches the same people it always did', async () => {
    state.eventColumnsMissing = true;
    expect(await who({ eventType: 'new_message' })).toEqual([ADMIN, AGENT, OTHER, OWNER].sort());
  });
});
