import { useState, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from '@/i18n';
import { useAuth } from '@/features/auth/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import {
  Eye, EyeOff, UserPlus, Loader2,
  CheckCircle2, AlertTriangle, ShieldCheck,
} from 'lucide-react';
import { usePlatformBrandingForLocale } from '@/hooks/usePublicBranding';
import { LanguageSelector } from '@/components/auth/LanguageSelector';
import { sendVerificationEmail } from '@/lib/auth-email-api';

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

export default function SignupPage() {
  const navigate = useNavigate();
  const { t, locale, dir } = useTranslation();
  const { signUp } = useAuth();
  const brand = usePlatformBrandingForLocale(locale);
  const isRtl = dir === 'rtl';

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);

  const pwStrength = useMemo(() => (password ? getPasswordStrength(password) : null), [password]);
  const passwordsMatch = confirmPassword.length > 0 && password === confirmPassword;

  const brandLetter = useMemo(() => {
    const name = brand?.platform_name || 'App';
    return name.charAt(0);
  }, [brand]);

  const strengthLabels: Record<string, string> = {
    weak: t('auth.pwWeak'),
    medium: t('auth.pwMedium'),
    good: t('auth.pwGood'),
    strong: t('auth.pwStrong'),
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirmPassword) {
      toast.error(t('auth.passwordsMismatch'));
      return;
    }
    if (password.length < 6) {
      toast.error(t('auth.passwordMinLength'));
      return;
    }

    setLoading(true);
    try {
      const { error } = await signUp({
        email: email.trim().toLowerCase(),
        password,
        fullName: fullName.trim(),
      });
      if (error) {
        toast.error(t('auth.signupFailed'), { description: error.message });
        return;
      }

      // Send verification email via configured provider (not Supabase built-in)
      try {
        await sendVerificationEmail(email.trim().toLowerCase(), locale);
      } catch (emailErr) {
        console.warn('[signup] Provider email failed, Supabase fallback may apply:', emailErr);
      }

      toast.success(t('auth.signupSuccess'), { description: t('auth.signupSuccessDesc') });
      navigate(`/auth/check-email?email=${encodeURIComponent(email.trim().toLowerCase())}`);
    } catch (err: any) {
      toast.error(t('auth.signupFailed'), { description: err?.message });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4" dir={dir}>
      <div className="w-full max-w-lg space-y-6">
        {/* Header */}
        <div className="text-center space-y-3">
          <div className="w-16 h-16 rounded-2xl bg-primary/10 border border-primary/20 mx-auto flex items-center justify-center">
            <span className="text-2xl font-black text-primary">{brandLetter}</span>
          </div>
          <div>
            <h1 className="text-2xl font-bold text-foreground">{t('auth.signupTitle')}</h1>
            <p className="text-sm text-muted-foreground mt-1">{t('auth.signupSubtitle')}</p>
          </div>
        </div>

        {/* Form Card */}
        <div className="bg-card border border-border rounded-2xl p-7 space-y-5 shadow-sm">
          <form onSubmit={handleRegister} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name" className="text-sm">{t('auth.fullName')}</Label>
              <Input
                id="name"
                placeholder={t('auth.fullNamePlaceholder')}
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                className="h-11"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="email" className="text-sm">{t('auth.email')}</Label>
              <Input
                id="email"
                type="email"
                placeholder="email@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                dir="ltr"
                className="text-left h-11"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password" className="text-sm">{t('auth.password')}</Label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  placeholder={t('auth.passwordPlaceholder')}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  dir="ltr"
                  className={`text-left h-11 ${isRtl ? 'pr-10' : 'pl-10'}`}
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className={`absolute ${isRtl ? 'right-3' : 'left-3'} top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors`}
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              {/* Password Strength */}
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
            <div className="space-y-2">
              <Label htmlFor="confirm" className="text-sm">{t('auth.confirmPassword')}</Label>
              <div className="relative">
                <Input
                  id="confirm"
                  type="password"
                  placeholder={t('auth.confirmPasswordPlaceholder')}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  dir="ltr"
                  className={`text-left h-11 ${confirmPassword && !passwordsMatch ? 'border-destructive/50 focus-visible:ring-destructive/30' : ''}`}
                  required
                />
                {confirmPassword && (
                  <div className={`absolute ${isRtl ? 'right-3' : 'left-3'} top-1/2 -translate-y-1/2`}>
                    {passwordsMatch
                      ? <CheckCircle2 className="w-4 h-4 text-green-500" />
                      : <AlertTriangle className="w-4 h-4 text-destructive" />
                    }
                  </div>
                )}
              </div>
              {confirmPassword && !passwordsMatch && (
                <p className="text-xs text-destructive">{t('auth.passwordsMismatch')}</p>
              )}
            </div>
            <Button type="submit" className="w-full h-11 text-sm" disabled={loading}>
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />}
              <span className={isRtl ? 'mr-2' : 'ml-2'}>{t('auth.signup')}</span>
            </Button>
          </form>
        </div>

        {/* Footer */}
        <p className="text-center text-sm text-muted-foreground">
          {t('auth.hasAccount')}{' '}
          <Link to="/auth/login" className="text-primary hover:underline font-medium">{t('auth.login')}</Link>
        </p>

        <LanguageSelector />
      </div>
    </div>
  );
}
