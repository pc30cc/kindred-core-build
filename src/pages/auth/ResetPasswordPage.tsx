import { useState, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from '@/i18n';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/lib/toast';
import { Lock, Loader2, CheckCircle2, AlertTriangle } from 'lucide-react';
import { usePlatformBrandingForLocale } from '@/hooks/usePublicBranding';
import { LanguageSelector } from '@/components/auth/LanguageSelector';
import { resetPasswordWithToken } from '@/lib/auth-email-api';

export default function ResetPasswordPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { t, locale, dir } = useTranslation();
  const brand = usePlatformBrandingForLocale(locale);
  const isRtl = dir === 'rtl';

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const passwordsMatch = confirmPassword.length > 0 && password === confirmPassword;
  const token = searchParams.get('token');

  const brandLetter = useMemo(() => {
    const name = brand?.platform_name || 'App';
    return name.charAt(0);
  }, [brand]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirmPassword) {
      toast.error(t('auth.passwordsMismatch'));
      return;
    }
    if (password.length < 8) {
      toast.error(t('auth.passwordMinLength'));
      return;
    }
    setLoading(true);

    try {
      if (!token) {
        toast.error(t('auth.error'), { description: 'No reset token provided.' });
        setLoading(false);
        return;
      }
      await resetPasswordWithToken(token, password);
      toast.success(t('auth.passwordChanged'));
      setLoading(false);
      navigate('/auth/login', { replace: true });
      return;

    } catch (err: any) {
      // The backend answers "Invalid or expired token" for links that are
      // expired, already used, or superseded by a newer reset email. Show
      // that in the user's own language instead of the raw English string.
      const raw = String(err?.message || '');
      const expired = /invalid or expired token/i.test(raw);
      const description = expired
        ? locale === 'fa'
          ? 'این لینک منقضی یا قبلاً استفاده شده است. لطفاً دوباره درخواست بازیابی رمز بدهید.'
          : locale === 'tr'
          ? 'Bu bağlantının süresi dolmuş veya daha önce kullanılmış. Lütfen yeni bir sıfırlama bağlantısı isteyin.'
          : 'This link has expired or was already used. Please request a new reset link.'
        : raw;
      toast.error(t('auth.error'), { description });
    }


    setLoading(false);
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4" dir={dir}>
      <div className="w-full max-w-md space-y-8">
        <div className="text-center space-y-2">
          <div className="w-14 h-14 rounded-xl bg-primary mx-auto flex items-center justify-center">
            <span className="text-2xl font-black text-primary-foreground">{brandLetter}</span>
          </div>
          <h1 className="text-2xl font-bold text-foreground">{t('auth.resetTitle')}</h1>
          <p className="text-sm text-muted-foreground">{t('auth.resetSubtitle')}</p>
        </div>

        <div className="bg-card border border-border rounded-xl p-6 shadow-sm">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="password">{t('auth.newPassword')}</Label>
              <Input id="password" type="password" placeholder={t('auth.passwordPlaceholder')} value={password} onChange={(e) => setPassword(e.target.value)} required dir="ltr" className="text-left" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm">{t('auth.confirmPassword')}</Label>
              <div className="relative">
                <Input
                  id="confirm"
                  type="password"
                  placeholder={t('auth.confirmPasswordPlaceholder')}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  dir="ltr"
                  className={`text-left ${confirmPassword && !passwordsMatch ? 'border-destructive/50' : ''}`}
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
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Lock className="w-4 h-4" />}
              <span className={isRtl ? 'mr-2' : 'ml-2'}>{t('auth.saveNewPassword')}</span>
            </Button>
          </form>
        </div>

        <LanguageSelector />
      </div>
    </div>
  );
}
