// @vitest-environment node
/**
 * The call in the chat on the iPhone (owner, 2026-11-02: "when a call is made
 * or ended, why isn't it recorded in the chat? or a missed call"):
 * docs/operations/TEAM_CALLS.md, "The call in the chat", as the app reads and
 * draws it.
 *
 * The server writes `call` on a team-chat line (server/services/calls/
 * teamCallChat.ts) and the app decodes it (`TeamChatCall`,
 * ios/Webyar/Sources/Core/Models/TeamChat.swift); the two are compiled by
 * different tools on different machines, and a key spelled differently on
 * one side is not an error anywhere — the line simply reads as its fallback
 * body (📞), on every iPhone. So the server's own `call` is put through JSON
 * here and every key is held against the Swift decoder's, and so are the
 * contract's table of titles and its strings.
 *
 * There is no Xcode here: what can be read from the sources is read; the
 * rules themselves run in ios/Webyar/Tests/Core/TeamCallLogTests.swift.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => null }));
vi.mock('../../../server/services/realtime/publish.js', () => ({ publishTeamEvent: async () => {} }));

const { teamCallChatView, formatTeamCallDuration } = await import('../../../server/services/calls/teamCallChat.js');

const MODELS = readFileSync('ios/Webyar/Sources/Core/Models/TeamChat.swift', 'utf8');
const LOG = readFileSync('ios/Webyar/Sources/Features/Colleagues/TeamCallLog.swift', 'utf8');
const THREAD = readFileSync('ios/Webyar/Sources/Features/Colleagues/TeamThreadView.swift', 'utf8');
const LIST = readFileSync('ios/Webyar/Sources/Features/Colleagues/ColleaguesView.swift', 'utf8');
const SAMPLE = readFileSync('ios/Webyar/Sources/Core/Networking/SampleAPI.swift', 'utf8');
const STRINGS = readFileSync('ios/Webyar/Sources/Localization/Strings.swift', 'utf8');
const KOTLIN = readFileSync('android/app/src/main/kotlin/com/platform/app/i18n/Strings.kt', 'utf8');
const XCTEST = readFileSync('ios/Webyar/Tests/Core/TeamCallLogTests.swift', 'utf8');
const DOC = readFileSync('docs/operations/TEAM_CALLS.md', 'utf8');

/** The contract's section. */
const SECTION = DOC.slice(DOC.indexOf('## The call in the chat'), DOC.indexOf('## Rollout'));

/** The text between `start` and the first `end` after it. */
function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  expect(from, `${start} not found`).toBeGreaterThanOrEqual(0);
  const to = source.indexOf(end, from + start.length);
  expect(to, `${end} not found after ${start}`).toBeGreaterThan(from);
  return source.slice(from, to);
}

/** `struct TeamChatCall`, its keys and its decoder. */
const chatCall = between(MODELS, 'struct TeamChatCall', '\n}\n');

/** The JSON keys a Swift `CodingKeys` enum names: `case a, b` and `case x = "y"`. */
function codingKeys(source: string): string[] {
  const block = between(source, 'enum CodingKeys: String, CodingKey {', '}');
  const keys: string[] = [];
  for (const line of block.split('\n')) {
    const mapped = line.match(/case\s+\w+\s*=\s*"([^"]+)"/);
    if (mapped) {
      keys.push(mapped[1]);
      continue;
    }
    const plain = line.match(/case\s+([\w,\s]+)$/);
    if (plain) keys.push(...plain[1].split(',').map((k) => k.trim()).filter(Boolean));
  }
  return keys.sort();
}

describe('the call on a team-chat line, server to iPhone', () => {
  const row = {
    id: '7d3f8c2e-1a4b-4c5d-9e6f-0a1b2c3d4e5f',
    workspace_id: 'w1',
    call_type: 'video',
    state: 'ended',
    initiated_by: 'u-caller',
    metadata: { team_call: { caller_user_id: 'u-caller', callee_user_id: 'u-callee', channel: 'video', outcome: 'completed' } },
    created_at: '2026-11-02T10:00:00.000Z',
    connected_at: '2026-11-02T10:00:10.000Z',
    ended_at: '2026-11-02T10:04:15.000Z',
  };
  // As the app receives it: through JSON.
  const view = JSON.parse(JSON.stringify(teamCallChatView(row as never))) as Record<string, unknown>;

  it('the server writes exactly the keys the app decodes, and the contract names', () => {
    expect(Object.keys(view).sort()).toEqual(codingKeys(chatCall));
    expect(codingKeys(chatCall)).toEqual(['caller_id', 'channel', 'duration_seconds', 'id', 'outcome']);
    for (const key of codingKeys(chatCall)) expect(SECTION).toContain(key);
  });

  it('in the JSON types the app reads them as', () => {
    expect(view).toEqual({
      id: row.id,
      channel: 'video',
      outcome: 'completed',
      duration_seconds: 245,
      caller_id: 'u-caller',
    });
    // `duration_seconds` is read as a number (a string is a length nobody
    // knows), the rest as strings.
    expect(chatCall).toMatch(/decodeIfPresent\(Double\.self, forKey: \.durationSeconds\)/);
    for (const key of ['id', 'callerID', 'channel', 'outcome']) {
      expect(chatCall).toMatch(new RegExp(`decode\\(String\\.self, forKey: \\.${key}\\)`));
    }
  });

  it('every channel and outcome the server can write is one the app knows', () => {
    for (const channel of ['audio', 'video']) expect(SECTION).toContain(`'${channel}'`);
    // The raw values the app maps them with: CallChannel and TeamCallOutcome.
    expect(chatCall).toContain('CallChannel(rawValue: rawChannel)');
    expect(chatCall).toContain('TeamCallOutcome(rawValue: rawOutcome)');
    const outcomes = readFileSync('ios/Webyar/Sources/Core/Models/TeamCall.swift', 'utf8')
      .match(/enum TeamCallOutcome: String[^{]*\{\s*case ([^\n]+)/)?.[1]
      .split(',').map((s) => s.trim()).sort();
    expect(outcomes).toEqual(['cancelled', 'completed', 'declined', 'failed', 'missed']);
  });

  it('`call` sits on the thread\'s messages and on the list\'s last message, read leniently', () => {
    const message = between(MODELS, 'struct TeamMessage:', '\n}\n');
    const last = between(MODELS, 'struct LastTeamMessage:', '\n    }\n');
    expect(codingKeys(message)).toContain('call');
    expect(codingKeys(last)).toContain('call');
    // One unreadable call never fails its thread: both decode it through
    // `lenient`, which swallows the error.
    const lenient = between(MODELS, 'static func lenient', '\n    }\n');
    expect(lenient).toContain('try? container.decodeIfPresent(TeamChatCall.self');
    expect(between(MODELS, 'extension TeamMessage {', '\n}\n')).toContain('call = TeamChatCall.lenient(c, forKey: .call)');
    expect(between(MODELS, 'extension Colleague.LastTeamMessage {', '\n}\n')).toContain(
      'call = TeamChatCall.lenient(c, forKey: .call)',
    );
  });
});

describe('the line as the iPhone draws it', () => {
  /** `teamCallLogNoAnswer` → `.noAnswer`, the Swift `Title` the string names. */
  function titleCase(name: string): string {
    const bare = name.replace(/^teamCallLog/, '');
    return `.${bare[0].toLowerCase()}${bare.slice(1)}`;
  }

  it('the titles follow the contract\'s table, on both sides, for both channels', () => {
    const table = between(SECTION, '| outcome | caller sees | callee sees |', '\n\n');
    const rows = [...table.matchAll(/^\s*\|\s*(\w+)\s*\|\s*([^|]+)\|\s*([^|]+)\|/gm)]
      .map(([, outcome, caller, callee]) => ({ outcome, caller: caller.trim(), callee: callee.trim() }))
      .filter((r) => r.outcome !== 'outcome');
    expect(rows.map((r) => r.outcome).sort()).toEqual(['cancelled', 'completed', 'declined', 'failed', 'missed']);

    /** The titles a cell names, by channel: `teamCallLogMissedVoice`/`Video` names two. */
    function cell(text: string, other: string): { audio: string; video: string } {
      const source = text === 'the same' ? other : text;
      const pair = source.match(/`(teamCallLog\w*?)Voice`\/`Video`/);
      if (pair) return { audio: titleCase(`${pair[1]}Voice`), video: titleCase(`${pair[1]}Video`) };
      const single = source.match(/`(teamCallLog\w+)`/);
      expect(single, `no string in "${source}"`).not.toBeNull();
      return { audio: titleCase(single![1]), video: titleCase(single![1]) };
    }

    for (const r of rows) {
      const caller = cell(r.caller, r.callee);
      const callee = cell(r.callee, r.caller);
      for (const channel of ['audio', 'video'] as const) {
        // The XCTest's own table runs `TeamCallLog.title` on the Mac.
        expect(XCTEST, `${r.outcome} ${channel}`).toContain(
          `(.${r.outcome}, .${channel}, ${caller[channel]}, ${callee[channel]})`,
        );
      }
    }
  });

  it('missed (and cancelled for the callee) in the danger colour', () => {
    expect(SECTION).toMatch(/Missed \(and cancelled, for the\s+callee\) is drawn in the danger colour/);
    const rule = between(LOG, 'static func isMissed', '\n    }\n');
    expect(rule).toContain('call.outcome == .missed || (call.outcome == .cancelled && !viewerIsCaller)');
    expect(between(LOG, 'struct TeamCallLogBubble', '\n}\n')).toContain('Theme.Palette.danger');
    expect(between(LOG, 'struct TeamCallLogPreview', '\n}\n')).toContain('Theme.Palette.danger');
  });

  it('the phone or the video camera, and an arrow out or in, mirrored in a right-to-left language', () => {
    expect(between(LOG, 'static func channelSymbol', '\n    }\n')).toContain('channel == .video ? "video.fill" : "phone.fill"');
    expect(between(LOG, 'static func arrowSymbol', '\n    }\n')).toContain(
      'viewerIsCaller ? "arrow.up.right" : "arrow.down.left"',
    );
    const bubble = between(LOG, 'struct TeamCallLogBubble', '\n}\n');
    expect(bubble).toMatch(/arrowSymbol\(viewerIsCaller: viewerIsCaller\)\)[\s\S]{0,300}\.flipsForRightToLeftLayoutDirection\(true\)/);
    // The words in the reader's direction, the side physical.
    expect(bubble).toContain('.environment(\\.layoutDirection, language.layoutDirection)');
    expect(bubble).toContain('.chatBubble(fill, hasBeak: true, pointsRight: isOutgoing)');
    // Dynamic Type: text styles and a scaled icon disc, no fixed font size.
    expect(bubble).toContain('@ScaledMetric(relativeTo: .body)');
    expect(bubble).not.toMatch(/\.system\(size:|\.app\(size:/);
  });

  it('a completed call shows its length as the server\'s body writes it', () => {
    // Every length the XCTest pins in English digits is the server's own
    // `formatTeamCallDuration` (the body the older apps read) for that value.
    const pins = [...XCTEST.matchAll(/TeamCallLog\.duration\((-?\d+), locale: en\), "([^"]+)"/g)];
    expect(pins.length).toBeGreaterThanOrEqual(8);
    for (const [, seconds, shown] of pins) expect(formatTeamCallDuration(Number(seconds))).toBe(shown);
    expect(between(LOG, 'static func duration(of call', '\n    }\n')).toContain('call.outcome == .completed');
  });

  it('the screen reader hears the title, the direction and the time, and can call back', () => {
    expect(SECTION).toContain('accessibility label is\n  the title, the direction and the time');
    const label = between(LOG, 'static func accessibilityLabel', '\n    }\n');
    expect(label).toContain('Str.teamCallLogOutgoing(language)');
    expect(label).toContain('Str.teamCallLogIncoming(language)');
    expect(label).toContain('parts.joined(separator: language.listSeparator)');
    const bubble = between(LOG, 'struct TeamCallLogBubble', '\n}\n');
    expect(bubble).toContain('.accessibilityAction(named: Text(Str.teamCallLogCallBack(language)))');
    expect(bubble).toContain('.accessibilityIdentifier(A11y.teamCallLog(call.id))');
  });

  it('the line cannot be selected, copied, quoted or replied to, and its body is never drawn', () => {
    const bubble = between(LOG, 'struct TeamCallLogBubble', '\n}\n');
    for (const forbidden of ['textSelection', 'contextMenu', 'message.body', 'swipeActions', 'onLongPressGesture']) {
      expect(bubble).not.toContain(forbidden);
    }
    const row = between(THREAD, 'private func callLine(_ call: TeamChatCall)', '\n    }\n');
    expect(row).toContain('TeamCallLogBubble(');
    for (const forbidden of ['textSelection', 'contextMenu', 'message.body', 'AttachmentView']) {
      expect(row).not.toContain(forbidden);
    }
    // A call's line is drawn instead of the message, never beside it.
    expect(THREAD).toMatch(/if let call = message\.call \{\s*callLine\(call\)\s*\} else \{\s*messageLine\s*\}/);
  });

  it('a tap calls back through the thread\'s own entry, under its gate, never during a call', () => {
    const gate = between(THREAD, 'private func callBack(for channel: CallChannel)', '\n    }\n');
    expect(gate).toContain('guard appState.teamCallAllowed(channel) else { return nil }');
    expect(gate).toContain('isDisabled: calls.call.map { !$0.phase.isOver } ?? false');
    expect(gate).toContain('await call(channel)');
    // The same entry the toolbar's buttons use: it asks for the microphone
    // and places the call through CallManager.
    const entry = between(THREAD, 'private func call(_ channel: CallChannel) async', '\n    }\n');
    expect(entry).toContain('calls.place(to: colleague, channel: channel, workspaceID: workspaceID)');
    expect(THREAD).toContain('callBack: message.call.flatMap { callBack(for: $0.channel) }');
    const bubble = between(LOG, 'struct TeamCallLogBubble', '\n}\n');
    expect(bubble).toContain('.disabled(callBack.isDisabled)');
  });

  it('the colleagues list previews a call by its icon and title, not its body', () => {
    expect(LIST).toMatch(/if let call = colleague\.lastMessage\?\.call \{\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*TeamCallLogPreview\(/);
    const preview = between(LOG, 'struct TeamCallLogPreview', '\n}\n');
    expect(preview).toContain('TeamCallLog.channelSymbol(call.channel)');
    expect(preview).toContain('TeamCallLog.headline(call, viewerIsCaller: viewerIsCaller, language: language)');
    expect(preview).not.toMatch(/\.body\b/);
  });

  it('the sample thread lays out a missed, a declined and a completed call', () => {
    const thread = between(SAMPLE, 'func teamThread(workspaceID: String, peerID: String)', '\n    }\n');
    expect(thread).toContain('(channel: .video, outcome: .missed, seconds: nil)');
    expect(thread).toContain('(channel: .audio, outcome: .declined, seconds: nil)');
    expect(thread).toContain('(channel: .audio, outcome: .completed, seconds: 245)');
    // Colleague calls are in the sample plan, so its lines call back.
    expect(SAMPLE).toContain('"team_calls": on,');
  });
});

describe('the strings', () => {
  const rows = [
    ...between(SECTION, '| Name | fa | en | tr | ar |', '\n\n').matchAll(
      /^\s*\|\s*`(teamCallLog\w+)`\s*\|([^|]+)\|([^|]+)\|([^|]+)\|([^|]+)\|/gm,
    ),
  ].map(([, name, fa, en, tr, ar]) => ({ name, fa: fa.trim(), en: en.trim(), tr: tr.trim(), ar: ar.trim() }));

  it('the contract names them all', () => {
    expect(rows).toHaveLength(11);
    expect(rows.map((r) => r.name)).toEqual(
      expect.arrayContaining([
        'teamCallLogVoice',
        'teamCallLogVideo',
        'teamCallLogMissedVoice',
        'teamCallLogMissedVideo',
        'teamCallLogNoAnswer',
        'teamCallLogDeclined',
        'teamCallLogCancelled',
        'teamCallLogFailed',
        'teamCallLogCallBack',
        'teamCallLogOutgoing',
        'teamCallLogIncoming',
      ]),
    );
  });

  it('Strings.swift says each in all four languages, word for word', () => {
    for (const r of rows) {
      const fn = between(STRINGS, `static func ${r.name}(_ l: Language) -> String {`, '\n    }\n');
      for (const lang of ['fa', 'en', 'tr', 'ar'] as const) {
        expect(fn, `${r.name} ${lang}`).toContain(`case .${lang}: "${r[lang]}"`);
      }
    }
  });

  it('Android\'s generated Strings.kt carries them', () => {
    for (const r of rows) expect(KOTLIN).toContain(`fun ${r.name}(l: Language): String`);
  });
});
