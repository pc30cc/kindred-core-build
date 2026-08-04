import { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/lib/toast';
import { Mail, Loader2, ArrowRight, ArrowLeft } from 'lucide-react';
import { usePlatformBrandingForLocale } from '@/hooks/usePublicBranding';
import { LanguageSelector } from '@/components/auth/LanguageSelector';
import { sendResetEmail } from '@/lib/auth-email-api';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const { t, locale, dir } = useTranslation();
  const brand = usePlatformBrandingForLocale(locale);
  const isRtl = dir === 'rtl';

  const brandLetter = useMemo(() => {
    const name = brand?.platform_name || 'App';
    return name.charAt(0);
  }, [brand]);

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
    <div className="min-h-screen flex items-center justify-center bg-background p-4" dir={dir}>
      <div className="w-full max-w-md space-y-8">
        <div className="text-center space-y-2">
          <div className="w-14 h-14 rounded-xl bg-primary mx-auto flex items-center justify-center">
            <span className="text-2xl font-black text-primary-foreground">{brandLetter}</span>
          </div>
          <h1 className="text-2xl font-bold text-foreground">{t('auth.forgotTitle')}</h1>
          <p className="text-sm text-muted-foreground">{t('auth.forgotSubtitle')}</p>
        </div>

        <div className="bg-card border border-border rounded-xl p-6 shadow-sm">
          {sent ? (
            <div className="text-center space-y-4 py-4">
              <Mail className="w-12 h-12 text-primary mx-auto" />
              <p className="text-sm text-foreground">{t('auth.forgotSent')} — <strong>{email}</strong></p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">{t('auth.email')}</Label>
                <Input id="email" type="email" placeholder="email@example.com" value={email} onChange={(e) => setEmail(e.target.value)} required dir="ltr" className="text-left" />
              </div>
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}
                <span className={isRtl ? 'mr-2' : 'ml-2'}>{t('auth.sendResetLink')}</span>
              </Button>
            </form>
          )}
        </div>

        <p className="text-center">
          <Link to="/auth/login" className="text-sm text-primary hover:underline inline-flex items-center gap-1">
            <BackIcon className="w-3 h-3" /> {t('auth.backToLogin')}
          </Link>
        </p>

        <LanguageSelector />
      </div>
    </div>
  );
}
