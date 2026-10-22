/**
 * Super Admin → Widget Settings → Advanced Routing.
 *
 * Platform-wide routing rules applied to ALL workspaces
 * (`app_runtime_config.global_advanced_routing`, globalAdvancedRouting.ts).
 * No workspace picker, no membership requirement. What each switch does,
 * as the copy says:
 *
 *   - owner fallback: chat routing (chatRouting.ts) and call routing give a
 *     conversation or call nobody else could take to the workspace owner
 *     (for chats only an owner who receives chats and is online, and only
 *     when the general pool did not already include them);
 *   - general pool: chats only — a department with nobody available hands
 *     its chats to the whole team; off, they wait for the department. Calls
 *     do not read it;
 *   - returning visitors: chats only — off, no workspace returns a visitor
 *     to their previous operator, whatever its own setting.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from '@/lib/toast';
import { Activity, Info, Loader2 } from 'lucide-react';

import {
  getGlobalAdvancedRouting,
  updateGlobalAdvancedRouting,
  type GlobalAdvancedRoutingPolicy,
} from '@/lib/admin-advanced-routing-api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useTranslation } from '@/i18n';

const QUERY_KEY = ['admin-global-advanced-routing'] as const;

export function AdvancedRoutingSection() {
  const { t } = useTranslation();
  const qc = useQueryClient();

  const { data: policy, isLoading } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: getGlobalAdvancedRouting,
    retry: false,
  });

  const updateMut = useMutation({
    mutationFn: (patch: Partial<GlobalAdvancedRoutingPolicy>) =>
      updateGlobalAdvancedRouting(patch),
    onSuccess: (next) => {
      qc.setQueryData(QUERY_KEY, next);
      toast.success(t('admin.widgetSettingsPage.routing.updated'));
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Activity className="h-4 w-4 text-muted-foreground" /> {t('admin.widgetSettingsPage.routing.title')}
            </CardTitle>
            <span className="text-[10px] uppercase tracking-wider rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-muted-foreground">
              {t('admin.widgetSettingsPage.routing.global')}
            </span>
          </div>
          <CardDescription>{t('admin.widgetSettingsPage.routing.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {isLoading || !policy ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : (
            <div className="space-y-4">
              <div className="space-y-2">
                <p className="text-xs font-medium text-foreground/80 uppercase tracking-wide">
                  {t('admin.widgetSettingsPage.routing.ownerFallback')}
                </p>
              <ToggleRow
                  label={t('admin.widgetSettingsPage.routing.enableOwner')}
                  description={t('admin.widgetSettingsPage.routing.enableOwnerHint')}
                checked={policy.owner_fallback_enabled}
                onChange={(v) => updateMut.mutate({ owner_fallback_enabled: v })}
              />
                <div className="ms-4 ps-3 border-s border-border/50 space-y-2">
                  <ToggleRow
                    label={t('admin.widgetSettingsPage.routing.ownerChat')}
                    checked={policy.owner_fallback_for_chat}
                    disabled={!policy.owner_fallback_enabled}
                    onChange={(v) => updateMut.mutate({ owner_fallback_for_chat: v })}
                  />
                  <ToggleRow
                    label={t('admin.widgetSettingsPage.routing.ownerAudio')}
                    checked={policy.owner_fallback_for_audio}
                    disabled={!policy.owner_fallback_enabled}
                    onChange={(v) => updateMut.mutate({ owner_fallback_for_audio: v })}
                  />
                  <ToggleRow
                    label={t('admin.widgetSettingsPage.routing.ownerVideo')}
                    checked={policy.owner_fallback_for_video}
                    disabled={!policy.owner_fallback_enabled}
                    onChange={(v) => updateMut.mutate({ owner_fallback_for_video: v })}
                  />
                </div>
              </div>
              <div className="space-y-2 pt-2 border-t border-border/40">
                <p className="text-xs font-medium text-foreground/80 uppercase tracking-wide">
                  {t('admin.widgetSettingsPage.routing.generalPool')}
                </p>
                <ToggleRow
                  label={t('admin.widgetSettingsPage.routing.useGeneralPool')}
                  description={t('admin.widgetSettingsPage.routing.useGeneralPoolHint')}
                  checked={policy.general_pool_enabled}
                  onChange={(v) => updateMut.mutate({ general_pool_enabled: v })}
                />
              </div>
              <div className="space-y-2 pt-2 border-t border-border/40">
                <p className="text-xs font-medium text-foreground/80 uppercase tracking-wide">
                  {t('admin.widgetSettingsPage.routing.lastAgentGroup')}
                </p>
                <ToggleRow
                  label={t('admin.widgetSettingsPage.routing.lastAgent')}
                  description={t('admin.widgetSettingsPage.routing.lastAgentHint')}
                  // Older servers do not send it: on, as they behave.
                  checked={policy.last_agent_routing_enabled !== false}
                  onChange={(v) => updateMut.mutate({ last_agent_routing_enabled: v })}
                />
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="bg-muted/20 border-border/60">
        <CardContent className="p-4 flex items-start gap-3 text-xs text-muted-foreground">
          <Info className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            {t('admin.widgetSettingsPage.routing.storageBefore')}{' '}
            <code className="mx-0.5 px-1 rounded bg-muted text-foreground">app_runtime_config.global_advanced_routing</code>.
            {t('admin.widgetSettingsPage.routing.storageAfter')}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function ToggleRow({
  label, description, checked, onChange, disabled,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-md border border-border/60 p-3">
      <div className="space-y-0.5">
        <Label className={`text-sm ${disabled ? 'text-muted-foreground' : 'text-foreground'}`}>
          {label}
        </Label>
        {description && (
          <p className="text-xs text-muted-foreground">{description}</p>
        )}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </div>
  );
}
