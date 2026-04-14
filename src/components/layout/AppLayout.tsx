import { Outlet } from 'react-router-dom';
import { AppSidebar } from './AppSidebar';
import { useI18n } from '@/i18n';
import { useAuth } from '@/features/auth/AuthContext';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { Locale } from '@/i18n/config';
import { SUPPORTED_LOCALES, LOCALE_CONFIG } from '@/i18n/config';
import { AlertTriangle } from 'lucide-react';
import { resendVerificationEmail } from '@/lib/auth-email-api';
import { toast } from 'sonner';
import { useState } from 'react';

function EmailVerificationBanner() {
  const { t } = useI18n();
  const [sending, setSending] = useState(false);
  const { user } = useAuth();

  const handleResend = async () => {
    if (!user?.email || sending) return;
    setSending(true);
    try {
      await resendVerificationEmail(user.email);
      toast.success(t('auth.verificationResent'));
    } catch {
      toast.error(t('auth.error'));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="bg-destructive/10 border-b border-destructive/30 px-4 py-3 flex items-center justify-center gap-3 text-sm">
      <AlertTriangle className="w-5 h-5 text-destructive shrink-0" />
      <span className="text-foreground font-medium">{t('auth.emailNotVerified')}</span>
      <button
        onClick={handleResend}
        disabled={sending}
        className="bg-destructive text-destructive-foreground hover:bg-destructive/90 px-3 py-1 rounded-md text-xs font-medium disabled:opacity-50 transition-colors shrink-0"
      >
        {sending ? '...' : t('auth.resendEmail')}
      </button>
    </div>
  );
}

export function AppLayout() {
  const { locale, dir, setLocale } = useI18n();
  const { user } = useAuth();
  const showVerificationBanner = user && !user.emailVerified;

  return (
    <div dir={dir} className="panel-scope flex h-screen overflow-hidden bg-background text-foreground">
      <AppSidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        {showVerificationBanner && <EmailVerificationBanner />}
        <header className="flex h-14 items-center justify-end gap-4 border-b border-border px-6">
          <Select value={locale} onValueChange={(v) => setLocale(v as Locale)}>
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SUPPORTED_LOCALES.map(l => (
                <SelectItem key={l} value={l}>{LOCALE_CONFIG[l].nativeLabel}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </header>
        <main className="flex-1 overflow-y-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
