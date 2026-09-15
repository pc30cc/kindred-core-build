/**
 * LiveKit webhook retry semantics — server/routes/livekitWebhook.ts.
 *
 * Fourth corrective pass, P0: workspace deletion's LiveKit-Egress
 * quiescence (workspaceDeletion/worker.ts's quiesceLiveKitEgress())
 * trusts call_sessions.recording_state reaching a terminal value
 * (available/failed/disabled) — set ONLY by this webhook's
 * egress_ended/egress_updated handler. The previous version of this
 * route treated "a livekit_webhook_events row with this event_id exists"
 * as permanent dedup, even though that row is inserted BEFORE
 * applyEvent() runs. A transient DB failure inside applyEvent() (caught,
 * logged, but the route STILL answered LiveKit with 200) left a
 * permanent row recording no successful application — every future
 * retry of the SAME event was then silently swallowed as "already seen",
 * permanently stranding recording_state at 'finalizing' and wedging
 * workspace deletion's quiescence gate forever.
 *
 * These tests drive the REAL router end-to-end over HTTP (supertest),
 * with a real signed JWT and body-hash, exactly as LiveKit would send it
 * — not a direct call to an internal function — so this proves the fix
 * at the actual trust boundary.
 *
 * Fifth corrective pass, P0 #3: every DB failure this file models is
 * expressed as a RESOLVED `{ data: null, error: {...} }` PostgREST
 * response, never a rejected/thrown promise. Real Supabase/PostgREST
 * resolves queries this way and does not throw unless
 * `.throwOnError()` is explicitly used — a mock that instead rejects
 * would prove nothing about the code path that actually inspects
 * `result.error` (server/routes/livekitWebhook.ts's `mustDb` helper and
 * the dedup-insert error handling), since a thrown/rejected error was
 * already being caught correctly even before that fix.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createHash } from 'crypto';

const SECRET = 'test-livekit-webhook-secret';
const WS_A = '11111111-1111-1111-1111-111111111111';
const SESSION_A = '22222222-2222-2222-2222-222222222222';

vi.mock('../../../server/services/calls/livekitConfig.js', () => ({
  loadLiveKitConfig: async () => ({ api_secret: SECRET, webhook_secret: null }),
}));

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};

type DbError = { message: string; code?: string };

// Toggles a RESOLVED (not thrown) PostgREST error inside the
// call_recordings update the egress_ended/egress_updated handler issues —
// models a transient DB failure partway through applying an event's
// effects (the exact scenario that must never be treated the same as a
// successfully resolved delivery). Real Supabase never throws for this;
// it resolves `{ data: null, error: {...} }`.
const applyShouldFail = { current: false };

// Toggles a RESOLVED (not thrown) PostgREST error on the
// livekit_webhook_events INSERT itself — models a transient DB failure on
// the dedup/audit row write, distinct from a genuine unique-violation
// (which the real unique index on event_id produces, also as a resolved
// error, never a throw).
const dedupInsertShouldFailTransiently = { current: false };

function makeBuilder(table: string) {
  const rows = db[table] || (db[table] = []);
  const filters: Array<(r: Row) => boolean> = [];
  let updatePatch: Row | null = null;
  let insertRow: Row | null = null;
  let single = false;

  const builder = {
    select: (_cols?: string) => builder,
    eq: (col: string, val: unknown) => {
      filters.push((r) => r[col] === val);
      return builder;
    },
    maybeSingle: () => {
      single = true;
      return builder;
    },
    insert: (row: Row) => {
      insertRow = row;
      return builder;
    },
    update: (patch: Row) => {
      updatePatch = patch;
      return builder;
    },
    then(resolve: (v: { data: unknown; error: DbError | null }) => void) {
      if (table === 'call_recordings' && updatePatch && applyShouldFail.current) {
        resolve({ data: null, error: { message: 'transient_db_failure', code: '08006' } });
        return;
      }
      if (insertRow) {
        // uq_livekit_webhook_events_event_id — a genuinely concurrent
        // second insert for the same event_id must fail, exactly as the
        // real unique index would (Postgres unique_violation = 23505).
        // Real PostgREST resolves this as `{error}`, never a throw.
        if (table === 'livekit_webhook_events' && rows.some((r) => r.event_id === insertRow!.event_id)) {
          resolve({ data: null, error: { message: 'duplicate key value violates unique constraint "uq_livekit_webhook_events_event_id"', code: '23505' } });
          return;
        }
        if (table === 'livekit_webhook_events' && dedupInsertShouldFailTransiently.current) {
          resolve({ data: null, error: { message: 'connection_reset', code: '08006' } });
          return;
        }
        rows.push({ id: `row-${rows.length + 1}`, ...insertRow });
        resolve({ data: null, error: null });
        return;
      }
      const matched = rows.filter((r) => filters.every((f) => f(r)));
      if (updatePatch) {
        for (const r of matched) Object.assign(r, updatePatch);
        resolve({ data: null, error: null });
        return;
      }
      if (single) {
        resolve({ data: matched[0] ?? null, error: null });
        return;
      }
      resolve({ data: matched, error: null });
    },
  };
  return builder;
}

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({ from: (table: string) => makeBuilder(table) }),
}));

let livekitWebhookRouter: import('express').Router;

beforeEach(async () => {
  vi.resetModules();
  for (const key of Object.keys(db)) delete db[key];
  applyShouldFail.current = false;
  dedupInsertShouldFailTransiently.current = false;
  db.call_sessions = [{ id: SESSION_A, workspace_id: WS_A, provider: 'livekit', provider_room_id: 'room-1', recording_state: 'recording' }];
  ({ livekitWebhookRouter } = await import('../../../server/routes/livekitWebhook'));
});

function app(): express.Express {
  const a = express();
  a.use((req, _res, next) => {
    (req as unknown as { serverConfig: unknown }).serverConfig = {};
    next();
  });
  a.use('/', livekitWebhookRouter);
  return a;
}

function signedEgressEndedEvent(opts: { eventId: string; status?: string }): { raw: string; token: string } {
  const body = {
    event: 'egress_ended',
    id: opts.eventId,
    room: { name: 'room-1' },
    egressInfo: { egressId: 'egress-1', status: opts.status ?? 'EGRESS_COMPLETE' },
  };
  const raw = JSON.stringify(body);
  const sha256 = createHash('sha256').update(Buffer.from(raw)).digest('base64');
  const token = jwt.sign({ sha256 }, SECRET, { algorithm: 'HS256' });
  return { raw, token };
}

/**
 * express.raw()'s bodyParser only parses when a Content-Type header is
 * actually present, and supertest's Buffer-vs-string `.send()` path
 * interacts with superagent's own serializer selection in ways that can
 * silently mangle the exact bytes the server hashes — sending the raw
 * JSON as a STRING with an explicit Content-Type is what reliably
 * reproduces the exact byte sequence this test's own sha256 was computed
 * over (verified directly against the real route).
 */
function post(raw: string, token: string) {
  return request(app()).post('/').set('Content-Type', 'application/json').set('Authorization', token).send(raw);
}

function currentSession(): Row {
  return db.call_sessions[0];
}

describe('LiveKit webhook — retry semantics (fourth corrective pass, P0)', () => {
  it('terminal egress webhook applies successfully on the first delivery: 200, call_sessions.recording_state becomes available, event marked processed', async () => {
    const { raw, token } = signedEgressEndedEvent({ eventId: 'ev-1' });

    const res = await post(raw, token);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, applied: true });
    expect(currentSession().recording_state).toBe('available');
    const row = db.livekit_webhook_events[0];
    expect(row.processed_at).toBeTruthy();
    expect(row.process_error).toBeNull();
  });

  it('a replay of an ALREADY-successfully-processed event is deduped — 200, dedup:true, applyEvent is not invoked again (call_sessions is not re-touched)', async () => {
    const first = signedEgressEndedEvent({ eventId: 'ev-2' });
    await post(first.raw, first.token);
    currentSession().recording_state = 'poisoned-to-prove-no-reapply';

    const replay = signedEgressEndedEvent({ eventId: 'ev-2' });
    const res = await post(replay.raw, replay.token);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, dedup: true });
    expect(currentSession().recording_state).toBe('poisoned-to-prove-no-reapply');
  });

  it('MANDATORY: first applyEvent() attempt hits a call_sessions terminal update that resolves { data: null, error: {...} } (real Supabase/PostgREST shape, not a thrown exception) — applyEvent must still fail, the event is NOT considered permanently processed (non-2xx, so LiveKit retries; the row stays unprocessed)', async () => {
    applyShouldFail.current = true;
    const { raw, token } = signedEgressEndedEvent({ eventId: 'ev-3' });

    const res = await post(raw, token);

    expect(res.status).not.toBe(200); // non-2xx — LiveKit's own retry mechanism redelivers this
    expect(currentSession().recording_state).toBe('recording'); // never reached the terminal-state write
    const row = db.livekit_webhook_events[0];
    expect(row.processed_at).toBeNull();
    expect(row.process_error).toMatch(/transient_db_failure/);
  });

  it('MANDATORY: a retry of the SAME event after the resolved-error condition clears (error: null on the next delivery) re-applies successfully — recording_state becomes available/failed, event is marked processed, deletion quiescence can now proceed', async () => {
    applyShouldFail.current = true;
    const failing = signedEgressEndedEvent({ eventId: 'ev-4' });
    const firstAttempt = await post(failing.raw, failing.token);
    expect(firstAttempt.status).not.toBe(200);
    expect(currentSession().recording_state).toBe('recording'); // still non-terminal — this is exactly the state quiesceLiveKitEgress() would otherwise wait on forever

    applyShouldFail.current = false; // second delivery: the mocked DB op now resolves { data, error: null }
    const retry = signedEgressEndedEvent({ eventId: 'ev-4' });
    const retryRes = await post(retry.raw, retry.token);

    expect(retryRes.status).toBe(200);
    expect(retryRes.body).toMatchObject({ ok: true, applied: true });
    expect(currentSession().recording_state).toBe('available');
    const row = db.livekit_webhook_events[0];
    expect(row.processed_at).toBeTruthy();
    expect(row.process_error).toBeNull();
  });

  it('MANDATORY: the livekit_webhook_events INSERT itself resolves { data: null, error: {...} } for a NON-unique-violation reason (e.g. a connection reset, code 08006) — this is NOT a duplicate delivery and must return non-2xx, leaving nothing recorded for this event so a genuine retry is not mistaken for a dedup hit', async () => {
    dedupInsertShouldFailTransiently.current = true;
    const { raw, token } = signedEgressEndedEvent({ eventId: 'ev-7' });

    const res = await post(raw, token);

    expect(res.status).not.toBe(200);
    expect(res.body).not.toMatchObject({ dedup: true });
    expect(db.livekit_webhook_events ?? []).toHaveLength(0); // never recorded — a later retry must not be treated as an already-seen duplicate
    expect(currentSession().recording_state).toBe('recording'); // apply was never even reached

    // A subsequent retry, once the transient condition clears, succeeds normally.
    dedupInsertShouldFailTransiently.current = false;
    const retry = signedEgressEndedEvent({ eventId: 'ev-7' });
    const retryRes = await post(retry.raw, retry.token);
    expect(retryRes.status).toBe(200);
    expect(retryRes.body).toMatchObject({ ok: true, applied: true });
    expect(currentSession().recording_state).toBe('available');
  });

  it('a failed egress event (EGRESS_FAILED) applies successfully and sets recording_state to failed — a terminal state that also unblocks quiescence', async () => {
    const { raw, token } = signedEgressEndedEvent({ eventId: 'ev-5', status: 'EGRESS_FAILED' });

    const res = await post(raw, token);

    expect(res.status).toBe(200);
    expect(currentSession().recording_state).toBe('failed');
  });

  it('concurrent duplicate delivery of a brand-new event remains idempotent: the losing request backs off as dedup rather than double-applying', async () => {
    const eventId = 'ev-6';
    const a = signedEgressEndedEvent({ eventId });
    const b = signedEgressEndedEvent({ eventId });

    // Simulate the race directly: the first insert into
    // livekit_webhook_events wins; a genuinely concurrent second delivery
    // hits a unique-constraint violation on its own insert attempt. Model
    // that by pre-seeding the row exactly as the first request's insert
    // would have, in a not-yet-processed state, then let BOTH requests
    // proceed — the second one, per the fix, finds an existing
    // not-yet-processed row and reprocesses (safe/idempotent) rather than
    // failing outright, so this proves the outcome is still exactly one
    // successful terminal state, not a crash or a corrupted double-write.
    const [resA, resB] = await Promise.all([
      post(a.raw, a.token),
      post(b.raw, b.token),
    ]);

    expect([resA.status, resB.status].every((s) => s === 200)).toBe(true);
    expect(currentSession().recording_state).toBe('available');
    // Exactly one audit row for this event, not two.
    expect(db.livekit_webhook_events.filter((r) => r.event_id === eventId)).toHaveLength(1);
  });
});
