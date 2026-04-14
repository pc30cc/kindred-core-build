import { useState, useEffect, useMemo } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from '@/i18n';
import { useAuth } from '@/features/auth/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { Eye, EyeOff, LogIn, Loader2 } from 'lucide-react';
import { usePlatformBrandingForLocale } from '@/hooks/usePublicBranding';
import { LanguageSelector } from '@/components/auth/LanguageSelector';

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

  const brandLetter = useMemo(() => {
    const name = brand?.platform_name || 'App';
    return name.charAt(0);
  }, [brand]);

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
    <div className="min-h-screen flex items-center justify-center bg-background p-4" dir={dir}>
      <div className="w-full max-w-md space-y-8">
        {/* Header */}
        <div className="text-center space-y-2">
          <div className="w-14 h-14 rounded-xl bg-primary mx-auto flex items-center justify-center">
            <span className="text-2xl font-black text-primary-foreground">{brandLetter}</span>
          </div>
          <h1 className="text-2xl font-bold text-foreground">{t('auth.loginTitle')}</h1>
          <p className="text-sm text-muted-foreground">{t('auth.loginSubtitle')}</p>
        </div>

        {/* Form Card */}
        <div className="bg-card border border-border rounded-xl p-6 space-y-5 shadow-sm">
          <form onSubmit={handleLogin} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">{t('auth.email')}</Label>
              <Input
                id="email"
                type="email"
                placeholder="email@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                dir="ltr"
                className="text-left"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">{t('auth.password')}</Label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  dir="ltr"
                  className={`text-left ${isRtl ? 'pr-10' : 'pl-10'}`}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className={`absolute ${isRtl ? 'right-3' : 'left-3'} top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground`}
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <LogIn className="w-4 h-4" />}
              <span className={isRtl ? 'mr-2' : 'ml-2'}>{t('auth.login')}</span>
            </Button>
          </form>
        </div>

        {/* Footer links */}
        <div className="text-center space-y-3">
          <p className="text-base text-muted-foreground">
            {t('auth.noAccount')}{' '}
            <Link to="/auth/signup" className="text-primary hover:underline font-medium">
              {t('auth.signup')}
            </Link>
          </p>
          <Link to="/auth/forgot-password" className="text-base text-primary hover:underline font-medium">
            {t('auth.forgotPassword')}
          </Link>
        </div>

        <LanguageSelector />
      </div>
    </div>
  );
}
