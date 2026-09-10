/**
 * Default plan for NEW signups — Super Admin → Core settings → Signup.
 *
 * Operator picks whether a brand-new workspace starts on a trial of a paid
 * plan or straight on the free plan. Stored on `platform_settings` and
 * resolved server-side by server/services/billing/signupPlan.ts. Applies to
 * new signups only; existing workspaces are never changed.
 */
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Rocket } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { adminFetch } from '@/hooks/useAdmin';
import { usePlans } from '@/hooks/usePlans';
import { useTranslation } from '@/i18n';

type Mode = 'free' | 'trial';
const AUTO = '__auto__';

export default function SignupPlanCard() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [mode, setMode] = useState<Mode>('free');
  const [planId, setPlanId] = useState<string>(AUTO);
  const [days, setDays] = useState<number>(14);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const { data: settings, isLoading } = useQuery({
    queryKey: ['platform_settings'],
    queryFn: async () => {
      const body = await adminFetch<{ settings: any }>('/api/admin/management/platform-settings');
      return body.settings;
    },
  });

  const { data: plans } = usePlans();
  const paidPlans = (plans ?? []).filter((p: any) => !p.is_free);

  useEffect(() => {
    if (!settings) return;
    setMode(settings.signup_default_plan_mode === 'trial' ? 'trial' : 'free');
    setPlanId(settings.signup_trial_plan_id || AUTO);
    setDays(Number.isFinite(Number(settings.signup_trial_days)) ? Number(settings.signup_trial_days) : 14);
    setDirty(false);
  }, [settings]);

  const save = async () => {
    setSaving(true);
    try {
      const body = await adminFetch<{ success: boolean; settings: any }>('/api/admin/management/platform-settings', {
        method: 'PUT',
        body: JSON.stringify({
          signup_default_plan_mode: mode,
          signup_trial_plan_id: planId === AUTO ? null : planId,
          signup_trial_days: Math.max(0, Math.min(365, Math.floor(days || 0))),
        }),
      });
      const saved = body.settings ?? {};
      if (!('signup_default_plan_mode' in saved)) {
        throw new Error(t('admin.coreSettings.signupNotSupported' as any));
      }
      qc.setQueryData(['platform_settings'], saved);
      setDirty(false);
      toast({ title: t('admin.brandingPage.settings.saved' as any) });
    } catch (e) {
      toast({
        title: t('admin.brandingPage.common.error' as any),
        description: e instanceof Error ? e.message : t('admin.brandingPage.common.saveFailed' as any),
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Rocket className="h-5 w-5 text-primary" />
            <CardTitle className="text-base">{t('admin.coreSettings.signupPlan.title' as any)}</CardTitle>
          </div>
          <Button size="sm" onClick={save} disabled={!dirty || saving}>
            {t('admin.brandingPage.common.save' as any)}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t('admin.coreSettings.signupPlan.hint' as any)}</p>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="grid gap-5 md:grid-cols-3">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : (
          <div className="grid gap-5 md:grid-cols-3">
            <div className="grid gap-1.5">
              <Label>{t('admin.coreSettings.signupPlan.mode' as any)}</Label>
              <Select value={mode} onValueChange={(v) => { setMode(v as Mode); setDirty(true); }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="free">{t('admin.coreSettings.signupPlan.modeFree' as any)}</SelectItem>
                  <SelectItem value="trial">{t('admin.coreSettings.signupPlan.modeTrial' as any)}</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {mode === 'trial'
                  ? t('admin.coreSettings.signupPlan.modeTrialHint' as any)
                  : t('admin.coreSettings.signupPlan.modeFreeHint' as any)}
              </p>
            </div>

            <div className="grid gap-1.5">
              <Label>{t('admin.coreSettings.signupPlan.plan' as any)}</Label>
              <Select
                value={planId}
                onValueChange={(v) => { setPlanId(v); setDirty(true); }}
                disabled={mode !== 'trial'}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={AUTO}>{t('admin.coreSettings.signupPlan.planAuto' as any)}</SelectItem>
                  {paidPlans.map((p: any) => (
                    <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-1.5">
              <Label>{t('admin.coreSettings.signupPlan.days' as any)}</Label>
              <Input
                type="number"
                min={1}
                max={365}
                value={days}
                disabled={mode !== 'trial'}
                onChange={(e) => { setDays(Number(e.target.value)); setDirty(true); }}
              />
              <p className="text-xs text-muted-foreground">{t('admin.coreSettings.signupPlan.daysHint' as any)}</p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
