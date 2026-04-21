import { useState, useMemo } from 'react';
import { useTranslation } from '@/i18n';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { Eye, EyeOff, Loader2, ArrowRight, ShieldCheck, User, Mail, Lock, Check, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
  const [focused, setFocused] = useState<string | null>(null);
  const [emailTouched, setEmailTouched] = useState(false);
  const pwStrength = useMemo(() => (password ? getPasswordStrength(password) : null), [password]);
  const emailValid = useMemo(() => EMAIL_RE.test(email.trim()), [email]);
  const showEmailError = emailTouched && email.length > 0 && !emailValid;

  const strengthLabels: Record<string, string> = {
    weak: t('auth.pwWeak'),
    medium: t('auth.pwMedium'),
    good: t('auth.pwGood'),
    strong: t('auth.pwStrong'),
  };

  // Shared field shell: icon prefix, focus ring, optional suffix slot.
  // All colors come from semantic tokens — no hard-coded values.
  const fieldShell = (args: {
    id: string;
    icon: React.ReactNode;
    children: React.ReactNode;
    suffix?: React.ReactNode;
    state?: 'default' | 'success' | 'error';
  }) => {
    const isFocused = focused === args.id;
    const ringClass =
      args.state === 'error'
        ? 'border-destructive/60 ring-destructive/20'
        : args.state === 'success'
        ? 'border-success/60 ring-success/15'
        : 'border-border ring-primary/15';
    return (
      <div
        className={cn(
          'group relative flex items-center h-12 rounded-xl border bg-background transition-all duration-200',
          'shadow-sm hover:border-foreground/20',
          isFocused && 'ring-4 border-primary',
          ringClass,
        )}
      >
        <span
          className={cn(
            'flex items-center justify-center w-11 h-full text-muted-foreground transition-colors',
            isFocused && 'text-primary',
            args.state === 'success' && !isFocused && 'text-success',
            args.state === 'error' && !isFocused && 'text-destructive',
          )}
          aria-hidden="true"
        >
          {args.icon}
        </span>
        {args.children}
        {args.suffix && (
          <span className={cn('flex items-center pr-3', isRtl && 'pl-3 pr-0')}>{args.suffix}</span>
        )}
      </div>
    );
  };

  const inputBase =
    'flex-1 h-full bg-transparent border-0 outline-none text-sm text-foreground placeholder:text-muted-foreground/70 disabled:opacity-50';

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      {/* Name row */}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label htmlFor="firstName" className="text-xs font-medium text-muted-foreground tracking-wide uppercase">
            {t('auth.firstName')}
          </Label>
          {fieldShell({
            id: 'firstName',
            icon: <User className="w-4 h-4" />,
            state: firstName.trim().length >= 2 ? 'success' : 'default',
            children: (
              <input
                id="firstName"
                type="text"
                placeholder={t('auth.firstNamePlaceholder')}
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                onFocus={() => setFocused('firstName')}
                onBlur={() => setFocused(null)}
                className={inputBase}
                required
                maxLength={60}
                autoComplete="given-name"
              />
            ),
          })}
        </div>
        <div className="space-y-2">
          <Label htmlFor="lastName" className="text-xs font-medium text-muted-foreground tracking-wide uppercase">
            {t('auth.lastName')}
          </Label>
          {fieldShell({
            id: 'lastName',
            icon: <User className="w-4 h-4" />,
            state: lastName.trim().length >= 2 ? 'success' : 'default',
            children: (
              <input
                id="lastName"
                type="text"
                placeholder={t('auth.lastNamePlaceholder')}
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                onFocus={() => setFocused('lastName')}
                onBlur={() => setFocused(null)}
                className={inputBase}
                required
                maxLength={60}
                autoComplete="family-name"
              />
            ),
          })}
        </div>
      </div>

      {/* Email */}
      <div className="space-y-2">
        <Label htmlFor="email" className="text-xs font-medium text-muted-foreground tracking-wide uppercase">
          {t('auth.email')}
        </Label>
        {fieldShell({
          id: 'email',
          icon: <Mail className="w-4 h-4" />,
          state: showEmailError ? 'error' : emailValid ? 'success' : 'default',
          suffix: emailValid ? (
            <Check className="w-4 h-4 text-success" />
          ) : showEmailError ? (
            <AlertCircle className="w-4 h-4 text-destructive" />
          ) : null,
          children: (
            <input
              id="email"
              type="email"
              placeholder="you@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onFocus={() => setFocused('email')}
              onBlur={() => { setFocused(null); setEmailTouched(true); }}
              dir="ltr"
              className={cn(inputBase, 'text-left')}
              required
              maxLength={255}
              autoComplete="email"
              inputMode="email"
            />
          ),
        })}
        {showEmailError && (
          <p className="text-xs text-destructive flex items-center gap-1.5 animate-fade-in">
            <AlertCircle className="w-3 h-3 shrink-0" />
            Please enter a valid email address
          </p>
        )}
      </div>

      {/* Password */}
      <div className="space-y-2">
        <Label htmlFor="password" className="text-xs font-medium text-muted-foreground tracking-wide uppercase">
          {t('auth.password')}
        </Label>
        {fieldShell({
          id: 'password',
          icon: <Lock className="w-4 h-4" />,
          state: pwStrength && pwStrength.score >= 3 ? 'success' : 'default',
          suffix: (
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="text-muted-foreground hover:text-foreground transition-colors p-1 -mr-1"
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              tabIndex={-1}
            >
              {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          ),
          children: (
            <input
              id="password"
              type={showPassword ? 'text' : 'password'}
              placeholder={t('auth.passwordPlaceholder')}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onFocus={() => setFocused('password')}
              onBlur={() => setFocused(null)}
              dir="ltr"
              className={cn(inputBase, 'text-left')}
              required
              maxLength={255}
              autoComplete="new-password"
            />
          ),
        })}
        {pwStrength && (
          <div className="space-y-1.5 pt-0.5 animate-fade-in">
            <div className="flex gap-1">
              {[1, 2, 3, 4].map(i => (
                <div
                  key={i}
                  className={cn(
                    'h-1 flex-1 rounded-full transition-all duration-300',
                    i <= pwStrength.score ? pwStrength.color : 'bg-border',
                  )}
                />
              ))}
            </div>
            <p className="text-xs text-muted-foreground flex items-center gap-1.5">
              <ShieldCheck className="w-3 h-3" />
              {t('auth.passwordStrength')}:{' '}
              <span className="font-semibold text-foreground">{strengthLabels[pwStrength.label]}</span>
            </p>
          </div>
        )}
      </div>

      <div className="flex items-start gap-2.5 pt-1">
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

      <Button
        type="submit"
        className="w-full h-12 text-base font-semibold gap-2 rounded-xl shadow-sm hover:shadow-md transition-shadow"
        disabled={loading || !acceptedTerms}
      >
        {loading ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <>
            {t('auth.continue')}
            <ArrowRight className={cn('w-4 h-4 transition-transform', isRtl ? 'rotate-180' : '')} />
          </>
        )}
      </Button>
    </form>
  );
}
