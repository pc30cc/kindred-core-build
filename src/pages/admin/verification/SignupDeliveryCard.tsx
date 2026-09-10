/**
 * Signup email verification delivery — Super Admin → Verification & OTP.
 *
 * This is the ONE place an operator picks how signup verification is
 * delivered (link vs. self-hosted OTP) and when it is required. It is stored
 * on `platform_settings` and resolved server-side through
 * server/services/auth/signupPolicy.ts. Express-only; no edge functions.
 */
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { MailCheck } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { adminFetch } from '@/hooks/useAdmin';
import { useTranslation } from '@/i18n';

type Method = 'link' | 'otp';
type Gate = 'before' | 'after';

export default function SignupDeliveryCard() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [method, setMethod] = useState<Method>('link');
  const [gate, setGate] = useState<Gate>('before');
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
    setMethod(settings.signup_verification_method === 'otp' ? 'otp' : 'link');
    setGate(settings.signup_verification_gate === 'after' ? 'after' : 'before');
    setDirty(false);
  }, [settings]);

  const save = async () => {
    setSaving(true);
    try {
      const body = await adminFetch<{ success: boolean; settings: any }>('/api/admin/management/platform-settings', {
        method: 'PUT',
        body: JSON.stringify({ signup_verification_method: method, signup_verification_gate: gate }),
      });
      const settings = body.settings ?? {};
      // An API build that predates this feature silently strips the two
      // fields (zod drops unknown keys), so the row comes back without them.
      // Say that plainly instead of a generic "save failed".
      const supported =
        'signup_verification_method' in settings && 'signup_verification_gate' in settings;
      if (!supported) {
        throw new Error(t('admin.coreSettings.signupNotSupported' as any));
      }
      const savedMethod: Method = settings.signup_verification_method === 'otp' ? 'otp' : 'link';
      const savedGate: Gate = settings.signup_verification_gate === 'after' ? 'after' : 'before';
      if (savedMethod !== method || savedGate !== gate) {
        throw new Error(t('admin.brandingPage.common.saveFailed' as any));
      }

      qc.setQueryData(['platform_settings'], body.settings);
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
            <MailCheck className="h-5 w-5 text-primary" />
            <CardTitle className="text-base">{t('admin.brandingPage.settings.general.signupVerification' as any)}</CardTitle>
          </div>
          <Button size="sm" onClick={save} disabled={!dirty || saving}>
            {t('admin.brandingPage.common.save' as any)}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t('admin.brandingPage.settings.general.signupVerificationHint' as any)}</p>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="grid gap-5 md:grid-cols-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : (
          <div className="grid gap-5 md:grid-cols-2">
            <div className="grid gap-1.5">
              <Label>{t('admin.brandingPage.settings.general.signupMethod' as any)}</Label>
              <Select value={method} onValueChange={(v) => { setMethod(v as Method); setDirty(true); }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="link">{t('admin.brandingPage.settings.general.signupMethodLink' as any)}</SelectItem>
                  <SelectItem value="otp">{t('admin.brandingPage.settings.general.signupMethodOtp' as any)}</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {method === 'otp'
                  ? t('admin.brandingPage.settings.general.signupMethodOtpHint' as any)
                  : t('admin.brandingPage.settings.general.signupMethodLinkHint' as any)}
              </p>
            </div>
            <div className="grid gap-1.5">
              <Label>{t('admin.brandingPage.settings.general.signupGate' as any)}</Label>
              <Select value={gate} onValueChange={(v) => { setGate(v as Gate); setDirty(true); }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="before">{t('admin.brandingPage.settings.general.signupGateBefore' as any)}</SelectItem>
                  <SelectItem value="after">{t('admin.brandingPage.settings.general.signupGateAfter' as any)}</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {gate === 'after'
                  ? t('admin.brandingPage.settings.general.signupGateAfterHint' as any)
                  : t('admin.brandingPage.settings.general.signupGateBeforeHint' as any)}
              </p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
