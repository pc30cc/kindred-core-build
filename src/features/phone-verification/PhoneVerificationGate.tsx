/**
 * Generic gate for any registered verification purpose.
 *
 * This is UX only — the real enforcement lives in the backend (RLS policies
 * and the `assertPhoneVerificationSatisfied` guard). `full_page` is implemented
 * in this phase; `inline` and `dialog` reuse the same hooks and backend.
 */
import type { ReactNode } from 'react';
import { useTranslation } from '@/i18n';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Loader2, ShieldAlert, ShieldCheck } from 'lucide-react';
import type { PhoneVerificationPurpose } from '@/lib/api';
import { PhoneVerificationFlow } from './PhoneVerificationFlow';
import { usePhoneVerificationStatus } from './hooks';
import type { PhoneVerificationMode } from './types';

export interface PhoneVerificationGateProps {
  purpose: PhoneVerificationPurpose;
  workspaceId?: string;
  workspaceSlug?: string;
  mode?: PhoneVerificationMode;
  children: ReactNode;
}

export function PhoneVerificationGate({
  purpose,
  workspaceId,
  workspaceSlug,
  mode = 'full_page',
  children,
}: PhoneVerificationGateProps) {
  const { t } = useTranslation();
  const ctx = {
    purpose,
    ...(workspaceId ? { workspaceId } : {}),
    ...(workspaceSlug ? { workspaceSlug } : {}),
  };
  const { data, isLoading, isError, refetch } = usePhoneVerificationStatus(ctx);

  if (isLoading || (!data && !isError)) {
    return (
      <div className="flex items-center justify-center p-16 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  // Fail closed: an unreadable status never unlocks the surface.
  if (isError) {
    return (
      <div className="p-8 text-center text-sm text-muted-foreground">
        {t('phoneVerification.errors.phone_verification_unavailable')}
      </div>
    );
  }

  if (data?.satisfied) return <>{children}</>;

  // Non-owner members are never asked for a number and can never send an OTP.
  if (!data?.canVerify) {
    return (
      <div className={mode === 'full_page' ? 'max-w-xl mx-auto py-16' : 'py-6'}>
        <Card className="card-elevated border-warning/40">
          <CardHeader className="items-center text-center">
            <div className="p-3 rounded-xl bg-warning/10 mb-2 w-fit">
              <ShieldAlert className="h-6 w-6 text-warning" />
            </div>
            <CardTitle className="text-lg">{t('phoneVerification.memberLockedTitle')}</CardTitle>
            <CardDescription>{t('phoneVerification.memberLockedBody')}</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <div className={mode === 'full_page' ? 'max-w-xl mx-auto py-12' : 'py-6'}>
      <Card className="card-elevated">
        <CardHeader className="items-center text-center">
          <div className="p-3 rounded-xl bg-primary/10 mb-2 w-fit">
            <ShieldCheck className="h-6 w-6 text-primary" />
          </div>
          <CardTitle className="text-lg">{t('phoneVerification.ownerTitle')}</CardTitle>
          <CardDescription>{t('phoneVerification.ownerBody')}</CardDescription>
        </CardHeader>
        <CardContent>
          <PhoneVerificationFlow
            /* Remount on challenge identity change so a resumed challenge
               rehydrates its countdown from the server, not stale state. */
            key={data?.activeChallengeId ?? 'new'}
            context={ctx}
            initialPhoneMasked={data?.phoneMasked ?? null}
            initialResendAfterSeconds={data?.resendAfterSeconds ?? 0}
            initialChallengeId={data?.activeChallengeId ?? null}
            initialChallengeExpiresInSeconds={data?.challengeExpiresInSeconds ?? null}
            initialRemainingAttempts={data?.remainingAttempts ?? null}
            onVerified={() => { void refetch(); }}
          />
        </CardContent>
      </Card>
    </div>
  );
}