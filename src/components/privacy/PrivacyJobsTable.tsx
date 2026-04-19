/**
 * Shared table of privacy jobs. Used by both Settings → Privacy (self) and
 * the workspace admin Privacy Requests page.
 */
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Loader2, Download, X, AlertCircle } from 'lucide-react';
import { PrivacyJobStatusBadge } from './PrivacyJobStatusBadge';
import { useCancelPrivacyJob, downloadExport } from '@/hooks/usePrivacyJobs';
import { toast } from '@/hooks/use-toast';
import type { PrivacyJob } from '@/lib/privacy-api';
import { useTranslation } from '@/i18n';

function maskEmail(email?: string | null): string {
  if (!email) return '—';
  const [u, d] = email.split('@');
  if (!d) return email;
  const head = u.length <= 2 ? u[0] : u.slice(0, 2);
  return `${head}***@${d}`;
}

function maskHash(hash?: string | null): string {
  return hash ? `subject:${hash.slice(0, 8)}…` : '—';
}

function fmt(dt?: string | null): string {
  return dt ? new Date(dt).toLocaleString() : '—';
}

export interface PrivacyJobsTableProps {
  jobs: PrivacyJob[];
  isLoading?: boolean;
  showActor?: boolean;
}

export function PrivacyJobsTable({ jobs, isLoading, showActor = false }: PrivacyJobsTableProps) {
  const { t } = useTranslation();
  const cancel = useCancelPrivacyJob();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-10">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!jobs.length) {
    return (
      <div className="text-center py-10 text-sm text-muted-foreground">
        {t('privacy.requests.empty')}
      </div>
    );
  }

  const handleDownload = async (id: string) => {
    try { await downloadExport(id); }
    catch (e: any) {
      toast({ title: t('privacy.download.failed'), description: e?.message, variant: 'destructive' });
    }
  };

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('privacy.table.action')}</TableHead>
          <TableHead>{t('privacy.table.subject')}</TableHead>
          {showActor && <TableHead>{t('privacy.table.actor')}</TableHead>}
          <TableHead>{t('privacy.table.requestedAt')}</TableHead>
          <TableHead>{t('privacy.table.completedAt')}</TableHead>
          <TableHead>{t('common.status')}</TableHead>
          <TableHead className="text-end">{t('common.actions')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {jobs.map((j) => {
          const subject = j.resolved_identity?.emails?.[0]
            ? maskEmail(j.resolved_identity.emails[0])
            : maskHash(j.subject_email_hash);
          return (
            <TableRow key={j.id}>
              <TableCell className="font-medium capitalize">
                {t(`privacy.action.${j.action}` as any)}
                <span className="ms-1 text-xs text-muted-foreground">({j.subject_type})</span>
              </TableCell>
              <TableCell className="text-sm">{subject}</TableCell>
              {showActor && (
                <TableCell className="text-xs text-muted-foreground font-mono">
                  {j.actor_user_id.slice(0, 8)}…
                </TableCell>
              )}
              <TableCell className="text-xs text-muted-foreground">{fmt(j.requested_at)}</TableCell>
              <TableCell className="text-xs text-muted-foreground">{fmt(j.completed_at)}</TableCell>
              <TableCell>
                <PrivacyJobStatusBadge status={j.status} />
                {j.status === 'failed' && j.error_message && (
                  <div className="flex items-center gap-1 text-xs text-destructive mt-1">
                    <AlertCircle className="w-3 h-3" />
                    <span className="truncate max-w-[200px]" title={j.error_message}>
                      {j.error_message}
                    </span>
                  </div>
                )}
              </TableCell>
              <TableCell className="text-end space-x-1.5">
                {j.action === 'export' && j.status === 'completed' && j.artifact_path && (
                  <Button size="sm" variant="outline" onClick={() => handleDownload(j.id)} className="gap-1.5">
                    <Download className="w-3.5 h-3.5" />
                    {t('privacy.download.button')}
                  </Button>
                )}
                {j.status === 'pending' && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => cancel.mutate(j.id)}
                    disabled={cancel.isPending}
                    className="gap-1.5"
                  >
                    <X className="w-3.5 h-3.5" />
                    {t('common.cancel')}
                  </Button>
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
