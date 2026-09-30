/**
 * Public self-signup on/off — Super Admin → Core settings → Signup.
 *
 * When off, POST /api/auth/signup refuses every request, the signup page
 * shows a "registration closed" notice and the login page hides its signup
 * link. Existing users still sign in, and workspace invitations still create
 * accounts. Stored on `platform_settings.signup_enabled` and resolved
 * server-side by server/services/auth/signupPolicy.ts.
 */
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { UserPlus } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { adminFetch } from '@/hooks/useAdmin';
import { useTranslation } from '@/i18n';

export default function SignupAccessCard() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [enabled, setEnabled] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const { data: settings, isLoading } = useQuery({
    queryKey: ['platform_settings'],
    queryFn: async () => {
      const body = await adminFetch<{ settings: any }>('/api/admin/management/platform-settings');
      return body.settings;
    },
  });

  useEffect(() => {
    if (!settings) return;
    setEnabled(settings.signup_enabled !== false);
    setDirty(false);
  }, [settings]);

  const save = async () => {
    setSaving(true);
    try {
      const body = await adminFetch<{ success: boolean; settings: any }>('/api/admin/management/platform-settings', {
        method: 'PUT',
        body: JSON.stringify({ signup_enabled: enabled }),
      });
      const saved = body.settings ?? {};
      if (!('signup_enabled' in saved)) {
        throw new Error(t('admin.coreSettings.signupNotSupported' as any));
      }
      if ((saved.signup_enabled !== false) !== enabled) {
        throw new Error(t('admin.brandingPage.common.saveFailed' as any));
      }
      qc.setQueryData(['platform_settings'], saved);
      qc.invalidateQueries({ queryKey: ['public_signup_policy'] });
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
            <UserPlus className="h-5 w-5 text-primary" />
            <CardTitle className="text-base">{t('admin.coreSettings.signupAccess.title' as any)}</CardTitle>
          </div>
          <Button size="sm" onClick={save} disabled={!dirty || saving}>
            {t('admin.brandingPage.common.save' as any)}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t('admin.coreSettings.signupAccess.hint' as any)}</p>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-10 w-full max-w-sm" />
        ) : (
          <div className="flex items-start justify-between gap-4">
            <div className="grid gap-1">
              <Label htmlFor="signup-enabled">{t('admin.coreSettings.signupAccess.label' as any)}</Label>
              <p className="text-xs text-muted-foreground">
                {enabled
                  ? t('admin.coreSettings.signupAccess.onHint' as any)
                  : t('admin.coreSettings.signupAccess.offHint' as any)}
              </p>
            </div>
            <Switch
              id="signup-enabled"
              checked={enabled}
              onCheckedChange={(v) => { setEnabled(v); setDirty(true); }}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
