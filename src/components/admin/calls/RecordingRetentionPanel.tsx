/**
 * Recording Retention Operability Panel — super-admin only.
 *
 * Read-mostly UI over the LIVE backend contract:
 *   GET  /api/admin/calls/recordings
 *   POST /api/admin/calls/recordings/:id/legal-hold
 *
 * Intentional non-features (do not add without a separate, audited pass):
 *   • No delete action — the retention janitor is the sole deletion path.
 *   • No edit of retention_expires_at — stamping is immutable post-creation.
 *   • No implicit backfill for legacy_unmanaged rows.
 *   • No bulk actions.
 */
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Loader2, ShieldAlert, AlertTriangle, Archive, Clock, Play, Download, Eye, EyeOff } from 'lucide-react';
import {
  fetchAdminRecordings,
  setAdminRecordingLegalHold,
  fetchAdminRecordingBlob,
  mintAdminRecordingPlaybackToken,
  type AdminRecordingRow,
  type RecordingRetentionStatus,
} from '@/lib/admin-calls-api';

const PAGE_SIZE = 25;

export function RetentionStatusBadge({ status }: { status: RecordingRetentionStatus }) {
  switch (status) {
    case 'on_hold':
      return (
        <Badge variant="secondary" className="gap-1 text-[10px]" data-testid="status-on_hold">
          <ShieldAlert className="h-3 w-3" /> Legal hold
        </Badge>
      );
    case 'expired':
      return (
        <Badge variant="destructive" className="gap-1 text-[10px]" data-testid="status-expired">
          <AlertTriangle className="h-3 w-3" /> Expired (pending janitor)
        </Badge>
      );
    case 'legacy_unmanaged':
      return (
        <Badge variant="outline" className="gap-1 text-[10px]" data-testid="status-legacy_unmanaged">
          <Archive className="h-3 w-3" /> Legacy (unmanaged)
        </Badge>
      );
    case 'expires_at':
    default:
      return (
        <Badge variant="default" className="gap-1 text-[10px]" data-testid="status-expires_at">
          <Clock className="h-3 w-3" /> Retained
        </Badge>
      );
  }
}

function fmtDate(s: string | null): string {
  if (!s) return '—';
  try {
    return new Date(s).toLocaleString();
  } catch {
    return s;
  }
}

function fmtBytes(n: number | null): string {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function fmtDuration(sec: number | null): string {
  if (sec == null) return '—';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}m ${s}s`;
}

/**
 * Classify a content-type into the minimal native player we can use
 * inline. Anything not reliably previewable by a browser <audio>/<video>
 * element falls through to `unsupported`, where the UI keeps Open/Save
 * available but refuses to fake playback.
 */
function classifyMediaKind(contentType: string): 'audio' | 'video' | 'unsupported' {
  const ct = (contentType || '').toLowerCase();
  if (ct.startsWith('audio/')) return 'audio';
  if (ct.startsWith('video/')) return 'video';
  return 'unsupported';
}

/**
 * Best-effort media-kind hint derived from row metadata. Used to pick the
 * right native element when we hand the browser a tokenized streaming URL
 * (no bytes fetched yet, so we can't read Content-Type). Mirrors the
 * server-side `guessContentType` mapping. Returns `null` when the row is
 * too ambiguous to commit, in which case the UI falls back to the Blob
 * path which DOES know the real Content-Type.
 */
function rowMediaKindHint(row: AdminRecordingRow): 'audio' | 'video' | null {
  const ext = String(row.storage_path || '').toLowerCase().split('.').pop() || '';
  const videoExt = new Set(['mp4', 'webm', 'mkv', 'mov']);
  const audioExt = new Set(['mp3', 'm4a', 'wav', 'ogg', 'opus', 'aac']);
  if (videoExt.has(ext)) return 'video';
  if (audioExt.has(ext)) return 'audio';
  if (row.recording_type === 'audio_only') return 'audio';
  if (row.recording_type === 'composite' || row.recording_type === 'individual') return 'video';
  return null;
}

function LegalHoldToggle({ row }: { row: AdminRecordingRow }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const mut = useMutation({
    mutationFn: (enabled: boolean) =>
      setAdminRecordingLegalHold(row.id, enabled, reason.trim() || undefined),
    onSuccess: () => {
      setReason('');
      qc.invalidateQueries({ queryKey: ['admin', 'call-recordings'] });
    },
  });
  const pending = mut.isPending;
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        {pending && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
        <Switch
          checked={!!row.legal_hold}
          disabled={pending}
          aria-label={`Toggle legal hold for recording ${row.id}`}
          data-testid={`legal-hold-toggle-${row.id}`}
          onCheckedChange={(next) => mut.mutate(next)}
        />
      </div>
      {!row.legal_hold && (
        <Input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason (optional)"
          className="h-7 text-[11px] w-44"
          disabled={pending}
          maxLength={500}
        />
      )}
      {mut.isError && (
        <span className="text-[10px] text-destructive max-w-[180px] text-right">
          {(mut.error as Error)?.message || 'Failed'}
        </span>
      )}
    </div>
  );
}

/**
 * Inline read-only preview surface for a single recording row.
 *
 * • Bytes flow through the existing super-admin file proxy via
 *   `fetchAdminRecordingBlob` — no provider URL or signed link is
 *   ever attached to the <audio>/<video> element.
 * • Fetch only happens when the operator explicitly toggles preview
 *   open; collapsing or unmounting revokes the object URL.
 * • Unknown / non-audio-video formats degrade to an explicit
 *   "preview unsupported" hint that preserves Open/Save fallbacks.
 */
function InlinePreview({ row }: { row: AdminRecordingRow }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [kind, setKind] = useState<'audio' | 'video' | 'unsupported' | null>(null);
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    urlRef.current = objectUrl;
  }, [objectUrl]);

  // Always revoke on unmount to avoid leaking object URLs across
  // open/close cycles or page navigations.
  useEffect(() => {
    return () => {
      if (urlRef.current) {
        try { URL.revokeObjectURL(urlRef.current); } catch { /* ignore */ }
        urlRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchAdminRecordingBlob(row.id, 'inline')
      .then(({ blob, contentType }) => {
        if (cancelled) return;
        const k = classifyMediaKind(contentType);
        setKind(k);
        if (k === 'unsupported') {
          setObjectUrl(null);
          return;
        }
        const url = URL.createObjectURL(blob);
        setObjectUrl(url);
      })
      .catch((e: any) => {
        if (cancelled) return;
        setError(e?.message || 'Failed to load recording');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [row.id]);

  if (loading) {
    return (
      <div
        className="flex items-center gap-2 text-[11px] text-muted-foreground"
        data-testid={`recording-preview-loading-${row.id}`}
      >
        <Loader2 className="h-3 w-3 animate-spin" /> Loading preview…
      </div>
    );
  }
  if (error) {
    return (
      <div
        className="text-[11px] text-destructive"
        data-testid={`recording-preview-error-${row.id}`}
      >
        {error}
      </div>
    );
  }
  if (kind === 'unsupported' || !objectUrl) {
    return (
      <div
        className="text-[11px] text-muted-foreground"
        data-testid={`recording-preview-unsupported-${row.id}`}
      >
        Inline preview is not supported for this file type. Use Save to download it.
      </div>
    );
  }
  if (kind === 'audio') {
    return (
      <audio
        controls
        preload="metadata"
        src={objectUrl}
        className="w-full max-w-md"
        data-testid={`recording-preview-audio-${row.id}`}
      />
    );
  }
  return (
    <video
      controls
      preload="metadata"
      src={objectUrl}
      className="w-full max-w-md rounded-md bg-black"
      data-testid={`recording-preview-video-${row.id}`}
    />
  );
}

/**
 * Read-only artifact access (open inline / download). Bytes are fetched
 * through the authed super-admin proxy and surfaced via an in-memory
 * object URL; no provider URL or signed link is exposed to the browser.
 */
function ArtifactActions({
  row,
  previewOpen,
  onTogglePreview,
}: {
  row: AdminRecordingRow;
  previewOpen: boolean;
  onTogglePreview: () => void;
}) {
  const [busy, setBusy] = useState<null | 'inline' | 'attachment'>(null);
  const [error, setError] = useState<string | null>(null);
  const disabled = !row.storage_path;

  async function run(mode: 'inline' | 'attachment') {
    setBusy(mode);
    setError(null);
    try {
      const { blob, filename } = await fetchAdminRecordingBlob(row.id, mode);
      const url = URL.createObjectURL(blob);
      if (mode === 'attachment') {
        const a = document.createElement('a');
        a.href = url;
        a.download = filename || `recording-${row.id}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
      } else {
        window.open(url, '_blank', 'noopener,noreferrer');
      }
      // Revoke after a short delay so the new tab / download has time to read it.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e: any) {
      setError(e?.message || 'Failed to load recording');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <div className="flex gap-1">
        <Button
          size="sm"
          variant={previewOpen ? 'default' : 'outline'}
          className="h-7 px-2 text-[11px]"
          disabled={disabled}
          onClick={onTogglePreview}
          data-testid={`recording-preview-toggle-${row.id}`}
          aria-pressed={previewOpen}
          aria-label={previewOpen ? `Hide preview for ${row.id}` : `Preview recording ${row.id}`}
        >
          {previewOpen ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
          <span className="ml-1">{previewOpen ? 'Hide' : 'Preview'}</span>
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2 text-[11px]"
          disabled={disabled || busy !== null}
          onClick={() => run('inline')}
          data-testid={`recording-open-${row.id}`}
          aria-label={`Open recording ${row.id}`}
        >
          {busy === 'inline' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
          <span className="ml-1">Open</span>
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-[11px]"
          disabled={disabled || busy !== null}
          onClick={() => run('attachment')}
          data-testid={`recording-download-${row.id}`}
          aria-label={`Download recording ${row.id}`}
        >
          {busy === 'attachment' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
          <span className="ml-1">Save</span>
        </Button>
      </div>
      {disabled && (
        <span className="text-[10px] text-muted-foreground">No stored artifact</span>
      )}
      {error && (
        <span className="text-[10px] text-destructive max-w-[180px]" data-testid={`recording-error-${row.id}`}>
          {error}
        </span>
      )}
    </div>
  );
}

export function RecordingRetentionPanel() {
  const [workspaceId, setWorkspaceId] = useState('');
  const [workspaceFilter, setWorkspaceFilter] = useState('');
  const [status, setStatus] = useState<RecordingRetentionStatus | 'all'>('all');
  const [page, setPage] = useState(0);
  const [previewId, setPreviewId] = useState<string | null>(null);

  const params = useMemo(
    () => ({
      workspace_id: workspaceFilter || undefined,
      status: status === 'all' ? undefined : status,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    }),
    [workspaceFilter, status, page],
  );

  const q = useQuery({
    queryKey: ['admin', 'call-recordings', params],
    queryFn: () => fetchAdminRecordings(params),
  });

  const items = q.data?.items ?? [];
  const total = q.data?.total ?? 0;
  const maxPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm flex items-center gap-2">
          <Archive className="h-4 w-4" /> Recording retention
        </CardTitle>
        <CardDescription className="text-xs">
          Super-admin visibility for call recordings. Deletion is performed exclusively by the
          retention janitor — this surface only toggles <code>legal_hold</code>. Recordings without
          a stamped expiry are labeled <em>Legacy (unmanaged)</em> and intentionally left untouched.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label className="text-[11px]">Workspace ID</Label>
            <div className="flex gap-2">
              <Input
                value={workspaceId}
                onChange={(e) => setWorkspaceId(e.target.value)}
                placeholder="UUID (optional)"
                className="h-8 w-72 text-xs"
                data-testid="workspace-filter-input"
              />
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setPage(0);
                  setWorkspaceFilter(workspaceId.trim());
                }}
              >
                Apply
              </Button>
              {workspaceFilter && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setWorkspaceId('');
                    setWorkspaceFilter('');
                    setPage(0);
                  }}
                >
                  Clear
                </Button>
              )}
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-[11px]">Status</Label>
            <Select
              value={status}
              onValueChange={(v) => {
                setStatus(v as any);
                setPage(0);
              }}
            >
              <SelectTrigger className="h-8 w-48 text-xs" data-testid="status-filter">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="expires_at">Retained</SelectItem>
                <SelectItem value="on_hold">Legal hold</SelectItem>
                <SelectItem value="expired">Expired (pending janitor)</SelectItem>
                <SelectItem value="legacy_unmanaged">Legacy (unmanaged)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="ml-auto text-[11px] text-muted-foreground">
            {q.isFetching ? 'Loading…' : `${total} total`}
          </div>
        </div>

        {q.isLoading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-8 justify-center">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading recordings…
          </div>
        ) : q.isError ? (
          <div className="text-xs text-destructive py-4" data-testid="recordings-error">
            {(q.error as Error)?.message || 'Failed to load recordings.'}
          </div>
        ) : items.length === 0 ? (
          <div className="text-xs text-muted-foreground py-8 text-center" data-testid="recordings-empty">
            No recordings match the current filters.
          </div>
        ) : (
          <div className="overflow-x-auto border border-border rounded-md">
            <table className="w-full text-xs">
              <thead className="bg-secondary/40 text-muted-foreground">
                <tr>
                  <th className="text-left p-2 font-medium">Recording</th>
                  <th className="text-left p-2 font-medium">Workspace</th>
                  <th className="text-left p-2 font-medium">Created</th>
                  <th className="text-left p-2 font-medium">Duration</th>
                  <th className="text-left p-2 font-medium">Size</th>
                  <th className="text-left p-2 font-medium">Expires</th>
                  <th className="text-left p-2 font-medium">Status</th>
                  <th className="text-left p-2 font-medium">Artifact</th>
                  <th className="text-right p-2 font-medium">Legal hold</th>
                </tr>
              </thead>
              <tbody>
                {items.map((r) => (
                  <Fragment key={r.id}>
                  <tr className="border-t border-border align-top" data-testid={`recording-row-${r.id}`}>
                    <td className="p-2 font-mono text-[10px] break-all max-w-[180px]">
                      <div>{r.id}</div>
                      <div className="text-muted-foreground">
                        {r.provider || '—'} · {r.recording_type || '—'}
                      </div>
                    </td>
                    <td className="p-2 font-mono text-[10px] break-all max-w-[180px]">
                      {r.workspace_id || '—'}
                    </td>
                    <td className="p-2 whitespace-nowrap">{fmtDate(r.created_at)}</td>
                    <td className="p-2 whitespace-nowrap">{fmtDuration(r.duration_seconds)}</td>
                    <td className="p-2 whitespace-nowrap">{fmtBytes(r.size_bytes)}</td>
                    <td className="p-2 whitespace-nowrap">{fmtDate(r.retention_expires_at)}</td>
                    <td className="p-2"><RetentionStatusBadge status={r.status} /></td>
                    <td className="p-2">
                      <ArtifactActions
                        row={r}
                        previewOpen={previewId === r.id}
                        onTogglePreview={() =>
                          setPreviewId((cur) => (cur === r.id ? null : r.id))
                        }
                      />
                    </td>
                    <td className="p-2"><LegalHoldToggle row={r} /></td>
                  </tr>
                  {previewId === r.id && (
                    <tr
                      className="border-t border-border bg-secondary/20"
                      data-testid={`recording-preview-row-${r.id}`}
                    >
                      <td colSpan={9} className="p-3">
                        <InlinePreview row={r} />
                      </td>
                    </tr>
                  )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex items-center justify-between pt-2">
          <div className="text-[11px] text-muted-foreground">
            Page {page + 1} of {maxPage + 1}
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={page === 0 || q.isFetching}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              Previous
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={page >= maxPage || q.isFetching}
              onClick={() => setPage((p) => Math.min(maxPage, p + 1))}
            >
              Next
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default RecordingRetentionPanel;