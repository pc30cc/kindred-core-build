/**
 * Everything that should reach an operator's phone besides a customer's
 * message: a conversation handed to them, a colleague's note, a new email,
 * a callback request — and a call-centre call ringing an Android phone.
 *
 * Until these, only customer messages and team chat were pushed; each of
 * the rest reached a desk that happened to be open, and nothing else.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

type Row = Record<string, unknown>;
type Result = { data: unknown; error: { code: string; message: string } | null };
interface Builder {
  select(): Builder;
  eq(col: string, val: unknown): Builder;
  is(col: string, val: null): Builder;
  in(col: string, vals: unknown[]): Builder;
  not(): Builder;
  insert(values: Row): Builder;
  update(values: Row): Builder;
  maybeSingle(): Promise<Result>;
  then(resolve: (value: Result) => void): void;
}
const db: Record<string, Row[]> = {};

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from(table: string): Builder {
      const rows: Row[] = db[table] || (db[table] = []);
      const filters: Array<(r: Row) => boolean> = [];
      let inserting: Row | null = null;
      let updating: Row | null = null;
      const matching = () => rows.filter((r) => filters.every((f) => f(r)));
      const builder: Builder = {
        select: () => builder,
        eq(col, val) { filters.push((r) => r[col] === val); return builder; },
        is(col, val) { filters.push((r) => (r[col] ?? null) === val); return builder; },
        in(col, vals) { filters.push((r) => vals.includes(r[col])); return builder; },
        not: () => builder,
        insert(values) { inserting = values; return builder; },
        update(values) { updating = values; return builder; },
        maybeSingle: async () => ({ data: matching()[0] ?? null, error: null }),
        then(resolve) {
          const row = inserting;
          if (row) {
            const clash = rows.some((r) =>
              r.workspace_id === row.workspace_id && r.user_id === row.user_id && r.dedupe_key === row.dedupe_key);
            if (clash) return resolve({ data: null, error: { code: '23505', message: 'duplicate key' } });
            rows.push({ ...row });
            return resolve({ data: null, error: null });
          }
          if (updating) {
            for (const match of matching()) Object.assign(match, updating);
            return resolve({ data: null, error: null });
          }
          return resolve({ data: matching(), error: null });
        },
      };
      return builder;
    },
  }),
}));

interface Sent { token: string; title?: string; body?: string; data: Record<string, string>; ttlSeconds?: number }
const sent = vi.hoisted(() => ({ fcm: [] as Sent[], data: [] as Sent[], voip: [] as Sent[] }));
const policy = vi.hoisted(() => ({ overrides: {} as Record<string, unknown> }));

vi.mock('../../../server/services/push/fcm.js', () => ({
  isPushConfigured: () => true,
  sendFcmMessage: async (msg: Sent) => { sent.fcm.push(msg); return { ok: true }; },
  sendFcmData: async (msg: Sent) => { sent.data.push(msg); return { ok: true }; },
}));
vi.mock('../../../server/services/push/apns.js', () => ({
  isApnsConfigured: () => false,
  nativeBundleId: () => 'com.webyar.ai',
  sendApnsAlert: async () => ({ ok: true }),
}));
vi.mock('../../../server/services/push/apnsVoip.js', () => ({
  isVoipConfigured: () => false,
  sendVoipPush: async (msg: Sent) => { sent.voip.push(msg); return { ok: true }; },
}));
vi.mock('../../../server/services/storage/urlResolver.js', () => ({
  createStorageUrlResolver: () => ({}),
  resolveContactAvatarUrl: async () => null,
}));
vi.mock('../../../server/services/widget/operatorPresenceSource.js', () => ({
  getConnectedOperators: async () => ({ mode: 'realtime', connected: new Set(), lastSeen: new Map(), degraded: false }),
}));
vi.mock('../../../server/services/push/platformSettings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/services/push/platformSettings.js')>();
  return {
    ...actual,
    loadPushPlatformSettings: async () => ({ ...actual.PUSH_PLATFORM_DEFAULTS, badge_enabled: false, ...policy.overrides }),
  };
});

const dispatch = await import('../../../server/services/push/dispatch.js');
const { ringOperators, cancelRing } = await import('../../../server/services/push/callRing.js');

const CONFIG = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k' } as never;
const WS = 'ws-1';
const ME = 'user-me';
const COLLEAGUE = 'user-colleague';
const OTHER = 'user-other';

function prefs(userId: string, overrides: Row = {}): Row {
  return {
    user_id: userId, workspace_id: null, platform: 'mobile',
    disable_all: false, play_sound: true, push_scope: 'all', push_preview: true, push_internal_notes: true,
    push_when_online: true, push_when_offline: true, quiet_hours_enabled: false,
    quiet_hours_start: null, quiet_hours_end: null, quiet_hours_timezone: null,
    ...overrides,
  };
}

function android(userId: string): Row {
  return { id: `d-${userId}`, user_id: userId, platform: 'android', push_token: `token-${userId}`, transport: 'fcm', device_id: `dev-${userId}`, enabled: true };
}

beforeEach(() => {
  for (const key of Object.keys(db)) delete db[key];
  db.workspace_members = [
    { workspace_id: WS, user_id: ME, suspended_at: null, role: 'owner' },
    { workspace_id: WS, user_id: COLLEAGUE, suspended_at: null, role: 'agent' },
    { workspace_id: WS, user_id: OTHER, suspended_at: null, role: 'support_agent' },
  ];
  db.profiles = [
    { id: ME, full_name: 'Reza', preferred_locale: 'fa' },
    { id: COLLEAGUE, full_name: 'Sara', preferred_locale: 'en' },
    { id: OTHER, full_name: 'Ben', preferred_locale: 'en' },
  ];
  db.user_notification_prefs = [];
  db.mobile_push_devices = [android(ME), android(COLLEAGUE), android(OTHER)];
  db.push_dispatch_log = [];
  db.contacts = [{ id: 'contact-1', name: 'Ali', email: null, visitor_code: null }];
  db.conversations = [{ id: 'conv-1', workspace_id: WS, assigned_to: ME, contact_id: 'contact-1', status: 'open' }];
  db.workspaces = [{ id: WS, name: 'Webyar' }];
  db.call_sessions = [{ id: 'call-1', workspace_id: WS, contact_id: 'contact-1', visitor_session_id: null }];
  db.call_center_agent_presence = [
    { workspace_id: WS, user_id: ME, status: 'available' },
    { workspace_id: WS, user_id: OTHER, status: 'available' },
    { workspace_id: WS, user_id: COLLEAGUE, status: 'offline' },
  ];
  sent.fcm = []; sent.data = []; sent.voip = [];
  policy.overrides = {};
});

describe('a conversation handed to an operator', () => {
  it('tells them, in their language, who it is and who handed it over', async () => {
    await dispatch.notifyAssignment(CONFIG, { workspaceId: WS, conversationId: 'conv-1', assigneeId: ME, actorId: COLLEAGUE, stamp: 't1' });
    expect(sent.fcm.map((m) => m.token)).toEqual([`token-${ME}`]);
    expect(sent.fcm[0].title).toBe('گفتگو به شما سپرده شد');
    expect(sent.fcm[0].body).toContain('Ali');
    expect(sent.fcm[0].body).toContain('Sara');
    expect(sent.fcm[0].data).toEqual({ type: 'assignment', workspaceId: WS, conversationId: 'conv-1' });
  });

  it('by routing, with nobody named as the one who handed it over', async () => {
    await dispatch.notifyAssignment(CONFIG, { workspaceId: WS, conversationId: 'conv-1', assigneeId: ME, actorId: null, stamp: 't1' });
    expect(sent.fcm).toHaveLength(1);
  });

  it('is not news to the operator who took it themselves', async () => {
    await dispatch.notifyAssignment(CONFIG, { workspaceId: WS, conversationId: 'conv-1', assigneeId: ME, actorId: ME, stamp: 't1' });
    expect(sent.fcm).toHaveLength(0);
  });

  it('a handover already undone is not sent', async () => {
    await dispatch.notifyAssignment(CONFIG, { workspaceId: WS, conversationId: 'conv-1', assigneeId: COLLEAGUE, actorId: ME, stamp: 't1' });
    expect(sent.fcm).toHaveLength(0);
  });

  it('reaches even an operator who follows only mentions — it is addressed to them', async () => {
    db.user_notification_prefs = [prefs(ME, { push_scope: 'mentions' })];
    await dispatch.notifyAssignment(CONFIG, { workspaceId: WS, conversationId: 'conv-1', assigneeId: ME, actorId: COLLEAGUE, stamp: 't1' });
    expect(sent.fcm).toHaveLength(1);
  });

  it('once per handover', async () => {
    await dispatch.notifyAssignment(CONFIG, { workspaceId: WS, conversationId: 'conv-1', assigneeId: ME, actorId: COLLEAGUE, stamp: 't1' });
    await dispatch.notifyAssignment(CONFIG, { workspaceId: WS, conversationId: 'conv-1', assigneeId: ME, actorId: COLLEAGUE, stamp: 't1' });
    expect(sent.fcm).toHaveLength(1);
  });
});

describe('an internal note', () => {
  const note = { workspaceId: WS, conversationId: 'conv-1', messageId: 'note-1', text: 'Refund approved', senderName: 'Sara', eventType: 'internal_note' as const, actorId: COLLEAGUE };

  it('reaches the assignee of an assigned conversation, and not every other operator', async () => {
    await dispatch.notifyInboundMessage(CONFIG, note);
    expect(sent.fcm.map((m) => m.token)).toEqual([`token-${ME}`]);
    expect(sent.fcm[0].title).toContain('یادداشت داخلی');
  });

  it('never its author', async () => {
    await dispatch.notifyInboundMessage(CONFIG, { ...note, actorId: ME });
    expect(sent.fcm.map((m) => m.token)).not.toContain(`token-${ME}`);
  });

  it('on an unassigned conversation, everyone following all conversations but the author', async () => {
    db.conversations[0].assigned_to = null;
    await dispatch.notifyInboundMessage(CONFIG, note);
    expect(sent.fcm.map((m) => m.token).sort()).toEqual([`token-${ME}`, `token-${OTHER}`].sort());
  });

  it('an operator who turned notes off hears nothing of them', async () => {
    db.user_notification_prefs = [prefs(ME, { push_internal_notes: false })];
    await dispatch.notifyInboundMessage(CONFIG, note);
    expect(sent.fcm).toHaveLength(0);
  });
});

describe('a new email', () => {
  it('reaches those following everything, naming the thread to open', async () => {
    db.user_notification_prefs = [prefs(OTHER, { push_scope: 'assigned' })];
    await dispatch.notifyEmailMessage(CONFIG, { workspaceId: WS, threadId: 'thread-1', messageId: 'email-1', from: 'ali@example.com', subject: 'Invoice', snippet: 'Please find it attached' });
    expect(sent.fcm.map((m) => m.token).sort()).toEqual([`token-${COLLEAGUE}`, `token-${ME}`].sort());
    const mine = sent.fcm.find((m) => m.token === `token-${ME}`)!;
    expect(mine.title).toBe('ali@example.com');
    expect(mine.body).toBe('Invoice — Please find it attached');
    expect(mine.data).toEqual({ type: 'email_message', workspaceId: WS, threadId: 'thread-1', messageId: 'email-1' });
  });

  it('with previews off says only that there is one', async () => {
    db.user_notification_prefs = [prefs(ME, { push_preview: false })];
    await dispatch.notifyEmailMessage(CONFIG, { workspaceId: WS, threadId: 'thread-1', messageId: 'email-1', from: 'ali@example.com', subject: 'Invoice' });
    const mine = sent.fcm.find((m) => m.token === `token-${ME}`)!;
    expect(`${mine.title} ${mine.body}`).not.toContain('Invoice');
    expect(`${mine.title} ${mine.body}`).not.toContain('ali@');
  });

  it('from a live Gmail inbox: no stored row, no content, still names the thread', async () => {
    await dispatch.notifyEmailMessage(CONFIG, { workspaceId: WS, threadId: '18c3f4a5b6c7d8e9', dedupeId: 'gmail-int-1-18c3f4a5b6c7d8ea' });
    const mine = sent.fcm.find((m) => m.token === `token-${ME}`)!;
    expect(mine.data).toEqual({ type: 'email_message', workspaceId: WS, threadId: '18c3f4a5b6c7d8e9' });
    const log = db.push_dispatch_log.find((r: { user_id?: string }) => r.user_id === ME) as { message_id?: unknown; dedupe_key?: string } | undefined;
    expect(log?.message_id ?? null).toBeNull();
    expect(log?.dedupe_key).toBe('email_message:gmail-int-1-18c3f4a5b6c7d8ea');
  });
});

describe('a callback request', () => {
  it('reaches those following everything, and never rings', async () => {
    await dispatch.notifyCallbackRequest(CONFIG, { workspaceId: WS, callbackId: 'cb-1', visitorName: 'Ali' });
    expect(sent.fcm).toHaveLength(3);
    expect(sent.data).toHaveLength(0);
    expect(sent.fcm.find((m) => m.token === `token-${ME}`)!.title).toBe('درخواست تماس');
  });
});

describe('a call-centre call on an Android phone', () => {
  it('rings with a data-only message, naming the caller and when the ring runs out', async () => {
    await ringOperators(CONFIG, { workspaceId: WS, callSessionId: 'call-1', agentId: ME, channel: 'video' });
    expect(sent.data).toHaveLength(1);
    const ring = sent.data[0];
    expect(ring.token).toBe(`token-${ME}`);
    expect(ring.ttlSeconds).toBe(45);
    expect(ring.data).toMatchObject({ type: 'call_incoming', callId: 'call-1', workspaceId: WS, channel: 'video', caller: 'Ali' });
    expect(Number(ring.data.expiresAt)).toBeGreaterThan(Date.now() / 1000);
    // No alert of its own: the app draws the ring.
    expect(sent.fcm).toHaveLength(0);
  });

  it('a caller nobody could name is sent unnamed, for the phone to name in its own language', async () => {
    db.contacts = [];
    await ringOperators(CONFIG, { workspaceId: WS, callSessionId: 'call-1', agentId: ME, channel: 'audio' });
    expect(sent.data[0].data.caller).toBe('');
  });

  it('an anonymous caller carries their visitor code, which the list names them by', async () => {
    db.contacts = [{ id: 'contact-1', name: null, email: null, visitor_code: '4ZTK' }];
    await ringOperators(CONFIG, { workspaceId: WS, callSessionId: 'call-1', agentId: ME, channel: 'audio' });
    expect(sent.data[0].data.caller).toBe('');
    expect(sent.data[0].data.callerCode).toBe('4ZTK');
  });

  it('broadcast rings every available operator, support agents included', async () => {
    await ringOperators(CONFIG, { workspaceId: WS, callSessionId: 'call-1', agentId: null, channel: 'audio' });
    expect(sent.data.map((m) => m.token).sort()).toEqual([`token-${ME}`, `token-${OTHER}`].sort());
  });

  it('stops every Android phone when one operator answers — theirs too, answered at the desk', async () => {
    await cancelRing(CONFIG, { workspaceId: WS, callSessionId: 'call-1', reason: 'answered', exceptUserId: ME });
    expect(sent.data.map((m) => m.token).sort()).toEqual([`token-${COLLEAGUE}`, `token-${ME}`, `token-${OTHER}`].sort());
    expect(sent.data[0].data).toEqual({ type: 'call_cancel', callId: 'call-1', workspaceId: WS, reason: 'answered' });
  });

  it('a decline stops only the phones of whoever declined', async () => {
    await cancelRing(CONFIG, { workspaceId: WS, callSessionId: 'call-1', reason: 'declined', onlyUserId: OTHER });
    expect(sent.data.map((m) => m.token)).toEqual([`token-${OTHER}`]);
  });

  it('an iPhone-only setup is unchanged: no Android ring without Firebase', async () => {
    db.mobile_push_devices = [];
    await ringOperators(CONFIG, { workspaceId: WS, callSessionId: 'call-1', agentId: ME, channel: 'audio' });
    expect(sent.data).toHaveLength(0);
  });
});

describe('a customer is named as the app lists them', () => {
  const message = { workspaceId: WS, conversationId: 'conv-1', messageId: 'm-1', text: 'Hello', channel: 'widget' };

  it('an anonymous visitor is "Visitor" and their code, in each operator\'s language', async () => {
    db.contacts = [{ id: 'contact-1', name: null, email: null, visitor_code: '4ZTK' }];
    db.conversations[0].assigned_to = null;
    await dispatch.notifyInboundMessage(CONFIG, message);
    const title = (token: string) => sent.fcm.find((m) => m.token === token)?.title;
    expect(title(`token-${ME}`)).toBe('بازدیدکننده 4ZTK');
    expect(title(`token-${COLLEAGUE}`)).toBe('Visitor 4ZTK');
  });

  it('never "Customer" for a visitor the widget sent no name for', async () => {
    db.contacts = [{ id: 'contact-1', name: null, email: null, visitor_code: '4ZTK' }];
    await dispatch.notifyInboundMessage(CONFIG, { ...message, senderName: null });
    expect(sent.fcm[0].title).not.toContain('مشتری');
  });

  it('once they give a name, by that name', async () => {
    db.contacts = [{ id: 'contact-1', name: 'سارا', email: 'sara@example.com', visitor_code: '4ZTK' }];
    await dispatch.notifyInboundMessage(CONFIG, message);
    expect(sent.fcm[0].title).toBe('سارا');
  });

  it('known only by email, by what comes before the @', async () => {
    db.contacts = [{ id: 'contact-1', name: null, email: 'ali.rezaei@example.com', visitor_code: '4ZTK' }];
    await dispatch.notifyInboundMessage(CONFIG, message);
    expect(sent.fcm[0].title).toContain('ali.rezaei');
  });

  it('the contact, not whatever name came with the message', async () => {
    db.contacts = [{ id: 'contact-1', name: 'M D', email: null, visitor_code: '8K2X' }];
    await dispatch.notifyInboundMessage(CONFIG, { ...message, senderName: 'someone else' });
    expect(sent.fcm[0].title).toContain('M D');
  });

  it('an AI handoff names the customer the same way', async () => {
    db.contacts = [{ id: 'contact-1', name: null, email: null, visitor_code: '4ZTK' }];
    await dispatch.notifyHandoff(CONFIG, { workspaceId: WS, conversationId: 'conv-1', handoffAt: 't1' });
    expect(sent.fcm[0].body).toContain('بازدیدکننده 4ZTK');
  });

  it('a handover names the customer the same way', async () => {
    db.contacts = [{ id: 'contact-1', name: null, email: null, visitor_code: '4ZTK' }];
    await dispatch.notifyAssignment(CONFIG, { workspaceId: WS, conversationId: 'conv-1', assigneeId: ME, actorId: null, stamp: 't9' });
    expect(sent.fcm[0].body).toBe('بازدیدکننده 4ZTK');
  });
});
