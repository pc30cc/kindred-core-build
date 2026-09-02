import { useState, useEffect, useMemo } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from '@/i18n';
import { useAuth } from '@/features/auth/AuthContext';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { toast } from '@/lib/toast';
import { Eye, EyeOff, Loader2, ArrowRight, Mail, Lock, Check } from 'lucide-react';
import { usePlatformBrandingForLocale } from '@/hooks/usePublicBranding';
import { LanguageSelector } from '@/components/auth/LanguageSelector';
import { cn } from '@/lib/utils';
import loginIllustration from '@/assets/login-illustration.jpg';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function LoginPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { t, locale, dir } = useTranslation();
  const { signIn, user, isLoading: authLoading } = useAuth();
  const brand = usePlatformBrandingForLocale(locale);
  const isRtl = dir === 'rtl';
  const destination = params.get('invited') === '1' ? '/invite' : (params.get('redirect') || '/app');

  useEffect(() => {
    if (user && !authLoading) {
      navigate(destination, { replace: true });
    }
  }, [user, authLoading, navigate, destination]);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [focused, setFocused] = useState<string | null>(null);
  const [setupRequired, setSetupRequired] = useState(false);
  const emailValid = useMemo(() => EMAIL_RE.test(email.trim()), [email]);

  const brandName = useMemo(() => brand?.platform_name || '', [brand]);
  const brandLetter = useMemo(() => brandName.charAt(0) || '', [brandName]);

  const forgotHref = useMemo(
    () => (emailValid ? `/auth/forgot-password?email=${encodeURIComponent(email.trim().toLowerCase())}` : '/auth/forgot-password'),
    [email, emailValid],
  );

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setSetupRequired(false);
    try {
      const { error } = await signIn({ email, password });
      if (error) {
        // Migrated account with no first-party password yet — the backend
        // answers 403 { passwordSetupRequired: true }. Surface the real
        // remediation instead of a bare "login failed" toast.
        if ((error as Error & { passwordSetupRequired?: boolean }).passwordSetupRequired) {
          setSetupRequired(true);
          toast.error(t('auth.passwordSetupRequiredTitle'), {
            description: t('auth.passwordSetupRequiredDesc'),
          });
          return;
        }
        toast.error(t('auth.loginFailed'), { description: error.message });
        return;
      }
      toast.success(t('auth.welcomeBack'));
      navigate(destination);
    } catch (err: any) {
      toast.error(t('auth.loginFailed'), { description: err?.message });
    } finally {
      setLoading(false);
    }
  };


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
        dir="ltr"
        className={cn(
          'group relative flex items-center h-12 rounded-xl border bg-background transition-all duration-200',
          'shadow-sm hover:border-foreground/20',
          isFocused && 'ring-4 border-primary',
          ringClass,
        )}
      >

        <span
          className={cn(
            'flex items-center justify-center w-12 h-full shrink-0 text-muted-foreground transition-colors',
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
          <span className="flex items-center justify-center w-11 h-full shrink-0">{args.suffix}</span>
        )}
      </div>
    );
  };

  const inputBase =
    'flex-1 min-w-0 h-full bg-transparent border-0 outline-none text-sm text-foreground placeholder:text-muted-foreground/70 disabled:opacity-50 px-1';

  return (
    <div className="fixed inset-0 flex" dir={dir}>
      <div className={`flex-1 flex flex-col bg-background overflow-y-auto ${isRtl ? 'order-2' : 'order-1'}`}>
        <div className="flex items-center justify-between px-8 py-5 shrink-0">
          {brandName ? (
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-primary flex items-center justify-center">
                <span className="text-sm font-black text-primary-foreground">{brandLetter}</span>
              </div>
              <span className="text-lg font-semibold text-foreground">{brandName}</span>
            </div>
          ) : (
            <div className="w-9 h-9" />
          )}
          <LanguageSelector />
        </div>

        <div className="flex-1 flex items-center justify-center px-6 pb-12">
          <div className="w-full max-w-[420px] space-y-8">
            <div className="space-y-2">
              <h1 className="text-3xl font-bold text-foreground tracking-tight">{t('auth.loginTitle')}</h1>
              <p className="text-muted-foreground">{t('auth.loginSubtitle')}</p>
            </div>

            <form onSubmit={handleLogin} className="space-y-5">
              <div className="space-y-2">
                <Label htmlFor="email" className="text-xs font-medium text-muted-foreground tracking-wide uppercase">
                  {t('auth.email')}
                </Label>
                {fieldShell({
                  id: 'email',
                  icon: <Mail className="w-4 h-4" />,
                  state: emailValid ? 'success' : 'default',
                  suffix: emailValid ? <Check className="w-4 h-4 text-success" /> : null,
                  children: (
                    <input
                      id="email"
                      type="email"
                      placeholder="you@company.com"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      onFocus={() => setFocused('email')}
                      onBlur={() => setFocused(null)}
                      required
                      dir="ltr"
                      className={cn(inputBase, 'text-left')}
                      autoComplete="email"
                      inputMode="email"
                    />
                  ),
                })}
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="password" className="text-xs font-medium text-muted-foreground tracking-wide uppercase">
                    {t('auth.password')}
                  </Label>
                  <Link
                    to={forgotHref}

                    className="text-xs text-primary hover:underline font-medium"
                  >
                    {t('auth.forgotPassword')}
                  </Link>
                </div>
                {fieldShell({
                  id: 'password',
                  icon: <Lock className="w-4 h-4" />,
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
                      placeholder="••••••••"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      onFocus={() => setFocused('password')}
                      onBlur={() => setFocused(null)}
                      required
                      dir="ltr"
                      className={cn(inputBase, 'text-left')}
                      autoComplete="current-password"
                    />
                  ),
                })}
              </div>

              {setupRequired && (
                <div className="rounded-xl border border-primary/30 bg-primary/5 p-4 space-y-3" role="alert">
                  <div className="space-y-1">
                    <p className="text-sm font-semibold text-foreground">{t('auth.passwordSetupRequiredTitle')}</p>
                    <p className="text-xs text-muted-foreground leading-relaxed">{t('auth.passwordSetupRequiredDesc')}</p>
                  </div>
                  <Button asChild variant="outline" size="sm" className="w-full rounded-lg">
                    <Link to={forgotHref}>{t('auth.setPasswordAction')}</Link>
                  </Button>
                </div>
              )}

              <Button

                type="submit"
                className="w-full h-12 text-base font-semibold gap-2 rounded-xl shadow-sm hover:shadow-md transition-shadow"
                disabled={loading}
              >
                {loading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <>
                    {t('auth.login')}
                    <ArrowRight className={cn('w-4 h-4', isRtl && 'rotate-180')} />
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

      <div className={`hidden lg:flex w-[42%] xl:w-[45%] relative overflow-hidden ${isRtl ? 'order-1' : 'order-2'}`}
        style={{ background: 'var(--gradient-auth-hero, var(--gradient-primary))' }}
      >
        <div className="absolute -top-24 -right-24 w-80 h-80 rounded-full bg-white/10 blur-3xl" />
        <div className="absolute bottom-0 -left-20 w-[500px] h-[500px] rounded-full bg-white/5 blur-2xl" />
        <div className="absolute top-1/3 right-16 w-48 h-48 rounded-full bg-white/8 blur-xl" />

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
