import { BrandWordmark } from '@/components/brand/BrandLoader';
import { toLatinKeyboard } from '@/lib/latinKeyboard';
import { useState } from 'react';
import { BrandLogo } from '@/components/brand/BrandLogo';
import { AuthHeroPanel } from '@/components/auth/AuthHeroPanel';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { toast } from '@/lib/toast';
import { Mail, Loader2, ArrowRight, ArrowLeft } from 'lucide-react';
import { usePlatformBrandingForLocale } from '@/hooks/usePublicBranding';
import { LanguageSelector } from '@/components/auth/LanguageSelector';
import { sendResetEmail } from '@/lib/auth-email-api';

export default function ForgotPasswordPage() {
  const [params] = useSearchParams();
  const [email, setEmail] = useState(() => toLatinKeyboard(params.get('email') || '').trim().toLowerCase());
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const { t, locale, dir } = useTranslation();
  const brand = usePlatformBrandingForLocale(locale);
  const brandName = brand?.platform_name || '';
  const isRtl = dir === 'rtl';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await sendResetEmail(email.trim().toLowerCase(), locale);
      setSent(true);
      toast.success(t('auth.forgotSent'));
    } catch (err: any) {
      toast.error(t('auth.error'), { description: err?.message });
    }
    setLoading(false);
  };

  const BackIcon = isRtl ? ArrowLeft : ArrowRight;

  return (
    <div className="fixed inset-0 flex" dir={dir}>
      <div className={`auth-aurora flex-1 flex flex-col overflow-y-auto ${isRtl ? 'order-2' : 'order-1'}`}>
        <div className="flex items-center justify-between px-8 py-5 shrink-0">
          {brandName ? (
            <div className="flex items-center gap-3">
              <BrandLogo className="w-9 h-9 rounded-lg" />
              <span className="text-lg font-semibold text-foreground">{brandName}</span>
            </div>
          ) : (
            <div className="w-9 h-9" />
          )}
          <LanguageSelector />
        </div>

        <div className="flex-1 flex items-center justify-center px-6 pb-12">
          <div className="glass beam-border w-full max-w-[440px] space-y-8 rounded-3xl p-7 shadow-glow sm:p-9">
            <div className="space-y-2">
              <h1 className="text-3xl font-bold tracking-tight text-foreground">{t('auth.forgotTitle')}</h1>
              <p className="text-muted-foreground">{t('auth.forgotSubtitle')}</p>
            </div>

            {sent ? (
              <div className="text-center space-y-4 py-4">
                <Mail className="w-12 h-12 text-primary mx-auto" />
                <p className="text-sm text-foreground">{t('auth.forgotSent')} — <strong dir="ltr">{email}</strong></p>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-5">
                <div className="space-y-2">
                  <Label htmlFor="email" className="text-xs font-medium text-muted-foreground tracking-wide uppercase">{t('auth.email')}</Label>
                  <div className="flex items-center gap-2 h-12 rounded-xl border border-input bg-background/60 px-3 focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20 transition" dir="ltr">
                    <Mail className="w-4 h-4 text-muted-foreground" />
                    <input
                      id="email"
                      type="text"
                      inputMode="email"
                      autoComplete="email"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      placeholder="you@company.com"
                      value={email}
                      onChange={(e) => setEmail(toLatinKeyboard(e.target.value))}
                      required
                      dir="ltr"
                      className="flex-1 min-w-0 h-full bg-transparent border-0 outline-none text-sm text-foreground placeholder:text-muted-foreground/70 px-1 text-left"
                    />
                  </div>
                </div>
                <Button type="submit" className="btn-shimmer w-full h-12 text-base font-semibold gap-2 rounded-xl" disabled={loading}>
                  {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}
                  {t('auth.sendResetLink')}
                </Button>
              </form>
            )}

            <div className="pt-2 text-center">
              <Link to="/auth/login" className="text-sm text-primary hover:underline font-medium inline-flex items-center gap-1">
                <BackIcon className="w-3 h-3" /> {t('auth.backToLogin')}
              </Link>
            </div>
          </div>
          <BrandWordmark className="mt-6" />
        </div>
      </div>

      <AuthHeroPanel
        title={t('auth.loginPromoTitle')}
        subtitle={t('auth.loginPromoSubtitle')}
        className={`w-[44%] xl:w-[46%] ${isRtl ? 'order-1' : 'order-2'}`}
      />
    </div>
  );
}
