// @vitest-environment node
/**
 * The VoIP push that rings an iPhone for a colleague call, as the server
 * writes it (`teamCallVoipPayload`, server/services/push/teamCallRing.ts) and
 * as the app reads it (`TeamCallRing`, ios/Webyar/Sources/Core/Models/TeamCall.swift),
 * against the contract's list of its fields (docs/operations/TEAM_CALLS.md,
 * "Ring and its stop").
 *
 * The two sides are compiled by different tools on different machines, and
 * PushKit hands the app the APNs payload's JSON parsed: a string as `String`,
 * a number as `NSNumber`, a null as `NSNull`. A field the server writes in
 * one JSON type and the app reads as another is not an error anywhere — the
 * ring is simply not a ring, CallKit flashes a call and ends it, and no
 * colleague call ever rings an iPhone. That happened once: `expires_at` is a
 * number (Unix seconds) and the app read it as a string. So the server's own
 * payload is put through JSON here, and every field's type is held against
 * the reader the Swift parser uses for it.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => null }));
vi.mock('../../../server/services/push/apnsVoip.js', () => ({
  isVoipConfigured: () => false,
  sendVoipPush: async () => ({ ok: false }),
}));
vi.mock('../../../server/services/push/fcm.js', () => ({
  isPushConfigured: () => false,
  sendFcmData: async () => ({ ok: false }),
}));

const { teamCallVoipPayload } = await import('../../../server/services/push/teamCallRing.js');

const SWIFT = readFileSync('ios/Webyar/Sources/Core/Models/TeamCall.swift', 'utf8');
const XCTEST = readFileSync('ios/Webyar/Tests/Core/TeamCallTests.swift', 'utf8');
const DOC = readFileSync('docs/operations/TEAM_CALLS.md', 'utf8');

/** `TeamCallRing.init?(payload:)`, where every field is read. */
const ringInit = SWIFT.slice(
  SWIFT.indexOf('init?(payload: [AnyHashable: Any])'),
  SWIFT.indexOf('static func instant('),
);
/** `TeamCallRing.instant(_:)`, how `expires_at` is read. */
const instant = SWIFT.slice(SWIFT.indexOf('static func instant('), SWIFT.indexOf('private static func epoch('));

/**
 * How the app reads a field: `text("key")` takes a `String` (anything else,
 * `NSNull` included, is nil), `Self.instant(payload["key"])` a number, a
 * numeric string or an ISO 8601 date.
 */
function swiftReader(key: string): 'text' | 'instant' | null {
  if (ringInit.includes(`text("${key}")`)) return 'text';
  if (ringInit.includes(`Self.instant(payload["${key}"])`)) return 'instant';
  return null;
}

/** The fields the app's parser reads, by either reader. */
const swiftKeys = new Set([
  ...[...ringInit.matchAll(/text\("([a-z_]+)"\)/g)].map((m) => m[1]),
  ...[...ringInit.matchAll(/payload\["([a-z_]+)"\]/g)].map((m) => m[1]),
]);

/** The fields of the iOS ring as the contract lists them. */
function docKeys(): Set<string> {
  const row = DOC.split('\n').find((line) => line.startsWith('| iOS |'));
  expect(row, 'the contract has an iOS row under "Ring and its stop"').toBeTruthy();
  const json = row!.slice(row!.indexOf('{"kind":"team_call"'), row!.indexOf('}', row!.indexOf('{"kind":"team_call"')) + 1);
  // The names, not the two values the row spells out (`"kind":"team_call"`).
  return new Set([...json.matchAll(/(?<=[{,])"([a-z_]+)"/g)].map((m) => m[1]));
}

/** What the server sends, after the trip PushKit's parser makes of it. */
function onTheWire(input: Parameters<typeof teamCallVoipPayload>[0]): Record<string, unknown> {
  return JSON.parse(JSON.stringify(teamCallVoipPayload(input))) as Record<string, unknown>;
}

// As server/routes/teamCalls.ts builds it: Unix seconds, a ring from now.
const now = Math.floor(Date.now() / 1000);
const full = {
  callId: '7d3f8c2e-1a4b-4c5d-9e6f-0a1b2c3d4e5f',
  workspaceId: 'a3c1e0f2-5b6d-4e7f-8a9b-0c1d2e3f4a5b',
  workspaceName: 'Acme',
  channel: 'video' as const,
  callerUserId: 'b4d2f1a3-6c7e-4f8a-9b0c-1d2e3f4a5b6c',
  callerName: 'Sara Ahmadi',
  callerAvatarUrl: 'https://cdn.example/sara.jpg',
  expiresAt: now + 45,
};
// A workspace without a name and a caller with neither name nor photo.
const sparse = { ...full, workspaceName: null, callerName: '', callerAvatarUrl: null };

describe('the colleague ring PushKit delivers', () => {
  it('has the same fields on the server, in the app and in the contract', () => {
    const sent = new Set(Object.keys(onTheWire(full)));
    expect([...sent].sort()).toEqual([...docKeys()].sort());
    expect([...swiftKeys].sort()).toEqual([...sent].sort());
  });

  it('carries every field in the JSON type the app reads it as', () => {
    for (const input of [full, sparse]) {
      for (const [key, value] of Object.entries(onTheWire(input))) {
        const reader = swiftReader(key);
        expect(reader, `${key} is read by TeamCallRing`).not.toBeNull();
        if (value === null) {
          // Read with `text`, a null is an absent optional field (`NSNull`
          // is not a `String`); read with `instant`, it would be no ring.
          expect(reader, `${key} may be null, so the app must read it as optional text`).toBe('text');
        } else if (reader === 'text') {
          expect(typeof value, `${key} is read as a String`).toBe('string');
        } else {
          expect(['number', 'string'], `${key} is read as a time`).toContain(typeof value);
        }
      }
    }
  });

  it('never sends null for a field without which the app has no ring', () => {
    // `guard`ed in the parser: without any of these it ends the ring at once.
    const required = ['kind', 'event', 'call_id', 'workspace_id', 'expires_at'];
    const guarded = ringInit.slice(ringInit.indexOf('guard text("kind")'));
    for (const key of required) expect(guarded.slice(0, guarded.indexOf('else { return nil }')), key).toContain(`"${key}"`);
    const wire = onTheWire(sparse);
    for (const key of required) expect(wire[key], key).not.toBeNull();
    expect(wire.kind).toBe('team_call');
    expect(wire.event).toBe('incoming');
  });

  it('sends the expiry as whole Unix seconds, which the app reads from an NSNumber', () => {
    const { expires_at: expiresAt } = onTheWire(full);
    expect(typeof expiresAt).toBe('number');
    expect(Number.isInteger(expiresAt)).toBe(true);
    // Seconds, not milliseconds: below the 1e12 where `epoch` switches.
    expect(expiresAt as number).toBeLessThan(1e12);
    expect(expiresAt).toBe(full.expiresAt);
    expect(swiftReader('expires_at')).toBe('instant');
    expect(instant).toContain('as? NSNumber');
    expect(SWIFT).toMatch(/value >= 1e12 \? value \/ 1000 : value/);
  });

  it('is read by the XCTest in the server\'s own shape, not an easier one', () => {
    // The XCTest runs on CI's Mac only; it must parse the payload as PushKit
    // gives it — `expires_at` a bare number, the absent fields null.
    expect(XCTEST).toMatch(/"expires_at": 1762000045\}/);
    expect(XCTEST).toMatch(/"workspace_name": null/);
    expect(XCTEST).toMatch(/"caller_avatar_url": null/);
    expect(XCTEST).toContain('JSONSerialization.jsonObject(with:');
  });
});
