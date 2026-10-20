/**
 * A workspace member's identity in a LiveKit room, and the way back to the
 * user (owner request, 2026-10-19: the visitor's browser must not learn the
 * operator's user id from the room).
 *
 * Every participant of a room sees every other one's identity, name and
 * metadata, and the visitor is in every call room. Members (operator, admin,
 * internal) used to join as `operator:<user uuid>` under the name `<uuid>`;
 * they now join as `operator:<ref>`, where <ref> is the opaque reference the
 * call widget's status endpoint already sends as `call.assigned_agent_id`
 * (S9: HMAC-SHA256 under the widget-session secret over
 * `ccw-agent-ref:<call>:<user>`, 16 hex), under their public name (the profile's
 * own name, or nothing). The server resolves <ref> back to the user wherever it
 * needs the user (the webhook's participant rows, the in-call lock, the room's
 * end), and calls that began before the deploy still carry `operator:<uuid>`,
 * which every parser keeps accepting.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { db, fakeClient } from '../callWidget/fakeDb';

process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const h = vi.hoisted(() => ({
  inCall: [] as Array<{ op: 'mark' | 'clear'; workspaceId: string; userId: string; callId?: string }>,
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => fakeClient }));
vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeClient }));
vi.mock('../../../server/services/calls/availability.js', () => ({
  markInCall: async (_c: unknown, workspaceId: string, userId: string, callId: string) => { h.inCall.push({ op: 'mark', workspaceId, userId, callId }); },
  clearInCall: async (_c: unknown, workspaceId: string, userId: string) => { h.inCall.push({ op: 'clear', workspaceId, userId }); },
}));
vi.mock('../../../server/services/calls/livekitConfig.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/calls/livekitConfig.js')>()),
  loadLiveKitConfig: async () => ({ enabled: true, api_key: 'lk-key', api_secret: 'lk-secret', rtc_url: 'https://lk.example' }),
}));

const WS = '22222222-2222-4222-8222-222222222222';
const CALL = 'c0000000-0000-4000-8000-00000000000a';
const OTHER_CALL = 'c0000000-0000-4000-8000-00000000000b';
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const C = '00000000-0000-4000-8000-00000000000c';
const OUTSIDER = '00000000-0000-4000-8000-0000000000ff';
const CONFIG = { supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'a', supabaseServiceRoleKey: 'SERVICE_KEY' };

const ids = await import('../../../server/services/calls/operatorIdentity.js');
const { livekitProvider } = await import('../../../server/services/calls/providers/livekitProvider.js');
const { applyEvent } = await import('../../../server/routes/livekitWebhook.js');

/** S9's formula, written out: what the status endpoint sends as `call.assigned_agent_id`. */
const statusRef = (callId: string, userId: string) =>
  crypto.createHmac('sha256', 'SERVICE_KEY').update(`ccw-agent-ref:${callId}:${userId}`).digest('hex').slice(0, 16);

beforeEach(() => {
  h.inCall = [];
  db.call_sessions = [{
    id: CALL, workspace_id: WS, provider: 'livekit', provider_room_id: 'gs_room', state: 'active', entry_source: 'call_widget',
    assigned_agent_id: A, transfer_from_agent_id: null, transfer_to_agent_id: null, initiated_by: null, connected_at: null,
  }];
  db.call_queue_entries = [{ call_session_id: CALL, workspace_id: WS, assigned_agent_id: A, offered_to_user_id: A }];
  db.call_participants = [];
  db.call_events = [];
  db.workspace_members = [A, B, C].map((user_id) => ({ workspace_id: WS, user_id, role: 'agent' }));
  db.profiles = [
    { id: A, full_name: '  Sara Ahmadi ', email: 'sara@shop.example' },
    { id: B, full_name: null, email: 'reza@shop.example' },
  ];
});

describe('the reference and the identity', () => {
  it('is the status endpoint\'s reference: 16 hex, one per call and user, never the id', () => {
    const ref = ids.operatorReference(CONFIG as never, CALL, A);
    expect(ref).toBe(statusRef(CALL, A));
    expect(ref).toMatch(/^[0-9a-f]{16}$/);
    expect(ids.operatorReference(CONFIG as never, CALL, A)).toBe(ref);
    expect(ids.operatorReference(CONFIG as never, OTHER_CALL, A)).not.toBe(ref);
    expect(ids.operatorReference(CONFIG as never, CALL, B)).not.toBe(ref);
    expect(ids.memberParticipantIdentity(CONFIG as never, CALL, 'operator', A)).toBe(`operator:${ref}`);
    expect(ids.memberParticipantIdentity(CONFIG as never, CALL, 'admin', A)).toBe(`admin:${ref}`);
  });

  it('uses the same secret as the widget session (an explicit widget secret wins over the service key)', () => {
    const cfg = { ...CONFIG, widgetTokenSecret: 'WIDGET' };
    const expected = crypto.createHmac('sha256', 'WIDGET').update(`ccw-agent-ref:${CALL}:${A}`).digest('hex').slice(0, 16);
    expect(ids.operatorReference(cfg as never, CALL, A)).toBe(expected);
  });

  it.each([
    [`operator:${'ab12'.repeat(4)}`, { type: 'operator', uuid: null, ref: 'ab12'.repeat(4) }],
    [`operator:${A}`, { type: 'operator', uuid: A, ref: null }],
    [`admin:${A}`, { type: 'admin', uuid: A, ref: null }],
    [`internal:${'0'.repeat(16)}`, { type: 'internal', uuid: null, ref: '0'.repeat(16) }],
    [`visitor:visitor:${CALL}`, { type: 'visitor', uuid: null, ref: null }],
    [`visitor:${B}`, { type: 'visitor', uuid: B, ref: null }],
    [`visitor:${'ab12'.repeat(4)}`, { type: 'visitor', uuid: null, ref: null }],
    ['operator:', { type: 'operator', uuid: null, ref: null }],
    ['operator:ABCDEF0123456789', { type: 'operator', uuid: null, ref: null }],
    ['something-else', { type: 'internal', uuid: null, ref: null }],
    ['', { type: 'internal', uuid: null, ref: null }],
  ])('parses %j (both the old and the new member form)', (identity, parsed) => {
    expect(ids.parseParticipantIdentity(identity)).toEqual(parsed);
  });
});

describe('livekitProvider.createParticipantToken: what the room shows of a member', () => {
  const claims = (token: string) => jwt.verify(token, 'lk-secret') as Record<string, unknown>;

  it('an operator joins as operator:<ref> under the name given, the uuid nowhere in the token', async () => {
    const tok = await livekitProvider.createParticipantToken(CONFIG as never, {
      callSessionId: CALL, providerRoomId: 'gs_room', participantId: A, participantType: 'operator',
      displayName: 'Sara Ahmadi', canPublish: true, canSubscribe: true, canPublishData: true,
    });
    const c = claims(tok.token);
    expect(c.sub).toBe(`operator:${statusRef(CALL, A)}`);
    expect(tok.identity).toBe(c.sub);
    expect(c.name).toBe('Sara Ahmadi');
    expect(JSON.stringify(c)).not.toContain(A);
  });

  it('no name given: an empty name, never the id (it used to be the uuid)', async () => {
    const tok = await livekitProvider.createParticipantToken(CONFIG as never, {
      callSessionId: CALL, providerRoomId: 'gs_room', participantId: B, participantType: 'operator',
      canPublish: true, canSubscribe: true, canPublishData: true,
    });
    const c = claims(tok.token);
    expect(c.sub).toBe(`operator:${statusRef(CALL, B)}`);
    expect(c.name).toBe('');
    expect(JSON.stringify(c)).not.toContain(B);
    expect(JSON.parse(String(c.metadata))).toEqual({ call_session_id: CALL, participant_type: 'operator' });
  });

  it('a visitor keeps the identity it had', async () => {
    const tok = await livekitProvider.createParticipantToken(CONFIG as never, {
      callSessionId: CALL, providerRoomId: 'gs_room', participantId: `visitor:${CALL}`, participantType: 'visitor',
      canPublish: true, canSubscribe: true, canPublishData: true,
    });
    expect(claims(tok.token).sub).toBe(`visitor:visitor:${CALL}`);
    expect(tok.identity).toBe(`visitor:visitor:${CALL}`);
  });
});

describe('the webhook: from a room identity back to the user', () => {
  const event = (kind: string, identity?: string) => ({
    event: kind, id: `ev-${Math.random()}`,
    room: { name: 'gs_room', metadata: JSON.stringify({ call_session_id: CALL, workspace_id: WS }) },
    ...(identity === undefined ? {} : { participant: { identity } }),
  });
  const refId = (user: string) => `operator:${statusRef(CALL, user)}`;
  const rowOf = (identity: string) => db.call_participants.find((r) => r.provider_participant_id === identity);

  it('the operator who has the call joins and leaves: their row names them, the in-call lock follows them', async () => {
    const identity = refId(A);
    expect(await applyEvent(CONFIG as never, event('participant_joined', identity))).toEqual({ applied: true });
    expect(rowOf(identity)).toMatchObject({ participant_type: 'operator', participant_id: A, call_session_id: CALL });
    expect(db.call_events.at(-1)).toMatchObject({ event_type: 'lk.participant_joined', payload: { identity, user_id: A } });
    await Promise.resolve();
    expect(h.inCall).toEqual([{ op: 'mark', workspaceId: WS, userId: A, callId: CALL }]);

    expect(await applyEvent(CONFIG as never, event('participant_left', identity))).toEqual({ applied: true });
    expect(rowOf(identity)!.left_at).toBeTruthy();
    expect(db.call_events.at(-1)).toMatchObject({ event_type: 'lk.participant_left', payload: { identity, user_id: A } });
    await Promise.resolve();
    expect(h.inCall.at(-1)).toEqual({ op: 'clear', workspaceId: WS, userId: A });
  });

  it('a call from before the deploy: operator:<uuid> is still the user (rolling deploy)', async () => {
    const identity = `operator:${A}`;
    await applyEvent(CONFIG as never, event('participant_joined', identity));
    expect(rowOf(identity)).toMatchObject({ participant_type: 'operator', participant_id: A });
    await applyEvent(CONFIG as never, event('participant_left', identity));
    await Promise.resolve();
    expect(h.inCall).toEqual([
      { op: 'mark', workspaceId: WS, userId: A, callId: CALL },
      { op: 'clear', workspaceId: WS, userId: A },
    ]);
  });

  it('A transferred the call to B: A leaving is still A (their row from the join, or the transfer\'s own columns)', async () => {
    await applyEvent(CONFIG as never, event('participant_joined', refId(A)));
    Object.assign(db.call_sessions[0], { assigned_agent_id: B, transfer_from_agent_id: A, transfer_to_agent_id: B });
    Object.assign(db.call_queue_entries[0], { assigned_agent_id: B, offered_to_user_id: B });
    await applyEvent(CONFIG as never, event('participant_joined', refId(B)));
    expect(rowOf(refId(B))).toMatchObject({ participant_id: B });
    await applyEvent(CONFIG as never, event('participant_left', refId(A)));
    await Promise.resolve();
    expect(h.inCall.at(-1)).toEqual({ op: 'clear', workspaceId: WS, userId: A });

    // The join was never delivered (or came before this release): the transfer's columns still name A.
    db.call_participants = [];
    h.inCall = [];
    await applyEvent(CONFIG as never, event('participant_left', refId(A)));
    await Promise.resolve();
    expect(h.inCall).toEqual([{ op: 'clear', workspaceId: WS, userId: A }]);
  });

  it('someone the call no longer names (A → B → C, A\'s join lost): the workspace\'s members', async () => {
    Object.assign(db.call_sessions[0], { assigned_agent_id: C, transfer_from_agent_id: B, transfer_to_agent_id: C });
    Object.assign(db.call_queue_entries[0], { assigned_agent_id: C, offered_to_user_id: C });
    await applyEvent(CONFIG as never, event('participant_left', refId(A)));
    await Promise.resolve();
    expect(h.inCall).toEqual([{ op: 'clear', workspaceId: WS, userId: A }]);
  });

  it('a reference of nobody here (another call\'s, a non-member\'s): a row without a user, no lock', async () => {
    for (const identity of [`operator:${statusRef(OTHER_CALL, A)}`, `operator:${statusRef(CALL, OUTSIDER)}`]) {
      await applyEvent(CONFIG as never, event('participant_joined', identity));
      expect(rowOf(identity)).toMatchObject({ participant_type: 'operator', participant_id: null });
    }
    await Promise.resolve();
    expect(h.inCall).toEqual([]);
  });

  it('visitors are as before: the call starts, a uuid visitor id is kept, no lock', async () => {
    await applyEvent(CONFIG as never, event('participant_joined', `visitor:visitor:${CALL}`));
    expect(rowOf(`visitor:visitor:${CALL}`)).toMatchObject({ participant_type: 'visitor', participant_id: null });
    expect(db.call_sessions[0].connected_at).toBeTruthy();
    await applyEvent(CONFIG as never, event('participant_joined', `visitor:${C}`));
    expect(rowOf(`visitor:${C}`)).toMatchObject({ participant_type: 'visitor', participant_id: C });
    await Promise.resolve();
    expect(h.inCall).toEqual([]);
  });

  it('the room ends: every operator whose row names them is released', async () => {
    await applyEvent(CONFIG as never, event('participant_joined', refId(A)));
    await applyEvent(CONFIG as never, event('participant_joined', `operator:${B}`));
    h.inCall = [];
    await applyEvent(CONFIG as never, event('room_finished'));
    await Promise.resolve();
    expect(h.inCall).toEqual([
      { op: 'clear', workspaceId: WS, userId: A },
      { op: 'clear', workspaceId: WS, userId: B },
    ]);
  });
});

describe('resolveParticipantId', () => {
  it('trusts the row its join resolved, even after the secret changed (one read, no member scan)', async () => {
    const identity = 'operator:00112233445566aa';
    db.call_participants = [{ call_session_id: CALL, participant_type: 'operator', participant_id: B, provider_participant_id: identity }];
    db.workspace_members = [];
    await expect(ids.resolveParticipantId(CONFIG as never, fakeClient as never, { callSessionId: CALL, workspaceId: WS, identity })).resolves.toBe(B);
    // Nobody resolves a reference no one on the call, its queue or the workspace has.
    await expect(ids.resolveParticipantId(CONFIG as never, fakeClient as never, { callSessionId: CALL, workspaceId: WS, identity: 'operator:ffffffffffffffff' })).resolves.toBeNull();
  });

  it('throws on a database error instead of answering "nobody" (the webhook then stays retryable)', async () => {
    const sb = {
      from: () => {
        const q: Record<string, unknown> = {};
        for (const k of ['select', 'eq', 'in', 'limit']) q[k] = () => q;
        q.maybeSingle = async () => ({ data: null, error: { message: 'boom' } });
        q.then = (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => Promise.resolve({ data: null, error: { message: 'boom' } }).then(ok, ko);
        return q;
      },
    };
    await expect(ids.resolveParticipantId(CONFIG as never, sb as never, { callSessionId: CALL, workspaceId: WS, identity: `operator:${statusRef(CALL, A)}` }))
      .rejects.toThrow();
    // An old-form or visitor identity needs no lookup at all.
    await expect(ids.resolveParticipantId(CONFIG as never, sb as never, { callSessionId: CALL, workspaceId: WS, identity: `operator:${A}` })).resolves.toBe(A);
    await expect(ids.resolveParticipantId(CONFIG as never, sb as never, { callSessionId: CALL, workspaceId: WS, identity: `visitor:visitor:${CALL}` })).resolves.toBeNull();
  });
});

describe('publicMemberName: the name a room shows for a member', () => {
  it('the profile\'s own name, trimmed, or empty; never the e-mail', async () => {
    expect(await ids.publicMemberName(CONFIG as never, A)).toBe('Sara Ahmadi');
    expect(await ids.publicMemberName(CONFIG as never, B)).toBe('');
    expect(await ids.publicMemberName(CONFIG as never, OUTSIDER)).toBe('');
  });

  it('the same rule as the call status\'s operator_name', async () => {
    const { operatorOwnName } = await import('../../../server/services/callCenter/publicPresence.js');
    for (const v of ['Sara', '  Sara Ahmadi  ', '', '   ', '\u200c', '\u0301', '\u0000x', 'علی', 42, null, undefined, { a: 1 }]) {
      expect(ids.publicNameOf(v)).toBe(operatorOwnName(v) ?? '');
    }
  });
});
