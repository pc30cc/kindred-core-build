/**
 * In-app six-digit email verification dialog.
 *
 * Used by the "email not verified" bar when the platform's signup
 * verification METHOD is `otp` and the GATE is `after`: the user is already
 * inside their workspace, so verification must happen in place instead of
 * bouncing them out to a full-page screen.
 *
 * Same self-hosted redemption path as the standalone page — Express only.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from '@/i18n';
import { useAuth } from '@/features/auth/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ShieldCheck, Loader2, RefreshCw } from 'lucide-react';
import { toast } from '@/lib/toast';
import { startEmailOtp, resendEmailOtp, verifyEmailOtp, EmailOtpError, type EmailOtpChallenge } from '@/lib/emailOtp';

const CODE_LENGTH = 6;

function secondsUntil(iso: string | undefined): number {
  if (!iso) return 0;
  return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 1000));
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function EmailOtpDialog({ open, onOpenChange }: Props) {
  const { t, locale, dir } = useTranslation();
  const { user } = useAuth();

  const [challenge, setChallenge] = useState<EmailOtpChallenge | null>(null);
  const [code, setCode] = useState('');
  const [starting, setStarting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef<string>(crypto.randomUUID());
  const requestedRef = useRef(false);

  const describeError = (codeStr: string) => {
    switch (codeStr) {
      case 'otp_unavailable':
        return t('auth.otpUnavailable' as any);
      case 'too_many_requests':
        return t('auth.otpTooManyRequests' as any);
      case 'expired':
      case 'not_found':
        return t('auth.otpExpired' as any);
      default:
        return t('auth.otpInvalidCode' as any);
    }
  };

  const issue = async (isResend: boolean) => {
    try {
      const next = isResend && challenge
        ? await resendEmailOtp(challenge.handle, locale)
        : await startEmailOtp(locale);
      if ((next as any).alreadyVerified) {
        toast.success(t('auth.emailAlreadyVerified' as any));
        window.location.reload();
        return;
      }
      setChallenge(next);
      setCooldown(secondsUntil(next.resendAvailableAt));
      setError(null);
      if (isResend) toast.success(t('auth.otpResent' as any));
    } catch (err) {
      const codeStr = err instanceof EmailOtpError ? err.code : 'unknown';
      setError(describeError(codeStr));
    }
  };

  // Request a fresh code the first time the dialog is opened.
  useEffect(() => {
    if (!open || requestedRef.current) return;
    requestedRef.current = true;
    setStarting(true);
    void issue(false).finally(() => setStarting(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setInterval(() => setCooldown((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(id);
  }, [cooldown]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!challenge || code.length !== CODE_LENGTH || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await verifyEmailOtp(challenge.handle, code, requestIdRef.current);
      toast.success(t('auth.otpVerified' as any));
      // Reload so the session's verified flag is re-resolved server-side.
      window.location.reload();
    } catch (err) {
      requestIdRef.current = crypto.randomUUID();
      const codeStr = err instanceof EmailOtpError ? err.code : 'unknown';
      setError(describeError(codeStr));
      setCode('');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm" dir={dir}>
        <DialogHeader className="items-center text-center">
          <div className="mx-auto mb-2 flex h-14 w-14 items-center justify-center rounded-full bg-primary/10">
            <ShieldCheck className="h-7 w-7 text-primary" />
          </div>
          <DialogTitle>{t('auth.otpTitle' as any)}</DialogTitle>
          <DialogDescription>
            {t('auth.otpDesc' as any)}
            {user?.email ? (
              <span className="mt-1 block select-all font-medium text-foreground" dir="ltr">
                {user.email}
              </span>
            ) : null}
          </DialogDescription>
        </DialogHeader>

        {starting ? (
          <div className="flex justify-center py-6">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, CODE_LENGTH))}
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              dir="ltr"
              placeholder="------"
              className="h-14 text-center text-2xl font-bold tracking-[0.5em]"
            />
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button
              type="submit"
              className="h-11 w-full text-base font-semibold"
              disabled={submitting || code.length !== CODE_LENGTH || !challenge}
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : t('auth.otpVerifyButton' as any)}
            </Button>
          </form>
        )}

        <div className="flex justify-center">
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={cooldown > 0 || starting}
            onClick={() => void issue(true)}
          >
            <RefreshCw className="h-4 w-4" />
            {cooldown > 0
              ? t('auth.otpResendIn' as any).replace('{seconds}', String(cooldown))
              : t('auth.otpResend' as any)}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default EmailOtpDialog;
