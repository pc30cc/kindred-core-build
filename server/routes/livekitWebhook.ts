/**
 * Phase 8B - LiveKit webhook ingestion.
 *
 * LiveKit signs each webhook POST with a JWT in the Authorization header
 * (`Authorization: <jwt>`, no "Bearer" prefix per LiveKit spec). The token
 * is signed with the SAME api_secret used elsewhere (HS256). The body is a
 * sha256 hash that is also embedded as the `sha256` claim.
 *
 * We:
 *   1. Verify the JWT signature using livekit_config.api_secret
 *      (or webhook_secret if configured separately).
 *   2. Verify the body sha256 matches the JWT's `sha256` claim.
 *   3. Dedup using livekit_webhook_events (event id + sha).
 *   4. Apply effects to call_sessions / call_participants / call_recordings
 *      / call_events. All updates are idempotent.
 *
 * STRICT:
 *   - This is the ONLY route mounted without standard auth - LiveKit calls
 *     it directly. Membership check is impossible (no user). We rely
 *     entirely on the JWT signature for trust.
 *   - We accept the webhook only when the body sha matches; otherwise 401.
 *   - Replays are silently de-duped (200 OK with `dedup: true`).
 */
import { Router } from 'express';
import express from 'express';
import { createHash } from 'crypto';
import jwt from 'jsonwebtoken';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { loadLiveKitConfig } from '../services/calls/livekitConfig.js';
import { emitCallMetric } from '../services/calls/metrics.js';
import { markInCall, clearInCall } from '../services/calls/availability.js';
import {
  resolveEffectiveRecordingRetentionDays,
  computeRetentionExpiresAt,
} from '../services/recordings/recordingRetention.js';
import { resolveStorageConfig } from '../services/storage/index.js';
import { assertCallRecordingKey, StorageKeyError } from '../services/storage/keys.js';
import { mustDb } from '../utils/mustDb.js';

export const livekitWebhookRouter = Router();

/**
 * LiveKit webhook event shape (subset we care about).
 * https://docs.livekit.io/home/server/webhooks/
 */
export interface LiveKitWebhookEvent {
  event: string;
  id?: string;
  createdAt?: number;
  room?: {
    sid?: string;
    name?: string;
    metadata?: string;
    numParticipants?: number;
    creationTime?: number;
  };
  participant?: {
    sid?: string;
    identity?: string;
    name?: string;
    state?: string;
    metadata?: string;
    joinedAt?: number;
  };
  egressInfo?: {
    egressId?: string;
    roomName?: string;
    status?: string;
    error?: string;
    fileResults?: Array<{ filename?: string; size?: number; duration?: number }>;
  };
  track?: { sid?: string; type?: string };
}

function parseRoomMetadata(raw: string | undefined): {
  workspace_id?: string;
  call_session_id?: string;
} {
  if (!raw) return {};
  try {
    const o = JSON.parse(raw);
    return {
      workspace_id: typeof o?.workspace_id === 'string' ? o.workspace_id : undefined,
      call_session_id: typeof o?.call_session_id === 'string' ? o.call_session_id : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Fifth corrective pass, P0 #3: real Supabase/PostgREST resolves queries as
 * `{ data, error }` — it does NOT throw on a failed write unless
 * `.throwOnError()` is explicitly used. Every `await sb...` in this file is
 * a thenable PostgREST builder, so an unchecked `await` silently swallows a
 * failed UPDATE/INSERT: applyEvent() would keep going, return
 * `{applied:true}`, and the webhook route would mark the event permanently
 * processed even though (for example) `call_sessions.recording_state` never
 * actually reached a terminal value — recreating the exact
 * deletion-quiescence wedge workspaceDeletion/worker.ts's
 * quiesceLiveKitEgress() depends on that column for. `mustDb` makes a
 * failed PostgREST response behave exactly like a thrown exception: it
 * throws, so the route's existing catch block (which marks the event
 * retryable and returns non-2xx) actually fires.
 */

/**
 * Resolve a call session by either provider_room_id or metadata-embedded id.
 *
 * Sixth corrective pass, P0 #3: both lookups previously destructured only
 * `data`, discarding `error` — a transient DB failure on this SELECT was
 * therefore indistinguishable from "no matching row exists". The caller
 * (`applyEvent`) would then return `{applied:false, reason:'session_not_found'}`,
 * a result the webhook route treats as a successfully resolved delivery:
 * the event gets marked processed and 200 is returned, so LiveKit never
 * retries — for an `egress_ended` event this can permanently strand
 * `call_sessions.recording_state` at a non-terminal value. Both lookups now
 * throw on a genuine `{error}` (fail closed, non-2xx, retryable) and only
 * return `null` when the query actually succeeded and found nothing.
 */
async function resolveCallSession(
  config: ServerConfig,
  ev: LiveKitWebhookEvent,
): Promise<{ id: string; workspace_id: string; provider: string } | null> {
  const sb = getServiceClient(config);
  // Prefer the metadata-embedded id (deterministic, set at createRoom).
  const meta = parseRoomMetadata(ev.room?.metadata);
  if (meta.call_session_id) {
    const data = await mustDb(
      await sb
        .from('call_sessions')
        .select('id, workspace_id, provider')
        .eq('id', meta.call_session_id)
        .maybeSingle(),
      'call_sessions.select:resolveCallSession.byId',
    );
    if (data) return data;
  }
  // Fall back to provider_room_id (the room name we set in createRoom).
  if (ev.room?.name) {
    const data = await mustDb(
      await sb
        .from('call_sessions')
        .select('id, workspace_id, provider')
        .eq('provider_room_id', ev.room.name)
        .maybeSingle(),
      'call_sessions.select:resolveCallSession.byRoomName',
    );
    if (data) return data;
  }
  return null;
}

/**
 * Apply effects to DB. Each handler is idempotent.
 */
export async function applyEvent(
  config: ServerConfig,
  ev: LiveKitWebhookEvent,
): Promise<{ applied: boolean; reason?: string }> {
  const sb = getServiceClient(config);
  const session = await resolveCallSession(config, ev);
  if (!session) {
    return { applied: false, reason: 'session_not_found' };
  }

  const recordEvent = async (eventType: string, payload: Record<string, unknown> = {}) => {
    await mustDb(
      await sb.from('call_events').insert({
        call_session_id: session.id,
        event_type: 'lk.' + eventType,
        actor_type: 'internal',
        actor_id: null,
        payload: { ...payload, livekit_event_id: ev.id ?? null },
      }),
      `call_events.insert:${eventType}`,
    );
  };

  switch (ev.event) {
    case 'room_started': {
      // Coverage fix for max_call_minutes_per_month activation:
      // every path that transitions a call to 'active' MUST ensure
      // connected_at is set, otherwise the billable-minute trigger
      // (tg_call_sessions_bill_minutes) silently drops the call.
      // The operator accept route already backfills connected_at; this
      // handles the webhook-driven path (and any other producer that
      // skips the operator accept route). Idempotent: never overwrites
      // an existing connected_at — accept-time is the preferred
      // earlier writer.
      const { data: prev } = await sb
        .from('call_sessions')
        .select('connected_at')
        .eq('id', session.id)
        .maybeSingle();
      const startedIso = new Date(
        (ev.room?.creationTime ?? Math.floor(Date.now() / 1000)) * 1000,
      ).toISOString();
      const patch: Record<string, unknown> = {
        state: 'active',
        started_at: startedIso,
      };
      if (!(prev as { connected_at?: string | null } | null)?.connected_at) {
        patch.connected_at = startedIso;
      }
      await mustDb(
        await sb.from('call_sessions').update(patch).eq('id', session.id),
        'call_sessions.update:room_started',
      );
      await recordEvent('room_started', { sid: ev.room?.sid });
      return { applied: true };
    }
    case 'room_finished': {
      const { data: cur } = await sb
        .from('call_sessions')
        .select('started_at')
        .eq('id', session.id)
        .maybeSingle();
      const startedAt = cur?.started_at ? new Date(cur.started_at).getTime() : null;
      const duration = startedAt ? Math.round((Date.now() - startedAt) / 1000) : null;
      await mustDb(
        await sb
          .from('call_sessions')
          .update({
            state: 'ended',
            ended_at: new Date().toISOString(),
            ...(duration !== null ? { duration_seconds: duration } : {}),
          })
          .eq('id', session.id),
        'call_sessions.update:room_finished',
      );
      await recordEvent('room_finished', { sid: ev.room?.sid });
      // Phase 8D — release any operator availability locks tied to this session.
      try {
        const { data: parts } = await sb
          .from('call_participants')
          .select('participant_id, participant_type')
          .eq('call_session_id', session.id);
        for (const p of parts ?? []) {
          const participant = p as { participant_type?: string; participant_id?: string };
          if (participant.participant_type === 'operator' && participant.participant_id) {
            void clearInCall(config, session.workspace_id, participant.participant_id).catch(() => {});
          }
        }
      } catch {/* best effort */}
      return { applied: true };
    }
    case 'participant_joined': {
      const identity = ev.participant?.identity || '';
      // Best-effort: create/update a call_participants row keyed by identity.
      // Identity format set by livekitProvider: `${type}:${id}`.
      const [pType, pId] = identity.split(':');
      const ptype = (pType === 'visitor' || pType === 'operator' || pType === 'admin' || pType === 'internal')
        ? pType
        : 'internal';
      // Upsert pattern: try update first by provider_participant_id.
      const { data: existing } = await sb
        .from('call_participants')
        .select('id')
        .eq('call_session_id', session.id)
        .eq('provider_participant_id', identity)
        .maybeSingle();
      if (existing) {
        await sb
          .from('call_participants')
          .update({ joined_at: new Date().toISOString(), left_at: null })
          .eq('id', existing.id);
      } else {
        await sb.from('call_participants').insert({
          call_session_id: session.id,
          participant_type: ptype,
          participant_id: pId && /^[0-9a-f-]{36}$/i.test(pId) ? pId : null,
          provider_participant_id: identity,
          joined_at: new Date().toISOString(),
        });
      }
      await recordEvent('participant_joined', { identity });
      // Phase 8D — when an operator actually joins media, lock them as in-call.
      if (ptype === 'operator' && pId && /^[0-9a-f-]{36}$/i.test(pId)) {
        void markInCall(config, session.workspace_id, pId, session.id).catch(() => {});
      }
      return { applied: true };
    }
    case 'participant_left': {
      const identity = ev.participant?.identity || '';
      await sb
        .from('call_participants')
        .update({ left_at: new Date().toISOString() })
        .eq('call_session_id', session.id)
        .eq('provider_participant_id', identity);
      await recordEvent('participant_left', { identity });
      // Phase 8D — operator left media → release busy lock.
      const [pType2, pId2] = identity.split(':');
      if (pType2 === 'operator' && pId2 && /^[0-9a-f-]{36}$/i.test(pId2)) {
        void clearInCall(config, session.workspace_id, pId2).catch(() => {});
      }
      return { applied: true };
    }
    case 'egress_started': {
      const egId = ev.egressInfo?.egressId;
      if (egId) {
        await mustDb(
          await sb.from('call_sessions').update({ recording_state: 'recording' }).eq('id', session.id),
          'call_sessions.update:egress_started',
        );
        // Upsert by provider_recording_id when known. Sixth corrective
        // pass, P0: this lookup gates whether we INSERT a new
        // call_recordings row — a swallowed `{error}` here would be
        // misread as "no existing row" and risk a duplicate insert (or,
        // worse, silently skip the row that egress_ended later needs to
        // update). Fail closed.
        const existing = await mustDb(
          await sb
            .from('call_recordings')
            .select('id')
            .eq('call_session_id', session.id)
            .eq('provider_recording_id', egId)
            .maybeSingle(),
          'call_recordings.select:egress_started.existing',
        );
        if (!existing) {
          // Stamp retention_expires_at at insert time using the workspace's
          // currently-effective recording_retention_days. This locks
          // retention at recording creation — subsequent plan changes do
          // NOT re-stamp existing rows (documented in
          // docs/CALL_RECORDING_RETENTION.md). -1 / unlimited → NULL,
          // which the partial index + janitor query both treat as
          // "never expires".
          const eff = await resolveEffectiveRecordingRetentionDays(config, session.workspace_id);
          const createdAtIso = new Date().toISOString();
          const retentionExpiresAt = computeRetentionExpiresAt(createdAtIso, eff.days);
          // Stamp storage_provider with the workspace's currently-effective
          // selected storage provider (canonical resolveStorageConfig path —
          // same resolver the read/playback/download/archive/janitor flows
          // use). Never hardcode a vendor here: doing so misreports the
          // backing store on multi-provider deployments and prevents
          // accurate provider audits. Legacy rows that pre-date this fix
          // keep their historical tag; read paths route by workspace
          // resolution, not by this column.
          let resolvedProvider = 'local';
          try {
            const sc = await resolveStorageConfig(config, session.workspace_id);
            if (sc?.provider) resolvedProvider = sc.provider;
          } catch {
            // Fall through with 'local' default — never block recording
            // ingest on provider resolution failure.
          }
          await mustDb(
            await sb.from('call_recordings').insert({
              call_session_id: session.id,
              workspace_id: session.workspace_id,
              provider: session.provider,
              provider_recording_id: egId,
              recording_type: 'composite',
              storage_provider: resolvedProvider,
              storage_path: '', // populated on egress_ended with file path
              retention_policy: eff.days < 0 ? 'unlimited' : `${eff.days}d`,
              retention_expires_at: retentionExpiresAt,
              metadata: {
                status: 'recording',
                retention_source: eff.source,
                storage_provider_source: 'workspace_effective',
              },
            }),
            'call_recordings.insert:egress_started',
          );
        }
      }
      await recordEvent('egress_started', { egress_id: egId });
      return { applied: true };
    }
    case 'egress_ended':
    case 'egress_updated': {
      const egId = ev.egressInfo?.egressId;
      const status = ev.egressInfo?.status || '';
      const fileResult = (ev.egressInfo?.fileResults || [])[0];
      let isComplete = status === 'EGRESS_COMPLETE';
      let isFailed = status === 'EGRESS_FAILED' || status === 'EGRESS_ABORTED';

      // The filename LiveKit reports is untrusted input from the webhook
      // boundary — verify it belongs to THIS workspace/call session before
      // ever writing it to call_recordings.storage_path. A mismatch (wrong
      // prefix, wrong session, traversal, or any other shape) fails closed:
      // the path is never persisted and the recording is marked failed
      // rather than silently trusting whatever the payload claims.
      // See docs/STORAGE_ARCHITECTURE_AUDIT.md §11.
      let rejectedFilename: string | null = null;
      if (fileResult?.filename) {
        try {
          assertCallRecordingKey(session.workspace_id, session.id, fileResult.filename);
        } catch (err) {
          rejectedFilename = err instanceof StorageKeyError ? err.message : 'invalid_filename';
        }
      }

      if (egId) {
        const patch: Record<string, unknown> = {};
        if (fileResult?.filename && !rejectedFilename) patch.storage_path = fileResult.filename;
        if (fileResult?.size) patch.size_bytes = fileResult.size;
        if (fileResult?.duration) patch.duration_seconds = Math.round(fileResult.duration);
        if (rejectedFilename) {
          isFailed = true;
          isComplete = false;
        }
        if (Object.keys(patch).length || isComplete || isFailed) {
          await mustDb(
            await sb
              .from('call_recordings')
              .update({
                ...patch,
                metadata: rejectedFilename
                  ? { status: 'rejected', error: 'untrusted_filename', reason: rejectedFilename }
                  : { status, error: ev.egressInfo?.error ?? null },
              })
              .eq('call_session_id', session.id)
              .eq('provider_recording_id', egId),
            'call_recordings.update:egress_ended',
          );
        }
        if (isComplete || isFailed) {
          // Fifth corrective pass, P0 #3: this write is THE terminal
          // signal workspaceDeletion/worker.ts's quiesceLiveKitEgress()
          // waits on. A silently-swallowed `{error}` here (unchecked
          // `await`) would leave recording_state stuck non-terminal
          // forever while the webhook route still marks the event
          // processed and returns 200 — critical enough to throw on any
          // failure rather than continue.
          await mustDb(
            await sb
              .from('call_sessions')
              .update({ recording_state: isFailed ? 'failed' : 'available' })
              .eq('id', session.id),
            'call_sessions.update:egress_ended_terminal',
          );
        }
      }
      await recordEvent('egress_' + (isFailed ? 'failed' : isComplete ? 'ended' : 'updated'), {
        egress_id: egId,
        status,
        ...(rejectedFilename ? { rejected_filename_reason: rejectedFilename } : {}),
      });
      return { applied: true };
    }
    default:
      return { applied: false, reason: 'unhandled_event_type' };
  }
}

/**
 * Mounted with raw body parser so we can hash the exact bytes LiveKit signed.
 * Express's normal json() middleware would re-stringify and break the hash.
 */
livekitWebhookRouter.post(
  '/',
  express.raw({ type: '*/*', limit: '1mb' }),
  async (req, res) => {
    const config: ServerConfig = (req as unknown as { serverConfig: ServerConfig }).serverConfig;
    const rawBody: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');

    // 1. Resolve secret.
    const lk = await loadLiveKitConfig(config);
    const secret = lk.webhook_secret || lk.api_secret;
    if (!secret) {
      return res.status(503).json({ error: 'webhook_not_configured' });
    }

    // 2. Verify JWT (LiveKit sends the JWT in Authorization header, no "Bearer").
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : auth;
    if (!token) {
      return res.status(401).json({ error: 'missing_signature' });
    }
    let payload: jwt.JwtPayload;
    try {
      payload = jwt.verify(token, secret, { algorithms: ['HS256'] }) as jwt.JwtPayload;
    } catch {
      return res.status(401).json({ error: 'invalid_signature' });
    }

    // 3. Verify body hash matches the sha256 claim.
    const expectedSha = createHash('sha256').update(rawBody).digest('base64');
    const claimSha = (payload as jwt.JwtPayload & { sha256?: unknown })?.sha256;
    if (typeof claimSha !== 'string' || claimSha !== expectedSha) {
      return res.status(401).json({ error: 'body_hash_mismatch' });
    }

    // 4. Parse event.
    let ev: LiveKitWebhookEvent;
    try {
      ev = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return res.status(400).json({ error: 'invalid_body' });
    }
    if (!ev?.event) {
      return res.status(400).json({ error: 'missing_event_field' });
    }

    // 5. Dedup using livekit_webhook_events (event id + body hash).
    //
    // Fourth corrective pass, P0: a RECEIVED event and a SUCCESSFULLY
    // APPLIED event are not the same state. The previous version treated
    // "a row with this event_id exists" as permanent dedup — but the row
    // is inserted BEFORE applyEvent() runs, so a transient DB failure
    // inside applyEvent() (caught below, previously still answering 200)
    // left a permanent row with no successful application, and every
    // future retry of the SAME event (LiveKit does retry on non-2xx, but
    // this handler always returned 200) would be silently swallowed as
    // "already seen". For an egress_ended/egress_updated event this can
    // permanently strand call_sessions.recording_state at 'finalizing' —
    // which is exactly the state workspaceDeletion/worker.ts's
    // quiesceLiveKitEgress() waits on — wedging workspace deletion
    // forever. Only a row that is BOTH processed (processed_at set) AND
    // error-free (process_error null) short-circuits as dedup; anything
    // else (still in flight, or a prior attempt threw) is reprocessed —
    // safe because every applyEvent() handler is itself idempotent (see
    // this module's own doc comment).
    const sb = getServiceClient(config);
    const dedupKey = ev.id || expectedSha;
    const { data: existingRow, error: existingRowError } = await sb
      .from('livekit_webhook_events')
      .select('id, processed_at, process_error')
      .eq('event_id', dedupKey)
      .maybeSingle();
    if (existingRowError) {
      // A transient failure on the dedup lookup itself must never be
      // read as "no row yet" — that would fall through to the insert
      // branch below and risk a spurious unique-violation race against a
      // row that genuinely exists. Fail closed: non-2xx, LiveKit retries.
      console.error('[livekit-webhook] dedup lookup failed:', existingRowError.message);
      return res.status(500).json({ ok: false, error: 'dedup_lookup_failed' });
    }

    const alreadyProcessed = !!existingRow && !!existingRow.processed_at && !existingRow.process_error;
    if (alreadyProcessed) {
      emitCallMetric(config, {
        metric: 'call.webhook.dedup',
        provider: 'livekit',
        extra: { event_type: ev.event },
      });
      return res.status(200).json({ ok: true, dedup: true });
    }

    if (!existingRow) {
      // First delivery — insert the audit/dedup row before applying, so a
      // genuinely concurrent duplicate delivery (racing this exact
      // insert, not a retry of a previously-failed attempt) backs off
      // instead of double-applying.
      //
      // Fifth corrective pass, P0 #3: real Supabase/PostgREST resolves
      // this insert as `{ error }` rather than throwing — the previous
      // try/catch here would never actually catch a unique-violation or
      // any other DB failure in production, silently falling through as
      // if the insert had succeeded. Explicitly inspect the error and
      // differentiate: a unique violation on event_id (Postgres code
      // 23505) is the genuine concurrent-duplicate race this branch is
      // meant to catch — safe to treat as dedup. Any OTHER error (a
      // transient DB failure, connection drop, etc.) is NOT a duplicate —
      // treating it as one would silently drop an event that was never
      // actually recorded or applied. The try/catch is kept as defense in
      // depth for a genuine thrown exception (e.g. a network-level
      // failure the client library does throw for), handled the same way
      // as a non-unique-violation `{error}`: fail closed, non-2xx.
      let insertError: { message: string; code?: string } | null = null;
      try {
        const result = await sb.from('livekit_webhook_events').insert({
          event_id: dedupKey,
          event_type: ev.event,
          raw: ev as unknown as Record<string, unknown>,
          room_name: ev.room?.name ?? null,
          participant_identity: ev.participant?.identity ?? null,
          egress_id: ev.egressInfo?.egressId ?? null,
          signature_valid: true,
        });
        insertError = result.error;
      } catch (err: unknown) {
        insertError = { message: err instanceof Error ? err.message : String(err) };
      }
      if (insertError) {
        if (insertError.code === '23505') {
          // Concurrent duplicate delivery — the request that landed
          // first owns applying this event; back off rather than
          // double-apply. If ITS apply fails, a later genuine LiveKit
          // retry will find the row in a not-yet-processed state and
          // reprocess, per the logic above.
          emitCallMetric(config, {
            metric: 'call.webhook.dedup',
            provider: 'livekit',
            extra: { event_type: ev.event, race: true },
          });
          return res.status(200).json({ ok: true, dedup: true });
        }
        // A transient/genuine DB failure, NOT a duplicate — this event
        // was never recorded, so it must remain retryable rather than
        // being silently swallowed as if deduped.
        console.error('[livekit-webhook] dedup insert failed:', insertError.message);
        return res.status(500).json({ ok: false, error: 'dedup_insert_failed' });
      }
    }
    // else: existingRow is present but not yet successfully processed —
    // reprocessing is safe (idempotent handlers); at worst two concurrent
    // retries of a previously-failed event both re-apply harmlessly.

    emitCallMetric(config, {
      metric: 'call.webhook.received',
      provider: 'livekit',
      extra: { event_type: ev.event },
    });

    // 6. Apply.
    try {
      const result = await applyEvent(config, ev);
      // A non-throwing result (applied:true, or applied:false with a
      // reason like 'unhandled_event_type'/'session_not_found') is a
      // successfully resolved delivery either way — nothing to retry.
      await sb
        .from('livekit_webhook_events')
        .update({ processed_at: new Date().toISOString(), process_error: null })
        .eq('event_id', dedupKey);
      return res.status(200).json({ ok: true, applied: result.applied, reason: result.reason });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[livekit-webhook] apply failed:', message);
      await sb
        .from('livekit_webhook_events')
        .update({
          // processed_at stays NULL — this event is NOT permanently
          // resolved, so the dedup check above will reprocess it on the
          // next delivery attempt.
          processed_at: null,
          process_error: message.slice(0, 500) || 'apply_error',
        })
        .eq('event_id', dedupKey);
      // Non-2xx so LiveKit retries. A transient DB failure must never
      // permanently strand an event — e.g. recording_state stuck at
      // 'finalizing' forever, wedging workspace-deletion quiescence.
      return res.status(500).json({ ok: false, error: 'apply_error' });
    }
  },
);