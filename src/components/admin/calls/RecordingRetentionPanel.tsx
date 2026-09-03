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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Loader2, ShieldAlert, AlertTriangle, Archive, Clock, Play, Download, Eye, EyeOff } from 'lucide-react';
import {
  fetchAdminRecordings,
  setAdminRecordingLegalHold,
  fetchAdminRecordingBlob,
  mintAdminRecordingPlaybackToken,
  bulkSetAdminRecordingLegalHold,
  setAdminRecordingRetentionOverride,
  restoreAdminRecordingRetention,
  adoptAdminRecordingRetention,
  type RetentionOverrideInput,
  type AdminRecordingRow,
  type RecordingRetentionStatus,
} from '@/lib/admin-calls-api';
import { RecordingTimeline } from '@/components/recordings/RecordingTimeline';
import { Checkbox } from '@/components/ui/checkbox';
import { ShieldCheck, ShieldOff } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { CalendarClock } from 'lucide-react';
import { useTranslation } from '@/i18n';

const PAGE_SIZE = 25;

export function RetentionStatusBadge({ status }: { status: RecordingRetentionStatus }) {
  const { t } = useTranslation();
  switch (status) {
    case 'on_hold':
      return (
        <Badge variant="secondary" className="gap-1 text-[10px]" data-testid="status-on_hold">
          <ShieldAlert className="h-3 w-3" /> {t('admin.voiceVideo.recordings.statusOnHold' as any)}
        </Badge>
      );
    case 'expired':
      return (
        <Badge variant="destructive" className="gap-1 text-[10px]" data-testid="status-expired">
          <AlertTriangle className="h-3 w-3" /> {t('admin.voiceVideo.recordings.statusExpired' as any)}
        </Badge>
      );
    case 'legacy_unmanaged':
      return (
        <Badge variant="outline" className="gap-1 text-[10px]" data-testid="status-legacy_unmanaged">
          <Archive className="h-3 w-3" /> {t('admin.voiceVideo.recordings.statusLegacy' as any)}
        </Badge>
      );
    case 'expires_at':
    default:
      return (
        <Badge variant="default" className="gap-1 text-[10px]" data-testid="status-expires_at">
          <Clock className="h-3 w-3" /> {t('admin.voiceVideo.recordings.statusRetained' as any)}
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
  const ext =
    String(row.storage_path || '')
      .toLowerCase()
      .split('.')
      .pop() || '';
  const videoExt = new Set(['mp4', 'webm', 'mkv', 'mov']);
  const audioExt = new Set(['mp3', 'm4a', 'wav', 'ogg', 'opus', 'aac']);
  if (videoExt.has(ext)) return 'video';
  if (audioExt.has(ext)) return 'audio';
  if (row.recording_type === 'audio_only') return 'audio';
  if (row.recording_type === 'composite' || row.recording_type === 'individual') return 'video';
  return null;
}

function LegalHoldToggle({ row }: { row: AdminRecordingRow }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const mut = useMutation({
    mutationFn: (enabled: boolean) => setAdminRecordingLegalHold(row.id, enabled, reason.trim() || undefined),
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
          aria-label={t('admin.voiceVideo.recordings.toggleLegalHold' as any, { id: row.id })}
          data-testid={`legal-hold-toggle-${row.id}`}
          onCheckedChange={(next) => mut.mutate(next)}
        />
      </div>
      {!row.legal_hold && (
        <Input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={t('admin.voiceVideo.recordings.reasonOptional' as any)}
          className="h-7 text-[11px] w-44"
          disabled={pending}
          maxLength={500}
        />
      )}
      {mut.isError && (
        <span className="text-[10px] text-destructive max-w-[180px] text-right">
          {(mut.error as Error)?.message || t('admin.voiceVideo.recordings.failed' as any)}
        </span>
      )}
    </div>
  );
}

/**
 * Single-row retention override editor.
 *
 * Mutates ONLY `retention_expires_at` + `retention_policy` via the
 * super-admin `/retention-override` route. Never touches `legal_hold`
 * (the existing per-row Legal hold toggle is the only surface for that).
 * Never deletes — the janitor remains the sole deletion path. No bulk
 * surface, no clear-override (operators set a new explicit value instead).
 *
 * Modes:
 *   • Exact date/time
 *   • Days from now
 *   • Unlimited (clears the stamped expiry; janitor never selects the row)
 */
function RetentionOverrideEditor({ row }: { row: AdminRecordingRow }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'exact' | 'days_from_now' | 'unlimited'>('days_from_now');
  const [days, setDays] = useState<string>('30');
  const [exact, setExact] = useState<string>(''); // datetime-local value
  const [reason, setReason] = useState('');

  const mut = useMutation({
    mutationFn: async () => {
      let input: RetentionOverrideInput;
      if (mode === 'unlimited') {
        input = { mode: 'unlimited', reason: reason.trim() || undefined };
      } else if (mode === 'days_from_now') {
        const n = Number(days);
        if (!Number.isFinite(n) || n < 0 || n > 3650)
          throw new Error(t('admin.voiceVideo.recordings.daysValidation' as any));
        input = { mode: 'days_from_now', days: Math.floor(n), reason: reason.trim() || undefined };
      } else {
        if (!exact) throw new Error(t('admin.voiceVideo.recordings.pickDateTime' as any));
        const iso = new Date(exact).toISOString();
        input = { mode: 'exact', expires_at: iso, reason: reason.trim() || undefined };
      }
      return setAdminRecordingRetentionOverride(row.id, input);
    },
    onSuccess: () => {
      setOpen(false);
      setReason('');
      qc.invalidateQueries({ queryKey: ['admin', 'call-recordings'] });
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) mut.reset();
      }}
    >
      <DialogTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          className="h-6 px-2 text-[10px] gap-1"
          data-testid={`retention-override-open-${row.id}`}
          aria-label={t('admin.voiceVideo.recordings.editOverrideAria' as any, { id: row.id })}
        >
          <CalendarClock className="h-3 w-3" /> {t('admin.voiceVideo.recordings.override' as any)}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md" data-testid={`retention-override-dialog-${row.id}`}>
        <DialogHeader>
          <DialogTitle className="text-sm">{t('admin.voiceVideo.recordings.overrideTitle' as any)}</DialogTitle>
          <DialogDescription className="text-xs">
            {t('admin.voiceVideo.recordings.overrideDescription' as any)}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-[11px]">{t('admin.voiceVideo.recordings.mode' as any)}</Label>
            <Select value={mode} onValueChange={(v) => setMode(v as any)}>
              <SelectTrigger className="h-8 text-xs" data-testid={`retention-override-mode-${row.id}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="days_from_now">{t('admin.voiceVideo.recordings.daysFromNow' as any)}</SelectItem>
                <SelectItem value="exact">{t('admin.voiceVideo.recordings.exactDateTime' as any)}</SelectItem>
                <SelectItem value="unlimited">{t('admin.voiceVideo.recordings.unlimited' as any)}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {mode === 'days_from_now' && (
            <div className="space-y-1">
              <Label className="text-[11px]">{t('admin.voiceVideo.recordings.days' as any)}</Label>
              <Input
                type="number"
                min={0}
                max={3650}
                value={days}
                onChange={(e) => setDays(e.target.value)}
                className="h-8 text-xs w-32"
                data-testid={`retention-override-days-${row.id}`}
              />
            </div>
          )}
          {mode === 'exact' && (
            <div className="space-y-1">
              <Label className="text-[11px]">{t('admin.voiceVideo.recordings.expiresAt' as any)}</Label>
              <Input
                type="datetime-local"
                value={exact}
                onChange={(e) => setExact(e.target.value)}
                className="h-8 text-xs"
                data-testid={`retention-override-exact-${row.id}`}
              />
            </div>
          )}
          <div className="space-y-1">
            <Label className="text-[11px]">{t('admin.voiceVideo.recordings.reasonOptional' as any)}</Label>
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t('admin.voiceVideo.recordings.overrideReasonPlaceholder' as any)}
              maxLength={500}
              className="h-8 text-xs"
            />
          </div>
          <div className="text-[10px] text-muted-foreground">
            {t('admin.voiceVideo.recordings.current' as any)}:{' '}
            {row.retention_expires_at
              ? fmtDate(row.retention_expires_at)
              : t('admin.voiceVideo.recordings.noExpiry' as any)}
            {row.retention_policy ? ` · ${t('admin.voiceVideo.recordings.policy' as any)} ${row.retention_policy}` : ''}
            {row.legal_hold ? ` · ${t('admin.voiceVideo.recordings.legalHoldActive' as any)}` : ''}
          </div>
          {mut.isError && (
            <div className="text-[11px] text-destructive" data-testid={`retention-override-error-${row.id}`}>
              {(mut.error as Error)?.message || t('admin.voiceVideo.recordings.overrideFailed' as any)}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button
            size="sm"
            variant="ghost"
            className="h-8 text-xs"
            disabled={mut.isPending}
            onClick={() => setOpen(false)}
          >
            {t('admin.voiceVideo.recordings.cancel' as any)}
          </Button>
          <Button
            size="sm"
            className="h-8 text-xs gap-1"
            disabled={mut.isPending}
            onClick={() => mut.mutate()}
            data-testid={`retention-override-submit-${row.id}`}
          >
            {mut.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
            {t('admin.voiceVideo.recordings.applyOverride' as any)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Single-row "Restore inherited retention" action.
 *
 * Visible ONLY for rows whose `retention_policy` starts with `override:`.
 * Calls the super-admin `/retention-restore` route which recomputes the
 * row's expiry from the workspace's CURRENT effective retention, anchored
 * at the row's own `created_at`. `legal_hold` is never touched and still
 * wins. The retention janitor remains the sole deletion path. Legacy/
 * unmanaged rows do not see this control and the server refuses them.
 */
function RetentionRestoreButton({ row }: { row: AdminRecordingRow }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const mut = useMutation({
    mutationFn: async () => restoreAdminRecordingRetention(row.id, reason.trim() || undefined),
    onSuccess: () => {
      setOpen(false);
      setReason('');
      qc.invalidateQueries({ queryKey: ['admin', 'call-recordings'] });
    },
  });
  if (!row.retention_policy?.startsWith('override:')) return null;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) mut.reset();
      }}
    >
      <DialogTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-[10px]"
          data-testid={`retention-restore-open-${row.id}`}
          aria-label={t('admin.voiceVideo.recordings.restoreAria' as any, { id: row.id })}
        >
          {t('admin.voiceVideo.recordings.restoreInherited' as any)}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md" data-testid={`retention-restore-dialog-${row.id}`}>
        <DialogHeader>
          <DialogTitle className="text-sm">{t('admin.voiceVideo.recordings.restoreInherited' as any)}</DialogTitle>
          <DialogDescription className="text-xs">
            {t('admin.voiceVideo.recordings.restoreDescription' as any)}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="text-[10px] text-muted-foreground">
            {t('admin.voiceVideo.recordings.current' as any)}:{' '}
            {row.retention_expires_at
              ? fmtDate(row.retention_expires_at)
              : t('admin.voiceVideo.recordings.noExpiry' as any)}
            {row.retention_policy ? ` · ${t('admin.voiceVideo.recordings.policy' as any)} ${row.retention_policy}` : ''}
            {row.legal_hold ? ` · ${t('admin.voiceVideo.recordings.legalHoldActive' as any)}` : ''}
          </div>
          <div className="space-y-1">
            <Label className="text-[11px]">{t('admin.voiceVideo.recordings.reasonOptional' as any)}</Label>
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t('admin.voiceVideo.recordings.restoreReasonPlaceholder' as any)}
              maxLength={500}
              className="h-8 text-xs"
            />
          </div>
          {mut.isError && (
            <div className="text-[11px] text-destructive" data-testid={`retention-restore-error-${row.id}`}>
              {(mut.error as Error)?.message || t('admin.voiceVideo.recordings.restoreFailed' as any)}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button
            size="sm"
            variant="ghost"
            className="h-8 text-xs"
            disabled={mut.isPending}
            onClick={() => setOpen(false)}
          >
            {t('admin.voiceVideo.recordings.cancel' as any)}
          </Button>
          <Button
            size="sm"
            className="h-8 text-xs gap-1"
            disabled={mut.isPending}
            onClick={() => mut.mutate()}
            data-testid={`retention-restore-submit-${row.id}`}
          >
            {mut.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
            {t('admin.voiceVideo.recordings.restoreInherited' as any)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Single-row "Adopt retention" action for legacy/unmanaged rows.
 *
 * Visible ONLY for rows whose `retention_policy` IS NULL AND
 * `retention_expires_at` IS NULL — i.e. rows the janitor today ignores
 * by design. Calls the super-admin `/retention-adopt` route which
 * computes the workspace's current effective retention anchored at the
 * row's own `created_at`, using the same canonical helpers as
 * insert-time stamping and restore-to-inherited. Never touches
 * `legal_hold`. The janitor remains the sole deletion path.
 */
function RetentionAdoptButton({ row }: { row: AdminRecordingRow }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const mut = useMutation({
    mutationFn: async () => adoptAdminRecordingRetention(row.id, reason.trim() || undefined),
    onSuccess: () => {
      setOpen(false);
      setReason('');
      qc.invalidateQueries({ queryKey: ['admin', 'call-recordings'] });
    },
  });
  const isLegacy = row.retention_policy == null && row.retention_expires_at == null;
  if (!isLegacy) return null;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) mut.reset();
      }}
    >
      <DialogTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-[10px]"
          data-testid={`retention-adopt-open-${row.id}`}
          aria-label={t('admin.voiceVideo.recordings.adoptAria' as any, { id: row.id })}
        >
          {t('admin.voiceVideo.recordings.adoptRetention' as any)}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md" data-testid={`retention-adopt-dialog-${row.id}`}>
        <DialogHeader>
          <DialogTitle className="text-sm">{t('admin.voiceVideo.recordings.adoptTitle' as any)}</DialogTitle>
          <DialogDescription className="text-xs">
            {t('admin.voiceVideo.recordings.adoptDescription' as any)}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="text-[10px] text-muted-foreground">
            {t('admin.voiceVideo.recordings.currentlyLegacy' as any)}
            {row.legal_hold ? ` · ${t('admin.voiceVideo.recordings.legalHoldActive' as any)}` : ''}
          </div>
          <div className="space-y-1">
            <Label className="text-[11px]">{t('admin.voiceVideo.recordings.reasonOptional' as any)}</Label>
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t('admin.voiceVideo.recordings.adoptReasonPlaceholder' as any)}
              maxLength={500}
              className="h-8 text-xs"
            />
          </div>
          {mut.isError && (
            <div className="text-[11px] text-destructive" data-testid={`retention-adopt-error-${row.id}`}>
              {(mut.error as Error)?.message || t('admin.voiceVideo.recordings.adoptionFailed' as any)}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button
            size="sm"
            variant="ghost"
            className="h-8 text-xs"
            disabled={mut.isPending}
            onClick={() => setOpen(false)}
          >
            {t('admin.voiceVideo.recordings.cancel' as any)}
          </Button>
          <Button
            size="sm"
            className="h-8 text-xs gap-1"
            disabled={mut.isPending}
            onClick={() => mut.mutate()}
            data-testid={`retention-adopt-submit-${row.id}`}
          >
            {mut.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
            {t('admin.voiceVideo.recordings.adoptRetention' as any)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [kind, setKind] = useState<'audio' | 'video' | 'unsupported' | null>(null);
  // When set, the browser streams directly from this short-lived tokenized
  // URL (native Range support, no full-file Blob buffering). When null we
  // fall back to the Blob+object-URL path which still works but buffers
  // the entire artifact first.
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [streamExpiresAt, setStreamExpiresAt] = useState<string | null>(null);
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    urlRef.current = objectUrl;
  }, [objectUrl]);

  // Always revoke on unmount to avoid leaking object URLs across
  // open/close cycles or page navigations.
  useEffect(() => {
    return () => {
      if (urlRef.current) {
        try {
          URL.revokeObjectURL(urlRef.current);
        } catch {
          /* ignore */
        }
        urlRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const hint = rowMediaKindHint(row);
    // Preferred path: mint a short-lived tokenized URL and let the native
    // media element issue Range requests directly. Only viable when we can
    // commit to audio vs video without first reading bytes.
    const preferTokenized = hint !== null;
    const start = preferTokenized
      ? mintAdminRecordingPlaybackToken(row.id, 'inline')
          .then((tok) => {
            if (cancelled) return;
            setStreamUrl(tok.url);
            setStreamExpiresAt(tok.expires_at);
            setKind(hint);
          })
          .catch((tokErr: any) => {
            // Tokenized mint failed (network, expired session, etc.) —
            // fall back to the bearer-protected Blob path so playback
            // still works.
            if (cancelled) return;
            return fetchAdminRecordingBlob(row.id, 'inline')
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
                setError(e?.message || tokErr?.message || t('admin.voiceVideo.recordings.loadRecordingFailed' as any));
              });
          })
      : fetchAdminRecordingBlob(row.id, 'inline').then(({ blob, contentType }) => {
          if (cancelled) return;
          const k = classifyMediaKind(contentType);
          setKind(k);
          if (k === 'unsupported') {
            setObjectUrl(null);
            return;
          }
          const url = URL.createObjectURL(blob);
          setObjectUrl(url);
        });
    Promise.resolve(start)
      .catch((e: any) => {
        if (cancelled) return;
        setError(e?.message || t('admin.voiceVideo.recordings.loadRecordingFailed' as any));
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
        <Loader2 className="h-3 w-3 animate-spin" /> {t('admin.voiceVideo.recordings.loadingPreview' as any)}
      </div>
    );
  }
  if (error) {
    return (
      <div className="text-[11px] text-destructive" data-testid={`recording-preview-error-${row.id}`}>
        {error}
      </div>
    );
  }
  if (kind === 'unsupported' || !objectUrl) {
    if (streamUrl && (kind === 'audio' || kind === 'video')) {
      // Native streaming path — short-lived tokenized URL, browser issues
      // Range requests directly against the backend playback route.
      return (
        <div className="space-y-1">
          <RecordingTimeline
            src={streamUrl}
            kind={kind}
            recordingId={row.id}
            durationHint={row.duration_seconds ?? null}
            className="w-full max-w-md"
            mediaClassName={kind === 'video' ? 'w-full max-w-md rounded-md bg-black' : 'w-full max-w-md'}
          />
          {streamExpiresAt && (
            <div className="text-[10px] text-muted-foreground">
              {t('admin.voiceVideo.recordings.playbackExpires' as any, {
                time: new Date(streamExpiresAt).toLocaleTimeString(),
              })}
            </div>
          )}
        </div>
      );
    }
    return (
      <div className="text-[11px] text-muted-foreground" data-testid={`recording-preview-unsupported-${row.id}`}>
        {t('admin.voiceVideo.recordings.previewUnsupported' as any)}
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
  const { t } = useTranslation();
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
      setError(e?.message || t('admin.voiceVideo.recordings.loadRecordingFailed' as any));
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
          aria-label={
            previewOpen
              ? t('admin.voiceVideo.recordings.hidePreviewAria' as any, { id: row.id })
              : t('admin.voiceVideo.recordings.previewAria' as any, { id: row.id })
          }
        >
          {previewOpen ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
          <span className="ms-1">
            {previewOpen
              ? t('admin.voiceVideo.recordings.hide' as any)
              : t('admin.voiceVideo.recordings.preview' as any)}
          </span>
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2 text-[11px]"
          disabled={disabled || busy !== null}
          onClick={() => run('inline')}
          data-testid={`recording-open-${row.id}`}
          aria-label={t('admin.voiceVideo.recordings.openAria' as any, { id: row.id })}
        >
          {busy === 'inline' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
          <span className="ms-1">{t('admin.voiceVideo.recordings.open' as any)}</span>
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-[11px]"
          disabled={disabled || busy !== null}
          onClick={() => run('attachment')}
          data-testid={`recording-download-${row.id}`}
          aria-label={t('admin.voiceVideo.recordings.downloadAria' as any, { id: row.id })}
        >
          {busy === 'attachment' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
          <span className="ms-1">{t('admin.voiceVideo.recordings.download' as any)}</span>
        </Button>
      </div>
      {disabled && (
        <span className="text-[10px] text-muted-foreground">{t('admin.voiceVideo.recordings.noArtifact' as any)}</span>
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
  const { t } = useTranslation();
  const [workspaceId, setWorkspaceId] = useState('');
  const [workspaceFilter, setWorkspaceFilter] = useState('');
  const [status, setStatus] = useState<RecordingRetentionStatus | 'all'>('all');
  const [page, setPage] = useState(0);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkReason, setBulkReason] = useState('');
  const [bulkResult, setBulkResult] = useState<null | {
    succeeded: number;
    failures: Array<{ id: string; error: string }>;
    enabled: boolean;
  }>(null);

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
  const qc = useQueryClient();

  // Drop any selected ids that aren't on the current page so the bulk
  // bar never appears to "remember" rows the operator can no longer see.
  useEffect(() => {
    setSelectedIds((cur) => {
      if (cur.size === 0) return cur;
      const visible = new Set(items.map((r) => r.id));
      const next = new Set<string>();
      for (const id of cur) if (visible.has(id)) next.add(id);
      return next.size === cur.size ? cur : next;
    });
  }, [items]);

  const allVisibleSelected = items.length > 0 && items.every((r) => selectedIds.has(r.id));
  const someVisibleSelected = items.some((r) => selectedIds.has(r.id));

  const bulkMut = useMutation({
    mutationFn: (enabled: boolean) =>
      bulkSetAdminRecordingLegalHold(Array.from(selectedIds), enabled, bulkReason.trim() || undefined),
    onSuccess: (r) => {
      setBulkResult({ succeeded: r.succeeded.length, failures: r.failures, enabled: r.enabled });
      setSelectedIds(new Set());
      setBulkReason('');
      qc.invalidateQueries({ queryKey: ['admin', 'call-recordings'] });
    },
  });

  function toggleRow(id: string) {
    setSelectedIds((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAllVisible() {
    setSelectedIds((cur) => {
      if (allVisibleSelected) {
        const next = new Set(cur);
        for (const r of items) next.delete(r.id);
        return next;
      }
      const next = new Set(cur);
      for (const r of items) next.add(r.id);
      return next;
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm flex items-center gap-2">
          <Archive className="h-4 w-4" /> {t('admin.voiceVideo.recordings.title' as any)}
        </CardTitle>
        <CardDescription className="text-xs">
          {t('admin.voiceVideo.recordings.descriptionBefore' as any)} <code>legal_hold</code>.{' '}
          {t('admin.voiceVideo.recordings.descriptionAfter' as any)}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label className="text-[11px]">{t('admin.voiceVideo.recordings.workspaceId' as any)}</Label>
            <div className="flex gap-2">
              <Input
                value={workspaceId}
                onChange={(e) => setWorkspaceId(e.target.value)}
                placeholder={t('admin.voiceVideo.recordings.uuidOptional' as any)}
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
                {t('admin.voiceVideo.recordings.apply' as any)}
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
                  {t('admin.voiceVideo.recordings.clear' as any)}
                </Button>
              )}
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-[11px]">{t('admin.voiceVideo.recordings.status' as any)}</Label>
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
                <SelectItem value="all">{t('admin.voiceVideo.recordings.all' as any)}</SelectItem>
                <SelectItem value="expires_at">{t('admin.voiceVideo.recordings.statusRetained' as any)}</SelectItem>
                <SelectItem value="on_hold">{t('admin.voiceVideo.recordings.statusOnHold' as any)}</SelectItem>
                <SelectItem value="expired">{t('admin.voiceVideo.recordings.statusExpired' as any)}</SelectItem>
                <SelectItem value="legacy_unmanaged">{t('admin.voiceVideo.recordings.statusLegacy' as any)}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="ms-auto text-[11px] text-muted-foreground">
            {q.isFetching
              ? t('admin.voiceVideo.recordings.loading' as any)
              : t('admin.voiceVideo.recordings.total' as any, { count: String(total) })}
          </div>
        </div>

        {selectedIds.size > 0 && (
          <div
            className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-secondary/30 p-2"
            data-testid="bulk-action-bar"
          >
            <span className="text-[11px] font-medium">
              {t('admin.voiceVideo.recordings.selected' as any, { count: String(selectedIds.size) })}
            </span>
            <Input
              value={bulkReason}
              onChange={(e) => setBulkReason(e.target.value)}
              placeholder={t('admin.voiceVideo.recordings.reasonOptional' as any)}
              className="h-7 text-[11px] w-56"
              maxLength={500}
              disabled={bulkMut.isPending}
              data-testid="bulk-reason-input"
            />
            <Button
              size="sm"
              variant="default"
              className="h-7 px-2 text-[11px] gap-1"
              disabled={bulkMut.isPending}
              onClick={() => bulkMut.mutate(true)}
              data-testid="bulk-hold-on"
            >
              {bulkMut.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <ShieldCheck className="h-3 w-3" />}
              {t('admin.voiceVideo.recordings.setHoldOn' as any)}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-[11px] gap-1"
              disabled={bulkMut.isPending}
              onClick={() => bulkMut.mutate(false)}
              data-testid="bulk-hold-off"
            >
              {bulkMut.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <ShieldOff className="h-3 w-3" />}
              {t('admin.voiceVideo.recordings.setHoldOff' as any)}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[11px]"
              disabled={bulkMut.isPending}
              onClick={() => setSelectedIds(new Set())}
              data-testid="bulk-clear"
            >
              {t('admin.voiceVideo.recordings.clear' as any)}
            </Button>
            {bulkMut.isError && (
              <span className="text-[10px] text-destructive">
                {(bulkMut.error as Error)?.message || t('admin.voiceVideo.recordings.bulkFailed' as any)}
              </span>
            )}
          </div>
        )}
        {bulkResult && (
          <div className="text-[11px] text-muted-foreground" data-testid="bulk-result">
            {t('admin.voiceVideo.recordings.bulkApplied' as any, {
              state: bulkResult.enabled
                ? t('admin.voiceVideo.recordings.on' as any)
                : t('admin.voiceVideo.recordings.off' as any),
              count: String(bulkResult.succeeded),
            })}
            {bulkResult.failures.length > 0 && (
              <span className="text-destructive">
                {' '}
                {t('admin.voiceVideo.recordings.failedCount' as any, { count: String(bulkResult.failures.length) })}
              </span>
            )}
          </div>
        )}

        {q.isLoading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-8 justify-center">
            <Loader2 className="h-4 w-4 animate-spin" /> {t('admin.voiceVideo.recordings.loadingRecordings' as any)}
          </div>
        ) : q.isError ? (
          <div className="text-xs text-destructive py-4" data-testid="recordings-error">
            {(q.error as Error)?.message || t('admin.voiceVideo.recordings.loadFailed' as any)}
          </div>
        ) : items.length === 0 ? (
          <div className="text-xs text-muted-foreground py-8 text-center" data-testid="recordings-empty">
            {t('admin.voiceVideo.recordings.empty' as any)}
          </div>
        ) : (
          <div className="overflow-x-auto border border-border rounded-md">
            <table className="w-full text-xs">
              <thead className="bg-secondary/40 text-muted-foreground">
                <tr>
                  <th className="p-2 w-8">
                    <Checkbox
                      checked={allVisibleSelected}
                      onCheckedChange={toggleAllVisible}
                      aria-label={t('admin.voiceVideo.recordings.selectAll' as any)}
                      data-testid="bulk-select-all"
                    />
                  </th>
                  <th className="text-start p-2 font-medium">{t('admin.voiceVideo.recordings.recording' as any)}</th>
                  <th className="text-start p-2 font-medium">{t('admin.voiceVideo.recordings.workspace' as any)}</th>
                  <th className="text-start p-2 font-medium">{t('admin.voiceVideo.recordings.created' as any)}</th>
                  <th className="text-start p-2 font-medium">{t('admin.voiceVideo.recordings.duration' as any)}</th>
                  <th className="text-start p-2 font-medium">{t('admin.voiceVideo.recordings.size' as any)}</th>
                  <th className="text-start p-2 font-medium">{t('admin.voiceVideo.recordings.expires' as any)}</th>
                  <th className="text-start p-2 font-medium">{t('admin.voiceVideo.recordings.status' as any)}</th>
                  <th className="text-start p-2 font-medium">{t('admin.voiceVideo.recordings.artifact' as any)}</th>
                  <th className="text-end p-2 font-medium">{t('admin.voiceVideo.recordings.legalHold' as any)}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((r) => (
                  <Fragment key={r.id}>
                    <tr className="border-t border-border align-top" data-testid={`recording-row-${r.id}`}>
                      <td className="p-2 align-top">
                        <Checkbox
                          checked={selectedIds.has(r.id)}
                          onCheckedChange={() => toggleRow(r.id)}
                          aria-label={t('admin.voiceVideo.recordings.selectRecording' as any, { id: r.id })}
                          data-testid={`bulk-select-${r.id}`}
                        />
                      </td>
                      <td className="p-2 font-mono text-[10px] break-all max-w-[180px]">
                        <div>{r.id}</div>
                        <div className="text-muted-foreground">
                          {r.provider || '—'} · {r.recording_type || '—'}
                        </div>
                      </td>
                      <td className="p-2 font-mono text-[10px] break-all max-w-[180px]">{r.workspace_id || '—'}</td>
                      <td className="p-2 whitespace-nowrap">{fmtDate(r.created_at)}</td>
                      <td className="p-2 whitespace-nowrap">{fmtDuration(r.duration_seconds)}</td>
                      <td className="p-2 whitespace-nowrap">{fmtBytes(r.size_bytes)}</td>
                      <td className="p-2 whitespace-nowrap">
                        <div className="flex flex-col items-start gap-1">
                          <span>{fmtDate(r.retention_expires_at)}</span>
                          {r.retention_policy?.startsWith('override:') && (
                            <span
                              className="text-[10px] text-muted-foreground"
                              data-testid={`retention-overridden-${r.id}`}
                            >
                              {t('admin.voiceVideo.recordings.overridden' as any, {
                                policy: r.retention_policy.replace(/^override:/, ''),
                              })}
                            </span>
                          )}
                          <div className="flex items-center gap-1">
                            <RetentionOverrideEditor row={r} />
                            <RetentionRestoreButton row={r} />
                            <RetentionAdoptButton row={r} />
                          </div>
                        </div>
                      </td>
                      <td className="p-2">
                        <RetentionStatusBadge status={r.status} />
                      </td>
                      <td className="p-2">
                        <ArtifactActions
                          row={r}
                          previewOpen={previewId === r.id}
                          onTogglePreview={() => setPreviewId((cur) => (cur === r.id ? null : r.id))}
                        />
                      </td>
                      <td className="p-2">
                        <LegalHoldToggle row={r} />
                      </td>
                    </tr>
                    {previewId === r.id && (
                      <tr
                        className="border-t border-border bg-secondary/20"
                        data-testid={`recording-preview-row-${r.id}`}
                      >
                        <td colSpan={10} className="p-3">
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
            {t('admin.voiceVideo.recordings.pageOf' as any, { page: String(page + 1), total: String(maxPage + 1) })}
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={page === 0 || q.isFetching}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              {t('admin.voiceVideo.recordings.previous' as any)}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={page >= maxPage || q.isFetching}
              onClick={() => setPage((p) => Math.min(maxPage, p + 1))}
            >
              {t('admin.voiceVideo.recordings.next' as any)}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default RecordingRetentionPanel;
