/**
 * Tokenized super-admin recording playback (read-only).
 *
 *   GET /api/calls/recording-playback/:id?token=...&disposition=inline|attachment
 *
 * This is the streaming endpoint a native <audio>/<video> element can use
 * as its `src`. It is intentionally NOT mounted under /api/admin and is NOT
 * protected by the bearer-based super-admin middleware, because the browser
 * cannot attach an Authorization header to media element requests. Access
 * is instead controlled by the short-lived HMAC token minted by
 *
 *   POST /api/admin/calls/recordings/:id/playback-token
 *
 * which IS bearer-protected and super-admin scoped.
 *
 * Bytes are streamed through the canonical storage abstraction
 * (downloadFileRange) — the same helper the existing admin file proxy
 * uses. Range requests are honored to keep large-recording playback cheap.
 *
 * This route never:
 *   • exposes provider URLs or credentials
 *   • writes to call_recordings or storage
 *   • mutates retention / legal-hold state
 *
 * The retention janitor remains the sole deletion path.
 */
import { Router } from 'express';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { downloadFileRange } from '../services/storage/index.js';
import { verifyPlaybackToken } from '../services/calls/recordingPlaybackToken.js';

/**
 * Explicit narrowing helper: the server tsconfig runs with
 * `strictNullChecks: false`, where `if (!verdict.ok)` does not discriminate
 * the `ok: true | false` union. This guard checks exactly the same runtime
 * condition the route already used — no behavior change.
 */
type PlaybackVerdict = ReturnType<typeof verifyPlaybackToken>;

function isPlaybackFailure(
  verdict: PlaybackVerdict,
): verdict is Extract<PlaybackVerdict, { ok: false }> {
  return verdict.ok === false;
}

export const recordingPlaybackRouter = Router();

function guessContentType(row: any): string {
  const path = String(row?.storage_path || '').toLowerCase();
  const ext = path.includes('.') ? path.split('.').pop() || '' : '';
  const byExt: Record<string, string> = {
    mp4: 'video/mp4',
    webm: 'video/webm',
    mkv: 'video/x-matroska',
    ogg: 'audio/ogg',
    m4a: 'audio/mp4',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    opus: 'audio/ogg',
  };
  if (ext && byExt[ext]) return byExt[ext];
  if (row?.recording_type === 'audio_only') return 'audio/mp4';
  if (row?.recording_type === 'composite' || row?.recording_type === 'individual') return 'video/mp4';
  return 'application/octet-stream';
}

function downloadFileName(row: any, ct: string): string {
  const ts = row?.created_at ? new Date(row.created_at).toISOString().replace(/[:.]/g, '-') : 'recording';
  const extFromCt: Record<string, string> = {
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/x-matroska': 'mkv',
    'audio/ogg': 'ogg',
    'audio/mp4': 'm4a',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
  };
  const ext = extFromCt[ct] || 'bin';
  return `call-recording-${String(row?.id || 'unknown').slice(0, 12)}-${ts}.${ext}`;
}

recordingPlaybackRouter.get('/:id', async (req, res) => {
  const config: ServerConfig = (req as any).serverConfig;
  const id = String(req.params.id || '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'invalid_id' });

  const token = typeof req.query.token === 'string' ? req.query.token : undefined;
  const verdict = verifyPlaybackToken(config, id, token);
  if (isPlaybackFailure(verdict)) {
    const status =
      verdict.reason === 'expired'
        ? 401
        : verdict.reason === 'missing_token' || verdict.reason === 'malformed_token'
          ? 400
          : 403;
    return res.status(status).json({ error: verdict.reason });
  }

  const sb = getServiceClient(config);
  const { data: row, error } = await sb
    .from('call_recordings')
    .select('id, storage_path, recording_type, created_at, call_sessions!inner(workspace_id)')
    .eq('id', id)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!row) return res.status(404).json({ error: 'not_found' });

  const storagePath = (row as any).storage_path as string | null;
  const workspaceId = (row as any)?.call_sessions?.workspace_id as string | undefined;
  if (!storagePath) return res.status(410).json({ error: 'missing_storage_path' });
  if (!workspaceId) return res.status(409).json({ error: 'orphan_session' });

  const rangeHeader = typeof req.headers.range === 'string' ? req.headers.range : undefined;
  const dl = await downloadFileRange(config, workspaceId, storagePath, rangeHeader);
  if (!dl.success || !dl.data) {
    if (dl.status === 416) {
      if (dl.totalSize != null) res.setHeader('Content-Range', `bytes */${dl.totalSize}`);
      return res.status(416).json({ error: 'range_not_satisfiable' });
    }
    const msg = String(dl.error || '').toLowerCase();
    if (dl.status === 404 || msg.includes('404') || msg.includes('not found') || msg.includes('no such')) {
      return res.status(404).json({ error: 'storage_object_missing' });
    }
    return res.status(502).json({ error: 'provider_download_failed', detail: dl.error || null });
  }

  const ct = guessContentType(row);
  // The token's disposition is the upper bound; query disposition can only
  // narrow inline (default) and never escalate inline-only tokens to a
  // forced download.
  const tokenAllowsAttachment = verdict.claims.disposition === 'attachment';
  const wantAttachment =
    tokenAllowsAttachment && String(req.query.disposition || '').toLowerCase() === 'attachment';
  const fname = downloadFileName(row, ct);

  res.setHeader('Content-Type', ct);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader(
    'Content-Disposition',
    `${wantAttachment ? 'attachment' : 'inline'}; filename="${fname.replace(/"/g, '')}"`,
  );
  if (dl.contentLength != null) res.setHeader('Content-Length', String(dl.contentLength));
  if (rangeHeader && dl.status === 206) {
    if (dl.contentRange) res.setHeader('Content-Range', dl.contentRange);
    res.status(206);
  }
  return res.send(dl.data);
});