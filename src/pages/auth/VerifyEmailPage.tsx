import { useNavigate } from 'react-router-dom';
import { useTranslation } from '@/i18n';
import { Mail, Home } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LanguageSelector } from '@/components/auth/LanguageSelector';

export default function VerifyEmailPage() {
  const { t, dir } = useTranslation();
  const navigate = useNavigate();

  return (
    <div className="auth-aurora min-h-screen flex items-center justify-center p-4" dir={dir}>
      <div className="w-full max-w-md">
        <div className="glass beam-border rounded-3xl shadow-glow p-8 text-center space-y-6">
          <div className="mx-auto w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center">
            <Mail className="w-10 h-10 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-foreground mb-2">{t('auth.verifyEmail')}</h1>
            <p className="text-muted-foreground">{t('auth.checkEmail')}</p>
          </div>
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
        <div className="mt-6">
          <LanguageSelector />
        </div>
      </div>
    </div>
  );
}
