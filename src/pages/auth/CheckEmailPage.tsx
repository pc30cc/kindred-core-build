import { useSearchParams, useNavigate } from 'react-router-dom';
import { useTranslation } from '@/i18n';
import { Mail, FolderSearch, Clock, MousePointerClick, Home } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LanguageSelector } from '@/components/auth/LanguageSelector';

export default function CheckEmailPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const email = searchParams.get('email') || '';
  const { t, dir } = useTranslation();

  const tips = [
    { icon: FolderSearch, key: 'auth.checkEmailTipSpam' as const },
    { icon: Clock, key: 'auth.checkEmailTipWait' as const },
    { icon: MousePointerClick, key: 'auth.checkEmailTipLatest' as const },
  ];

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4" dir={dir}>
      <div className="w-full max-w-lg">
        <div className="bg-card border border-border rounded-2xl shadow-lg p-8 md:p-10 text-center space-y-7">
          {/* Icon */}
          <div className="mx-auto w-24 h-24 rounded-full bg-primary/10 flex items-center justify-center">
            <Mail className="w-12 h-12 text-primary" />
          </div>

          {/* Headline */}
          <div className="space-y-2">
            <h1 className="text-2xl md:text-3xl font-bold text-foreground">
              {t('auth.checkEmailTitle')}
            </h1>
            <p className="text-muted-foreground text-base leading-relaxed">
              {t('auth.checkEmailDesc')}
            </p>
          </div>

          {/* Email badge */}
          {email && (
            <div className="inline-flex items-center gap-2.5 bg-primary/[0.08] border border-primary/20 rounded-2xl px-5 py-3">
              <Mail className="w-4 h-4 text-primary shrink-0" />
              <span className="text-sm font-medium text-foreground select-all" dir="ltr">
                {email}
              </span>
            </div>
          )}

          {/* Tips */}
          <div className="bg-muted/40 rounded-2xl p-5 space-y-3 text-start">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
              {t('auth.checkEmailTipsHeading')}
            </p>
            {tips.map((tip, i) => (
              <div key={i} className="flex items-start gap-3 text-sm text-foreground">
                <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                  <tip.icon className="w-4 h-4 text-primary" />
                </div>
                <span className="leading-relaxed">{t(tip.key)}</span>
              </div>
            ))}
          </div>

          {/* Actions */}
          <div className="space-y-3 pt-1">
            <button
              onClick={() => navigate('/auth/signup')}
              className="text-sm text-primary hover:underline font-medium"
            >
              {t('auth.checkEmailWrongEmail')}
            </button>
            <div className="flex gap-3 justify-center">
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
        </div>

        <div className="mt-6">
          <LanguageSelector />
        </div>
      </div>
    </div>
  );
}
