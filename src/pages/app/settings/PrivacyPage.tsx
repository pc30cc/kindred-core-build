/**
 * Settings → Privacy (self-service).
 *
 * - Export my data: creates a user-subject export (re-auth required).
 * - Delete my account: creates a user-subject delete (re-auth + typed confirm).
 *   Backend blocks self-delete while the user owns an account; we surface that
 *   message inline.
 * - History list: this user's user-subject jobs.
 */
import { useState } from 'react';
import { useAuth } from '@/features/auth/AuthContext';
import { useTranslation } from '@/i18n';
import { useCreatePrivacyJob, usePrivacyJobs } from '@/hooks/usePrivacyJobs';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Loader2, Download, Trash2, Info, ShieldCheck } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { ReauthDialog } from '@/components/privacy/ReauthDialog';
import { ConfirmDeleteDialog } from '@/components/privacy/ConfirmDeleteDialog';
import { PrivacyJobsTable } from '@/components/privacy/PrivacyJobsTable';

type Pending = { kind: 'export' | 'delete' } | null;

export default function PrivacyPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const create = useCreatePrivacyJob();
  const { data, isLoading } = usePrivacyJobs(undefined, !!user);

  const [pending, setPending] = useState<Pending>(null);
  const [reauthOpen, setReauthOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [reauthToken, setReauthToken] = useState<string | null>(null);
  const [ownsAccount, setOwnsAccount] = useState(false);

  const startExport = () => { setPending({ kind: 'export' }); setReauthOpen(true); };
  const startDelete = () => { setPending({ kind: 'delete' }); setReauthOpen(true); };

  const onReauthed = async (token: string) => {
    setReauthToken(token);
    if (pending?.kind === 'export') {
      await runExport(token);
    } else if (pending?.kind === 'delete') {
      // Move to typed confirmation
      setDeleteOpen(true);
    }
  };

  const runExport = async (token: string) => {
    try {
      await create.mutateAsync({
        subject_type: 'user',
        subject_id: user!.id,
        action: 'export',
        reauth_token: token,
      });
      toast({ title: t('privacy.toast.exportQueued'), description: t('privacy.toast.exportQueuedDesc') });
    } catch (e: any) {
      toast({ title: t('privacy.toast.failed'), description: e?.message, variant: 'destructive' });
    } finally {
      setPending(null);
      setReauthToken(null);
    }
  };

  const runDelete = async () => {
    if (!reauthToken) return;
    try {
      await create.mutateAsync({
        subject_type: 'user',
        subject_id: user!.id,
        action: 'delete',
        reauth_token: reauthToken,
      });
      toast({ title: t('privacy.toast.deleteQueued'), description: t('privacy.toast.deleteQueuedDesc') });
      setDeleteOpen(false);
    } catch (e: any) {
      if (e?.code === 'OWNS_ACCOUNT') {
        setOwnsAccount(true);
        setDeleteOpen(false);
      } else {
        toast({ title: t('privacy.toast.failed'), description: e?.message, variant: 'destructive' });
      }
    } finally {
      setPending(null);
      setReauthToken(null);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t('privacy.self.title')}</h1>
        <p className="text-sm text-muted-foreground mt-1">{t('privacy.self.subtitle')}</p>
      </div>

      <Alert>
        <Info className="h-4 w-4" />
        <AlertTitle>{t('privacy.scope.title')}</AlertTitle>
        <AlertDescription className="space-y-1 mt-2 text-sm">
          <p><ShieldCheck className="inline w-3.5 h-3.5 me-1" />{t('privacy.scope.exportedSelf')}</p>
          <p><ShieldCheck className="inline w-3.5 h-3.5 me-1" />{t('privacy.scope.anonymizedSelf')}</p>
          <p><ShieldCheck className="inline w-3.5 h-3.5 me-1" />{t('privacy.scope.retainedSelf')}</p>
        </AlertDescription>
      </Alert>

      {ownsAccount && (
        <Alert variant="destructive">
          <AlertTitle>{t('privacy.self.ownsAccountTitle')}</AlertTitle>
          <AlertDescription>{t('privacy.self.ownsAccountDescription')}</AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Download className="w-5 h-5" />{t('privacy.self.exportTitle')}</CardTitle>
            <CardDescription>{t('privacy.self.exportDescription')}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={startExport} disabled={create.isPending} className="gap-1.5">
              {create.isPending && pending?.kind === 'export'
                ? <Loader2 className="w-4 h-4 animate-spin" />
                : <Download className="w-4 h-4" />}
              {t('privacy.self.exportButton')}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-destructive">
              <Trash2 className="w-5 h-5" />{t('privacy.self.deleteTitle')}
            </CardTitle>
            <CardDescription>{t('privacy.self.deleteDescription')}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="destructive" onClick={startDelete} disabled={create.isPending} className="gap-1.5">
              <Trash2 className="w-4 h-4" />
              {t('privacy.self.deleteButton')}
            </Button>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('privacy.self.historyTitle')}</CardTitle>
          <CardDescription>{t('privacy.self.historyDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <PrivacyJobsTable jobs={data?.jobs ?? []} isLoading={isLoading} />
        </CardContent>
      </Card>

      <ReauthDialog
        open={reauthOpen}
        onOpenChange={(v) => { setReauthOpen(v); if (!v && !reauthToken) setPending(null); }}
        onConfirmed={onReauthed}
        description={
          pending?.kind === 'delete'
            ? t('privacy.reauth.descriptionDelete')
            : t('privacy.reauth.descriptionExport')
        }
      />

      <ConfirmDeleteDialog
        open={deleteOpen}
        onOpenChange={(v) => { setDeleteOpen(v); if (!v) setReauthToken(null); }}
        title={t('privacy.self.deleteConfirmTitle')}
        description={
          <>
            <p>{t('privacy.self.deleteConfirmIntro')}</p>
            <ul className="list-disc ms-5 space-y-1">
              <li>{t('privacy.self.deleteBullet1')}</li>
              <li>{t('privacy.self.deleteBullet2')}</li>
              <li>{t('privacy.self.deleteBullet3')}</li>
            </ul>
            <p className="text-destructive font-medium">{t('privacy.self.deleteIrreversible')}</p>
          </>
        }
        busy={create.isPending}
        onConfirm={runDelete}
      />
    </div>
  );
}
