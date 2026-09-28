/**
 * A colleague's message reaches the phone it was sent to.
 *
 * Team chat told its recipient over realtime only — which reaches an app
 * that is open, and nothing else — so a message from a colleague to a phone
 * in a pocket arrived in silence, on every platform. `notifyTeamMessage`
 * pushes it, to that one operator, under the same preferences as any other
 * notification and in their own language.
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
            // push_dispatch_log's UNIQUE (workspace_id, user_id, dedupe_key).
            const clash = rows.some((r) =>
              r.workspace_id === row.workspace_id &&
              r.user_id === row.user_id &&
              r.dedupe_key === row.dedupe_key);
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

/** What a transport was handed, as far as these tests look. */
interface Sent {
  token: string;
  title: string;
  body: string;
  data: Record<string, string>;
  collapseKey?: string;
  androidChannelId?: string;
  apns?: { threadId?: string; categoryId?: string };
}

const sent = vi.hoisted(() => ({ fcm: [] as Sent[], apns: [] as Sent[] }));
const policy = vi.hoisted(() => ({ overrides: {} as Record<string, unknown> }));

vi.mock('../../../server/services/push/fcm.js', () => ({
  isPushConfigured: () => true,
  sendFcmMessage: async (msg: Sent) => { sent.fcm.push(msg); return { ok: true }; },
}));
vi.mock('../../../server/services/push/apns.js', () => ({
  isApnsConfigured: () => true,
  nativeBundleId: () => 'com.webyar.ai',
  sendApnsAlert: async (msg: Sent) => { sent.apns.push(msg); return { ok: true }; },
}));
vi.mock('../../../server/services/widget/operatorPresenceSource.js', () => ({
  getConnectedOperators: async () => ({ mode: 'realtime', connected: new Set(), lastSeen: new Map(), degraded: false }),
}));
vi.mock('../../../server/services/push/platformSettings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/services/push/platformSettings.js')>();
  return {
    ...actual,
    loadPushPlatformSettings: async () => ({
      ...actual.PUSH_PLATFORM_DEFAULTS,
      // The unread count is a read of its own, and not what this is about.
      badge_enabled: false,
      ...policy.overrides,
    }),
  };
});

const { notifyTeamMessage, renderTeamContent } = await import('../../../server/services/push/dispatch.js');

const CONFIG = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k' } as never;
const RLM = '‏';
const WS = 'ws-1';
const SENDER = 'user-sara';
const RECIPIENT = 'user-reza';
const BYSTANDER = 'user-other';

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
    ...overrides,
  };
}

function device(userId: string, transport: 'fcm' | 'apns' = 'fcm'): Row {
  return {
    id: `d-${userId}-${transport}`,
    user_id: userId,
    platform: transport === 'fcm' ? 'android' : 'ios',
    push_token: `token-${userId}-${transport}`,
    transport,
    device_id: `device-${userId}-${transport}`,
    enabled: true,
  };
}

function send(overrides: Record<string, unknown> = {}) {
  return notifyTeamMessage(CONFIG, {
    workspaceId: WS,
    senderId: SENDER,
    recipientId: RECIPIENT,
    messageId: 'tm-1',
    text: 'Can you take the Rasht customer?',
    ...overrides,
  });
}

beforeEach(() => {
  for (const key of Object.keys(db)) delete db[key];
  db.workspace_members = [
    { workspace_id: WS, user_id: SENDER, suspended_at: null },
    { workspace_id: WS, user_id: RECIPIENT, suspended_at: null },
    { workspace_id: WS, user_id: BYSTANDER, suspended_at: null },
  ];
  db.profiles = [
    { id: SENDER, full_name: 'Sara', preferred_locale: 'en' },
    { id: RECIPIENT, full_name: 'Reza', preferred_locale: 'fa' },
    { id: BYSTANDER, full_name: 'Ben', preferred_locale: 'en' },
  ];
  db.user_notification_prefs = [];
  db.mobile_push_devices = [device(SENDER), device(RECIPIENT), device(RECIPIENT, 'apns'), device(BYSTANDER)];
  db.push_dispatch_log = [];
  sent.fcm = [];
  sent.apns = [];
  policy.overrides = {};
});

describe('a colleague’s message is pushed', () => {
  it('to every phone of the operator it was sent to, and nobody else', async () => {
    await send();
    expect(sent.fcm.map((m) => m.token)).toEqual([`token-${RECIPIENT}-fcm`]);
    expect(sent.apns.map((m) => m.token)).toEqual([`token-${RECIPIENT}-apns`]);
  });

  it('names the colleague as the thread to open — ids only, never the text', async () => {
    await send();
    const [message] = sent.fcm;
    expect(message.data).toEqual({ type: 'team_message', workspaceId: WS, peerId: SENDER, messageId: 'tm-1' });
    expect(JSON.stringify(message.data)).not.toContain('Rasht');
  });

  it("in the recipient's language, marked as a colleague's and not a customer's", async () => {
    await send();
    const [message] = sent.fcm;
    expect(message.title).toBe(`${RLM}Sara · همکار`);
    expect(message.body).toBe('Can you take the Rasht customer?');
  });

  it('one thread per colleague, on the messages channel', async () => {
    await send();
    const [message] = sent.fcm;
    expect(message.collapseKey).toBe(`team-${SENDER}`);
    expect(message.androidChannelId).toBe('webyar_messages');
    expect(sent.apns[0].apns?.threadId).toBe(`team-${SENDER}`);
    // No Reply / Mark-as-read buttons: those act on a customer conversation.
    expect(sent.apns[0].apns?.categoryId).toBeUndefined();
  });

  it('once, however many times it is asked', async () => {
    await send();
    await send();
    expect(sent.fcm).toHaveLength(1);
    expect(db.push_dispatch_log).toHaveLength(1);
    expect(db.push_dispatch_log[0]).toMatchObject({
      user_id: RECIPIENT,
      conversation_id: null,
      notification_type: 'team_message',
      dedupe_key: 'team_message:tm-1',
      status: 'sent',
      device_count: 2,
      accepted_count: 2,
    });
  });

  it('never to the sender', async () => {
    await send({ recipientId: SENDER });
    expect(sent.fcm).toHaveLength(0);
    expect(sent.apns).toHaveLength(0);
  });
});

describe('under the recipient’s own settings', () => {
  it('previews off: neither the text nor the name leaves the server', async () => {
    db.user_notification_prefs = [prefs(RECIPIENT, { push_preview: false })];
    await send();
    const [message] = sent.fcm;
    expect(message.title).toBe('Webyar');
    expect(message.body).toBe('پیام جدید از همکار');
    expect(`${message.title} ${message.body}`).not.toContain('Sara');
    expect(`${message.title} ${message.body}`).not.toContain('Rasht');
  });

  it('"only mentions" and "only assigned to me" still get a message addressed to them', async () => {
    db.user_notification_prefs = [prefs(RECIPIENT, { push_scope: 'mentions' })];
    await send({ messageId: 'tm-a' });
    db.user_notification_prefs = [prefs(RECIPIENT, { push_scope: 'assigned' })];
    await send({ messageId: 'tm-b' });
    expect(sent.fcm).toHaveLength(2);
  });

  it('"none" and "disable all" silence it', async () => {
    db.user_notification_prefs = [prefs(RECIPIENT, { push_scope: 'none' })];
    await send({ messageId: 'tm-a' });
    db.user_notification_prefs = [prefs(RECIPIENT, { disable_all: true })];
    await send({ messageId: 'tm-b' });
    expect(sent.fcm).toHaveLength(0);
  });

  it('breaks quiet hours only where a mention would', async () => {
    const allDay = { quiet_hours_enabled: true, quiet_hours_start: '00:00', quiet_hours_end: '23:59', quiet_hours_timezone: 'UTC' };
    db.user_notification_prefs = [prefs(RECIPIENT, allDay)];
    await send({ messageId: 'tm-a' });
    expect(sent.fcm).toHaveLength(1);

    policy.overrides = { mention_bypasses_quiet_hours: false };
    await send({ messageId: 'tm-b' });
    // 23:59–00:00 is the one minute outside this window.
    const now = new Date();
    const lastMinute = now.getUTCHours() === 23 && now.getUTCMinutes() === 59;
    expect(sent.fcm).toHaveLength(lastMinute ? 2 : 1);
  });

  it('a suspended operator, or one outside the workspace, gets nothing', async () => {
    db.workspace_members = db.workspace_members.map((m) =>
      m.user_id === RECIPIENT ? { ...m, suspended_at: '2026-01-01T00:00:00Z' } : m);
    await send({ messageId: 'tm-a' });
    db.workspace_members = db.workspace_members.filter((m) => m.user_id !== RECIPIENT);
    await send({ messageId: 'tm-b' });
    expect(sent.fcm).toHaveLength(0);
    expect(db.push_dispatch_log).toHaveLength(0);
  });

  it('push turned off platform-wide sends nothing', async () => {
    policy.overrides = { push_enabled: false };
    await send();
    expect(sent.fcm).toHaveLength(0);
  });
});

describe('team message copy', () => {
  it('reads as a colleague in each language', () => {
    expect(renderTeamContent({ senderName: 'Sara', text: 'hi' }, true, 'en').title).toBe('Sara · colleague');
    expect(renderTeamContent({ senderName: 'Sara', text: 'hi' }, true, 'tr').title).toBe('Sara · iş arkadaşı');
    expect(renderTeamContent({ senderName: 'سارا', text: 'سلام' }, true, 'fa')).toEqual({ title: 'سارا · همکار', body: 'سلام' });
  });

  it('a nameless colleague and a message that is only a file still say something', () => {
    expect(renderTeamContent({ senderName: null, text: '', hasAttachment: true }, true, 'fa')).toEqual({
      title: 'همکار',
      body: '📎 پیوست',
    });
    expect(renderTeamContent({ senderName: '  ', text: null }, true, 'en')).toEqual({
      title: 'Colleague',
      body: 'New message',
    });
  });
});
