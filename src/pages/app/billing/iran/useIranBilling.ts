/**
 * Shared data layer for the Iran-native Billing/Financial page.
 *
 * All money stays in IRR end to end (server contract); every component under
 * billing/iran/ formats it via src/lib/money.ts at render time only.
 */
import { useCallback, useEffect, useState } from 'react';
import { useWorkspaces } from '@/hooks/useWorkspace';
import { billingGetPlans, billingGetStatus, billingGetProviders, billingGetEvents } from '@/lib/api';
import { fetchWorkspaceEffective, type WorkspaceEffectiveEntitlements } from '@/lib/entitlements-api';

export interface IranBillingState {
  workspaceId: string | null;
  loading: boolean;
  plans: any[];
  subscription: any;
  payments: any[];
  attempts: any[];
  events: any[];
  effective: WorkspaceEffectiveEntitlements | null;
  providerCapabilities: Record<string, boolean> | null;
  reload: () => void;
}

export function useIranBilling(): IranBillingState {
  const { data: workspaces } = useWorkspaces();
  const workspace = workspaces?.[0];
  const workspaceId = workspace?.id ?? null;

  const [loading, setLoading] = useState(true);
  const [plans, setPlans] = useState<any[]>([]);
  const [subscription, setSubscription] = useState<any>(null);
  const [payments, setPayments] = useState<any[]>([]);
  const [attempts, setAttempts] = useState<any[]>([]);
  const [events, setEvents] = useState<any[]>([]);
  const [effective, setEffective] = useState<WorkspaceEffectiveEntitlements | null>(null);
  const [providerCapabilities, setProviderCapabilities] = useState<Record<string, boolean> | null>(null);

  const load = useCallback(() => {
    if (!workspaceId) return;
    setLoading(true);
    Promise.all([
      billingGetPlans('fa'),
      billingGetStatus(workspaceId),
      billingGetProviders(),
      billingGetEvents(workspaceId).catch(() => ({ events: [] })),
      fetchWorkspaceEffective(workspaceId).catch(() => null),
    ])
      .then(([plansRes, statusRes, providersRes, eventsRes, effRes]) => {
        setPlans(plansRes.plans || []);
        setSubscription(statusRes.subscription);
        setPayments(statusRes.payments || []);
        setAttempts((statusRes as any).attempts || []);
        setEvents(eventsRes.events || []);
        setEffective(effRes);
        const activeProvider = statusRes.subscription?.provider_name;
        const caps = activeProvider ? providersRes.providers?.[activeProvider]?.capabilities : null;
        setProviderCapabilities((caps as any) || null);
      })
      .catch((e) => console.error('[billing/iran] failed to load billing data', e))
      .finally(() => setLoading(false));
  }, [workspaceId]);

  useEffect(() => { load(); }, [load]);

  return { workspaceId, loading, plans, subscription, payments, attempts, events, effective, providerCapabilities, reload: load };
}
