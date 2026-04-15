import { Outlet } from 'react-router-dom';
import { AppSidebar } from './AppSidebar';
import { useI18n } from '@/i18n';
import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { WorkspaceNotFound } from '@/features/workspace/WorkspaceNotFound';
import { useAuth } from '@/features/auth/AuthContext';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { Locale } from '@/i18n/config';
import { SUPPORTED_LOCALES, LOCALE_CONFIG } from '@/i18n/config';
import { AlertTriangle } from 'lucide-react';
import { resendVerificationEmail } from '@/lib/auth-email-api';
import { toast } from 'sonner';
import { useState, useEffect } from 'react';

const RESEND_COOLDOWN_MS = 60 * 60 * 1000;
const RESEND_LS_KEY = 'verification_resend_at';

function getResendCooldownRemaining(): number {
  const lastSent = localStorage.getItem(RESEND_LS_KEY);
  if (!lastSent) return 0;
  const elapsed = Date.now() - Number(lastSent);
  return Math.max(0, RESEND_COOLDOWN_MS - elapsed);
}

function formatMinutes(ms: number): number {
  return Math.ceil(ms / 60000);
}

function EmailVerificationBanner() {
  const { t, locale } = useI18n();
  const [sending, setSending] = useState(false);
  const { user } = useAuth();
  const [cooldownMs, setCooldownMs] = useState(() => getResendCooldownRemaining());

  useEffect(() => {
    const id = setInterval(() => setCooldownMs(getResendCooldownRemaining()), 30_000);
    return () => clearInterval(id);
  }, []);

  const isCoolingDown = cooldownMs > 0;

  const handleResend = async () => {
    if (!user?.email || sending || isCoolingDown) return;
    setSending(true);
    try {
      await resendVerificationEmail(user.email, locale);
      localStorage.setItem(RESEND_LS_KEY, String(Date.now()));
      setCooldownMs(RESEND_COOLDOWN_MS);
      toast.success(t('auth.verificationResent'));
    } catch {
      toast.error(t('auth.error'));
    } finally {
      setSending(false);
    }
  };

  const buttonLabel = sending
    ? '...'
    : isCoolingDown
      ? t('auth.resendCooldown').replace('{minutes}', String(formatMinutes(cooldownMs)))
      : t('auth.resendEmail');

  return (
    <div className="bg-destructive/10 border-b border-destructive/30 px-4 py-3 flex items-center justify-center gap-3 text-sm">
      <AlertTriangle className="w-5 h-5 text-destructive shrink-0" />
      <span className="text-foreground font-medium">{t('auth.emailNotVerified')}</span>
      <button
        onClick={handleResend}
        disabled={sending || isCoolingDown}
        className="bg-destructive text-destructive-foreground hover:bg-destructive/90 px-3 py-1 rounded-md text-xs font-medium disabled:opacity-50 transition-colors shrink-0"
      >
        {buttonLabel}
      </button>
    </div>
  );
}

export function AppLayout() {
  const { locale, dir, setLocale } = useI18n();
  const { user } = useAuth();
  const showVerificationBanner = user && !user.emailVerified;

  return (
    <div dir={dir} className="app-scope flex h-screen overflow-hidden bg-background text-foreground">
      <AppSidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        {showVerificationBanner && <EmailVerificationBanner />}
        <main className="flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
