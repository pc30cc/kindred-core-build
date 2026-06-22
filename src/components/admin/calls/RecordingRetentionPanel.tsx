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
import { useMemo, useState } from 'react';
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
import { Loader2, ShieldAlert, AlertTriangle, Archive, Clock } from 'lucide-react';
import {
  fetchAdminRecordings,
  setAdminRecordingLegalHold,
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

export function RecordingRetentionPanel() {
  const [workspaceId, setWorkspaceId] = useState('');
  const [workspaceFilter, setWorkspaceFilter] = useState('');
  const [status, setStatus] = useState<RecordingRetentionStatus | 'all'>('all');
  const [page, setPage] = useState(0);

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
                  <th className="text-right p-2 font-medium">Legal hold</th>
                </tr>
              </thead>
              <tbody>
                {items.map((r) => (
                  <tr key={r.id} className="border-t border-border align-top" data-testid={`recording-row-${r.id}`}>
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
                    <td className="p-2"><LegalHoldToggle row={r} /></td>
                  </tr>
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