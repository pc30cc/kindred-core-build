/**
 * The switches an operator has for each kind of event beyond a customer's
 * message, and who hears that the AI has let go of a conversation.
 *
 * Team chat, assignments and email each reach a phone now, and each can be
 * turned off on its own (migration 235) — a deployment that has not run the
 * migration yet still sends, as it did before the switches existed. A handoff
 * the routing gave to nobody new goes to whoever already held the
 * conversation, or to the operators following everything.
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
          // A database that has not run migration 235.
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

async function who(ctx: Partial<RecipientContext>): Promise<string[]> {
  const out = await resolveRecipients(CONFIG, {
    workspaceId: WS,
    conversationId: 'conv-1',
    assignedTo: null,
    actorId: null,
    eventType: 'new_message',
    ...ctx,
  });
  return out.map((r) => r.userId).sort();
}

/** How `notifyTeamMessage` asks: one addressee, passed as mentioned. */
const teamMessage = (to: string): Partial<RecipientContext> => ({
  eventType: 'team_message',
  conversationId: null,
  actorId: AGENT,
  mentionedUserIds: [to],
  userIds: [to],
});

beforeEach(() => {
  for (const key of Object.keys(db)) delete db[key];
  state.eventColumnsMissing = false;
  db.workspace_members = [OWNER, AGENT, OTHER].map((id) => ({ workspace_id: WS, user_id: id, suspended_at: null }));
  db.profiles = [OWNER, AGENT, OTHER].map((id) => ({ id, preferred_locale: 'en' }));
  db.user_notification_prefs = [prefs(OWNER), prefs(AGENT), prefs(OTHER)];
});

describe('each kind of event has its own switch', () => {
  it('a colleague\'s message: push_team_chat', async () => {
    expect(await who(teamMessage(OTHER))).toEqual([OTHER]);
    db.user_notification_prefs = [prefs(OTHER, { push_team_chat: false })];
    expect(await who(teamMessage(OTHER))).toEqual([]);
  });

  it('a conversation handed over: push_assignments', async () => {
    const assignment: Partial<RecipientContext> = { eventType: 'assignment', assignedTo: OTHER, userIds: [OTHER] };
    expect(await who(assignment)).toEqual([OTHER]);
    db.user_notification_prefs = [prefs(OTHER, { push_assignments: false })];
    expect(await who(assignment)).toEqual([]);
  });

  it('a new email: push_email', async () => {
    db.user_notification_prefs = [prefs(OWNER, { push_email: false }), prefs(AGENT), prefs(OTHER)];
    expect(await who({ eventType: 'email_message', conversationId: null })).toEqual([AGENT, OTHER].sort());
  });

  it('turning one off leaves the others alone', async () => {
    db.user_notification_prefs = [prefs(OTHER, { push_team_chat: false })];
    expect(await who({ eventType: 'assignment', assignedTo: OTHER, userIds: [OTHER] })).toEqual([OTHER]);
    expect(await who({ eventType: 'new_message', assignedTo: OTHER })).toEqual([OTHER]);
  });
});

describe('the AI letting go of a conversation', () => {
  it('goes to the operator already holding it, and only them', async () => {
    expect(await who({ eventType: 'handoff', assignedTo: AGENT, userIds: [AGENT] })).toEqual([AGENT]);
    expect(await who({ eventType: 'handoff', assignedTo: AGENT })).toEqual([AGENT]);
  });

  it('with nobody holding it, goes to everyone following all conversations', async () => {
    db.user_notification_prefs = [
      prefs(OWNER),
      prefs(AGENT, { push_scope: 'assigned' }),
      prefs(OTHER),
    ];
    expect(await who({ eventType: 'handoff' })).toEqual([OTHER, OWNER].sort());
  });

  it('is silenced by the assignments switch', async () => {
    db.user_notification_prefs = [prefs(OWNER, { push_assignments: false }), prefs(AGENT), prefs(OTHER)];
    expect(await who({ eventType: 'handoff' })).toEqual([AGENT, OTHER].sort());
  });
});

describe('a database one migration behind', () => {
  it('still sends, with the switches it does not have treated as on', async () => {
    state.eventColumnsMissing = true;
    expect(await who(teamMessage(OTHER))).toEqual([OTHER]);
    expect(await who({ eventType: 'email_message', conversationId: null })).toEqual([AGENT, OTHER, OWNER].sort());
    expect(await who({ eventType: 'new_message' })).toEqual([AGENT, OTHER, OWNER].sort());
  });
});
