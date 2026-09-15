/**
 * LiveKit webhook — recording filename fail-closed validation.
 *
 * Proves the requirement in docs/STORAGE_ARCHITECTURE_AUDIT.md §11: the
 * `fileResults[].filename` LiveKit reports on egress_ended/egress_updated
 * is untrusted webhook-boundary input. applyEvent() must validate it
 * against the expected workspace/<workspaceId>/calls/recordings/<callSessionId>/
 * prefix before ever writing it to call_recordings.storage_path, and fail
 * closed (never persist the untrusted path, mark the recording failed) on
 * any mismatch — wrong session, wrong workspace, or the old non-canonical
 * LiveKit shape.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { applyEvent, type LiveKitWebhookEvent } from '../../../server/routes/livekitWebhook';
import { callRecordingKey } from '../../../server/services/storage/keys';

const WS_A = '11111111-1111-1111-1111-111111111111';
const SESSION_A = '55555555-5555-5555-5555-555555555555';
const OTHER_SESSION = '66666666-6666-6666-6666-666666666666';

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};

interface UpdateChain {
  eq: (col: string, val: unknown) => UpdateChain;
}

function makeBuilder(table: string) {
  const rows: Row[] = db[table] || (db[table] = []);
  const filters: Array<(r: Row) => boolean> = [];
  const builder = {
    select: () => builder,
    eq(col: string, val: unknown) {
      filters.push((r) => r[col] === val);
      return builder;
    },
    maybeSingle: async () => {
      const matched = rows.filter((r) => filters.every((f) => f(r)));
      return { data: matched[0] ?? null, error: null };
    },
    insert: async (payload: Row) => {
      rows.push({ ...payload });
      return { data: null, error: null };
    },
    update(patch: Row) {
      const scoped: Array<(r: Row) => boolean> = [...filters];
      const chain: UpdateChain = {
        eq(col: string, val: unknown) {
          scoped.push((r) => r[col] === val);
          const matched = rows.filter((r) => scoped.every((f) => f(r)));
          for (const r of matched) Object.assign(r, patch);
          return chain;
        },
      };
      return chain;
    },
  };
  return builder;
}

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({ from: (table: string) => makeBuilder(table) }),
}));

vi.mock('../../../server/services/recordings/recordingRetention.js', () => ({
  resolveEffectiveRecordingRetentionDays: async () => ({ days: 30, source: 'platform_default' }),
  computeRetentionExpiresAt: (createdAtIso: string) => new Date(new Date(createdAtIso).getTime() + 30 * 86400_000).toISOString(),
}));
vi.mock('../../../server/services/storage/index.js', () => ({
  resolveStorageConfig: async () => ({ provider: 'local' }),
}));
vi.mock('../../../server/services/calls/availability.js', () => ({
  markInCall: async () => undefined,
  clearInCall: async () => undefined,
}));

function callRecordingRow(): Row {
  const row = db.call_recordings?.find((r) => r.call_session_id === SESSION_A);
  if (!row) throw new Error('call_recordings row not seeded');
  return row;
}

function callSessionRow(): Row {
  const row = db.call_sessions?.find((r) => r.id === SESSION_A);
  if (!row) throw new Error('call_sessions row not seeded');
  return row;
}

beforeEach(() => {
  for (const key of Object.keys(db)) delete db[key];
  db.call_sessions = [{
    id: SESSION_A,
    workspace_id: WS_A,
    provider: 'livekit',
    recording_state: 'recording',
    provider_room_id: 'gs_11111111_555555555555',
  }];
  db.call_recordings = [
    {
      id: 'rec-row-1',
      call_session_id: SESSION_A,
      provider_recording_id: 'egress-1',
      storage_path: '',
    },
  ];
});

function egressEvent(filename: string | undefined, overrides: Partial<LiveKitWebhookEvent> = {}): LiveKitWebhookEvent {
  return {
    event: 'egress_ended',
    id: 'ev-1',
    room: { name: 'gs_11111111_555555555555' },
    egressInfo: {
      egressId: 'egress-1',
      status: 'EGRESS_COMPLETE',
      fileResults: filename ? [{ filename, size: 1024, duration: 12 }] : [],
    },
    ...overrides,
  };
}

describe('applyEvent — egress_ended fail-closed filename validation', () => {
  it('accepts and persists a filename correctly scoped to the workspace + call session', async () => {
    const goodKey = callRecordingKey({ workspaceId: WS_A, callSessionId: SESSION_A, fileName: 'out.mp4' });
    const result = await applyEvent({} as never, egressEvent(goodKey));
    expect(result.applied).toBe(true);
    expect(callRecordingRow().storage_path).toBe(goodKey);
    expect(callSessionRow().recording_state).toBe('available');
  });

  it('rejects a filename scoped to a DIFFERENT call session and never writes it to storage_path', async () => {
    const wrongSessionKey = callRecordingKey({ workspaceId: WS_A, callSessionId: OTHER_SESSION, fileName: 'out.mp4' });
    const result = await applyEvent({} as never, egressEvent(wrongSessionKey));
    expect(result.applied).toBe(true);
    expect(callRecordingRow().storage_path).toBe(''); // never overwritten with the untrusted value
    expect(callSessionRow().recording_state).toBe('failed'); // fail closed
  });

  it('rejects the legacy non-canonical LiveKit shape (gs_<room>/<timestamp>.mp4)', async () => {
    const legacyShapeKey = 'gs_11111111_555555555555/171234.mp4';
    const result = await applyEvent({} as never, egressEvent(legacyShapeKey));
    expect(result.applied).toBe(true);
    expect(callRecordingRow().storage_path).toBe('');
    expect(callSessionRow().recording_state).toBe('failed');
  });

  it('rejects a filename with a different workspace id', async () => {
    const WS_B = '22222222-2222-2222-2222-222222222222';
    const wrongWorkspaceKey = callRecordingKey({ workspaceId: WS_B, callSessionId: SESSION_A, fileName: 'out.mp4' });
    const result = await applyEvent({} as never, egressEvent(wrongWorkspaceKey));
    expect(callRecordingRow().storage_path).toBe('');
    expect(callSessionRow().recording_state).toBe('failed');
  });

  it('rejects traversal smuggled through an otherwise-matching prefix', async () => {
    const traversalKey = `workspace/${WS_A}/calls/recordings/${SESSION_A}/../../../etc/passwd`;
    const result = await applyEvent({} as never, egressEvent(traversalKey));
    expect(callRecordingRow().storage_path).toBe('');
    expect(callSessionRow().recording_state).toBe('failed');
  });

  it('marks the recording metadata with an explicit rejection reason on mismatch (visible for ops)', async () => {
    const wrongSessionKey = callRecordingKey({ workspaceId: WS_A, callSessionId: OTHER_SESSION, fileName: 'out.mp4' });
    await applyEvent({} as never, egressEvent(wrongSessionKey));
    const meta = callRecordingRow().metadata as { status?: string; error?: string };
    expect(meta.status).toBe('rejected');
    expect(meta.error).toBe('untrusted_filename');
  });
});
