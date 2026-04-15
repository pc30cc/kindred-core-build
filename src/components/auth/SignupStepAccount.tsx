import { useState, useMemo } from 'react';
import { useTranslation } from '@/i18n';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { Eye, EyeOff, Loader2, ArrowRight, ShieldCheck } from 'lucide-react';

function getPasswordStrength(pw: string): { score: number; label: string; color: string } {
  let score = 0;
  if (pw.length >= 6) score++;
  if (pw.length >= 10) score++;
  if (/[A-Z]/.test(pw)) score++;
  if (/[0-9]/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  if (score <= 1) return { score: 1, label: 'weak', color: 'bg-destructive' };
  if (score <= 2) return { score: 2, label: 'medium', color: 'bg-yellow-500' };
  if (score <= 3) return { score: 3, label: 'good', color: 'bg-blue-500' };
  return { score: 4, label: 'strong', color: 'bg-green-500' };
}

interface SignupStepAccountProps {
  firstName: string;
  setFirstName: (v: string) => void;
  lastName: string;
  setLastName: (v: string) => void;
  email: string;
  setEmail: (v: string) => void;
  password: string;
  setPassword: (v: string) => void;
  acceptedTerms: boolean;
  setAcceptedTerms: (v: boolean) => void;
  loading: boolean;
  onSubmit: (e: React.FormEvent) => void;
  isRtl: boolean;
}

export default function SignupStepAccount({
  firstName, setFirstName, lastName, setLastName,
  email, setEmail, password, setPassword,
  acceptedTerms, setAcceptedTerms, loading, onSubmit, isRtl,
}: SignupStepAccountProps) {
  const { t } = useTranslation();
  const [showPassword, setShowPassword] = useState(false);
  const pwStrength = useMemo(() => (password ? getPasswordStrength(password) : null), [password]);

  const strengthLabels: Record<string, string> = {
    weak: t('auth.pwWeak'),
    medium: t('auth.pwMedium'),
    good: t('auth.pwGood'),
    strong: t('auth.pwStrong'),
  };

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label htmlFor="firstName" className="text-foreground">
            {t('auth.firstName')} <span className="text-destructive">*</span>
          </Label>
          <Input
            id="firstName"
            type="text"
            placeholder={t('auth.firstNamePlaceholder')}
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            className="h-12 bg-background border-border"
            required
            maxLength={60}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="lastName" className="text-foreground">
            {t('auth.lastName')} <span className="text-destructive">*</span>
          </Label>
          <Input
            id="lastName"
            type="text"
            placeholder={t('auth.lastNamePlaceholder')}
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            className="h-12 bg-background border-border"
            required
            maxLength={60}
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="email" className="text-foreground">
          {t('auth.email')} <span className="text-destructive">*</span>
        </Label>
        <Input
          id="email"
          type="email"
          placeholder="you@company.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          dir="ltr"
          className="h-12 text-left bg-background border-border"
          required
          maxLength={255}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="password" className="text-foreground">
          {t('auth.password')} <span className="text-destructive">*</span>
        </Label>
        <div className="relative">
          <Input
            id="password"
            type={showPassword ? 'text' : 'password'}
            placeholder={t('auth.passwordPlaceholder')}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            dir="ltr"
            className="h-12 text-left bg-background border-border pr-11"
            required
            maxLength={255}
          />
          <button
            type="button"
            onClick={() => setShowPassword(!showPassword)}
            className={`absolute ${isRtl ? 'left-3' : 'right-3'} top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors`}
          >
            {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
        </div>
        {pwStrength && (
          <div className="space-y-1.5">
            <div className="flex gap-1">
              {[1, 2, 3, 4].map(i => (
                <div
                  key={i}
                  className={`h-1.5 flex-1 rounded-full transition-all ${
                    i <= pwStrength.score ? pwStrength.color : 'bg-border'
                  }`}
                />
              ))}
            </div>
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <ShieldCheck className="w-3 h-3" />
              {t('auth.passwordStrength')}: <span className="font-medium text-foreground">{strengthLabels[pwStrength.label]}</span>
            </p>
          </div>
        )}
      </div>

      <div className="flex items-start gap-2">
        <Checkbox
          id="terms"
          checked={acceptedTerms}
          onCheckedChange={(v) => setAcceptedTerms(v === true)}
          className="mt-0.5"
        />
        <Label htmlFor="terms" className="text-sm text-muted-foreground leading-snug cursor-pointer">
          {t('auth.acceptTerms')}
        </Label>
      </div>

      <Button type="submit" className="w-full h-12 text-base font-semibold gap-2" disabled={loading || !acceptedTerms}>
        {loading ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <>
            {t('auth.continue')}
            <ArrowRight className="w-4 h-4" />
          </>
        )}
      </Button>
    </form>
  );
}
