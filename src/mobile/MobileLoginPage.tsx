/**
 * Native (iOS) login screen.
 *
 * Only rendered inside the Capacitor shell — the web login page is untouched.
 * Sign-up is intentionally absent: operators are invited from the dashboard.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Eye, EyeOff, Loader2, Lock, Mail } from 'lucide-react';
import { useI18n, useTranslation } from '@/i18n';
import type { Locale } from '@/i18n/config';
import { useAuth } from '@/features/auth/AuthContext';
import { usePlatformBrandingForLocale } from '@/hooks/usePublicBranding';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { normalizeEmail, stripInvisible } from './normalizeCredentials';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const LANGUAGES: { code: Locale; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'tr', label: 'Türkçe' },
  { code: 'fa', label: 'فارسی' },
];

export default function MobileLoginPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { locale, setLocale, dir } = useI18n();
  const { signIn, user, isLoading: authLoading } = useAuth();
  const brand = usePlatformBrandingForLocale(locale);

  const destination = params.get('redirect') || '/app';

  useEffect(() => {
    if (user && !authLoading) navigate(destination, { replace: true });
  }, [user, authLoading, navigate, destination]);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);

  const brandName = brand?.platform_name || 'Webyar';
  const canSubmit = useMemo(
    () => EMAIL_RE.test(normalizeEmail(email)) && password.length > 0 && !loading,
    [email, password, loading],
  );

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading) return;
    setLoading(true);
    try {
      const { error } = await signIn({
        email: normalizeEmail(email),
        password: stripInvisible(password),
      });
      if (error) {
        toast.error(t('auth.loginFailed'), { description: error.message });
        return;
      }
      navigate(destination, { replace: true });
    } catch (err: any) {
      toast.error(t('auth.loginFailed'), { description: err?.message });
    } finally {
      setLoading(false);
    }
  };

  const field =
    'flex-1 min-w-0 h-14 bg-transparent border-0 outline-none text-[17px] text-foreground placeholder:text-muted-foreground/60 px-1';

  return (
    <div dir={dir} className="min-h-[100dvh] bg-background flex flex-col">
      <div className="flex-1 overflow-y-auto px-6 pb-8 pt-[max(3rem,env(safe-area-inset-top))]">
        <div className="mx-auto w-full max-w-[420px]">
          <div className="flex flex-col items-center gap-4 pt-6 pb-10">
            <div className="h-16 w-16 rounded-[1.25rem] bg-primary flex items-center justify-center shadow-elegant">
              <span className="text-2xl font-black text-primary-foreground">
                {brandName.charAt(0)}
              </span>
            </div>
            <div className="text-center space-y-1">
              <h1 className="text-[28px] font-bold tracking-tight text-foreground">
                {t('auth.loginTitle')}
              </h1>
              <p className="text-[15px] text-muted-foreground">{t('auth.loginSubtitle')}</p>
            </div>
          </div>

          <form onSubmit={handleLogin} className="space-y-4">
            <div className="rounded-2xl border border-border bg-card overflow-hidden divide-y divide-border">
              <div className="flex items-center px-4" dir="ltr">
                <Mail className="h-[18px] w-[18px] text-muted-foreground shrink-0" />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@company.com"
                  className={cn(field, 'ml-3 text-left')}
                  autoComplete="username"
                  inputMode="email"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  enterKeyHint="next"
                  required
                />
              </div>
              <div className="flex items-center px-4" dir="ltr">
                <Lock className="h-[18px] w-[18px] text-muted-foreground shrink-0" />
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className={cn(field, 'ml-3 text-left')}
                  autoComplete="current-password"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  enterKeyHint="go"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="p-2 -mr-2 text-muted-foreground active:opacity-60"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOff className="h-[18px] w-[18px]" /> : <Eye className="h-[18px] w-[18px]" />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={!canSubmit}
              className={cn(
                'w-full h-14 rounded-2xl bg-primary text-primary-foreground text-[17px] font-semibold',
                'transition-all active:scale-[0.98] disabled:opacity-40 flex items-center justify-center gap-2',
              )}
            >
              {loading && <Loader2 className="h-5 w-5 animate-spin" />}
              {t('auth.login')}
            </button>

            <button
              type="button"
              onClick={() => navigate('/auth/forgot-password')}
              className="w-full text-center text-[15px] text-primary py-2 active:opacity-60"
            >
              {t('auth.forgotPassword')}
            </button>
          </form>
        </div>
      </div>

      <div className="px-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-2">
        <div className="mx-auto w-full max-w-[420px] flex items-center justify-center gap-2">
          {LANGUAGES.map((lang) => (
            <button
              key={lang.code}
              type="button"
              onClick={() => setLocale(lang.code)}
              className={cn(
                'px-4 py-2 rounded-full text-[15px] transition-colors',
                locale === lang.code
                  ? 'bg-primary/10 text-primary font-semibold'
                  : 'text-muted-foreground active:bg-muted',
              )}
            >
              {lang.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
