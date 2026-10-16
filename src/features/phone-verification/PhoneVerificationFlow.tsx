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
import { AlertTriangle, CheckCircle2, Loader2, MessageSquare, PhoneCall, ShieldCheck, Smartphone } from 'lucide-react';
import type { PhoneChallenge, PhoneDeliveryChannel, PhoneVerificationContext } from '@/lib/api';
import { useEdition } from '@/hooks/useEdition';
import { isValidIntlPhone, normalizeIntlPhone, sanitizeIntlPhoneInput } from '@/lib/phone-countries';
import {
  useCheckPhoneVerification,
  useCancelPhoneVerification,
  usePhoneDeliveryState,
  usePhoneVerificationStatus,
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
  'phone_call_unavailable',
]);

function errorKey(err: unknown): string {
  const raw = err instanceof Error ? err.message : '';
  return KNOWN_ERRORS.has(raw) ? `phoneVerification.errors.${raw}` : 'phoneVerification.errors.phone_verification_unavailable';
}

function errorCode(err: unknown): string {
  const raw = err instanceof Error ? err.message : '';
  return KNOWN_ERRORS.has(raw) ? raw : 'phone_verification_unavailable';
}

/** 75 → "1:15": the countdowns read like a clock. */
function formatClock(totalSeconds: number): string {
  const seconds = Math.max(0, Math.ceil(totalSeconds));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
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
  // Iranian edition: an Iranian mobile number, as before. International: the
  // whole number in international form (+ and the country code), sent as the
  // pseudo-country `ZZ` (server/services/phoneVerification/phone.ts).
  const { isInternational } = useEdition();
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [challengeId, setChallengeId] = useState<string | null>(initialChallengeId);
  const [maskedPhone, setMaskedPhone] = useState<string | null>(initialPhoneMasked ?? null);
  const [cooldown, setCooldown] = useState(initialResendAfterSeconds);
  const [expiresIn, setExpiresIn] = useState<number>(initialChallengeExpiresInSeconds ?? 0);
  const [attemptsLeft, setAttemptsLeft] = useState<number | null>(initialRemainingAttempts);
  const [expired, setExpired] = useState(false);
  // How the current code went out, and when (for the delivery watch). A code
  // rehydrated after a reload has no known send time and is not watched.
  const [channel, setChannel] = useState<PhoneDeliveryChannel>('sms');
  const [sentAt, setSentAt] = useState<number | null>(null);

  // The same cached status query the surrounding screen already made: whether
  // a voice call can carry the code, and how the first code goes out.
  const { data: status } = usePhoneVerificationStatus(context);
  const voiceCall = status?.delivery?.voiceCall === true;
  const defaultChannel: PhoneDeliveryChannel = status?.delivery?.defaultChannel === 'call' ? 'call' : 'sms';

  const delivery = usePhoneDeliveryState(context, challengeId, sentAt);
  const deliveryState = delivery.data?.state ?? 'unknown';

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
  const intlPhone = useMemo(() => normalizeIntlPhone(phone), [phone]);
  const phoneReady = isInternational ? intlPhone !== '' && isValidIntlPhone(intlPhone) : digitsOnly.length >= 10;
  const codeDigits = useMemo(() => toAsciiDigits(code).replace(/\D/g, '').slice(0, 6), [code]);

  const applyChallenge = (res: PhoneChallenge, requested?: PhoneDeliveryChannel) => {
    const via: PhoneDeliveryChannel = res.channel ?? requested ?? defaultChannel;
    setChallengeId(res.challengeId);
    setMaskedPhone(res.phoneMasked);
    setCooldown(res.resendAfterSeconds);
    setExpiresIn(res.expiresInSeconds);
    setAttemptsLeft(null);
    setExpired(false);
    setCode('');
    setChannel(via);
    setSentAt(Date.now());
    toast({ title: t(via === 'call' ? 'phoneVerification.callStarted' : 'phoneVerification.codeSent') });
  };

  const handleSend = () => {
    if (busy || !phoneReady) return;
    start.mutate(
      isInternational ? { phone: intlPhone, country: 'ZZ' } : { phone: digitsOnly, country: 'IR' },
      {
        onSuccess: (res) => applyChallenge(res),
        onError: (err) => toast({ title: t(errorKey(err) as never), variant: 'destructive' }),
      },
    );
  };

  /** A new code by `via` ("Resend SMS", "Call me instead"); undefined = the platform default. */
  const handleResend = (via?: PhoneDeliveryChannel) => {
    if (busy || cooldown > 0) return;
    resend.mutate(via, {
      onSuccess: (res) => applyChallenge(res, via),
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
      setSentAt(null);
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
            data-phone-field
            className="flex items-stretch overflow-hidden rounded-xl border border-border bg-background shadow-sm transition-colors focus-within:border-primary/60 focus-within:ring-2 focus-within:ring-primary/20"
          >
            <span data-phone-prefix className="inline-flex items-center gap-1.5 border-r border-border bg-muted/60 px-3 text-sm font-mono text-muted-foreground select-none">
              <Smartphone className="h-3.5 w-3.5" />
              {isInternational ? null : '+98'}
            </span>
            <Input
              value={phone}
              onChange={(e) => setPhone(isInternational ? sanitizeIntlPhoneInput(e.target.value) : e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSend(); }}
              placeholder={isInternational ? '+447700900123' : '09121234567'}
              inputMode={isInternational ? 'tel' : 'numeric'}
              dir="ltr"
              className="h-11 flex-1 border-0 bg-transparent font-mono tracking-wider shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
              disabled={busy}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {t(isInternational ? 'phoneVerification.phoneHintInternational' : 'phoneVerification.phoneHint')}
          </p>
          <Button onClick={handleSend} disabled={busy || !phoneReady} className="w-full h-11 shadow-sm">
            {start.isPending
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : defaultChannel === 'call' ? <PhoneCall className="h-4 w-4" /> : <Smartphone className="h-4 w-4" />}
            <span className="ms-2">
              {t(defaultChannel === 'call' ? 'phoneVerification.sendCodeByCall' : 'phoneVerification.sendCode')}
            </span>
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <Label className="text-sm font-medium">{t('phoneVerification.codeLabel')}</Label>
          <div className="space-y-2" data-testid="phone-code-sent-to">
            {channel === 'call' ? (
              <p className="flex items-start gap-2 text-xs text-muted-foreground">
                <PhoneCall className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                <span>{t('phoneVerification.sentByCall')}</span>
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">{t('phoneVerification.sentBySms')}</p>
            )}
            {maskedPhone && (
              <div className="flex flex-wrap items-center gap-2">
                <p className="inline-flex items-center gap-1.5 rounded-full bg-muted/60 px-2.5 py-1 text-xs font-mono text-muted-foreground" dir="ltr">
                  {channel === 'call' ? <PhoneCall className="h-3 w-3" /> : <Smartphone className="h-3 w-3" />}
                  {maskedPhone}
                </p>
                {channel === 'sms' && deliveryState === 'delivered' && (
                  <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400" data-testid="phone-sms-delivered">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    {t('phoneVerification.smsDelivered')}
                  </span>
                )}
              </div>
            )}
          </div>
          {channel === 'sms' && deliveryState === 'failed' && !expired && (
            <div
              role="alert"
              data-testid="phone-sms-failed"
              className="space-y-2.5 rounded-xl border border-warning/40 bg-warning/10 p-3"
            >
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                <div className="space-y-0.5">
                  <p className="text-sm font-medium text-foreground">{t('phoneVerification.smsFailedTitle')}</p>
                  <p className="text-xs text-muted-foreground">
                    {t(voiceCall ? 'phoneVerification.smsFailedBody' : 'phoneVerification.smsFailedBodyNoCall')}
                  </p>
                </div>
              </div>
              {voiceCall && (
                <Button
                  size="sm"
                  className="w-full"
                  disabled={busy || cooldown > 0}
                  onClick={() => handleResend('call')}
                  data-testid="phone-call-me-failed"
                >
                  {resend.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <PhoneCall className="h-4 w-4" />}
                  <span className="ms-2">
                    {cooldown > 0
                      ? t('phoneVerification.callMeIn').replace('{{time}}', formatClock(cooldown))
                      : t('phoneVerification.callMe')}
                  </span>
                </Button>
              )}
            </div>
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
          <div className="space-y-2 border-t border-border/60 pt-3" data-testid="phone-not-received">
            <p className="text-center text-xs font-medium text-muted-foreground">{t('phoneVerification.notReceived')}</p>
            {cooldown > 0 ? (
              <p className="text-center text-xs text-muted-foreground" data-testid="phone-new-code-in">
                {t('phoneVerification.newCodeIn').replace('{{time}}', formatClock(cooldown))}
              </p>
            ) : voiceCall ? (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => handleResend('sms')}
                  data-testid="phone-resend-sms"
                >
                  <MessageSquare className="h-4 w-4" />
                  <span className="ms-2">
                    {t(channel === 'call' ? 'phoneVerification.sendSmsInstead' : 'phoneVerification.resendSms')}
                  </span>
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => handleResend('call')}
                  data-testid="phone-call-me"
                >
                  <PhoneCall className="h-4 w-4" />
                  <span className="ms-2">
                    {t(channel === 'call' ? 'phoneVerification.callAgain' : 'phoneVerification.callMe')}
                  </span>
                </Button>
              </div>
            ) : (
              <Button variant="outline" size="sm" className="w-full" disabled={busy} onClick={() => handleResend()}>
                {resend.isPending && <Loader2 className="h-3 w-3 animate-spin me-2" />}
                {t('phoneVerification.resend')}
              </Button>
            )}
            <div className="flex justify-center">
              <Button variant="ghost" size="sm" disabled={busy} onClick={handleChangeNumber}>
                {cancel.isPending && <Loader2 className="h-3 w-3 animate-spin me-2" />}
                {t('phoneVerification.changeNumber')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}