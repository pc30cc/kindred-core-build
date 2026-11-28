import { useQueryClient } from '@tanstack/react-query';
import { useCallCenterCapabilities, useUpdateCallCenterSettings } from '@/hooks/useCallCenter';
import { useWorkspaceRole } from '@/hooks/useWorkspaceRole';
import { usePlanAccess } from '@/hooks/useEntitlements';
import { toast } from '@/hooks/use-toast';
import { useTranslation } from '@/i18n';

/**
 * The workspace's call center switch (owner, 2026-11-28): the workspace
 * owner's alone (PUT /api/call-center/settings refuses anyone else's change),
 * off by default, shown in the call center's masthead and behind the
 * Overview's "Turn on". Off is always allowed; on needs the call center in
 * the plan and on the platform. A change resolves once the call center's
 * queries have been read again, so the switch and the readiness pill move
 * together with its toast.
 */
export function useCallCenterMasterSwitch(workspaceId: string | undefined) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: caps } = useCallCenterCapabilities(workspaceId);
  const { data: role } = useWorkspaceRole(workspaceId);
  const plan = usePlanAccess(workspaceId);
  const update = useUpdateCallCenterSettings(workspaceId);

  const on = !!caps?.workspace_enabled;
  const planCallCenter = plan.module('call_center');
  const planLocked = plan.status === 'ready' && !planCallCenter;
  const canTurnOn = !!caps?.platform_enabled && plan.status === 'ready' && planCallCenter;

  async function set(next: boolean) {
    if (!workspaceId) return;
    try {
      await update.mutateAsync({ enabled: next });
      await qc.invalidateQueries({ queryKey: ['call-center'] });
      toast({ title: t(next ? 'teamDept.ccMasterOn' : 'teamDept.ccMasterOff') });
    } catch (err: unknown) {
      const planDenied = (err as { code?: unknown }).code === 'plan_forbidden';
      toast({
        title: planDenied ? t('callCenter.settingsPage.masterPlanLocked') : t('callCenter.settingsPage.saveFailed'),
        description: planDenied ? undefined : (err as Error).message,
        variant: 'destructive',
      });
    }
  }

  return {
    /** Known only once the capabilities are read. */
    ready: !!caps,
    isOwner: role === 'owner',
    on,
    planLocked,
    canTurnOn,
    pending: update.isPending,
    set,
  };
}
