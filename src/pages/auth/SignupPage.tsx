import { useState, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from '@/i18n';
import { useAuth } from '@/features/auth/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { toast } from 'sonner';
import {
  Eye, EyeOff, Loader2, ArrowRight,
  CheckCircle2, AlertTriangle, ShieldCheck,
} from 'lucide-react';
import { usePlatformBrandingForLocale } from '@/hooks/usePublicBranding';
import { LanguageSelector } from '@/components/auth/LanguageSelector';
import signupIllustration from '@/assets/signup-illustration.jpg';

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
  const { signUp, signIn } = useAuth();
  const brand = usePlatformBrandingForLocale(locale);
  const isRtl = dir === 'rtl';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [loading, setLoading] = useState(false);

  const pwStrength = useMemo(() => (password ? getPasswordStrength(password) : null), [password]);
  const passwordsMatch = confirmPassword.length > 0 && password === confirmPassword;

  const brandName = useMemo(() => brand?.platform_name || 'App', [brand]);
  const brandLetter = useMemo(() => brandName.charAt(0), [brandName]);

  const strengthLabels: Record<string, string> = {
    weak: t('auth.pwWeak'),
    medium: t('auth.pwMedium'),
    good: t('auth.pwGood'),
    strong: t('auth.pwStrong'),
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!acceptedTerms) {
      toast.error(t('auth.mustAcceptTerms'));
      return;
    }
    if (password !== confirmPassword) {
      toast.error(t('auth.passwordsMismatch'));
      return;
    }
    if (password.length < 6) {
      toast.error(t('auth.passwordMinLength'));
      return;
    }

    setLoading(true);
    const trimmedEmail = email.trim().toLowerCase();
    try {
      const { error } = await signUp({
        email: trimmedEmail,
        password,
        website: '',
        locale,
        metadata: { locale },
      });
      if (error) {
        toast.error(t('auth.signupFailed'), { description: error.message });
        return;
      }

      const { error: signInError } = await signIn({ email: trimmedEmail, password });
      if (signInError) {
        console.warn('[signup] Auto-login failed, retrying...', signInError.message);
        await new Promise(r => setTimeout(r, 500));
        const { error: retryError } = await signIn({ email: trimmedEmail, password });
        if (retryError) {
          console.error('[signup] Auto-login retry failed:', retryError.message);
          toast.error(t('auth.signupSuccess'), { description: 'Please log in manually.' });
          navigate('/auth/login');
          return;
        }
      }

      toast.success(t('auth.signupSuccess'));
      navigate('/app');
    } catch (err: any) {
      toast.error(t('auth.signupFailed'), { description: err?.message });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 flex" dir={dir}>
      {/* Left side — Form */}
      <div className={`flex-1 flex flex-col bg-background overflow-y-auto ${isRtl ? 'order-2' : 'order-1'}`}>
        {/* Top bar */}
        <div className="flex items-center justify-between px-8 py-5 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-primary flex items-center justify-center">
              <span className="text-sm font-black text-primary-foreground">{brandLetter}</span>
            </div>
            <span className="text-lg font-semibold text-foreground">{brandName}</span>
          </div>
          <LanguageSelector />
        </div>

        {/* Form area */}
        <div className="flex-1 flex items-center justify-center px-6 pb-12">
          <div className="w-full max-w-[420px] space-y-7">
            <div className="space-y-2">
              <h1 className="text-3xl font-bold text-foreground tracking-tight">{t('auth.signupTitle')}</h1>
              <p className="text-muted-foreground">{t('auth.signupSubtitle')}</p>
            </div>

            <form onSubmit={handleRegister} className="space-y-4">
              {/* Email */}
              <div className="space-y-2">
                <Label htmlFor="email" className="text-foreground">{t('auth.email')}</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="you@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  dir="ltr"
                  className="h-12 text-left bg-background border-border"
                  required
                />
              </div>

              {/* Password */}
              <div className="space-y-2">
                <Label htmlFor="password" className="text-foreground">{t('auth.password')}</Label>
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

              {/* Confirm Password */}
              <div className="space-y-2">
                <Label htmlFor="confirm" className="text-foreground">{t('auth.confirmPassword')}</Label>
                <div className="relative">
                  <Input
                    id="confirm"
                    type="password"
                    placeholder={t('auth.confirmPasswordPlaceholder')}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    dir="ltr"
                    className={`h-12 text-left bg-background border-border pr-11 ${confirmPassword && !passwordsMatch ? 'border-destructive/50 focus-visible:ring-destructive/30' : ''}`}
                    required
                  />
                  {confirmPassword && (
                    <div className={`absolute ${isRtl ? 'left-3' : 'right-3'} top-1/2 -translate-y-1/2`}>
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

              {/* Terms */}
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
                    {t('auth.signup')}
                    <ArrowRight className="w-4 h-4" />
                  </>
                )}
              </Button>
            </form>

            <div className="pt-1 text-center">
              <p className="text-sm text-muted-foreground">
                {t('auth.hasAccount')}{' '}
                <Link to="/auth/login" className="text-primary hover:underline font-semibold">
                  {t('auth.login')}
                </Link>
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Right side — Illustration panel */}
      <div className={`hidden lg:flex w-[42%] xl:w-[45%] relative overflow-hidden ${isRtl ? 'order-1' : 'order-2'}`}
        style={{ background: 'linear-gradient(135deg, hsl(250 80% 55%), hsl(280 70% 50%), hsl(250 80% 45%))' }}
      >
        {/* Decorative blurred shapes */}
        <div className="absolute -top-24 -right-24 w-80 h-80 rounded-full bg-white/10 blur-3xl" />
        <div className="absolute bottom-0 -left-20 w-[500px] h-[500px] rounded-full bg-white/5 blur-2xl" />
        <div className="absolute top-1/3 right-16 w-48 h-48 rounded-full bg-white/8 blur-xl" />

        {/* Grid pattern overlay */}
        <div className="absolute inset-0 opacity-[0.03]"
          style={{
            backgroundImage: 'radial-gradient(circle, white 1px, transparent 1px)',
            backgroundSize: '24px 24px',
          }}
        />

        <div className="relative z-10 flex flex-col justify-center items-center p-12 text-center w-full">
          <div className="space-y-5 max-w-md">
            <h2 className="text-3xl xl:text-4xl font-bold text-white leading-tight">
              {t('auth.signupPromoTitle')}
            </h2>
            <p className="text-white/70 text-base leading-relaxed">
              {t('auth.signupPromoSubtitle')}
            </p>
          </div>

          <div className="mt-10 w-full max-w-md rounded-2xl overflow-hidden shadow-2xl ring-1 ring-white/20 transform hover:scale-[1.02] transition-transform duration-500">
            <img
              src={signupIllustration}
              alt="Team collaboration"
              className="w-full h-auto object-cover"
              width={960}
              height={1080}
            />
          </div>

          {/* Trust badges */}
          <div className="mt-8 flex flex-wrap justify-center gap-2">
            {['Free Forever', 'No Credit Card', 'Setup in 2 min', 'Secure'].map((badge) => (
              <span key={badge} className="px-3 py-1.5 text-xs font-medium text-white/90 bg-white/10 rounded-full backdrop-blur-sm border border-white/10">
                ✓ {badge}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
