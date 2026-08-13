/**
 * Privacy actions for an individual contact. Visible only to workspace admins.
 * Renders inside the contact drawer / detail view.
 *
 * Export: admin re-auth NOT required by backend; we still surface scope copy.
 * Delete: re-auth REQUIRED by backend, plus typed confirmation.
 */
import { useState } from 'react';
import { useTranslation } from '@/i18n';
import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { useWorkspaceRole, isWorkspaceAdmin } from '@/hooks/useWorkspaceRole';
import { useCreatePrivacyJob, usePrivacyJobs } from '@/hooks/usePrivacyJobs';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Download, Trash2, Loader2, Info, ShieldCheck } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { ReauthDialog } from './ReauthDialog';
import { ConfirmDeleteDialog } from './ConfirmDeleteDialog';
import { PrivacyJobStatusBadge } from './PrivacyJobStatusBadge';

interface Props {
  contactId: string;
  contactLabel?: string;
}

export function ContactPrivacyActions({ contactId, contactLabel }: Props) {
  const { t } = useTranslation();
  const { workspace } = useActiveWorkspace();
  const { data: role } = useWorkspaceRole(workspace?.id);
  const create = useCreatePrivacyJob();
  const { data: jobsData } = usePrivacyJobs(workspace?.id, isWorkspaceAdmin(role));

  const [reauthOpen, setReauthOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [reauthToken, setReauthToken] = useState<string | null>(null);

  if (!isWorkspaceAdmin(role)) return null;

  // Most-recent job that touched this subject
  const lastJob = jobsData?.jobs?.find((j) => j.subject_id === contactId && j.subject_type === 'contact');

  const runExport = async () => {
    if (!workspace) return;
    try {
      await create.mutateAsync({
        subject_type: 'contact',
        subject_id: contactId,
        action: 'export',
        workspace_id: workspace.id,
        scope: { include_notes: false },
      });
      toast({ title: t('privacy.toast.exportQueued'), description: t('privacy.toast.exportQueuedDesc') });
    } catch (e: any) {
      toast({ title: t('privacy.toast.failed'), description: e?.message, variant: 'destructive' });
    }
  };

  const startDelete = () => setReauthOpen(true);
  const onReauthed = (token: string) => { setReauthToken(token); setDeleteOpen(true); };

  const runDelete = async () => {
    if (!workspace || !reauthToken) return;
    try {
      await create.mutateAsync({
        subject_type: 'contact',
        subject_id: contactId,
        action: 'delete',
        workspace_id: workspace.id,
        reauth_token: reauthToken,
      });
      toast({ title: t('privacy.toast.deleteQueued'), description: t('privacy.toast.deleteQueuedDesc') });
      setDeleteOpen(false);
    } catch (e: any) {
      toast({ title: t('privacy.toast.failed'), description: e?.message, variant: 'destructive' });
    } finally {
      setReauthToken(null);
    }
  };

  return (
    <Card className="border-warning/30 text-start">
      <CardHeader className="text-start">
        <CardTitle className="text-base flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-warning" />
          {t('privacy.contact.title')}
        </CardTitle>
        <CardDescription className="text-xs">{t('privacy.contact.subtitle')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-start">
        <Alert>
          <Info className="h-4 w-4" />
          <AlertTitle className="text-xs">{t('privacy.scope.title')}</AlertTitle>
          <AlertDescription className="text-xs space-y-0.5 mt-1">
            <p>• {t('privacy.scope.exportedContact')}</p>
            <p>• {t('privacy.scope.notesExcluded')}</p>
            <p>• {t('privacy.scope.anonymizedContact')}</p>
            <p>• {t('privacy.scope.operatorScrubbed')}</p>
            <p>• {t('privacy.scope.retainedContact')}</p>
          </AlertDescription>
        </Alert>

        {lastJob && (
          <div className="text-xs text-muted-foreground flex items-center gap-2">
            {t('privacy.contact.lastJob', { action: t(`privacy.action.${lastJob.action}` as any) })}
            <PrivacyJobStatusBadge status={lastJob.status} />
          </div>
        )}

        <div className="flex gap-2 flex-wrap">
          <Button size="sm" variant="outline" onClick={runExport} disabled={create.isPending} className="gap-1.5">
            {create.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
            {t('privacy.contact.exportButton')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={startDelete}
            disabled={create.isPending}
            className="gap-1.5 text-destructive border-destructive/30 hover:bg-destructive/10"
          >
            <Trash2 className="w-3.5 h-3.5" />
            {t('privacy.contact.deleteButton')}
          </Button>
        </div>
      </CardContent>

      <ReauthDialog
        open={reauthOpen}
        onOpenChange={(v) => { setReauthOpen(v); if (!v) setReauthToken(null); }}
        onConfirmed={onReauthed}
        description={t('privacy.reauth.descriptionDelete')}
      />

      <ConfirmDeleteDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t('privacy.contact.deleteConfirmTitle')}
        description={
          <>
            <p>{t('privacy.contact.deleteConfirmIntro', { name: contactLabel || t('privacy.contact.thisContact') })}</p>
            <ul className="list-disc ms-5 space-y-1">
              <li>{t('privacy.contact.deleteBullet1')}</li>
              <li>{t('privacy.contact.deleteBullet2')}</li>
              <li>{t('privacy.contact.deleteBullet3')}</li>
              <li>{t('privacy.contact.deleteBullet4')}</li>
            </ul>
          </>
        }
        busy={create.isPending}
        onConfirm={runDelete}
      />
    </Card>
  );
}
