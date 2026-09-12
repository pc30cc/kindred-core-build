/**
 * Six-digit email verification code screen.
 *
 * Used when the platform's signup verification METHOD is `otp`: no link is
 * ever mailed in that mode, so this page is the only redemption surface.
 * It works for both gates — reached right after signup when the gate is
 * `before`, or from the in-app banner when the gate is `after`.
 *
 * A code can only be requested for, and redeemed by, the signed-in account
 * it belongs to; the address is never taken from the URL.
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from '@/i18n';
import { useAuth } from '@/features/auth/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LanguageSelector } from '@/components/auth/LanguageSelector';
import { ShieldCheck, Loader2, RefreshCw, Home } from 'lucide-react';
import { toast } from '@/lib/toast';
import { startEmailOtp, resendEmailOtp, verifyEmailOtp, EmailOtpError, type EmailOtpChallenge } from '@/lib/emailOtp';

const CODE_LENGTH = 6;

function secondsUntil(iso: string | undefined): number {
  if (!iso) return 0;
  return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 1000));
}

export default function VerifyOtpPage() {
  const { t, locale, dir } = useTranslation();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [challenge, setChallenge] = useState<EmailOtpChallenge | null>(null);
  const [code, setCode] = useState('');
  const [starting, setStarting] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // Stable per submit attempt so an interrupted request replays instead of
  // consuming a second verification attempt on retry.
  const requestIdRef = useRef<string>(crypto.randomUUID());
  const requestedRef = useRef(false);

  const describeError = (codeStr: string) => {
    switch (codeStr) {
      case 'otp_unavailable':
        return t('auth.otpUnavailable');
      case 'too_many_requests':
        return t('auth.otpTooManyRequests');
      case 'expired':
      case 'not_found':
        return t('auth.otpExpired');
      default:
        return t('auth.otpInvalidCode');
    }
  };

  const issue = async (isResend: boolean) => {
    try {
      const next = isResend && challenge
        ? await resendEmailOtp(challenge.handle, locale)
        : await startEmailOtp(locale);
      if ((next as any).alreadyVerified) {
        toast.success(t('auth.emailAlreadyVerified'));
        window.location.href = '/app';
        return;
      }
      setChallenge(next);
      setCooldown(secondsUntil(next.resendAvailableAt));
      setError(null);
      if (isResend) toast.success(t('auth.otpResent'));
    } catch (err) {
      const codeStr = err instanceof EmailOtpError ? err.code : 'unknown';
      setError(describeError(codeStr));
    }
  };

  useEffect(() => {
    if (requestedRef.current) return;
    requestedRef.current = true;
    void issue(false).finally(() => setStarting(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      toast.success(t('auth.otpVerified'));
      // Full reload so the session's verified flag (and the workspace the
      // gate may have been withholding) are re-resolved from the server.
      window.location.href = '/app';
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
    <div className="min-h-screen bg-background flex items-center justify-center p-4" dir={dir}>
      <div className="w-full max-w-md">
        <div className="bg-card border border-border rounded-2xl shadow-lg p-8 space-y-6 text-center">
          <div className="mx-auto w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center">
            <ShieldCheck className="w-10 h-10 text-primary" />
          </div>

          <div className="space-y-2">
            <h1 className="text-2xl font-bold text-foreground">{t('auth.otpTitle')}</h1>
            <p className="text-muted-foreground text-sm leading-relaxed">{t('auth.otpDesc')}</p>
            {user?.email && (
              <span className="inline-block text-sm font-medium text-foreground select-all" dir="ltr">
                {user.email}
              </span>
            )}
          </div>

          {starting ? (
            <div className="flex justify-center py-6">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
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
                className="w-full h-12 text-base font-semibold"
                disabled={submitting || code.length !== CODE_LENGTH || !challenge}
              >
                {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : t('auth.otpVerifyButton')}
              </Button>
            </form>
          )}

          <div className="flex justify-center gap-3">
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              disabled={cooldown > 0 || starting}
              onClick={() => void issue(true)}
            >
              <RefreshCw className="w-4 h-4" />
              {cooldown > 0
                ? t('auth.otpResendIn').replace('{seconds}', String(cooldown))
                : t('auth.otpResend')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground gap-1.5"
              onClick={() => navigate('/app')}
            >
              <Home className="w-4 h-4" />
              {t('auth.otpLater')}
            </Button>
          </div>
        </div>

        <div className="mt-6">
          <LanguageSelector />
        </div>
      </div>
    </div>
  );
}
