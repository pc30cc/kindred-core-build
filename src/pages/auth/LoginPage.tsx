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
                    className="h-12 text-left bg-background border-border pr-11"
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
      <div className={`hidden lg:flex w-[42%] xl:w-[45%] relative overflow-hidden ${isRtl ? 'order-1' : 'order-2'}`}
        style={{ background: 'linear-gradient(135deg, hsl(221 83% 53%), hsl(250 80% 55%), hsl(221 83% 45%))' }}
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
              {t('auth.loginPromoTitle')}
            </h2>
            <p className="text-white/70 text-base leading-relaxed">
              {t('auth.loginPromoSubtitle')}
            </p>
          </div>

          <div className="mt-10 w-full max-w-md rounded-2xl overflow-hidden shadow-2xl ring-1 ring-white/20 transform hover:scale-[1.02] transition-transform duration-500">
            <img
              src={loginIllustration}
              alt="Platform preview"
              className="w-full h-auto object-cover"
              width={960}
              height={1080}
            />
          </div>

          {/* Feature pills */}
          <div className="mt-8 flex flex-wrap justify-center gap-2">
            {['Live Chat', 'Smart Inbox', 'Analytics', 'Automation'].map((feature) => (
              <span key={feature} className="px-3 py-1.5 text-xs font-medium text-white/90 bg-white/10 rounded-full backdrop-blur-sm border border-white/10">
                {feature}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
