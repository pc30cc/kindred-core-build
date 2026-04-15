import { useState, useEffect, useMemo } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from '@/i18n';
import { useAuth } from '@/features/auth/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { Eye, EyeOff, Loader2, ArrowRight } from 'lucide-react';
import { usePlatformBrandingForLocale } from '@/hooks/usePublicBranding';
import { LanguageSelector } from '@/components/auth/LanguageSelector';
import loginIllustration from '@/assets/login-illustration.jpg';

export default function LoginPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { t, locale, dir } = useTranslation();
  const { signIn, user, isLoading: authLoading } = useAuth();
  const brand = usePlatformBrandingForLocale(locale);
  const isRtl = dir === 'rtl';

  useEffect(() => {
    if (user && !authLoading) {
      navigate(params.get('redirect') || '/app', { replace: true });
    }
  }, [user, authLoading, navigate, params]);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);

  const brandName = useMemo(() => brand?.platform_name || 'App', [brand]);
  const brandLetter = useMemo(() => brandName.charAt(0), [brandName]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const { error } = await signIn({ email, password });
      if (error) {
        toast.error(t('auth.loginFailed'), { description: error.message });
        return;
      }
      toast.success(t('auth.welcomeBack'));
      navigate(params.get('redirect') || '/app');
    } catch (err: any) {
      toast.error(t('auth.loginFailed'), { description: err?.message });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex" dir={dir}>
      {/* Left side — Form */}
      <div className="flex-1 flex flex-col bg-background">
        {/* Top bar */}
        <div className="flex items-center justify-between px-8 py-5">
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
          <div className="w-full max-w-[420px] space-y-8">
            <div className="space-y-2">
              <h1 className="text-3xl font-bold text-foreground tracking-tight">{t('auth.loginTitle')}</h1>
              <p className="text-muted-foreground">{t('auth.loginSubtitle')}</p>
            </div>

            <form onSubmit={handleLogin} className="space-y-5">
              <div className="space-y-2">
                <Label htmlFor="email" className="text-foreground">{t('auth.email')}</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="you@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  dir="ltr"
                  className="h-12 text-left bg-background border-border"
                />
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="password" className="text-foreground">{t('auth.password')}</Label>
                  <Link
                    to="/auth/forgot-password"
                    className="text-xs text-primary hover:underline font-medium"
                  >
                    {t('auth.forgotPassword')}
                  </Link>
                </div>
                <div className="relative">
                  <Input
                    id="password"
                    type={showPassword ? 'text' : 'password'}
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    dir="ltr"
                    className={`h-12 text-left bg-background border-border ${isRtl ? 'pr-11' : 'pr-11'}`}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className={`absolute ${isRtl ? 'left-3' : 'right-3'} top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors`}
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <Button type="submit" className="w-full h-12 text-base font-semibold gap-2" disabled={loading}>
                {loading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <>
                    {t('auth.login')}
                    <ArrowRight className="w-4 h-4" />
                  </>
                )}
              </Button>
            </form>

            <div className="pt-2 text-center">
              <p className="text-sm text-muted-foreground">
                {t('auth.noAccount')}{' '}
                <Link to="/auth/signup" className="text-primary hover:underline font-semibold">
                  {t('auth.signup')}
                </Link>
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Right side — Illustration panel (hidden on mobile) */}
      <div className="hidden lg:flex w-[480px] xl:w-[540px] relative overflow-hidden bg-gradient-to-br from-primary/90 via-primary to-[hsl(var(--primary)/0.8)]">
        {/* Decorative circles */}
        <div className="absolute -top-20 -right-20 w-72 h-72 rounded-full bg-white/5" />
        <div className="absolute -bottom-32 -left-16 w-96 h-96 rounded-full bg-white/5" />
        <div className="absolute top-1/4 right-10 w-40 h-40 rounded-full bg-white/5" />

        <div className="relative z-10 flex flex-col justify-center items-center p-10 text-center w-full">
          <div className="space-y-6 max-w-sm">
            <h2 className="text-2xl xl:text-3xl font-bold text-primary-foreground leading-tight">
              {t('auth.loginPromoTitle')}
            </h2>
            <p className="text-primary-foreground/80 text-sm leading-relaxed">
              {t('auth.loginPromoSubtitle')}
            </p>
          </div>

          <div className="mt-8 w-full max-w-[400px] rounded-2xl overflow-hidden shadow-2xl ring-1 ring-white/10">
            <img
              src={loginIllustration}
              alt="Platform preview"
              className="w-full h-auto object-cover"
              width={960}
              height={1080}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
