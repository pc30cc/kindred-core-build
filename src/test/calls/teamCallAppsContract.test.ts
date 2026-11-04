// @vitest-environment node
/**
 * Colleague calls: the server and the two apps against one contract,
 * docs/operations/TEAM_CALLS.md, field by field.
 *
 * The server's side is exercised for real elsewhere (teamCallsRoute,
 * teamCallRing, teamCallMissedPush, teamCallWebhook). What no test there can
 * see is the other end of each wire: the Swift and the Kotlin that read it
 * are compiled on their own CI (a Mac, a Gradle box), and a field the server
 * writes under one name and an app reads under another is an error nowhere —
 * the app simply finds nothing there: a ring that never shows, a call screen
 * that never learns it was answered, a missed call that opens nothing. So
 * here the server's own output is put next to the doc, and the names each
 * app reads are lifted from its source and held to both:
 *
 *   - `TeamCall`, every /api/team-calls answer: keys, states, outcomes, roles
 *     (iOS `CodingKeys`, Android `@SerialName`s);
 *   - the routes and their bodies, as each app's API client calls them;
 *   - the error codes the apps turn into "busy", "not in your plan", …;
 *   - the LiveKit token's answer, which both apps read with the reader they
 *     use for a visitor call's;
 *   - Android's FCM ring and its stop (`team_call_incoming`,
 *     `team_call_cancel`), keys and reasons;
 *   - the missed-call alert (`team_call_missed`) and its Android tag;
 *   - the realtime nudge (`kind: 'team_call'`) on the member's own channel;
 *   - the plan's keys and where each lives in the effective entitlements;
 *   - the install id: the one each app answers with is the one it registers
 *     its push device with, which is how the server tells the callee's other
 *     phones "answered elsewhere" and leaves the answering one alone.
 *
 * The iOS VoIP ring has its own test, src/test/ios/teamCallVoipPayload.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => null }));
vi.mock('../../../server/services/calls/rtcResolver.js', () => ({
  getCallNetworkBundle: async () => ({
    rtc_url: 'https://rtc.example',
    ws_url: 'wss://rtc.example',
    turn: { urls: ['turn:turn.example:3478'], username: 'u', credential: 'c', static_secret_present: false },
    ice_policy: 'all',
  }),
}));
vi.mock('../../../server/services/calls/providerResolver.js', () => ({
  resolveCallProvider: () => ({
    createParticipantToken: async () => ({ token: 'lk-token', expiresAt: 1_900_000_000, identity: 'internal:0123456789abcdef' }),
  }),
}));
vi.mock('../../../server/services/calls/livekitConfig.js', () => ({
  loadLiveKitConfig: async () => ({}),
  providesOwnRelay: () => false,
}));
vi.mock('../../../server/services/calls/metrics.js', () => ({ emitCallMetric: () => {} }));

const { teamCallView, TEAM_CALL_LIVE_STATES, TEAM_CALL_TERMINAL_STATES } = await import('../../../server/services/calls/teamCall.js');
const { teamCallAndroidRingData, teamCallAndroidCancelData } = await import('../../../server/services/push/teamCallRing.js');
const { androidNotificationTag } = await import('../../../server/services/push/fcm.js');
const { issueParticipantToken } = await import('../../../server/services/calls/participantToken.js');
const { CAPABILITY_REGISTRY } = await import('../../../server/services/billing/capabilityRegistry.js');

const read = (path: string) => readFileSync(path, 'utf8');

const DOC = read('docs/operations/TEAM_CALLS.md');
const SERVER_TEAM_CALL = read('server/services/calls/teamCall.ts');
const SERVER_ROUTES = read('server/routes/teamCalls.ts');

const IOS_MODEL = read('ios/Webyar/Sources/Core/Models/TeamCall.swift');
const IOS_API = read('ios/Webyar/Sources/Core/Networking/APIClient.swift');
const IOS_CALL_TOKEN = read('ios/Webyar/Sources/Core/Models/ConversationDetail.swift');
const IOS_PUSH_TARGET = read('ios/Webyar/Sources/Core/Push/PushTarget.swift');
const IOS_PUSH_CONTROLLER = read('ios/Webyar/Sources/Core/Push/PushController.swift');
const IOS_CALL_MANAGER = read('ios/Webyar/Sources/Features/Calls/TeamCalls/CallManager.swift');

const KT = 'android/app/src/main/kotlin/com/platform/app';
const ANDROID_MODEL = read(`${KT}/core/model/TeamCall.kt`);
const ANDROID_API = read(`${KT}/core/net/ApiClient.kt`);
const ANDROID_CALL_TOKEN = read(`${KT}/core/model/ConversationDetail.kt`);
const ANDROID_REALTIME = read(`${KT}/core/model/Realtime.kt`);
const ANDROID_SYNC = read(`${KT}/core/sync/SyncCoordinator.kt`);
const ANDROID_RING = read(`${KT}/core/push/TeamCallRing.kt`);
const ANDROID_INCOMING = read(`${KT}/core/push/IncomingCall.kt`);
const ANDROID_PAYLOAD = read(`${KT}/core/push/PushPayload.kt`);
const ANDROID_NOTIFICATIONS = read(`${KT}/core/push/Notifications.kt`);
const ANDROID_REGISTRAR = read(`${KT}/core/push/PushRegistrar.kt`);
const ANDROID_TEAM_ROUTES = read(`${KT}/ui/nav/TeamCallRoutes.kt`);
const ANDROID_CALL_END = read(`${KT}/feature/call/TeamCallState.kt`);

const sorted = (values: Iterable<string>) => [...new Set(values)].sort();

/** The text of [source] from [start] (included) to the first [end] after it. */
function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  expect(from, `found: ${start}`).toBeGreaterThanOrEqual(0);
  const to = source.indexOf(end, from + start.length);
  expect(to, `found after ${start}: ${end}`).toBeGreaterThan(from);
  return source.slice(from, to);
}

/** A doc table row, by its first cell. */
function docRow(firstCell: string): string {
  const row = DOC.split('\n').find((line) => line.startsWith(`| ${firstCell} |`));
  expect(row, `the contract has a "${firstCell}" row`).toBeTruthy();
  return row!;
}

/**
 * The names in one of the doc's push shapes, `{type:"x", a, b}` or
 * `{kind:"x", a, b}`: every name, the spelled-out one included.
 */
function docShape(text: string, opening: string): string[] {
  const shape = between(text, opening, '}');
  return shape.slice(1).split(',').map((part) => part.trim().replace(/:.*$/, '')).filter(Boolean);
}

/** `a | b | c` (or `a|b|c`) between backticks or quotes, as a list. */
const alternatives = (text: string) => text.split('|').map((v) => v.trim()).filter(Boolean);

// ── Swift ─────────────────────────────────────────────────────────────

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
  return names;
}

/** The raw values of a Swift `enum X: String … { case a, b, c` whose cases are their own names. */
function swiftCases(source: string, enumName: string): string[] {
  const match = source.match(new RegExp(`enum ${enumName}: String[^{]*\\{\\s*case ([^\\n]+)`));
  expect(match, `enum ${enumName}`).toBeTruthy();
  return match![1].split(',').map((s) => s.trim());
}

// ── Kotlin ────────────────────────────────────────────────────────────

/** The JSON names of a Kotlin `@Serializable` class's constructor: `@SerialName`, or the property's own name. */
function kotlinFields(block: string): string[] {
  const names: string[] = [];
  for (const line of block.split('\n')) {
    const field = line.match(/^\s*(?:@SerialName\("([^"]+)"\)\s*)?(?:@Serializable\([^)]*\)\s*)?val (\w+)/);
    if (field) names.push(field[1] ?? field[2]);
  }
  return names;
}

/** The `@SerialName`s of a Kotlin enum's constants. */
function kotlinEnumNames(source: string, enumName: string): string[] {
  const body = between(source, `enum class ${enumName} {`, '}');
  return [...body.matchAll(/@SerialName\("([^"]+)"\)/g)].map((m) => m[1]);
}

/** `const val NAME = "value"` in a Kotlin file. */
function kotlinConstants(source: string): Map<string, string> {
  return new Map([...source.matchAll(/const val (\w+) = "([^"]*)"/g)].map((m) => [m[1], m[2]]));
}

const ANDROID_CONSTANTS: Record<string, Map<string, string>> = {
  PushPayload: kotlinConstants(ANDROID_PAYLOAD),
  IncomingCall: kotlinConstants(ANDROID_INCOMING),
  TeamCallRing: kotlinConstants(ANDROID_RING),
};

/**
 * The FCM data keys a Kotlin reader takes (`data[IncomingCall.KEY_CALL]`),
 * resolved to their strings. A bare `KEY_X` is [home]'s own.
 */
function androidDataKeys(reader: string, home: keyof typeof ANDROID_CONSTANTS): string[] {
  return [...reader.matchAll(/data\[(?:(\w+)\.)?(KEY_\w+)\]/g)].map((m) => {
    const owner = (m[1] ?? home) as keyof typeof ANDROID_CONSTANTS;
    const value = ANDROID_CONSTANTS[owner]?.get(m[2]);
    expect(value, `${owner}.${m[2]} is a string constant`).toBeDefined();
    return value!;
  });
}

// ── Fixtures ──────────────────────────────────────────────────────────

const CALL_ID = '7d3f8c2e-1a4b-4c5d-9e6f-0a1b2c3d4e5f';
const WS = 'a3c1e0f2-5b6d-4e7f-8a9b-0c1d2e3f4a5b';
const CALLER = 'b4d2f1a3-6c7e-4f8a-9b0c-1d2e3f4a5b6c';
const CALLEE = 'c5e3a2b4-7d8f-4a9b-8c1d-2e3f4a5b6c7d';

const serverCall = teamCallView(
  {
    id: CALL_ID,
    workspace_id: WS,
    provider: 'livekit',
    provider_room_id: `room-${CALL_ID}`,
    call_type: 'video',
    state: 'connecting',
    entry_source: 'team_call',
    initiated_by: CALLER,
    metadata: {
      team_call: {
        caller_user_id: CALLER,
        callee_user_id: CALLEE,
        channel: 'video',
        outcome: null,
        answered_device_id: 'android-install-1',
        answered_at: '2026-11-02T10:00:05.000Z',
        rung_android_device_ids: ['android-install-1'],
        rung_ios_device_ids: [],
      },
    },
    created_at: '2026-11-02T10:00:00.000Z',
    connected_at: '2026-11-02T10:00:05.000Z',
    ended_at: null,
  },
  CALLEE,
  { user_id: CALLER, name: 'Daniel Carter', avatar_url: null },
);

const ring = {
  callId: CALL_ID,
  workspaceId: WS,
  workspaceName: 'Acme',
  channel: 'video' as const,
  callerUserId: CALLER,
  callerName: 'Daniel Carter',
  callerAvatarUrl: 'https://cdn.example/daniel.jpg',
  expiresAt: Math.floor(Date.parse('2026-11-02T10:00:45.000Z') / 1000),
};

// ═══ TeamCall ════════════════════════════════════════════════════════

describe('TeamCall, the answer of every /api/team-calls route', () => {
  const docJson = between(DOC, '```json', '```');
  const docPeer = between(docJson, '"peer": {', '}');
  const docPeerKeys = [...docPeer.matchAll(/"([a-z_]+)":/g)].map((m) => m[1]).filter((k) => k !== 'peer');
  const docKeys = [...docJson.matchAll(/"([a-z_]+)":/g)].map((m) => m[1]).filter((k) => !docPeerKeys.includes(k));

  const iosCall = between(IOS_MODEL, 'struct TeamCall: Decodable', '    init(\n');
  const iosPeerKeys = swiftCodingKeys(between(iosCall, 'struct Peer: Decodable', '    }\n\n    enum CodingKeys'));
  const iosKeys = swiftCodingKeys(iosCall.slice(iosCall.indexOf('    }\n\n    enum CodingKeys')));

  const androidCall = between(ANDROID_MODEL, 'data class TeamCall(', '    @Serializable\n    data class Peer(');
  const androidPeerKeys = kotlinFields(between(ANDROID_MODEL, 'data class Peer(', '\n    )'));
  const androidKeys = kotlinFields(androidCall);

  // `rang_at` (owner, 2026-11-04) reaches the apps in their own changes, made
  // alongside the server's: an app model may still lack it, never carry
  // anything the server does not write. Once both apps read it, drop this.
  const ADDED_BEFORE_THE_APPS = ['rang_at'];
  const withAdded = (keys: string[]) => sorted([...keys, ...ADDED_BEFORE_THE_APPS]);

  it('has the same fields on the server, in the doc and in both apps', () => {
    const serverKeys = Object.keys(serverCall);
    expect(sorted(serverKeys)).toEqual(sorted(docKeys));
    expect(serverKeys).toEqual(expect.arrayContaining(ADDED_BEFORE_THE_APPS));
    expect(withAdded(iosKeys)).toEqual(sorted(serverKeys));
    expect(withAdded(androidKeys)).toEqual(sorted(serverKeys));
  });

  it('names the colleague with the same three fields everywhere', () => {
    const serverPeer = between(SERVER_TEAM_CALL, 'export interface TeamCallPeer {', '}');
    const serverPeerKeys = [...serverPeer.matchAll(/^\s+(\w+):/gm)].map((m) => m[1]);
    expect(sorted(Object.keys(serverCall.peer))).toEqual(sorted(serverPeerKeys));
    expect(sorted(serverPeerKeys)).toEqual(sorted(docPeerKeys));
    expect(sorted(iosPeerKeys)).toEqual(sorted(docPeerKeys));
    expect(sorted(androidPeerKeys)).toEqual(sorted(docPeerKeys));
  });

  it('knows the same states, outcomes and roles', () => {
    const docStates = alternatives(docJson.match(/"state": "([^"]+)"/)![1]);
    const docRoles = alternatives(docJson.match(/"role": "([^"]+)"/)![1]);
    const docOutcomes = alternatives(DOC.match(/`outcome` ∈ `([^`]+)`/)![1]);

    const serverStates = [...TEAM_CALL_LIVE_STATES, ...TEAM_CALL_TERMINAL_STATES];
    const serverOutcomes = [...between(SERVER_TEAM_CALL, 'const OUTCOMES', ']').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    const serverRoles = [...between(SERVER_TEAM_CALL, "role: 'caller' | 'callee'", ';').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);

    expect(sorted(serverStates)).toEqual(sorted(docStates));
    expect(sorted(swiftCases(IOS_MODEL, 'TeamCallState'))).toEqual(sorted(docStates));
    expect(sorted(kotlinEnumNames(ANDROID_MODEL, 'TeamCallState'))).toEqual(sorted(docStates));

    expect(sorted(serverOutcomes)).toEqual(sorted(docOutcomes));
    expect(sorted(swiftCases(IOS_MODEL, 'TeamCallOutcome'))).toEqual(sorted(docOutcomes));
    expect(sorted(kotlinEnumNames(ANDROID_MODEL, 'TeamCallOutcome'))).toEqual(sorted(docOutcomes));

    expect(sorted(serverRoles)).toEqual(sorted(docRoles));
    expect(sorted(swiftCases(IOS_MODEL, 'TeamCallRole'))).toEqual(sorted(docRoles));
    expect(sorted(kotlinEnumNames(ANDROID_MODEL, 'TeamCallRole'))).toEqual(sorted(docRoles));
  });

  it('writes its times as ISO 8601, which both apps parse as dates', () => {
    expect(serverCall.expires_at).toBe('2026-11-02T10:00:45.000Z');
    expect(serverCall.answered_at).toBe('2026-11-02T10:00:05.000Z');
    // iOS decodes every Date with DateParsing; Android with InstantSerializer.
    const iosDecoder = between(IOS_MODEL, 'init(from decoder: Decoder) throws {\n        let c', '\n    }\n');
    for (const key of ['createdAt', 'answeredAt', 'endedAt', 'expiresAt']) {
      expect(iosDecoder, `iOS ${key}`).toContain(`${key} = try c.decodeIfPresent(Date.self, forKey: .${key})`);
      expect(androidCall, `Android ${key}`).toMatch(new RegExp(`@Serializable\\(InstantSerializer::class\\) val ${key}: Instant\\?`));
    }
  });
});

// ═══ Routes ══════════════════════════════════════════════════════════

describe('the routes, as each app calls them', () => {
  const docRoutes = [...DOC.matchAll(/^\| `(GET|POST) (\/[^`]*)`/gm)]
    .map((m) => `${m[1]} /api/team-calls${m[2] === '/' ? '' : m[2]}`);
  const serverRoutes = [...SERVER_ROUTES.matchAll(/teamCallsRouter\.(get|post)\('([^']*)'/g)]
    .map((m) => `${m[1].toUpperCase()} /api/team-calls${m[2] === '/' ? '' : m[2]}`);
  const iosRoutes = [...IOS_API.matchAll(/makeRequest\(\s*"(GET|POST)",\s*"(\/api\/team-calls[^"]*)"/g)]
    .map((m) => `${m[1]} ${m[2].replace('\\(Self.escape(id))', ':id')}`);
  const androidRoutes = [...ANDROID_API.matchAll(/build\(\s*HttpMethod\.(Get|Post),\s*"(\/api\/team-calls[^"]*)"/g)]
    .map((m) => `${m[1].toUpperCase()} ${m[2].replace('${callId.urlPath()}', ':id')}`);

  it('are the doc\'s, on the server', () => {
    expect(sorted(serverRoutes)).toEqual(sorted(docRoutes));
  });

  it('are called only where the server listens, with the same method', () => {
    expect(iosRoutes.length).toBeGreaterThanOrEqual(6);
    expect(androidRoutes.length).toBeGreaterThanOrEqual(7);
    for (const route of [...iosRoutes, ...androidRoutes]) expect(serverRoutes, route).toContain(route);
  });

  it('carry the doc\'s bodies: {workspace_id, callee_id, channel} to ring, {device_id} to answer', () => {
    // The doc's own spelling of both, in the first cell of their rows.
    docRow('`POST /` `{workspace_id, callee_id, channel}`');
    docRow('`POST /:id/accept` `{device_id?}`');
    const serverCreate = [...between(SERVER_ROUTES, 'const createSchema = z.object({', '});').matchAll(/^\s+(\w+):/gm)].map((m) => m[1]);
    const serverAccept = [...between(SERVER_ROUTES, 'const acceptSchema = z.object({', '});').matchAll(/^\s+(\w+):/gm)].map((m) => m[1]);
    expect(sorted(serverCreate)).toEqual(['callee_id', 'channel', 'workspace_id']);
    expect(serverAccept).toEqual(['device_id']);

    const iosCreate = [...between(IOS_API, 'struct TeamCallBody: Encodable', '}').matchAll(/let (\w+):/g)].map((m) => m[1]);
    const iosAccept = [...between(IOS_API, 'struct TeamCallAcceptBody: Encodable', '}').matchAll(/let (\w+):/g)].map((m) => m[1]);
    const androidCreate = kotlinFields(between(ANDROID_API, 'private data class TeamCallBody(', ')\n'));
    const androidAccept = [...between(ANDROID_API, 'private data class TeamCallAcceptBody(', ')').matchAll(/val (\w+):/g)].map((m) => m[1]);
    expect(sorted(iosCreate)).toEqual(sorted(serverCreate));
    expect(sorted(androidCreate)).toEqual(sorted(serverCreate));
    expect(iosAccept).toEqual(serverAccept);
    expect(androidAccept).toEqual(serverAccept);
    // The channel goes as the server spells it.
    expect(IOS_API).toContain('channel: channel.rawValue');
    expect(ANDROID_API).toContain('channel = channel.wire');
  });

  it('refuse with the codes the apps explain, as the doc lists them', () => {
    const docCodes = new Set([...docRow('`POST /` `{workspace_id, callee_id, channel}`').matchAll(/`\d{3} ([a-z_]+)`/g)].map((m) => m[1]));
    const serverCodes = new Set([...SERVER_ROUTES.matchAll(/error: '([a-z_]+)'/g)].map((m) => m[1]));
    // `caller_busy` / `callee_busy` also come back from team_call_place's verdict.
    for (const code of docCodes) expect(serverCodes.has(code) || SERVER_ROUTES.includes(`'${code}'`), code).toBe(true);
    expect(serverCodes.has('not_ringing')).toBe(true);

    const iosRefusal = between(IOS_MODEL, 'static func refusal(status: Int, code: String?)', '\n    }\n');
    const androidRefusal = between(ANDROID_CALL_END, 'fun refusal(error: Throwable)', '\n        }\n');
    const iosCodes = [...iosRefusal.matchAll(/\(\d{3}, "([a-z_]+)"\?\)/g)].map((m) => m[1]);
    const androidCodes = [...androidRefusal.matchAll(/code == "([a-z_]+)"/g)].map((m) => m[1]);
    expect(sorted(iosCodes)).toEqual(['callee_busy', 'caller_busy', 'upgrade_required']);
    expect(sorted(androidCodes)).toEqual(sorted(iosCodes));
    for (const code of iosCodes) expect(docCodes.has(code), code).toBe(true);
    // 422 is `limit_reached`, whichever limit: both apps read the status.
    expect(docCodes.has('limit_reached')).toBe(true);
    expect(iosRefusal).toContain('case (422, _)');
    expect(androidRefusal).toContain('server.status == 422');
  });
});

// ═══ Token ═══════════════════════════════════════════════════════════

describe('POST /api/team-calls/:id/token', () => {
  it('answers in POST /api/calls/:id/token\'s shape, and both apps read only what it carries', async () => {
    expect(docRow('`POST /:id/token`')).toContain("same shape as `POST /api/calls/:id/token`'s answer");
    const answer = await issueParticipantToken({} as never, {
      id: CALL_ID,
      workspace_id: WS,
      provider: 'livekit',
      provider_room_id: `room-${CALL_ID}`,
    }, { participantType: 'internal', participantId: CALLEE, displayName: 'Sara' });
    expect(answer.status).toBe(200);
    const serverKeys = Object.keys(answer.body);
    const serverTurnKeys = Object.keys(answer.body.turn as Record<string, unknown>);

    const iosToken = between(IOS_CALL_TOKEN, 'struct CallToken: Codable', 'var signallingURL');
    const iosTurnKeys = [...between(iosToken, 'struct TurnConfig: Codable', '}').matchAll(/let (\w+):/g)].map((m) => m[1]);
    const androidToken = between(ANDROID_CALL_TOKEN, 'data class CallToken(', ') {');
    const androidTurnKeys = kotlinFields(between(ANDROID_CALL_TOKEN, 'data class TurnConfig(', ')'));

    for (const key of swiftCodingKeys(iosToken)) expect(serverKeys, `iOS reads ${key}`).toContain(key);
    for (const key of kotlinFields(androidToken)) expect(serverKeys, `Android reads ${key}`).toContain(key);
    for (const key of [...iosTurnKeys, ...androidTurnKeys]) expect(serverTurnKeys, `turn.${key}`).toContain(key);
    // Where each app dials: ws_url, else rtc_url.
    expect(answer.body.token).toBe('lk-token');
    expect(answer.body.ws_url).toBeTruthy();
  });
});

// ═══ Android's ring and its stop ════════════════════════════════════

describe('the FCM ring and its stop, on Android', () => {
  const row = docRow('Android');
  const ringReader = between(ANDROID_RING, 'fun from(data: Map<String, String>): TeamCallRing?', 'internal fun avatarUrl');
  const cancelReader = between(ANDROID_RING, 'fun from(data: Map<String, String>): TeamCallCancel?', 'return TeamCallCancel(');

  it('rings with the doc\'s keys, and the app reads every one of them', () => {
    const sent = Object.keys(teamCallAndroidRingData(ring));
    expect(sorted(sent)).toEqual(sorted(docShape(row, '{type:"team_call_incoming"')));
    expect(sorted(androidDataKeys(ringReader, 'TeamCallRing'))).toEqual(sorted(sent));
    expect(teamCallAndroidRingData(ring).type).toBe(ANDROID_CONSTANTS.TeamCallRing.get('TYPE_INCOMING'));
  });

  it('sends the expiry as whole Unix seconds in a string, which the app reads with toLongOrNull', () => {
    const { expiresAt } = teamCallAndroidRingData(ring);
    expect(expiresAt).toMatch(/^\d{10}$/);
    expect(ringReader).toContain('data[IncomingCall.KEY_EXPIRES]?.toLongOrNull()');
  });

  it('stops with the doc\'s keys and reasons, and the app knows every reason', () => {
    const sent = Object.keys(teamCallAndroidCancelData(CALL_ID, 'answered_elsewhere'));
    expect(sorted(sent)).toEqual(sorted(docShape(row, '{type:"team_call_cancel"')));
    expect(sorted(androidDataKeys(cancelReader, 'TeamCallRing'))).toEqual(sorted(sent));
    expect(teamCallAndroidCancelData(CALL_ID, 'missed').type).toBe(ANDROID_CONSTANTS.TeamCallRing.get('TYPE_CANCEL'));

    const docReasons = alternatives(row.match(/with reason `([^`]+)`/)![1]);
    const serverReasons = [...between(SERVER_TEAM_CALL, 'export type TeamCallCancelReason =', ';').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    const androidReasons = [...cancelReader.matchAll(/"([a-z_]+)" -> Reason\./g)].map((m) => m[1]);
    expect(sorted(serverReasons)).toEqual(sorted(docReasons));
    // `ended` is the app's `else`, which every reason it does not know reads as.
    expect(sorted([...androidReasons, 'ended'])).toEqual(sorted(docReasons));
  });
});

// ═══ Missed ══════════════════════════════════════════════════════════

describe('the missed-call notification', () => {
  const docKeys = docShape(docRow('Missed'), '{type:"team_call_missed"');

  it('opens the colleague\'s thread on Android, under the server\'s own tag', () => {
    expect(docKeys).toEqual(['type', 'workspaceId', 'peerId', 'callId', 'channel']);
    const payload = ANDROID_CONSTANTS.PushPayload;
    expect(payload.get('TYPE_TEAM_CALL_MISSED')).toBe('team_call_missed');
    for (const key of ['KEY_TYPE', 'KEY_WORKSPACE', 'KEY_PEER', 'KEY_CALL']) expect(docKeys, key).toContain(payload.get(key));
    expect(ANDROID_PAYLOAD).toContain('(isTeamMessage || isTeamCallMissed) && !workspaceId.isNullOrBlank() && !peerId.isNullOrBlank()');
    // One notification per call, whether Firebase drew it or the app did.
    expect(androidNotificationTag({ type: 'team_call_missed', callId: CALL_ID })).toBe(`team_call:${CALL_ID}`);
    expect(ANDROID_NOTIFICATIONS).toContain('private fun teamCallKey(callId: String) = "team_call:$callId"');
  });

  it('opens the colleague\'s thread on iOS', () => {
    const target = between(IOS_PUSH_TARGET, 'init?(userInfo info: [AnyHashable: Any])', '} else if type == "email_message"');
    expect(target).toContain('type == "team_message" || type == "team_call_missed"');
    expect(target).toContain('value("workspaceId")');
    expect(target).toContain('value("peerId")');
    for (const key of ['workspaceId', 'peerId']) expect(docKeys).toContain(key);
  });
});

// ═══ Realtime ════════════════════════════════════════════════════════

describe('the realtime nudge on the member\'s own channel', () => {
  const docKeys = docShape(docRow('Both apps in the foreground'), '{kind:"team_call"');

  it('carries the doc\'s keys (server: teamCallsRoute.test.ts), and both apps read its kind and call id', () => {
    expect(docKeys).toEqual(['kind', 'workspace_id', 'call_id', 'state', 'outcome', 'rang_at']);
    expect(docRow('Both apps in the foreground')).toContain('`ws:<workspace>:user:<uid>`');

    const iosSignal = between(IOS_MODEL, 'struct TeamCallSignal', 'enum TeamCallEnd');
    expect(iosSignal).toContain('static let kind = "team_call"');
    expect(iosSignal).toContain('payload?["kind"]?.stringValue == kind');
    expect(iosSignal).toContain('payload?["call_id"]?.stringValue');

    expect(ANDROID_REALTIME).toContain('@SerialName("call_id") val callId: String? = null');
    expect(ANDROID_REALTIME).toMatch(/val kind: String\?/);
    expect(ANDROID_SYNC).toContain('const val CALL_KIND = "team_call"');
  });
});

// ═══ Plan ════════════════════════════════════════════════════════════

describe('the plan\'s keys', () => {
  it('are the registry\'s, read from the section the effective entitlements put each in', () => {
    const type = (key: string) => CAPABILITY_REGISTRY.find((c) => c.key === key)?.type;
    // features[…], modules[…] and channels[…] of GET /api/plans/workspace/:id/effective.
    expect(type('team_calls')).toBe('feature');
    expect(type('voice_video')).toBe('module');
    expect(type('voice')).toBe('channel');
    expect(type('video')).toBe('channel');

    const ios = between(IOS_MODEL, 'func allowsTeamCall(_ channel: CallChannel) -> Bool {', '\n    }');
    expect(ios).toContain('featureEnabled("team_calls")');
    expect(ios).toContain('moduleEnabled("voice_video")');
    expect(ios).toContain('channelEnabled(channel == .video ? "video" : "voice")');

    const android = between(ANDROID_MODEL, 'fun Entitlements.allowsTeamCall(channel: CallChannel): Boolean =', '\n\n');
    expect(android).toContain('featureEnabled(TEAM_CALLS_FEATURE)');
    expect(ANDROID_MODEL).toContain('const val TEAM_CALLS_FEATURE = "team_calls"');
    expect(android).toContain('moduleEnabled("voice_video")');
    expect(android).toContain('channelEnabled(if (channel == CallChannel.VIDEO) "video" else "voice")');
  });
});

// ═══ The install that answered ══════════════════════════════════════

describe('the device id an app answers with', () => {
  it('is the one it registers its push device with, on iOS', () => {
    expect(IOS_CALL_MANAGER).toContain('private var deviceID: String { PushController.shared.deviceID }');
    expect(IOS_CALL_MANAGER).toContain('api.acceptTeamCall(id: callID, deviceID: deviceID)');
    const register = between(IOS_PUSH_CONTROLLER, 'try await api.registerPushDevice(', ')');
    expect(register).toContain('deviceID: deviceID');
  });

  it('is the one it registers its push device with, on Android', () => {
    expect(ANDROID_TEAM_ROUTES).toContain('deviceId = { graph?.push?.deviceId() }');
    const register = between(ANDROID_REGISTRAR, 'val registration = PushDeviceRegistration(', '\n        )');
    expect(register).toContain('deviceId = deviceId(),');
  });
});
