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

interface Props {
  context: PhoneVerificationContext;
  initialPhoneMasked?: string | null;
  initialResendAfterSeconds?: number;
  onVerified?: () => void;
}

export function PhoneVerificationFlow({
  context,
  initialPhoneMasked,
  initialResendAfterSeconds = 0,
  onVerified,
}: Props) {
  const { t } = useTranslation();
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [maskedPhone, setMaskedPhone] = useState<string | null>(initialPhoneMasked ?? null);
  const [cooldown, setCooldown] = useState(initialResendAfterSeconds);

  const start = useStartPhoneVerification(context);
  const resend = useResendPhoneVerification(context);
  const check = useCheckPhoneVerification(context);

  useEffect(() => {
    if (cooldown <= 0) return;
    const id = window.setInterval(() => setCooldown((v) => (v > 0 ? v - 1 : 0)), 1000);
    return () => window.clearInterval(id);
  }, [cooldown]);

  const busy = start.isPending || resend.isPending || check.isPending;
  const step = challengeId ? 'code' : 'phone';

  const digitsOnly = useMemo(() => phone.replace(/[^\d\u06F0-\u06F9\u0660-\u0669]/g, ''), [phone]);

  const handleSend = () => {
    start.mutate(
      { phone: digitsOnly, country: 'IR' },
      {
        onSuccess: (res) => {
          setChallengeId(res.challengeId);
          setMaskedPhone(res.phoneMasked);
          setCooldown(res.resendAfterSeconds);
          toast({ title: t('phoneVerification.codeSent') });
        },
        onError: (err) => toast({ title: t(errorKey(err) as never), variant: 'destructive' }),
      },
    );
  };

  const handleResend = () => {
    resend.mutate(undefined, {
      onSuccess: (res) => {
        setChallengeId(res.challengeId);
        setMaskedPhone(res.phoneMasked);
        setCooldown(res.resendAfterSeconds);
        setCode('');
        toast({ title: t('phoneVerification.codeSent') });
      },
      onError: (err) => toast({ title: t(errorKey(err) as never), variant: 'destructive' }),
    });
  };

  const handleVerify = () => {
    if (!challengeId) return;
    check.mutate(
      { challengeId, code: code.replace(/\D/g, '') },
      {
        onSuccess: () => {
          toast({ title: t('phoneVerification.verifiedTitle') });
          onVerified?.();
        },
        onError: (err) => toast({ title: t(errorKey(err) as never), variant: 'destructive' }),
      },
    );
  };

  return (
    <div className="space-y-5">
      {step === 'phone' ? (
        <div className="space-y-3">
          <Label className="text-sm font-medium">{t('phoneVerification.phoneLabel')}</Label>
          <div className="flex items-stretch gap-2">
            <span className="inline-flex items-center rounded-md border border-border bg-muted px-3 text-sm font-mono text-muted-foreground">
              +98
            </span>
            <Input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="09121234567"
              inputMode="numeric"
              dir="ltr"
              className="font-mono"
              disabled={busy}
            />
          </div>
          <p className="text-xs text-muted-foreground">{t('phoneVerification.phoneHint')}</p>
          <Button onClick={handleSend} disabled={busy || digitsOnly.length < 10} className="w-full">
            {start.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Smartphone className="h-4 w-4" />}
            <span className="ms-2">{t('phoneVerification.sendCode')}</span>
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <Label className="text-sm font-medium">{t('phoneVerification.codeLabel')}</Label>
          {maskedPhone && (
            <p className="text-xs text-muted-foreground font-mono" dir="ltr">
              {maskedPhone}
            </p>
          )}
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="––––––"
            inputMode="numeric"
            maxLength={6}
            dir="ltr"
            className="font-mono text-center tracking-[0.5em]"
            disabled={busy}
          />
          <Button onClick={handleVerify} disabled={busy || code.replace(/\D/g, '').length < 6} className="w-full">
            {check.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
            <span className="ms-2">{t('phoneVerification.verify')}</span>
          </Button>
          <div className="flex items-center justify-between gap-2">
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setChallengeId(null); setCode(''); }}>
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