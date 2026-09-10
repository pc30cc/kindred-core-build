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

const FREE = '__free__';

export default function SignupPlanCard() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [choice, setChoice] = useState<string>(FREE);
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
  const paidPlans = (plans ?? []).filter((p: any) => !p.is_free && p.is_active !== false);

  useEffect(() => {
    if (!settings) return;
    const trial = settings.signup_default_plan_mode === 'trial' && settings.signup_trial_plan_id;
    setChoice(trial ? String(settings.signup_trial_plan_id) : FREE);
    setDirty(false);
  }, [settings]);

  const save = async () => {
    setSaving(true);
    try {
      const body = await adminFetch<{ success: boolean; settings: any }>('/api/admin/management/platform-settings', {
        method: 'PUT',
        body: JSON.stringify({
          signup_default_plan_mode: choice === FREE ? 'free' : 'trial',
          signup_trial_plan_id: choice === FREE ? null : choice,
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
          <Skeleton className="h-16 w-full max-w-sm" />
        ) : (
          <div className="grid max-w-sm gap-1.5">
            <Label>{t('admin.coreSettings.signupPlan.plan' as any)}</Label>
            <Select value={choice} onValueChange={(v) => { setChoice(v); setDirty(true); }}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={FREE}>{t('admin.coreSettings.signupPlan.modeFree' as any)}</SelectItem>
                {paidPlans.map((p: any) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                    {Number(p.trial_days) > 0 ? ` — ${p.trial_days}` : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
