import { useTranslation } from '@/i18n';
import { useWidgetPrechatSettings, useUpdateWidgetPrechatSettings, type WidgetPrechatSettings } from '@/hooks/useWidgetIdentity';
import { useWidgetPlatformSettings, type PreChatPolicy } from '@/hooks/useWidgetPlatformSettings';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { User, Mail, Phone, ShieldCheck, Lock, Info, Clock } from 'lucide-react';
import { toast } from '@/hooks/use-toast';

interface Props {
  workspaceId: string | undefined;
}

type FieldKey = 'name' | 'email' | 'phone';

const FIELD_META: Record<FieldKey, { icon: React.ComponentType<{ className?: string }>; canVerify: boolean }> = {
  name: { icon: User, canVerify: false },
  email: { icon: Mail, canVerify: true },
  phone: { icon: Phone, canVerify: true },
};

/**
 * Resolves how a platform-level PreChatPolicy constrains the workspace toggle:
 *  - force_on  → ask=ON locked, require=ON locked
 *  - force_off → ask=OFF locked (require irrelevant)
 *  - default_* → workspace can override freely
 */
function resolveLock(policy: PreChatPolicy | undefined) {
  if (policy === 'force_on') return { askLocked: true, askValue: true, requireLocked: true, requireValue: true, labelKey: 'forcedOn' as const };
  if (policy === 'force_off') return { askLocked: true, askValue: false, requireLocked: true, requireValue: false, labelKey: 'forcedOff' as const };
  return { askLocked: false, askValue: undefined, requireLocked: false, requireValue: undefined, labelKey: null };
}

export function PrechatSection({ workspaceId }: Props) {
  const { t, dir } = useTranslation();
  const { data: settings, isLoading } = useWidgetPrechatSettings(workspaceId);
  const { data: platform } = useWidgetPlatformSettings();
  const updateMut = useUpdateWidgetPrechatSettings(workspaceId);

  const update = (patch: Partial<WidgetPrechatSettings>) => {
    updateMut.mutate(patch, {
      onSuccess: () => toast({ title: t('widgetPage.prechat.saved'), description: t('widgetPage.prechat.savedDescription') }),
      onError: (e: any) => toast({ title: t('common.error'), description: e.message, variant: 'destructive' }),
    });
  };

  if (isLoading) return <div dir={dir} className="text-sm text-muted-foreground">{t('widgetPage.loading')}</div>;

  // Defaults if no row yet — match server fallback in widgetIdentity.ts
  const s: WidgetPrechatSettings = settings || {
    workspace_id: workspaceId || '',
    ask_name: true, ask_email: true, ask_phone: false,
    require_name: true, require_email: true, require_phone: false,
    verify_email: false, verify_phone: false,
    history_continue_window_hours: 24,
  };

  const policyByField: Record<FieldKey, PreChatPolicy | undefined> = {
    name: platform?.prechat_name_policy,
    email: platform?.prechat_email_policy,
    phone: platform?.prechat_phone_policy,
  };

  return (
    <div className="space-y-4" dir={dir}>
      <Card className="card-elevated">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <ShieldCheck className="h-4 w-4" /> {t('widgetPage.prechat.title')}
          </CardTitle>
          <CardDescription>
            {t('widgetPage.prechat.description')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {(Object.keys(FIELD_META) as FieldKey[]).map((key) => {
            const meta = FIELD_META[key];
            const fieldLabel = t(`widgetPage.prechat.${key}` as any);
            const Icon = meta.icon;
            const lock = resolveLock(policyByField[key]);
            const askField = `ask_${key}` as keyof WidgetPrechatSettings;
            const requireField = `require_${key}` as keyof WidgetPrechatSettings;
            const verifyField = `verify_${key}` as keyof WidgetPrechatSettings;
            const askValue = lock.askLocked ? lock.askValue! : (s[askField] as boolean);
            const requireValue = lock.requireLocked ? lock.requireValue! : (s[requireField] as boolean);
            const verifyValue = (s[verifyField as keyof WidgetPrechatSettings] as boolean) ?? false;

            return (
              <div key={key} className="rounded-lg border border-border p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <div className="p-2 rounded-lg bg-primary/10">
                      <Icon className="h-4 w-4 text-primary" />
                    </div>
                    <Label className="text-sm font-medium">{fieldLabel}</Label>
                    {lock.askLocked && (
                      <Badge variant="destructive" className="gap-1 text-[10px]">
                        <Lock className="h-3 w-3" /> {lock.labelKey ? t(`widgetPage.prechat.${lock.labelKey}` as any) : ''}
                      </Badge>
                    )}
                  </div>
                  <Switch
                    checked={askValue}
                    disabled={lock.askLocked || updateMut.isPending}
                    onCheckedChange={(v) => update({ [askField]: v } as any)}
                  />
                </div>

                {askValue && (
                  <div className="ms-11 space-y-2 pt-1">
                    <div className="flex items-center justify-between">
                      <Label className="text-xs text-muted-foreground">{t('widgetPage.prechat.required')}</Label>
                      <Switch
                        checked={requireValue}
                        disabled={lock.requireLocked || updateMut.isPending}
                        onCheckedChange={(v) => update({ [requireField]: v } as any)}
                      />
                    </div>
                    {/* OTP verification toggles removed by product decision. */}

                  </div>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>

      <Card className="card-elevated">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Clock className="h-4 w-4" /> {t('widgetPage.prechat.continuityTitle')}
          </CardTitle>
          <CardDescription>
            {t('widgetPage.prechat.continuityDescription')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Label className="text-xs font-medium">{t('widgetPage.prechat.continueWindow')}</Label>
          <Input
            type="number"
            min={0}
            max={720}
            value={s.history_continue_window_hours}
            onChange={(e) => update({ history_continue_window_hours: parseInt(e.target.value || '24', 10) })}
            className="max-w-32"
          />
          <p className="text-[11px] text-muted-foreground">
            {t('widgetPage.prechat.continueWindowHint')}
          </p>
        </CardContent>
      </Card>

      <div className="flex items-start gap-2 bg-muted/40 rounded-lg p-3 text-xs text-muted-foreground">
        <Info className="h-4 w-4 mt-0.5 shrink-0" />
        <p>
          {t('widgetPage.prechat.adminNote')}
        </p>
      </div>
    </div>
  );
}
