/**
 * Account-settings phone field wired to the SAME verification pipeline used by
 * the widget gate. Whether the user starts verification here or in the gate,
 * it is one challenge, one state, one source of truth (the backend).
 *
 * When the user cannot verify (no workspace context, or not the owner) the
 * legacy plain profile-phone field is rendered instead.
 */
import { useState, type ReactNode } from 'react';
import { useTranslation } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { CheckCircle2, Loader2, ShieldAlert, Smartphone } from 'lucide-react';
import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { PhoneVerificationFlow } from './PhoneVerificationFlow';
import { usePhoneVerificationStatus } from './hooks';

interface Props {
  /** Rendered when verification is not available for this user/context. */
  fallback: ReactNode;
}

export function AccountPhoneField({ fallback }: Props) {
  const { t } = useTranslation();
  const { workspace } = useActiveWorkspace();
  const [open, setOpen] = useState(false);

  const ctx = { purpose: 'widget_access' as const, ...(workspace?.slug ? { workspaceSlug: workspace.slug } : {}) };
  const { data, isLoading, isError, refetch } = usePhoneVerificationStatus(ctx, Boolean(workspace?.slug));

  if (!workspace?.slug || isError || (!isLoading && !data?.canVerify && !data?.satisfied)) {
    return <>{fallback}</>;
  }

  if (isLoading) {
    return (
      <div className="space-y-2">
        <Label className="text-xs font-medium text-muted-foreground">{t('account.phone')}</Label>
        <div className="flex h-10 items-center rounded-md border border-border/60 px-3 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      </div>
    );
  }

  const verified = Boolean(data?.satisfied);

  return (
    <div className="space-y-2">
      <Label className="text-xs font-medium text-muted-foreground">{t('account.phone')}</Label>

      <div
        className={`flex items-center justify-between gap-3 rounded-xl border px-3 py-2.5 ${
          verified ? 'border-success/40 bg-success/5' : 'border-warning/40 bg-warning/5'
        }`}
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <div
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
              verified ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning'
            }`}
          >
            {verified ? <CheckCircle2 className="h-4 w-4" /> : <ShieldAlert className="h-4 w-4" />}
          </div>
          <div className="min-w-0">
            <p className="truncate font-mono text-sm text-foreground" dir="ltr">
              {data?.phoneMasked || t('phoneVerification.statusNoPhone')}
            </p>
            <Badge variant="outline" className="mt-1 h-5 px-1.5 text-[10px]">
              {verified ? t('phoneVerification.statusVerified') : t('phoneVerification.statusUnverified')}
            </Badge>
          </div>
        </div>

        {!verified && (
          <Button size="sm" onClick={() => setOpen(true)}>
            <Smartphone className="h-4 w-4 me-1.5" />
            {t('phoneVerification.accountVerifyCta')}
          </Button>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        {verified ? t('phoneVerification.accountVerifiedNote') : t('phoneVerification.accountUnverifiedNote')}
      </p>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('phoneVerification.ownerTitle')}</DialogTitle>
            <DialogDescription>{t('phoneVerification.accountDialogBody')}</DialogDescription>
          </DialogHeader>
          <PhoneVerificationFlow
            key={data?.activeChallengeId ?? 'new'}
            context={ctx}
            initialPhoneMasked={data?.phoneMasked ?? null}
            initialResendAfterSeconds={data?.resendAfterSeconds ?? 0}
            initialChallengeId={data?.activeChallengeId ?? null}
            initialChallengeExpiresInSeconds={data?.challengeExpiresInSeconds ?? null}
            initialRemainingAttempts={data?.remainingAttempts ?? null}
            onVerified={() => {
              setOpen(false);
              void refetch();
            }}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
