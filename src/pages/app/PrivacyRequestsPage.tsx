/**
 * Workspace admin: list of all privacy jobs in the active workspace.
 * Polled every 5s while any non-terminal job is present.
 */
import { useTranslation } from '@/i18n';
import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { useWorkspaceRole, isWorkspaceAdmin } from '@/hooks/useWorkspaceRole';
import { usePrivacyJobs } from '@/hooks/usePrivacyJobs';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { PrivacyJobsTable } from '@/components/privacy/PrivacyJobsTable';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { ShieldAlert } from 'lucide-react';

export default function PrivacyRequestsPage() {
  const { t, dir } = useTranslation();
  const { workspace } = useActiveWorkspace();
  const { data: role } = useWorkspaceRole(workspace?.id);
  const admin = isWorkspaceAdmin(role);
  const { data, isLoading } = usePrivacyJobs(workspace?.id, !!workspace && admin);

  if (!admin) {
    return (
      <div className="p-6 max-w-3xl mx-auto" dir={dir}>
        <Alert variant="destructive">
          <ShieldAlert className="h-4 w-4" />
          <AlertTitle>{t('privacy.requests.forbiddenTitle')}</AlertTitle>
          <AlertDescription>{t('privacy.requests.forbiddenDescription')}</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6" dir={dir}>
      <div>
        <h1 className="text-2xl font-bold">{t('privacy.requests.title')}</h1>
        <p className="text-sm text-muted-foreground mt-1">{t('privacy.requests.subtitle')}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('privacy.requests.listTitle')}</CardTitle>
          <CardDescription>{t('privacy.requests.listDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <PrivacyJobsTable jobs={data?.jobs ?? []} isLoading={isLoading} showActor />
        </CardContent>
      </Card>
    </div>
  );
}
