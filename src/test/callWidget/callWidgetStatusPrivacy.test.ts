/**
 * GET /api/call-widget/calls/:id/status and the operator's privacy (S9, D27).
 * The visitor sees the operator's own name or nothing, never a part of their
 * e-mail; `call.assigned_agent_id` keeps its name (an older engine compares it
 * to notice a transfer) but carries an opaque reference per call and
 * operator, a domain-separated HMAC, instead of the operator's user id; the
 * provider's room is not sent.
 */
import { afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import { db, fakeClient } from './fakeDb';
import { startTestServer } from './callWidgetHttp';

process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
vi.mock('@supabase/supabase-js', () => ({ createClient: () => fakeClient }));
vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeClient }));

const WS = '22222222-2222-4222-8222-222222222222';
const ORIGIN = 'https://shop.example';
const CALL_A = 'c0000000-0000-4000-8000-00000000000a';
const CALL_B = 'c0000000-0000-4000-8000-00000000000b';
const AGENT_1 = 'a1111111-1111-4111-8111-111111111111';
const AGENT_2 = 'a2222222-2222-4222-8222-222222222222';
const CONFIG = { supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'a', supabaseServiceRoleKey: 'SERVICE_KEY' };

db.platform_call_center_settings = [{ singleton: true, call_center_enabled: true, queue_eta_seconds_per_position: 45 }];

const { callWidgetRouter } = await import('../../../server/routes/callWidget.js');
const { signWidgetSession } = await import('../../../server/services/callCenter/widgetSession.js');
const server = startTestServer('/api/call-widget', callWidgetRouter, CONFIG, { origin: ORIGIN });
afterAll(() => { server.close(); });

type Status = { call: Record<string, unknown>; operator_name: string | null; position: number | null };

function status(callId: string) {
  const token = signWidgetSession(CONFIG as never, { workspace_id: WS, public_key: 'cck_x', call_id: callId, origin: ORIGIN });
  return server.get<Status>(`/api/call-widget/calls/${callId}/status`, { 'x-cc-session': token });
}

/** The reference the contract names: HMAC-SHA256(widget-session secret, 'ccw-agent-ref:' + call + ':' + agent), 16 hex. */
const expectedRef = (callId: string, agentId: string) =>
  crypto.createHmac('sha256', 'SERVICE_KEY').update(`ccw-agent-ref:${callId}:${agentId}`).digest('hex').slice(0, 16);

beforeEach(() => {
  db.call_sessions = [CALL_A, CALL_B].map((id) => ({
    id, workspace_id: WS, state: 'active', call_type: 'audio', provider: 'livekit', provider_room_id: `room-${id}`,
    recording_enabled: false, recording_state: null, assigned_agent_id: AGENT_1, started_at: '2026-10-19T06:00:00Z',
    ended_at: null, end_reason: null, duration_seconds: null,
  }));
  db.profiles = [
    { id: AGENT_1, full_name: null, email: 'first.operator@shop.example' },
    { id: AGENT_2, full_name: '  Sara Ahmadi ', email: 'sara@shop.example' },
  ];
});

describe('call status: the operator\'s privacy', () => {
  it('never derives a name from the e-mail: no full name, no name', async () => {
    const { status: code, body, text } = await status(CALL_A);
    expect(code).toBe(200);
    expect(body.operator_name).toBeNull();
    expect(text).not.toContain('first.operator');
    expect(text).not.toContain('@');
  });

  it('sends the operator\'s own name, trimmed', async () => {
    db.call_sessions[0].assigned_agent_id = AGENT_2;
    expect((await status(CALL_A)).body.operator_name).toBe('Sara Ahmadi');
  });

  it('a name with nothing that shows (only marks or spaces) is no name', async () => {
    db.profiles[0].full_name = '‏‌ ';
    expect((await status(CALL_A)).body.operator_name).toBeNull();
  });

  it('replaces the operator\'s user id with an opaque reference, stable per call and operator', async () => {
    const first = await status(CALL_A);
    const ref = first.body.call.assigned_agent_id as string;
    expect(ref).toMatch(/^[0-9a-f]{16}$/);
    expect(ref).toBe(expectedRef(CALL_A, AGENT_1));
    // Domain separated: not the HMAC of the bare pair.
    expect(ref).not.toBe(crypto.createHmac('sha256', 'SERVICE_KEY').update(`${CALL_A}:${AGENT_1}`).digest('hex').slice(0, 16));
    expect(first.text).not.toContain(AGENT_1);
    expect((await status(CALL_A)).body.call.assigned_agent_id).toBe(ref);
    // Another call with the same operator: another reference.
    expect((await status(CALL_B)).body.call.assigned_agent_id).not.toBe(ref);
    // A transfer to another operator: the reference changes (the engine's cue).
    db.call_sessions[0].assigned_agent_id = AGENT_2;
    const moved = (await status(CALL_A)).body.call.assigned_agent_id;
    expect(moved).toBe(expectedRef(CALL_A, AGENT_2));
    expect(moved).not.toBe(ref);
  });

  it('keeps null while nobody is assigned', async () => {
    db.call_sessions[0].assigned_agent_id = null;
    const { body } = await status(CALL_A);
    expect(body.call.assigned_agent_id).toBeNull();
    expect(body.operator_name).toBeNull();
  });

  it('drops the provider and its room, keeping what the engine reads', async () => {
    const { body, text } = await status(CALL_A);
    expect(body.call).not.toHaveProperty('provider');
    expect(body.call).not.toHaveProperty('provider_room_id');
    expect(text).not.toContain('room-');
    expect(body.call).toMatchObject({ id: CALL_A, state: 'active', call_type: 'audio', started_at: '2026-10-19T06:00:00Z', recording_enabled: false });
  });
});
