import { useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { BarChart3 } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { useActiveWorkspace, useWorkspacePath } from '@/hooks/useWorkspace';
import { SkeletonStats } from '@/components/common/Skeletons';
import { WebAnalyticsSection } from '@/pages/app/seo/WebAnalyticsSection';
import { WebAnalyticsSectionNav } from './WebAnalyticsSectionNav';
import { firstWebAnalyticsLeafKey } from './webAnalyticsNavTree';

export default function WebAnalyticsPage() {
  const { t } = useTranslation();
  const { workspace } = useActiveWorkspace();
  const workspaceId = workspace?.id;
  const wsPath = useWorkspacePath();
  const navigate = useNavigate();
  const { subsection: subsectionParam } = useParams<{ subsection?: string }>();

  // Canonicalize the URL: bare /analytics redirects to the first report so
  // the nav's active state is always well-defined.
  useEffect(() => {
    if (!subsectionParam) {
      navigate(wsPath(`/analytics/${firstWebAnalyticsLeafKey()}`), { replace: true });
    }
  }, [subsectionParam, navigate, wsPath]);

  if (!workspaceId) {
    return <div className="p-6"><SkeletonStats count={4} /></div>;
  }

  const subsectionKey = subsectionParam || firstWebAnalyticsLeafKey();

  return (
    <div className="flex h-full flex-col">
      <div className="p-6 pb-0">
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <BarChart3 className="h-6 w-6" /> {t('nav.webAnalytics' as any)}
        </h1>
        <p className="text-sm text-muted-foreground">{t('seo.webAnalytics.pageSubtitle' as any)}</p>
      </div>
      <div className="mt-4 flex min-h-0 flex-1 items-stretch gap-0 px-6 pb-6">
        <WebAnalyticsSectionNav activeSubsectionKey={subsectionKey} />
        <div className="flex-1 overflow-y-auto rounded-e-xl border border-s-0 border-border/60 bg-background p-6">
          <WebAnalyticsSection workspaceId={workspaceId} subsectionKey={subsectionKey} />
        </div>
      </div>
    </div>
  );
}
