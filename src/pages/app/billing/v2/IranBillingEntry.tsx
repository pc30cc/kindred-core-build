/**
 * Engine dispatch for the Iran billing screen.
 *
 * The invoice-driven V2 experience is now the site-wide default: every
 * workspace gets it unless the server explicitly reports a `legacy` rollout
 * state (an account whose engine cannot honour invoices yet).
 */
import { useEffect, useState } from 'react';
import { useWorkspaces } from '@/hooks/useWorkspace';
import { SkeletonStats, SkeletonCard } from '@/components/common/Skeletons';
import { billingEngineReadModel } from '@/lib/billingV2Api';
import IranBillingPage from '../iran/IranBillingPage';
import BillingV2Page from './BillingV2Page';

export default function IranBillingEntry() {
  const { data: workspaces } = useWorkspaces();
  const workspaceId = workspaces?.[0]?.id ?? null;
  const [engine, setEngine] = useState<'v1' | 'v2' | null>(null);
  const [resolved, setResolved] = useState(false);

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    setResolved(false);
    billingEngineReadModel(workspaceId)
      .then((model) => {
        if (!cancelled) setEngine(model.rolloutState === 'legacy' ? 'v1' : 'v2');
      })
      // A read failure must not lock the customer out of billing entirely:
      // keep the default V2 screen rather than dropping to the legacy one.
      .catch(() => {
        if (!cancelled) setEngine('v2');
      })
      .finally(() => {
        if (!cancelled) setResolved(true);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  if (!workspaceId || !resolved) {
    return (
      <div className="space-y-5 p-4 md:p-6 lg:p-8">
        <SkeletonStats count={3} />
        <SkeletonCard lines={5} />
      </div>
    );
  }

  if (engine === 'v2') return <BillingV2Page workspaceId={workspaceId} />;
  return <IranBillingPage />;
}
