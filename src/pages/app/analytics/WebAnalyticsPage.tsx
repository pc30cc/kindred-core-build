import { useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useActiveWorkspace, useWorkspacePath } from '@/hooks/useWorkspace';
import { SkeletonStats } from '@/components/common/Skeletons';
import { WebAnalyticsSection } from '@/pages/app/seo/WebAnalyticsSection';
import { WebAnalyticsSectionNav } from './WebAnalyticsSectionNav';
import { firstWebAnalyticsLeafKey } from './webAnalyticsNavTree';

export default function WebAnalyticsPage() {
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
    <div className="flex h-full min-h-0 items-stretch">
      <WebAnalyticsSectionNav activeSubsectionKey={subsectionKey} />
      <div className="min-w-0 flex-1 overflow-y-auto bg-background p-6">
        <WebAnalyticsSection workspaceId={workspaceId} subsectionKey={subsectionKey} />
      </div>
    </div>
  );
}
