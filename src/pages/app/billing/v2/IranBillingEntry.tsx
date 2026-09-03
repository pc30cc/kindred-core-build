/**
 * Engine dispatch for the Iran billing screen.
 *
 * Which UI a workspace sees is decided by the SERVER's rollout state, never by
 * a local flag: only `v2_active` gets the invoice-driven V2 experience, while
 * legacy / shadow / cutover-pending workspaces keep the existing page so a
 * half-migrated account is never shown invoices its engine cannot honour.
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
        if (!cancelled) setEngine(model.rolloutState === 'v2_active' ? 'v2' : 'v1');
      })
      // A read failure must not lock the customer out of billing entirely:
      // fall back to the legacy screen, which is valid for every workspace.
      .catch(() => {
        if (!cancelled) setEngine('v1');
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
