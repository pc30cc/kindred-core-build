// @vitest-environment node
/**
 * The call in the chat, across areas (owner, 2026-11-02: "when a call is made
 * or ended, why isn't it recorded in the chat? or a missed call isn't
 * recorded in the chat"): docs/operations/TEAM_CALLS.md, "The call in the
 * chat", held against the server, the web panel, the iPhone and Android in
 * one place.
 *
 * Each area has its own suite (src/test/calls/teamCallChat.test.ts, the
 * migration's src/test/database/teamCallChatRecords294.test.ts,
 * src/test/teamCalls/teamCallChatLog.test.tsx, src/test/ios/teamCallLog.test.ts,
 * and the XCTest and Robolectric suites that run on their own CI). What none
 * of them sees is the other end of the wire: a key the server writes under
 * one name and a client reads under another, an outcome one side knows and
 * the other does not, a title one client gives the caller and another the
 * callee, a string whose words drifted. None of those is an error anywhere —
 * the line just reads as its fallback body (📞), or reads wrong, on one
 * surface. So here:
 *
 *   - the server's own `call` (through JSON) against the contract and the
 *     names the web type, the Swift decoder and the Kotlin reader take, and
 *     the channel and outcome values each knows;
 *   - `call` on a thread message and on a colleague's `last_message`, in all
 *     three, and `call_session_id` never leaving the server;
 *   - the server showing `call` only on a line its caller sent to its callee,
 *     which is why the clients' three ways of telling "I placed it" agree;
 *   - migration 294 (its name, re-runnable, no data) and announceTeamCall
 *     writing a line only for a call that is over;
 *   - the viewer rules — titles by caller and callee, side, arrow, direction,
 *     danger colour, duration — on the web (run here) and in the iOS and
 *     Android unit tests' tables (which run against the code on their CI);
 *   - the eleven strings, word for word, in Strings.swift, the generated
 *     Strings.kt and the web's locales.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

type Write = { table: string; op: 'insert' | 'upsert'; row: Record<string, unknown>; options?: Record<string, unknown> };

const h = vi.hoisted(() => ({
  writes: [] as Array<{ table: string; op: 'insert' | 'upsert'; row: Record<string, unknown>; options?: Record<string, unknown> }>,
  published: [] as Array<{ users: readonly string[]; payload: Record<string, unknown> }>,
}));

/** A database that records the writes and answers an upsert with its new row's id. */
function recordingDb() {
  return {
    from(table: string) {
      let result: { data: unknown; error: null } = { data: [], error: null };
      const chain = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        insert(row: Record<string, unknown>) {
          h.writes.push({ table, op: 'insert', row });
          return chain;
        },
        upsert(row: Record<string, unknown>, options?: Record<string, unknown>) {
          h.writes.push({ table, op: 'upsert', row, options });
          result = { data: [{ id: `tm-${h.writes.length}` }], error: null };
          return chain;
        },
        then<T>(resolve: (value: { data: unknown; error: null }) => T, reject?: (reason: unknown) => T) {
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return chain;
    },
  };
}

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => recordingDb() }));
vi.mock('../../../server/services/realtime/publish.js', () => ({
  publishTeamEvent: async (_config: unknown, users: readonly string[], payload: Record<string, unknown>) => {
    h.published.push({ users, payload });
  },
}));
vi.mock('../../../server/services/push/teamCallRing.js', () => ({ cancelTeamCallRing: async () => {} }));
vi.mock('../../../server/services/push/dispatch.js', () => ({ notifyTeamCallMissed: async () => {} }));
vi.mock('../../../server/services/calls/providerResolver.js', () => ({
  resolveCallProvider: () => ({ closeRoom: async () => {} }),
}));

const { teamCallChatView, teamCallChatViews, formatTeamCallDuration: serverDuration } = await import(
  '../../../server/services/calls/teamCallChat.js'
);
const { announceTeamCall } = await import('../../../server/services/calls/teamCallLifecycle.js');
const { TEAM_CALL_LIVE_STATES, TEAM_CALL_TERMINAL_STATES } = await import('../../../server/services/calls/teamCall.js');
const {
  teamChatCallOf,
  teamCallLogTitleKey,
  teamCallLogIsMissed,
  formatTeamCallDuration: webDuration,
} = await import('@/features/teamCalls/teamCallLog');
const { default: en } = await import('@/i18n/locales/en');
const { default: fa } = await import('@/i18n/locales/fa');
const { default: tr } = await import('@/i18n/locales/tr');

const read = (path: string) => readFileSync(path, 'utf8');

const DOC = read('docs/operations/TEAM_CALLS.md');
/** The contract's section. */
const SECTION = DOC.slice(DOC.indexOf('## The call in the chat'), DOC.indexOf('## Rollout'));

const SERVER_TEAM_CALL = read('server/services/calls/teamCall.ts');
const SERVER_CHAT = read('server/services/calls/teamCallChat.ts');
const SERVER_ROUTE = read('server/routes/teamChat.ts');
const MIGRATIONS = 'database/migrations';
const MIGRATION_294 = `${MIGRATIONS}/294_team_call_chat_records.sql`;

const WEB_API = read('src/lib/team-calls-api.ts');
const WEB_HOOK = read('src/hooks/useTeamChat.ts');
const WEB_LOG = read('src/features/teamCalls/teamCallLog.ts');
const WEB_BUBBLE = read('src/components/inbox/TeamCallLogBubble.tsx');
const WEB_PANEL = read('src/components/inbox/TeamChatPanel.tsx');

const IOS_MODEL = read('ios/Webyar/Sources/Core/Models/TeamChat.swift');
const IOS_TEAM_CALL = read('ios/Webyar/Sources/Core/Models/TeamCall.swift');
const IOS_CHANNEL = read('ios/Webyar/Sources/Core/Models/ConversationDetail.swift');
const IOS_LOG = read('ios/Webyar/Sources/Features/Colleagues/TeamCallLog.swift');
const IOS_THREAD = read('ios/Webyar/Sources/Features/Colleagues/TeamThreadView.swift');
const IOS_LIST = read('ios/Webyar/Sources/Features/Colleagues/ColleaguesView.swift');
const IOS_XCTEST = read('ios/Webyar/Tests/Core/TeamCallLogTests.swift');
const IOS_STRINGS = read('ios/Webyar/Sources/Localization/Strings.swift');

const KT = 'android/app/src/main/kotlin/com/platform/app';
const ANDROID_MODEL = read(`${KT}/core/model/TeamChat.kt`);
const ANDROID_TEAM_CALL = read(`${KT}/core/model/TeamCall.kt`);
const ANDROID_CHANNEL = read(`${KT}/core/model/ConversationDetail.kt`);
const ANDROID_LOG = read(`${KT}/feature/team/TeamCallLog.kt`);
const ANDROID_THREAD = read(`${KT}/feature/team/TeamThreadScreen.kt`);
const ANDROID_LIST = read(`${KT}/feature/team/ColleaguesScreen.kt`);
const ANDROID_STRINGS = read(`${KT}/i18n/Strings.kt`);
const ANDROID_TEST = read('android/app/src/test/kotlin/com/platform/app/feature/team/TeamCallLogTest.kt');

const sorted = (values: Iterable<string>) => [...new Set(values)].sort();

/** The text of [source] from [start] (included) to the first [end] after it. */
function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  expect(from, `found: ${start}`).toBeGreaterThanOrEqual(0);
  const to = source.indexOf(end, from + start.length);
  expect(to, `found after ${start}: ${end}`).toBeGreaterThan(from);
  return source.slice(from, to);
}

/** `'a' | 'b'` (or `'a'|'b'`): the quoted values. */
const quoted = (text: string) => [...text.matchAll(/'([^']+)'/g)].map((m) => m[1]);

/** A TS string-literal union, `export type Name = 'a' | 'b';`. */
function tsUnion(source: string, name: string): string[] {
  const match = source.match(new RegExp(`export type ${name} = ([^;]+);`));
  expect(match, `type ${name}`).toBeTruthy();
  return sorted(quoted(match![1]));
}

/** The property names of a TS interface body. */
function tsFields(block: string): string[] {
  return [...block.matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1]);
}

/** The wire names of a Swift `enum CodingKeys: String, CodingKey { … }` block. */
function swiftCodingKeys(block: string): string[] {
  const body = between(block, 'enum CodingKeys: String, CodingKey {', '}');
  const names: string[] = [];
  for (const line of body.split('\n')) {
    const cases = line.trim().match(/^case (.+)$/);
    if (!cases) continue;
    for (const item of cases[1].split(',')) {
      const [name, raw] = item.split('=').map((s) => s.trim());
      names.push(raw ? raw.replace(/^"|"$/g, '') : name);
    }
  }
  return sorted(names);
}

/** The raw values of a Swift `enum X: String … { case a, b, c` whose cases are their own names. */
function swiftCases(source: string, enumName: string): string[] {
  const match = source.match(new RegExp(`enum ${enumName}: String[^{]*\\{\\s*case ([^\\n]+)`));
  expect(match, `enum ${enumName}`).toBeTruthy();
  return sorted(match![1].split(',').map((s) => s.trim()));
}

/** The JSON names of a Kotlin class's constructor: `@SerialName`, or the property's own name. */
function kotlinFields(block: string): string[] {
  const names: string[] = [];
  for (const line of block.split('\n')) {
    const field = line.match(/^\s*(?:@SerialName\("([^"]+)"\)\s*)?(?:@Serializable\([^)]*\)\s*)?val (\w+)/);
    if (field) names.push(field[1] ?? field[2]);
  }
  return sorted(names);
}

/** The `@SerialName`s of a Kotlin enum's constants, by constant. */
function kotlinEnum(source: string, enumName: string): Map<string, string> {
  const body = between(source, `enum class ${enumName} {`, '}');
  return new Map([...body.matchAll(/@SerialName\("([^"]+)"\)\s*(\w+)/g)].map((m) => [m[2], m[1]]));
}

// ── The contract ──────────────────────────────────────────────────────

/** The API bullet's `{ id, channel: …, outcome: …, duration_seconds: …, caller_id }`. */
const docShape = between(SECTION, '`{ id,', '}`').slice(2).replace(/\([^)]*\)/g, '');
const DOC_KEYS = sorted(docShape.split(',').map((part) => part.trim().replace(/:[\s\S]*$/, '')).filter(Boolean));
const DOC_CHANNELS = sorted(quoted(between(docShape, 'channel:', 'outcome:')));
const DOC_OUTCOMES = sorted(quoted(between(docShape, 'outcome:', 'duration_seconds:')));

type Outcome = 'completed' | 'missed' | 'declined' | 'cancelled' | 'failed';
type Channel = 'audio' | 'video';
const CHANNELS: Channel[] = ['audio', 'video'];

/** The titles table: by outcome, the string each side sees, per channel. */
const TITLES = (() => {
  const table = between(SECTION, '| outcome | caller sees | callee sees |', '\n\n');
  const rows = [...table.matchAll(/^\s*\|\s*(\w+)\s*\|\s*([^|]+)\|\s*([^|]+)\|/gm)]
    .map(([, outcome, caller, callee]) => ({ outcome, caller: caller.trim(), callee: callee.trim() }))
    .filter((r) => r.outcome !== 'outcome');
  /** The string a cell names for [channel]: `teamCallLogMissedVoice`/`Video` names two. */
  function cell(text: string, other: string, channel: Channel): string {
    const source = text === 'the same' ? other : text;
    const pair = source.match(/`(teamCallLog\w*?)Voice`\/`Video`/);
    if (pair) return `${pair[1]}${channel === 'video' ? 'Video' : 'Voice'}`;
    const single = source.match(/`(teamCallLog\w+)`/);
    expect(single, `a string in "${source}"`).not.toBeNull();
    return single![1];
  }
  return rows.map((r) => ({
    outcome: r.outcome as Outcome,
    title: (channel: Channel, viewerIsCaller: boolean) =>
      viewerIsCaller ? cell(r.caller, r.callee, channel) : cell(r.callee, r.caller, channel),
  }));
})();

/** The strings table. */
const STRINGS = [
  ...between(SECTION, '| Name | fa | en | tr | ar |', '\n\n').matchAll(
    /^\s*\|\s*`(teamCallLog\w+)`\s*\|([^|]+)\|([^|]+)\|([^|]+)\|([^|]+)\|/gm,
  ),
].map(([, name, fa, en, tr, ar]) => ({ name, fa: fa.trim(), en: en.trim(), tr: tr.trim(), ar: ar.trim() }));

/** `teamCallLogMissedVoice` → the web's `teamCalls.log.missedVoice`. */
const webKey = (name: string) => {
  const bare = name.replace(/^teamCallLog/, '');
  return `teamCalls.log.${bare[0].toLowerCase()}${bare.slice(1)}`;
};
/** `teamCallLogMissedVoice` → Swift's `.missedVoice`. */
const swiftTitle = (name: string) => {
  const bare = name.replace(/^teamCallLog/, '');
  return `.${bare[0].toLowerCase()}${bare.slice(1)}`;
};
/** `teamCallLogMissedVoice` → Kotlin's `TeamCallLogTitle.MISSED_VOICE`. */
const kotlinTitle = (name: string) =>
  `TeamCallLogTitle.${name.replace(/^teamCallLog/, '').replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()}`;

// ── Fixtures ──────────────────────────────────────────────────────────

const WS = 'a3c1e0f2-5b6d-4e7f-8a9b-0c1d2e3f4a5b';
const CALLER = 'b4d2f1a3-6c7e-4f8a-9b0c-1d2e3f4a5b6c';
const CALLEE = 'c5e3a2b4-7d8f-4a9b-8c1d-2e3f4a5b6c7d';

/** A colleague call's row in [state], ended as [outcome]. */
function callRow(
  state: string,
  outcome: Outcome | null,
  channel: Channel = 'audio',
  id = '7d3f8c2e-1a4b-4c5d-9e6f-0a1b2c3d4e5f',
) {
  const connected = outcome === 'completed' || state === 'active';
  return {
    id,
    workspace_id: WS,
    provider: 'livekit',
    provider_room_id: `room-${id}`,
    call_type: channel,
    state,
    entry_source: 'team_call',
    initiated_by: CALLER,
    metadata: {
      team_call: {
        caller_user_id: CALLER,
        callee_user_id: CALLEE,
        channel,
        outcome,
        rung_android_device_ids: [],
        rung_ios_device_ids: [],
      },
    },
    created_at: '2026-11-02T10:00:00.000Z',
    connected_at: connected ? '2026-11-02T10:00:10.000Z' : null,
    ended_at: TEAM_CALL_LIVE_STATES.includes(state as never) ? null : '2026-11-02T10:04:15.000Z',
  };
}

/** How a call that is over ends, state by outcome (TEAM_CALLS.md). */
const ENDS: Array<{ state: string; outcome: Outcome }> = [
  { state: 'ended', outcome: 'completed' },
  { state: 'ended', outcome: 'declined' },
  { state: 'ended', outcome: 'failed' },
  { state: 'missed', outcome: 'missed' },
  { state: 'cancelled', outcome: 'cancelled' },
];

/** The server's `call` for a line, as a client receives it: through JSON. */
const wire = (row: ReturnType<typeof callRow>) =>
  JSON.parse(JSON.stringify(teamCallChatView(row as never))) as Record<string, unknown>;

beforeEach(() => {
  h.writes.length = 0;
  h.published.length = 0;
});

// ═══ The wire ═════════════════════════════════════════════════════════

describe('`call` on a team-chat line: one shape, server to every client', () => {
  it('the server writes exactly the contract\'s keys, and the web, iOS and Android read the same names', () => {
    expect(DOC_KEYS).toEqual(['caller_id', 'channel', 'duration_seconds', 'id', 'outcome']);
    const server = sorted(Object.keys(wire(callRow('ended', 'completed'))));
    expect(server).toEqual(DOC_KEYS);
    // The server's own interface, TeamCallChatView.
    expect(sorted(tsFields(between(SERVER_CHAT, 'export interface TeamCallChatView {', '\n}')))).toEqual(DOC_KEYS);
    // The web's TeamChatCall.
    expect(sorted(tsFields(between(WEB_API, 'export interface TeamChatCall {', '\n}')))).toEqual(DOC_KEYS);
    // iOS's TeamChatCall decoder.
    expect(swiftCodingKeys(between(IOS_MODEL, 'struct TeamChatCall', '\n}\n'))).toEqual(DOC_KEYS);
    // Android's wire shape, which TeamChatCall.of reads.
    expect(kotlinFields(between(ANDROID_MODEL, 'internal data class Wire(', '\n    )'))).toEqual(DOC_KEYS);
  });

  it('the channels and outcomes are the same five-and-two everywhere', () => {
    expect(DOC_CHANNELS).toEqual(['audio', 'video']);
    expect(DOC_OUTCOMES).toEqual(['cancelled', 'completed', 'declined', 'failed', 'missed']);
    // Server.
    expect(tsUnion(SERVER_TEAM_CALL, 'TeamCallChannel')).toEqual(DOC_CHANNELS);
    expect(tsUnion(SERVER_TEAM_CALL, 'TeamCallOutcome')).toEqual(DOC_OUTCOMES);
    // Web: the types, and the reader's own set.
    expect(tsUnion(WEB_API, 'TeamCallChannel')).toEqual(DOC_CHANNELS);
    expect(tsUnion(WEB_API, 'TeamCallOutcome')).toEqual(DOC_OUTCOMES);
    expect(sorted(quoted(between(WEB_LOG, 'const OUTCOMES', ';')))).toEqual(DOC_OUTCOMES);
    // iOS: by raw value, an unknown one being no call (not TeamCallOutcome's
    // own decoding, which reads an unknown outcome as `failed`).
    expect(swiftCases(IOS_CHANNEL, 'CallChannel')).toEqual(DOC_CHANNELS);
    expect(swiftCases(IOS_TEAM_CALL, 'TeamCallOutcome')).toEqual(DOC_OUTCOMES);
    const swiftDecoder = between(IOS_MODEL, 'struct TeamChatCall', '\n}\n');
    expect(swiftDecoder).toContain('CallChannel(rawValue: rawChannel)');
    expect(swiftDecoder).toContain('TeamCallOutcome(rawValue: rawOutcome)');
    // Android: the reader's own spellings, each mapped to the constant of that name.
    const androidOf = between(ANDROID_MODEL, 'fun of(wire: Wire)', '\n        }\n');
    expect(sorted(quoted(androidOf.replace(/"/g, "'")).filter((v) => DOC_CHANNELS.includes(v)))).toEqual(DOC_CHANNELS);
    const channels = kotlinEnum(ANDROID_CHANNEL, 'CallChannel');
    for (const [, spelling, constant] of androidOf.matchAll(/"(\w+)" -> CallChannel\.(\w+)/g)) {
      expect(channels.get(constant), spelling).toBe(spelling);
    }
    const outcomes = kotlinEnum(ANDROID_TEAM_CALL, 'TeamCallOutcome');
    const map = [...between(ANDROID_MODEL, 'private val OUTCOMES = mapOf(', ')\n').matchAll(/"(\w+)" to TeamCallOutcome\.(\w+)/g)];
    expect(sorted(map.map((m) => m[1]))).toEqual(DOC_OUTCOMES);
    for (const [, spelling, constant] of map) expect(outcomes.get(constant), spelling).toBe(spelling);
  });

  it('every call the server can write reads back unchanged through the web\'s reader', () => {
    for (const end of ENDS) {
      for (const channel of CHANNELS) {
        const view = wire(callRow(end.state, end.outcome, channel));
        expect(view.outcome).toBe(end.outcome);
        expect(view.channel).toBe(channel);
        expect(view.caller_id).toBe(CALLER);
        // A duration for a completed call only (ended_at − connected_at).
        expect(view.duration_seconds).toBe(end.outcome === 'completed' ? 245 : null);
        expect(teamChatCallOf(view)).toEqual(view);
      }
    }
    // One no client knows reads as no call (the line is then its body).
    expect(teamChatCallOf({ ...wire(callRow('ended', 'completed')), outcome: 'busy' })).toBeNull();
    expect(teamChatCallOf({ ...wire(callRow('ended', 'completed')), channel: 'screen' })).toBeNull();
  });

  it('a completed call\'s length is the same clock on the server (the body) and the web', () => {
    for (const seconds of [0, 5, 65, 245, 754, 3599, 3600, 3725, 36_000]) {
      expect(webDuration(seconds), String(seconds)).toBe(serverDuration(seconds));
    }
    // Android's and iOS's pins (run on their CI) are the server's clock too.
    const androidPins = [...ANDROID_TEST.matchAll(/assertEquals\("([^"]+)", teamCallLogDuration\((-?\d+), Language\.EN\)\)/g)];
    expect(androidPins.length).toBeGreaterThanOrEqual(6);
    for (const [, shown, seconds] of androidPins) expect(serverDuration(Number(seconds))).toBe(shown);
    const iosPins = [...IOS_XCTEST.matchAll(/TeamCallLog\.duration\((-?\d+), locale: en\), "([^"]+)"/g)];
    expect(iosPins.length).toBeGreaterThanOrEqual(6);
    for (const [, seconds, shown] of iosPins) expect(serverDuration(Number(seconds))).toBe(shown);
  });

  it('`call` is on each thread message and on each colleague\'s last message, in every client', () => {
    // Server: both reads, and the send's answer (null).
    expect(SERVER_ROUTE).toContain('call: calls.get(m.id) ?? null,');
    expect(SERVER_ROUTE).toContain('call: previewCalls.get(last.id) ?? null,');
    expect(SERVER_ROUTE).toContain('message: { ...inserted, attachment, call: null }');
    // Web.
    expect(between(WEB_HOOK, 'export interface TeamMessage {', '\n}')).toMatch(/\bcall\?: TeamChatCall \| null;/);
    expect(between(WEB_HOOK, 'export interface Colleague {', '\n}')).toMatch(/\bcall\?: TeamChatCall \| null;/);
    // iOS: both decode it, leniently.
    expect(swiftCodingKeys(between(IOS_MODEL, 'struct TeamMessage:', '\n}\n'))).toContain('call');
    expect(swiftCodingKeys(between(IOS_MODEL, 'struct LastTeamMessage:', '\n    }\n'))).toContain('call');
    expect(between(IOS_MODEL, 'extension TeamMessage {', '\n}\n')).toContain('call = TeamChatCall.lenient(c, forKey: .call)');
    expect(between(IOS_MODEL, 'extension Colleague.LastTeamMessage {', '\n}\n')).toContain('call = TeamChatCall.lenient(c, forKey: .call)');
    // Android: both, through the reader that never fails the message.
    const field = '@Serializable(TeamChatCallSerializer::class) val call: TeamChatCall? = null';
    expect(between(ANDROID_MODEL, 'data class TeamMessage(', '\n)')).toContain(field);
    expect(between(ANDROID_MODEL, 'data class LastTeamMessage(', '\n    )')).toContain(field);
  });

  it('`call_session_id` stays on the server: the thread drops it and no client reads it', () => {
    expect(SERVER_ROUTE).toContain('rows.map(({ call_session_id: _callSessionId, ...m }) => ({');
    // /colleagues names last_message's fields one by one.
    expect(between(SERVER_ROUTE, 'last_message: last', ': null,')).not.toContain('call_session_id');
    const clients = {
      WEB_API, WEB_HOOK, WEB_LOG, WEB_BUBBLE, WEB_PANEL,
      IOS_MODEL, IOS_LOG, IOS_THREAD, IOS_LIST,
      ANDROID_MODEL, ANDROID_LOG, ANDROID_THREAD, ANDROID_LIST,
    };
    for (const [name, source] of Object.entries(clients)) expect(source, name).not.toContain('call_session_id');
  });
});

// ═══ Who placed it ════════════════════════════════════════════════════

describe('a line is the caller\'s, so every client\'s "I placed it" agrees', () => {
  /** A database whose call_sessions read answers [rows]. */
  const callsDb = (rows: unknown[]) => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      in: () => chain,
      then: <T,>(resolve: (value: { data: unknown; error: null }) => T) => Promise.resolve({ data: rows, error: null }).then(resolve),
    };
    return { from: () => chain } as never;
  };

  it('the server shows `call` only on a line its caller sent to its callee, of a call that is over', async () => {
    const over = callRow('ended', 'completed', 'video', 'call-over');
    const live = callRow('active', null, 'video', 'call-live');
    const elsewhere = { ...callRow('missed', 'missed', 'audio', 'call-elsewhere'), workspace_id: 'another-workspace' };
    const views = await teamCallChatViews(callsDb([over, live, elsewhere]), WS, [
      { id: 'm-right', sender_id: CALLER, recipient_id: CALLEE, call_session_id: 'call-over' },
      { id: 'm-swapped', sender_id: CALLEE, recipient_id: CALLER, call_session_id: 'call-over' },
      { id: 'm-live', sender_id: CALLER, recipient_id: CALLEE, call_session_id: 'call-live' },
      { id: 'm-elsewhere', sender_id: CALLER, recipient_id: CALLEE, call_session_id: 'call-elsewhere' },
      { id: 'm-plain', sender_id: CALLER, recipient_id: CALLEE, call_session_id: null },
    ]);
    expect([...views.keys()]).toEqual(['m-right']);
    expect(views.get('m-right')?.caller_id).toBe(CALLER);
  });

  it('so the web (caller is me), iOS (caller is not the colleague) and Android (caller is me) tell it alike', () => {
    expect(WEB_PANEL).toContain('const callerIsMe = call ? call.caller_id === user?.id : false;');
    expect(between(IOS_LOG, 'static func viewerIsCaller', '\n    }\n')).toContain('call.callerID != peerID');
    expect(ANDROID_THREAD).toContain('viewerIsCaller = me != null && call.callerId == me,');
    // In the colleagues list too (the last line's own sender is its caller).
    expect(WEB_PANEL).toContain('viewerIsCaller={user?.id ? lastCall.caller_id === user.id : !!c.last_message?.outgoing}');
    expect(IOS_LIST).toContain('viewerIsCaller: TeamCallLog.viewerIsCaller(call, peerID: colleague.userId)');
    expect(ANDROID_LIST).toContain('viewerIsCaller = last?.outgoing == true,');
  });
});

// ═══ The server writes it ═════════════════════════════════════════════

describe('the line is written once, by the server, when the call is over', () => {
  it('migration 294 is the one file of its number, adds the column and the key re-runnably, and writes no data', () => {
    expect(readdirSync(MIGRATIONS).filter((f) => f.startsWith('294'))).toEqual(['294_team_call_chat_records.sql']);
    expect(SECTION).toContain('`294_team_call_chat_records.sql`');
    const sql = read(MIGRATION_294);
    const code = sql.replace(/--[^\n]*/g, '');
    expect(code).toMatch(/ALTER TABLE public\.team_messages\s+ADD COLUMN IF NOT EXISTS call_session_id uuid\s+REFERENCES public\.call_sessions\(id\) ON DELETE SET NULL;/);
    // The unique key, added only when it is not there yet.
    expect(code).toMatch(/IF NOT EXISTS \([\s\S]*conname = 'team_messages_call_session_id_key'[\s\S]*\) THEN\s+ALTER TABLE public\.team_messages\s+ADD CONSTRAINT team_messages_call_session_id_key UNIQUE \(call_session_id\);/);
    expect(code).toContain("SET lock_timeout = '5s';");
    // No data written, no transaction of its own (migrate-database.sh runs each file).
    expect(code).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM|TRUNCATE|DROP\s)/i);
    expect(code).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im);
    // The server's insert relies on that key.
    expect(SERVER_CHAT).toContain(".upsert(line, { onConflict: 'call_session_id', ignoreDuplicates: true })");
  });

  it('announceTeamCall writes nothing while the call is live', async () => {
    expect(sorted(TEAM_CALL_LIVE_STATES)).toEqual(['active', 'connecting', 'ringing']);
    for (const state of TEAM_CALL_LIVE_STATES) {
      await announceTeamCall({} as never, callRow(state, null) as never, { actorId: null });
    }
    expect(h.writes.filter((w) => w.table === 'team_messages')).toEqual([]);
    expect(h.published.filter((p) => p.payload.kind === 'team_message')).toEqual([]);
  });

  it('and one line per call that is over, from the caller to the callee, then the sent message\'s nudge', async () => {
    expect(sorted(new Set(ENDS.map((e) => e.state)))).toEqual(sorted(TEAM_CALL_TERMINAL_STATES));
    /** The nudge a sent message gives (POST /messages), its keys. */
    const sendNudge = between(SERVER_ROUTE, "kind: 'team_message',", '});');
    const nudgeKeys = sorted(['kind', ...[...sendNudge.matchAll(/^\s*(\w+)[,:]/gm)].map((m) => m[1])]);
    expect(nudgeKeys).toEqual(['kind', 'message_id', 'recipient_id', 'sender_id', 'workspace_id']);
    for (const end of ENDS) {
      for (const channel of CHANNELS) {
        h.writes.length = 0;
        h.published.length = 0;
        const row = callRow(end.state, end.outcome, channel);
        await announceTeamCall({} as never, row as never, { actorId: null, missedAlert: end.outcome === 'missed' });
        const lines = h.writes.filter((w) => w.table === 'team_messages') as Write[];
        expect(lines, `${end.outcome} ${channel}`).toHaveLength(1);
        const [line] = lines;
        expect(line.op).toBe('upsert');
        expect(line.options).toEqual({ onConflict: 'call_session_id', ignoreDuplicates: true });
        const mark = channel === 'video' ? '\u{1F4F9}' : '\u{1F4DE}';
        expect(line.row).toMatchObject({
          workspace_id: WS,
          sender_id: CALLER,
          recipient_id: CALLEE,
          created_at: row.created_at,
          attachment_id: null,
          reply_to_id: null,
          call_session_id: row.id,
          body: end.outcome === 'completed' ? `${mark} 4:05` : mark,
        });
        // Unread for the callee only when they missed it.
        const unread = end.outcome === 'missed' || end.outcome === 'cancelled';
        expect(line.row.read_at === null, `${end.outcome} read_at`).toBe(unread);
        const nudges = h.published.filter((p) => p.payload.kind === 'team_message');
        expect(nudges).toHaveLength(1);
        expect(sorted(nudges[0].users)).toEqual(sorted([CALLER, CALLEE]));
        expect(sorted(Object.keys(nudges[0].payload))).toEqual(nudgeKeys);
        expect(nudges[0].payload).toMatchObject({ workspace_id: WS, sender_id: CALLER, recipient_id: CALLEE });
      }
    }
  });
});

// ═══ How each client draws it ═════════════════════════════════════════

describe('the viewer rules agree on the web, the iPhone and Android', () => {
  it('the titles: the contract\'s table, by outcome, channel and side', () => {
    expect(sorted(TITLES.map((t) => t.outcome))).toEqual(DOC_OUTCOMES);
    for (const { outcome, title } of TITLES) {
      for (const channel of CHANNELS) {
        for (const viewerIsCaller of [true, false]) {
          const expected = title(channel, viewerIsCaller);
          const what = `${outcome} ${channel} ${viewerIsCaller ? 'caller' : 'callee'}`;
          // Web: the rule itself, run.
          expect(teamCallLogTitleKey({ channel, outcome }, viewerIsCaller), what).toBe(webKey(expected));
        }
        // iOS: the XCTest's table (it runs TeamCallLog.title on the Mac).
        expect(IOS_XCTEST, `iOS ${outcome} ${channel}`).toContain(
          `(.${outcome}, .${channel}, ${swiftTitle(title(channel, true))}, ${swiftTitle(title(channel, false))})`,
        );
        // Android: the Robolectric test's table (it runs logTitle on Gradle).
        expect(ANDROID_TEST, `Android ${outcome} ${channel}`).toContain(
          `Triple(TeamCallOutcome.${outcome.toUpperCase()}, ${channel}, ${kotlinTitle(title(channel, true))} to ${kotlinTitle(title(channel, false))})`,
        );
      }
    }
    // And each title is the shared string of its name.
    for (const name of new Set(TITLES.flatMap((t) => CHANNELS.flatMap((c) => [t.title(c, true), t.title(c, false)])))) {
      expect(IOS_LOG, name).toContain(`case ${swiftTitle(name)}: Str.${name}(language)`);
      expect(ANDROID_LOG, name).toContain(`${kotlinTitle(name).replace('TeamCallLogTitle.', '')} -> Str.${name}(l)`);
    }
  });

  it('the danger colour: missed, and cancelled for the callee', () => {
    expect(SECTION).toMatch(/Missed \(and cancelled, for the\s+callee\) is drawn in the danger colour/);
    for (const outcome of DOC_OUTCOMES as Outcome[]) {
      for (const viewerIsCaller of [true, false]) {
        const danger = outcome === 'missed' || (outcome === 'cancelled' && !viewerIsCaller);
        expect(teamCallLogIsMissed({ outcome }, viewerIsCaller), `${outcome} ${viewerIsCaller}`).toBe(danger);
      }
    }
    expect(between(IOS_LOG, 'static func isMissed', '\n    }\n')).toContain(
      'call.outcome == .missed || (call.outcome == .cancelled && !viewerIsCaller)',
    );
    expect(between(ANDROID_LOG, 'fun TeamChatCall.isMissedFor', '\n\n')).toContain(
      'outcome == TeamCallOutcome.MISSED || (outcome == TeamCallOutcome.CANCELLED && !viewerIsCaller)',
    );
    // In the thread and in the list, on all three.
    expect(WEB_BUBBLE.match(/teamCallLogIsMissed\(call, viewerIsCaller\)/g)).toHaveLength(2);
    expect(between(IOS_LOG, 'struct TeamCallLogBubble', '\n}\n')).toContain('Theme.Palette.danger');
    expect(between(IOS_LOG, 'struct TeamCallLogPreview', '\n}\n')).toContain('Theme.Palette.danger');
    expect(between(ANDROID_LOG, 'internal fun TeamCallLine(', '\n}\n')).toContain('MaterialTheme.colorScheme.error');
    expect(between(ANDROID_LOG, 'internal fun TeamCallPreview(', '\n}\n')).toContain('MaterialTheme.colorScheme.error');
  });

  it('the side: the caller\'s (the line\'s sender), ours on the right', () => {
    expect(WEB_PANEL).toContain("<div className={cn('flex', callerIsMe ? 'justify-end' : 'justify-start'");
    expect(IOS_THREAD).toContain('isOutgoing: message.senderId == (model.me ?? ""),');
    expect(between(IOS_THREAD, 'private func callLine(_ call: TeamChatCall)', '\n    }\n')).toContain('isOutgoing: isOutgoing,');
    expect(between(ANDROID_THREAD, 'TeamCallLine(', 'onCallBack =')).toContain('outgoing = row.outgoing,');
    expect(ANDROID_THREAD).toContain('val outgoing = me != null && message.senderId == me');
  });

  it('a call\'s line stands on its own run in both apps, so the message before it keeps its time', () => {
    expect(SECTION).toContain('the\n  apps end a run of bubbles at it');
    expect(between(IOS_THREAD, 'private static func endsRun', '\n    }\n')).toContain(
      'if messages[index].call != nil || messages[index + 1].call != nil { return true }',
    );
    const layout = between(ANDROID_THREAD, 'private fun layout(', '\n}\n');
    expect(layout).toContain('val standsAlone = message.call != null');
    expect(layout).toMatch(/endsRun = next == null \|\| standsAlone \|\| next\.call != null \|\|/);
    expect(layout).toMatch(/startsRun = previous == null \|\| standsAlone \|\| previous\.call != null \|\|/);
  });

  it('the arrow: out for the caller, in for the callee, mirrored right to left; the direction read out', () => {
    expect(WEB_BUBBLE).toContain('const Arrow = viewerIsCaller ? ArrowUpRight : ArrowDownLeft;');
    expect(WEB_BUBBLE).toContain("dir === 'rtl' && '-scale-x-100'");
    expect(between(IOS_LOG, 'static func arrowSymbol', '\n    }\n')).toContain('viewerIsCaller ? "arrow.up.right" : "arrow.down.left"');
    expect(between(IOS_LOG, 'struct TeamCallLogBubble', '\n}\n')).toContain('.flipsForRightToLeftLayoutDirection(true)');
    expect(ANDROID_LOG).toContain('if (viewerIsCaller) CallArrow.Out else CallArrow.In');
    expect(between(ANDROID_LOG, 'private object CallArrow', '\n}\n')).toContain('autoMirror = true');
    // The direction, in the label: Outgoing for the caller, Incoming for the callee.
    expect(WEB_BUBBLE).toContain("t(viewerIsCaller ? 'teamCalls.log.outgoing' : 'teamCalls.log.incoming')");
    expect(IOS_LOG).toContain('viewerIsCaller ? Str.teamCallLogOutgoing(language) : Str.teamCallLogIncoming(language)');
    expect(ANDROID_LOG).toContain('if (viewerIsCaller) Str.teamCallLogOutgoing(language) else Str.teamCallLogIncoming(language)');
    // The tap is named Call back.
    expect(WEB_BUBBLE).toContain("title={t('teamCalls.log.callBack')}");
    expect(IOS_LOG).toContain('.accessibilityAction(named: Text(Str.teamCallLogCallBack(language)))');
    expect(ANDROID_LOG).toContain('onClickLabel = Str.teamCallLogCallBack(language),');
  });

  it('a call\'s line is drawn instead of its body, and calls back with its own channel under the call buttons\' gate', () => {
    // The body (the older apps' 📞) is never drawn for a line with a call.
    expect(WEB_BUBBLE).not.toMatch(/\.body\b/);
    expect(between(IOS_LOG, 'struct TeamCallLogBubble', '\n}\n')).not.toContain('message.body');
    expect(between(ANDROID_LOG, 'internal fun TeamCallLine(', '\n}\n')).not.toMatch(/\.body\b/);
    expect(WEB_PANEL).toMatch(/\{call \? \(\s*<div[^>]*>\s*<TeamCallLogBubble/);
    expect(IOS_THREAD).toMatch(/if let call = message\.call \{\s*callLine\(call\)\s*\} else \{\s*messageLine\s*\}/);
    expect(ANDROID_THREAD).toMatch(/if \(call != null\) \{\s*TeamCallLine\(/);
    // Call back: the same channel, the plan's gate, never during a call.
    expect(WEB_PANEL).toContain('callBack={callKinds.includes(call.channel)');
    expect(WEB_PANEL).toContain('{ disabled: callBusy, onCallBack: () => placeTeamCall(call.channel) }');
    expect(IOS_THREAD).toContain('guard appState.teamCallAllowed(channel) else { return nil }');
    expect(IOS_THREAD).toContain('callBack: message.call.flatMap { callBack(for: $0.channel) }');
    expect(ANDROID_THREAD).toContain('onCallBack = if (call.channel in callBackChannels) {');
  });

  it('the colleagues list previews a call line by its icon and title, never its body', () => {
    expect(WEB_PANEL).toMatch(/\{lastCall \? \([\s\S]{0,120}<TeamCallLogPreview/);
    expect(IOS_LIST).toMatch(/if let call = colleague\.lastMessage\?\.call \{[\s\S]{0,200}TeamCallLogPreview\(/);
    expect(ANDROID_LIST).toMatch(/if \(lastCall != null\) \{[\s\S]{0,400}TeamCallPreview\(/);
  });
});

// ═══ The strings ══════════════════════════════════════════════════════

describe('the strings, word for word, on every surface', () => {
  type Locale = Record<string, unknown>;
  const lookup = (locale: Locale, key: string) =>
    key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], locale);

  it('the contract names eleven: the eight titles, Call back and the two directions', () => {
    expect(STRINGS.map((s) => s.name).sort()).toEqual([
      'teamCallLogCallBack',
      'teamCallLogCancelled',
      'teamCallLogDeclined',
      'teamCallLogFailed',
      'teamCallLogIncoming',
      'teamCallLogMissedVideo',
      'teamCallLogMissedVoice',
      'teamCallLogNoAnswer',
      'teamCallLogOutgoing',
      'teamCallLogVideo',
      'teamCallLogVoice',
    ]);
    // Every title the table names is one of them.
    for (const { title } of TITLES) {
      for (const channel of CHANNELS) {
        expect(STRINGS.map((s) => s.name)).toContain(title(channel, true));
        expect(STRINGS.map((s) => s.name)).toContain(title(channel, false));
      }
    }
  });

  it('Strings.swift: fa, en, tr and ar', () => {
    for (const s of STRINGS) {
      const fn = between(IOS_STRINGS, `static func ${s.name}(_ l: Language) -> String {`, '\n    }\n');
      for (const lang of ['fa', 'en', 'tr', 'ar'] as const) {
        expect(fn, `${s.name} ${lang}`).toContain(`case .${lang}: "${s[lang]}"`);
      }
    }
  });

  it('Android\'s generated Strings.kt: fa, en and tr', () => {
    for (const s of STRINGS) {
      const fn = between(ANDROID_STRINGS, `fun ${s.name}(l: Language): String = when (l) {`, '\n    }\n');
      expect(fn, `${s.name} en`).toContain(`Language.EN -> "${s.en}"`);
      expect(fn, `${s.name} fa`).toContain(`Language.FA -> "${s.fa}"`);
      expect(fn, `${s.name} tr`).toContain(`Language.TR -> "${s.tr}"`);
    }
  });

  it('the web\'s teamCalls.log.*: en, fa and tr, and nothing else under it', () => {
    for (const [lang, locale] of [['en', en], ['fa', fa], ['tr', tr]] as const) {
      for (const s of STRINGS) {
        expect(lookup(locale as Locale, webKey(s.name)), `${webKey(s.name)} ${lang}`).toBe(s[lang]);
      }
      const log = lookup(locale as Locale, 'teamCalls.log') as Record<string, string>;
      expect(sorted(Object.keys(log)), lang).toEqual(sorted(STRINGS.map((s) => webKey(s.name).replace('teamCalls.log.', ''))));
    }
  });
});
