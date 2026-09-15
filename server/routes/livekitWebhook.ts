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

/** Resolve a call session by either provider_room_id or metadata-embedded id. */
async function resolveCallSession(
  config: ServerConfig,
  ev: LiveKitWebhookEvent,
): Promise<{ id: string; workspace_id: string; provider: string } | null> {
  const sb = getServiceClient(config);
  // Prefer the metadata-embedded id (deterministic, set at createRoom).
  const meta = parseRoomMetadata(ev.room?.metadata);
  if (meta.call_session_id) {
    const { data } = await sb
      .from('call_sessions')
      .select('id, workspace_id, provider')
      .eq('id', meta.call_session_id)
      .maybeSingle();
    if (data) return data;
  }
  // Fall back to provider_room_id (the room name we set in createRoom).
  if (ev.room?.name) {
    const { data } = await sb
      .from('call_sessions')
      .select('id, workspace_id, provider')
      .eq('provider_room_id', ev.room.name)
      .maybeSingle();
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
    await sb.from('call_events').insert({
      call_session_id: session.id,
      event_type: 'lk.' + eventType,
      actor_type: 'internal',
      actor_id: null,
      payload: { ...payload, livekit_event_id: ev.id ?? null },
    });
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
      await sb
        .from('call_sessions')
        .update(patch)
        .eq('id', session.id);
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
      await sb
        .from('call_sessions')
        .update({
          state: 'ended',
          ended_at: new Date().toISOString(),
          ...(duration !== null ? { duration_seconds: duration } : {}),
        })
        .eq('id', session.id);
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
        await sb
          .from('call_sessions')
          .update({ recording_state: 'recording' })
          .eq('id', session.id);
        // Upsert by provider_recording_id when known.
        const { data: existing } = await sb
          .from('call_recordings')
          .select('id')
          .eq('call_session_id', session.id)
          .eq('provider_recording_id', egId)
          .maybeSingle();
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
          });
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
          await sb
            .from('call_recordings')
            .update({
              ...patch,
              metadata: rejectedFilename
                ? { status: 'rejected', error: 'untrusted_filename', reason: rejectedFilename }
                : { status, error: ev.egressInfo?.error ?? null },
            })
            .eq('call_session_id', session.id)
            .eq('provider_recording_id', egId);
        }
        if (isComplete || isFailed) {
          await sb
            .from('call_sessions')
            .update({ recording_state: isFailed ? 'failed' : 'available' })
            .eq('id', session.id);
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
    const sb = getServiceClient(config);
    const dedupKey = ev.id || expectedSha;
    {
      const { data: existing } = await sb
        .from('livekit_webhook_events')
        .select('id')
        .eq('event_id', dedupKey)
        .maybeSingle();
      if (existing) {
        emitCallMetric(config, {
          metric: 'call.webhook.dedup',
          provider: 'livekit',
          extra: { event_type: ev.event },
        });
        return res.status(200).json({ ok: true, dedup: true });
      }
    }

    // Insert dedup row first to make the handler idempotent under retries.
    try {
      await sb.from('livekit_webhook_events').insert({
        event_id: dedupKey,
        event_type: ev.event,
        raw: ev as unknown as Record<string, unknown>,
        room_name: ev.room?.name ?? null,
        participant_identity: ev.participant?.identity ?? null,
        egress_id: ev.egressInfo?.egressId ?? null,
        signature_valid: true,
      });
    } catch {
      // Race with a concurrent identical webhook - treat as dedup.
      emitCallMetric(config, {
        metric: 'call.webhook.dedup',
        provider: 'livekit',
        extra: { event_type: ev.event, race: true },
      });
      return res.status(200).json({ ok: true, dedup: true });
    }

    emitCallMetric(config, {
      metric: 'call.webhook.received',
      provider: 'livekit',
      extra: { event_type: ev.event },
    });

    // 6. Apply.
    try {
      const result = await applyEvent(config, ev);
      await sb
        .from('livekit_webhook_events')
        .update({
          processed_at: new Date().toISOString(),
          process_error: result.applied ? null : (result.reason ?? 'not_applied'),
        })
        .eq('event_id', dedupKey);
      return res.status(200).json({ ok: true, applied: result.applied, reason: result.reason });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[livekit-webhook] apply failed:', message);
      await sb
        .from('livekit_webhook_events')
        .update({
          processed_at: new Date().toISOString(),
          process_error: message.slice(0, 500) || 'apply_error',
        })
        .eq('event_id', dedupKey);
      // Still 200: LiveKit will retry on non-2xx. We have the dedup row so
      // we won't double-process; the failed event is logged for ops review.
      return res.status(200).json({ ok: true, applied: false, reason: 'apply_error' });
    }
  },
);