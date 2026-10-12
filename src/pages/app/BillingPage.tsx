/**
 * Canonical workspace billing entry.
 * This is the only customer-facing billing experience: the simple prepaid
 * billing (docs/billing/SIMPLE_BILLING.md).
 */
import { SkeletonCard, SkeletonStats } from '@/components/common/Skeletons';
import { useActiveWorkspace } from '@/hooks/useWorkspace';
import AccountBillingPage from './billing/account/AccountBillingPage';

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

  return <AccountBillingPage workspaceId={workspace.id} slug={workspace.slug} />;
}
