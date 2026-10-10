/**
 * Canonical workspace billing entry.
 * This is the only customer-facing billing experience.
 *
 * Billing v2 is hidden (shared/billingMode.ts): the page is the simple
 * prepaid billing (docs/billing/SIMPLE_BILLING.md).
 */
import { SkeletonCard, SkeletonStats } from '@/components/common/Skeletons';
import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { LEGACY_BILLING_ENABLED } from '../../../shared/billingMode';
import WorkspaceBillingPage from './billing/WorkspaceBillingPage';
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

  if (!LEGACY_BILLING_ENABLED) return <AccountBillingPage workspaceId={workspace.id} slug={workspace.slug} />;
  return <WorkspaceBillingPage workspaceId={workspace.id} />;
}
