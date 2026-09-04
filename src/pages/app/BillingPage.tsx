/**
 * Canonical workspace billing entry.
 *
 * Billing V2 is the only customer-facing billing experience. There is no
 * region, rollout-state, or legacy fallback dispatch in the frontend.
 */
import { SkeletonCard, SkeletonStats } from '@/components/common/Skeletons';
import { useActiveWorkspace } from '@/hooks/useWorkspace';
import WorkspaceBillingPage from './billing/WorkspaceBillingPage';

export default function BillingPage() {
  const { workspace, isLoading } = useActiveWorkspace();

  if (isLoading || !workspace) {
    return (
      <div className="space-y-5 p-4 md:p-6 lg:p-8">
        <SkeletonStats count={3} />
        <SkeletonCard lines={5} />
      </div>
    );
  }

  return <WorkspaceBillingPage workspaceId={workspace.id} />;
}
