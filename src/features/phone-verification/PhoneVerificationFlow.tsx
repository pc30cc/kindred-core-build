/**
 * Reusable OTP flow: phone → send code → enter code → verified.
 * Contains zero provider knowledge: the platform's SMS vendor is chosen by
 * the super admin only and is never surfaced here.
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/hooks/use-toast';
import { Loader2, ShieldCheck, Smartphone } from 'lucide-react';
import type { PhoneVerificationContext } from '@/lib/api';
import {
  useCheckPhoneVerification,
  useCancelPhoneVerification,
  useResendPhoneVerification,
  useStartPhoneVerification,
} from './hooks';

const KNOWN_ERRORS = new Set([
  'phone_verification_required',
  'phone_verification_not_allowed',
  'phone_invalid',
  'phone_country_not_supported',
  'phone_rate_limited',
  'phone_resend_too_soon',
  'phone_code_invalid',
  'phone_code_expired',
  'phone_attempts_exceeded',
  'phone_challenge_not_found',
  'phone_already_verified',
  'phone_verification_unavailable',
]);

function errorKey(err: unknown): string {
  const raw = err instanceof Error ? err.message : '';
  return KNOWN_ERRORS.has(raw) ? `phoneVerification.errors.${raw}` : 'phoneVerification.errors.phone_verification_unavailable';
}

function errorCode(err: unknown): string {
  const raw = err instanceof Error ? err.message : '';
  return KNOWN_ERRORS.has(raw) ? raw : 'phone_verification_unavailable';
}

/** Persian/Arabic-Indic digits → ASCII. */
function toAsciiDigits(value: string): string {
  return value
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660));
}

interface Props {
  context: PhoneVerificationContext;
  initialPhoneMasked?: string | null;
  initialResendAfterSeconds?: number;
  /** Rehydrated from the server status so a reload never loses the OTP. */
  initialChallengeId?: string | null;
  initialChallengeExpiresInSeconds?: number | null;
  initialRemainingAttempts?: number | null;
  onVerified?: () => void;
}

export function PhoneVerificationFlow({
  context,
  initialPhoneMasked,
  initialResendAfterSeconds = 0,
  initialChallengeId = null,
  initialChallengeExpiresInSeconds = null,
  initialRemainingAttempts = null,
  onVerified,
}: Props) {
  const { t } = useTranslation();
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [challengeId, setChallengeId] = useState<string | null>(initialChallengeId);
  const [maskedPhone, setMaskedPhone] = useState<string | null>(initialPhoneMasked ?? null);
  const [cooldown, setCooldown] = useState(initialResendAfterSeconds);
  const [expiresIn, setExpiresIn] = useState<number>(initialChallengeExpiresInSeconds ?? 0);
  const [attemptsLeft, setAttemptsLeft] = useState<number | null>(initialRemainingAttempts);
  const [expired, setExpired] = useState(false);

  const start = useStartPhoneVerification(context);
  const resend = useResendPhoneVerification(context);
  const check = useCheckPhoneVerification(context);
  const cancel = useCancelPhoneVerification(context);

  useEffect(() => {
    if (cooldown <= 0) return;
    const id = window.setInterval(() => setCooldown((v) => (v > 0 ? v - 1 : 0)), 1000);
    return () => window.clearInterval(id);
  }, [cooldown]);

  // Server-derived expiry countdown; on expiry the code step becomes read-only
  // and the user is guided back to a fresh resend/start.
  useEffect(() => {
    if (!challengeId || expiresIn <= 0) return;
    const id = window.setInterval(() => {
      setExpiresIn((v) => {
        if (v <= 1) {
          setExpired(true);
          return 0;
        }
        return v - 1;
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, [challengeId, expiresIn]);

  const busy = start.isPending || resend.isPending || check.isPending || cancel.isPending;
  const step = challengeId ? 'code' : 'phone';

  const digitsOnly = useMemo(
    () => toAsciiDigits(phone).replace(/\D/g, ''),
    [phone],
  );
  const codeDigits = useMemo(() => toAsciiDigits(code).replace(/\D/g, '').slice(0, 6), [code]);

  const applyChallenge = (res: { challengeId: string; phoneMasked: string; expiresInSeconds: number; resendAfterSeconds: number }) => {
    setChallengeId(res.challengeId);
    setMaskedPhone(res.phoneMasked);
    setCooldown(res.resendAfterSeconds);
    setExpiresIn(res.expiresInSeconds);
    setAttemptsLeft(null);
    setExpired(false);
    setCode('');
  };

  const handleSend = () => {
    if (busy || digitsOnly.length < 10) return;
    start.mutate(
      { phone: digitsOnly, country: 'IR' },
      {
        onSuccess: (res) => {
          applyChallenge(res);
          toast({ title: t('phoneVerification.codeSent') });
        },
        onError: (err) => toast({ title: t(errorKey(err) as never), variant: 'destructive' }),
      },
    );
  };

  const handleResend = () => {
    if (busy || cooldown > 0) return;
    resend.mutate(undefined, {
      onSuccess: (res) => {
        applyChallenge(res);
        toast({ title: t('phoneVerification.codeSent') });
      },
      onError: (err) => toast({ title: t(errorKey(err) as never), variant: 'destructive' }),
    });
  };

  const handleVerify = () => {
    if (!challengeId || busy || expired || codeDigits.length < 6) return;
    check.mutate(
      { challengeId, code: codeDigits },
      {
        onSuccess: () => {
          toast({ title: t('phoneVerification.verifiedTitle') });
          onVerified?.();
        },
        onError: (err) => {
          const code2 = errorCode(err);
          toast({ title: t(`phoneVerification.errors.${code2}` as never), variant: 'destructive' });
          // A wrong code keeps the user on the code step; only a dead challenge
          // sends them back to the start.
          if (code2 === 'phone_code_expired') setExpired(true);
          if (code2 === 'phone_attempts_exceeded' || code2 === 'phone_challenge_not_found') {
            setChallengeId(null);
            setCode('');
            setExpired(false);
          } else if (code2 === 'phone_code_invalid') {
            setAttemptsLeft((v) => (typeof v === 'number' && v > 0 ? v - 1 : v));
          }
        },
      },
    );
  };

  /** Invalidates the outstanding code server-side before returning to step 1. */
  const handleChangeNumber = () => {
    if (busy) return;
    const id = challengeId;
    const reset = () => {
      setChallengeId(null);
      setCode('');
      setExpired(false);
      setAttemptsLeft(null);
      setExpiresIn(0);
    };
    cancel.mutate(
      { challengeId: id },
      {
        onSuccess: reset,
        // A cancel that could not be recorded must not pretend the old code is
        // dead: keep the user on the code step and surface the failure.
        onError: (err) => toast({ title: t(errorKey(err) as never), variant: 'destructive' }),
      },
    );
  };

  return (
    <div className="space-y-5">
      {step === 'phone' ? (
        <div className="space-y-3">
          <Label className="text-sm font-medium">{t('phoneVerification.phoneLabel')}</Label>
          {/* dir=ltr keeps the country prefix pinned to the left even in RTL locales */}
          <div
            dir="ltr"
            className="flex items-stretch overflow-hidden rounded-xl border border-border bg-background shadow-sm transition-colors focus-within:border-primary/60 focus-within:ring-2 focus-within:ring-primary/20"
          >
            <span className="inline-flex items-center gap-1.5 border-r border-border bg-muted/60 px-3 text-sm font-mono text-muted-foreground select-none">
              <Smartphone className="h-3.5 w-3.5" />
              +98
            </span>
            <Input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSend(); }}
              placeholder="09121234567"
              inputMode="numeric"
              dir="ltr"
              className="h-11 flex-1 border-0 bg-transparent font-mono tracking-wider shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
              disabled={busy}
            />
          </div>
          <p className="text-xs text-muted-foreground">{t('phoneVerification.phoneHint')}</p>
          <Button onClick={handleSend} disabled={busy || digitsOnly.length < 10} className="w-full h-11 shadow-sm">
            {start.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Smartphone className="h-4 w-4" />}
            <span className="ms-2">{t('phoneVerification.sendCode')}</span>
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <Label className="text-sm font-medium">{t('phoneVerification.codeLabel')}</Label>
          {maskedPhone && (
            <p className="inline-flex items-center gap-1.5 rounded-full bg-muted/60 px-2.5 py-1 text-xs font-mono text-muted-foreground" dir="ltr">
              <Smartphone className="h-3 w-3" />
              {maskedPhone}
            </p>
          )}
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleVerify(); }}
            placeholder="––––––"
            inputMode="numeric"
            maxLength={6}
            dir="ltr"
            className="h-14 rounded-xl bg-muted/30 font-mono text-center text-xl tracking-[0.5em]"
            disabled={busy || expired}
          />
          {expired ? (
            <p className="text-xs text-warning">{t('phoneVerification.errors.phone_code_expired')}</p>
          ) : (
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                {expiresIn > 0
                  ? t('phoneVerification.expiresIn').replace('{{seconds}}', String(expiresIn))
                  : ''}
              </span>
              {typeof attemptsLeft === 'number' && (
                <span>{t('phoneVerification.attemptsLeft').replace('{{count}}', String(attemptsLeft))}</span>
              )}
            </div>
          )}
          <Button onClick={handleVerify} disabled={busy || expired || codeDigits.length < 6} className="w-full h-11 shadow-sm">
            {check.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
            <span className="ms-2">{t('phoneVerification.verify')}</span>
          </Button>
          <div className="flex items-center justify-between gap-2">
            <Button variant="ghost" size="sm" disabled={busy} onClick={handleChangeNumber}>
              {cancel.isPending && <Loader2 className="h-3 w-3 animate-spin me-2" />}
              {t('phoneVerification.changeNumber')}
            </Button>
            <Button variant="ghost" size="sm" disabled={busy || cooldown > 0} onClick={handleResend}>
              {cooldown > 0
                ? t('phoneVerification.resendIn').replace('{{seconds}}', String(cooldown))
                : t('phoneVerification.resend')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}