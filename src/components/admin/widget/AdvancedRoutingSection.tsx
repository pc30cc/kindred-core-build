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
 *     to their previous operator, whatever its own setting;
 *   - quiet conversations (migration 284): the platform switch of the
 *     inactivity close and the window of every workspace without its own
 *     (1–48 hours). These are typed columns of widget_platform_settings, so
 *     they read and save through the page's platform settings
 *     (GET / PATCH /api/widget-settings/platform/config), not through
 *     /api/admin/advanced-routing; the close's SQL reads them itself, so
 *     turning the switch off stops every close at once.
 */
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from '@/lib/toast';
import { Activity, Info, Loader2 } from 'lucide-react';

import {
  getGlobalAdvancedRouting,
  updateGlobalAdvancedRouting,
  type GlobalAdvancedRoutingPolicy,
} from '@/lib/admin-advanced-routing-api';
import {
  useUpdateWidgetPlatformSettings,
  useWidgetPlatformSettings,
  type WidgetPlatformSettings,
} from '@/hooks/useWidgetPlatformSettings';
import { NumberSetting } from '@/components/app/widget/NumberSetting';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useTranslation } from '@/i18n';
import {
  INACTIVITY_CLOSE_MAX_HOURS,
  INACTIVITY_CLOSE_MIN_HOURS,
  effectiveInactivityCloseHours,
} from '../../../../shared/inactivityClose';

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
          {/* Its own data (the platform settings), so it never waits on the
              advanced-routing read: the kill switch stays reachable when
              that read fails. */}
          <InactivityCloseGroup />
        </CardContent>
      </Card>

      <Card className="bg-muted/20 border-border/60">
        <CardContent className="p-4 flex items-start gap-3 text-xs text-muted-foreground">
          <Info className="h-4 w-4 mt-0.5 shrink-0" />
          <div className="space-y-1">
            <p>
              {t('admin.widgetSettingsPage.routing.storageBefore')}{' '}
              <code className="mx-0.5 px-1 rounded bg-muted text-foreground">app_runtime_config.global_advanced_routing</code>.
              {t('admin.widgetSettingsPage.routing.storageAfter')}
            </p>
            <p>
              {t('admin.widgetSettingsPage.routing.storageInactivityBefore')}{' '}
              <code className="mx-0.5 px-1 rounded bg-muted text-foreground">widget_platform_settings</code>{' '}
              {t('admin.widgetSettingsPage.routing.storageInactivityAfter')}
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

const PLATFORM_QUERY_KEY = ['widget-platform-settings'] as const;

/**
 * "Quiet conversations": the inactivity close's platform switch and default
 * window, from widget_platform_settings. An older server (before 284) sends
 * neither: on and 24, as the panel's defaults say. A change shows at once
 * and goes back to the stored value when the save is refused, unless a
 * newer change replaced it meanwhile. The default stays editable while the
 * switch is off: it is stored on its own and applies once the switch is on.
 */
function InactivityCloseGroup() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: platform, isLoading, error } = useWidgetPlatformSettings();
  const updateMut = useUpdateWidgetPlatformSettings();
  const [draft, setDraft] = useState<Partial<WidgetPlatformSettings>>({});

  const save = (updates: Partial<WidgetPlatformSettings>) => {
    if (!platform) return;
    setDraft((d) => ({ ...d, ...updates }));
    // Drop the keys of this save that no newer change has replaced.
    const settle = () => setDraft((d) => {
      const next = { ...d };
      for (const key of Object.keys(updates) as Array<keyof WidgetPlatformSettings>) {
        if (next[key] === updates[key]) delete next[key];
      }
      return next;
    });
    // mutateAsync, not mutate: mutate reports only the latest call's
    // outcome, so a refused earlier save would keep its draft and its error
    // would never be said.
    updateMut.mutateAsync({ id: platform.id, updates }).then(
      (next) => {
        // The stored row at once; the hook refetches it after this.
        if (next) qc.setQueryData(PLATFORM_QUERY_KEY, next);
        settle();
        toast.success(t('admin.widgetSettingsPage.routing.updated'));
      },
      (e: unknown) => {
        settle();
        const message = e instanceof Error ? e.message : String(e);
        toast.error(
          message === 'inactivity_close_migration_required'
            ? t('admin.widgetSettingsPage.routing.inactivityMigrationRequired')
            : message,
        );
      },
    );
  };

  const live = platform ? { ...platform, ...draft } : null;
  const enabled = live?.inactivity_close_enabled !== false;
  return (
    <div className="space-y-2 pt-2 border-t border-border/40" data-routing-inactivity>
      <p className="text-xs font-medium text-foreground/80 uppercase tracking-wide">
        {t('admin.widgetSettingsPage.routing.inactivityGroup')}
      </p>
      {isLoading ? (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      ) : !live ? (
        <p className="text-xs text-destructive">
          {error instanceof Error ? error.message : t('admin.widgetSettingsPage.loadFailed')}
        </p>
      ) : (
        <>
          <ToggleRow
            label={t('admin.widgetSettingsPage.routing.inactivityClose')}
            description={t('admin.widgetSettingsPage.routing.inactivityCloseHint')}
            checked={enabled}
            onChange={(v) => save({ inactivity_close_enabled: v })}
          />
          <div className="rounded-md border border-border/60 p-3">
            <NumberSetting
              id="routing-inactivity-default"
              label={t('admin.widgetSettingsPage.routing.inactivityDefaultHours')}
              hint={t('admin.widgetSettingsPage.routing.inactivityDefaultHint')}
              unit={t('widgetPage.behavior.assignment.hours')}
              value={effectiveInactivityCloseHours(null, live.inactivity_close_default_hours)}
              min={INACTIVITY_CLOSE_MIN_HOURS}
              max={INACTIVITY_CLOSE_MAX_HOURS}
              onCommit={(n) => save({ inactivity_close_default_hours: n })}
            />
          </div>
        </>
      )}
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
