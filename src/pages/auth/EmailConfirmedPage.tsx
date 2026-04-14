import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from '@/i18n';
import { useAuth } from '@/features/auth/AuthContext';
import { Button } from '@/components/ui/button';
import {
  CheckCircle2, Loader2, XCircle, ArrowRight, ArrowLeft,
  Shield, Sparkles, Home, AlertTriangle, RefreshCw,
} from 'lucide-react';
import { LanguageSelector } from '@/components/auth/LanguageSelector';

export default function EmailConfirmedPage() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const { t, dir } = useTranslation();
  const { session } = useAuth();
  const isRtl = dir === 'rtl';

  useEffect(() => {
    const checkConfirmation = async () => {
      // If we already have a session (from auth state listener), success
      if (session) {
        setStatus('success');
        return;
      }
      // Wait a bit for auth state to settle
      await new Promise(r => setTimeout(r, 2000));
      // Re-check — the auth listener should have updated by now
      setStatus(session ? 'success' : 'error');
    };
    checkConfirmation();
  }, [session]);

  // Re-check when session changes
  useEffect(() => {
    if (session && status === 'loading') {
      setStatus('success');
    }
  }, [session, status]);

  const NavArrow = isRtl ? ArrowLeft : ArrowRight;

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4" dir={dir}>
      <div className="w-full max-w-lg">
        <div className="bg-card border border-border rounded-2xl shadow-lg p-8 md:p-10 text-center">
          {/* Loading */}
          {status === 'loading' && (
            <div className="space-y-6">
              <div className="mx-auto w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center">
                <Loader2 className="w-10 h-10 text-primary animate-spin" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-foreground mb-2">{t('auth.emailConfirmLoading')}</h1>
                <p className="text-muted-foreground">{t('auth.emailConfirmLoadingDesc')}</p>
              </div>
            </div>
          )}

          {/* Success */}
          {status === 'success' && (
            <div className="space-y-7">
              <div className="mx-auto w-24 h-24 rounded-full bg-green-500/10 flex items-center justify-center">
                <CheckCircle2 className="w-14 h-14 text-green-500" />
              </div>

              <div>
                <h1 className="text-2xl md:text-3xl font-bold text-foreground mb-3">
                  {t('auth.emailConfirmSuccess')}
                </h1>
                <p className="text-muted-foreground text-base leading-relaxed">
                  {t('auth.emailConfirmSuccessDesc')}
                </p>
              </div>

              <div className="bg-muted/50 rounded-2xl p-5 space-y-3">
                <div className="flex items-center gap-3 text-sm text-foreground">
                  <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                    <Shield className="w-4 h-4 text-primary" />
                  </div>
                  <span>{t('auth.emailConfirmSecured')}</span>
                </div>
                <div className="flex items-center gap-3 text-sm text-foreground">
                  <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                    <Sparkles className="w-4 h-4 text-primary" />
                  </div>
                  <span>{t('auth.emailConfirmAccess')}</span>
                </div>
              </div>

              <div className="space-y-3">
                <Button
                  onClick={() => navigate('/app')}
                  size="lg"
                  className="w-full h-12 text-base font-semibold rounded-xl gap-2"
                >
                  {t('auth.emailConfirmCta')}
                  <NavArrow className="w-5 h-5" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => navigate('/auth/login')}
                  className="text-muted-foreground gap-1.5"
                >
                  <Home className="w-4 h-4" />
                  {t('auth.backToLogin')}
                </Button>
              </div>
            </div>
          )}

          {/* Error */}
          {status === 'error' && (
            <div className="space-y-7">
              <div className="mx-auto w-24 h-24 rounded-full bg-destructive/10 flex items-center justify-center">
                <XCircle className="w-14 h-14 text-destructive" />
              </div>

              <div>
                <h1 className="text-2xl md:text-3xl font-bold text-foreground mb-3">
                  {t('auth.emailConfirmError')}
                </h1>
                <p className="text-muted-foreground text-base leading-relaxed">
                  {t('auth.emailConfirmErrorDesc')}
                </p>
              </div>

              <div className="bg-muted/40 rounded-2xl p-5 space-y-3 text-start">
                <div className="flex items-start gap-3 text-sm text-foreground">
                  <div className="w-8 h-8 rounded-lg bg-destructive/10 flex items-center justify-center shrink-0 mt-0.5">
                    <AlertTriangle className="w-4 h-4 text-destructive" />
                  </div>
                  <span className="leading-relaxed">{t('auth.emailConfirmErrorExpired')}</span>
                </div>
                <div className="flex items-start gap-3 text-sm text-foreground">
                  <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                    <RefreshCw className="w-4 h-4 text-primary" />
                  </div>
                  <span className="leading-relaxed">{t('auth.emailConfirmErrorRetry')}</span>
                </div>
              </div>

              <div className="space-y-3">
                <Button
                  onClick={() => navigate('/auth/login')}
                  size="lg"
                  className="w-full h-12 text-base font-semibold rounded-xl gap-2"
                >
                  {t('auth.login')}
                  <NavArrow className="w-5 h-5" />
                </Button>
                <Button
                  variant="outline"
                  onClick={() => navigate('/auth/signup')}
                  className="w-full h-11 rounded-xl"
                >
                  {t('auth.signup')}
                </Button>
              </div>
            </div>
          )}
        </div>

        <div className="mt-6">
          <LanguageSelector />
        </div>
      </div>
    </div>
  );
}
