import { Outlet, useLocation } from 'react-router-dom';
import { AppSidebar } from './AppSidebar';
import { AppTopBar } from './AppTopBar';
import { CommandPalette } from './CommandPalette';
import { useI18n } from '@/i18n';
import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { WorkspaceNotFound } from '@/features/workspace/WorkspaceNotFound';
import { useAuth } from '@/features/auth/AuthContext';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { Locale } from '@/i18n/config';
import { SUPPORTED_LOCALES, LOCALE_CONFIG } from '@/i18n/config';
import { AlertTriangle, CheckCircle2, Loader2, MailCheck, X } from 'lucide-react';
import { resendMyVerificationEmail, ResendVerificationError } from '@/lib/api';
import { toast } from '@/lib/toast';
import { useState, useEffect } from 'react';
import DegradedModeBanner from '@/components/realtime/DegradedModeBanner';
import { OperatorCallProvider } from '@/features/calls/OperatorCallContext';
import { FloatingOperatorCallWindow } from '@/features/calls/FloatingOperatorCallWindow';
import { useOperatorHeartbeat } from '@/hooks/useOperatorHeartbeat';

// Cooldown between two resend attempts. The authoritative cooldown lives on
// the server (`/api/account/resend-verification` answers 429 with
// `retry_after_seconds`); this is only the optimistic client mirror so the
// button disables immediately and survives a page reload.
const RESEND_COOLDOWN_MS = 5 * 60 * 1000;
const RESEND_LS_KEY = 'verification_resend_until';
const BANNER_DISMISS_KEY = 'verification_banner_hidden_until';
const DISMISS_MS = 60 * 60 * 1000;

function readTimestamp(key: string): number {
  const raw = localStorage.getItem(key);
  const value = raw ? Number(raw) : 0;
  return Number.isFinite(value) ? value : 0;
}

function remainingMs(key: string): number {
  return Math.max(0, readTimestamp(key) - Date.now());
}

/**
 * Bottom-anchored verification bar.
 *
 * Resending goes through the self-hosted backend endpoint, which mints a
 * fresh `auth_verify_tokens` row and delivers the mail through the workspace's
 * configured email provider — the exact same path used at signup.
 */
function EmailVerificationBar() {
  const { t, locale } = useI18n();
  const { user } = useAuth();
  const [sending, setSending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [cooldownMs, setCooldownMs] = useState(() => remainingMs(RESEND_LS_KEY));
  const [hiddenMs, setHiddenMs] = useState(() => remainingMs(BANNER_DISMISS_KEY));

  useEffect(() => {
    const id = setInterval(() => {
      setCooldownMs(remainingMs(RESEND_LS_KEY));
      setHiddenMs(remainingMs(BANNER_DISMISS_KEY));
    }, 1000);
    return () => clearInterval(id);
  }, []);

  const isCoolingDown = cooldownMs > 0;

  const startCooldown = (ms: number) => {
    const until = Date.now() + ms;
    localStorage.setItem(RESEND_LS_KEY, String(until));
    setCooldownMs(ms);
  };

  const handleResend = async () => {
    if (sending || isCoolingDown) return;
    setSending(true);
    try {
      const result = await resendMyVerificationEmail(locale);
      if (result.already_verified) {
        toast.success(t('auth.emailAlreadyVerified'));
        return;
      }
      startCooldown(RESEND_COOLDOWN_MS);
      setSentTo(result.email || user?.email || null);
      toast.success(t('auth.verificationResent'), {
        description: t('auth.resendCheckInbox').replace('{email}', result.email || user?.email || ''),
      });
    } catch (err) {
      if (err instanceof ResendVerificationError && err.code === 'too_many_requests') {
        startCooldown((err.retryAfterSeconds || 60) * 1000);
        toast.warning(
          t('auth.resendCooldownSeconds').replace('{seconds}', String(err.retryAfterSeconds || 60)),
        );
      } else {
        toast.error(t('auth.resendFailed'));
      }
    } finally {
      setSending(false);
    }
  };

  const dismiss = () => {
    const until = Date.now() + DISMISS_MS;
    localStorage.setItem(BANNER_DISMISS_KEY, String(until));
    setHiddenMs(DISMISS_MS);
  };

  if (hiddenMs > 0) return null;

  const cooldownSeconds = Math.ceil(cooldownMs / 1000);
  const buttonLabel = sending
    ? t('auth.resendSending')
    : isCoolingDown
      ? cooldownSeconds >= 60
        ? t('auth.resendCooldown').replace('{minutes}', String(Math.ceil(cooldownSeconds / 60)))
        : t('auth.resendCooldownSeconds').replace('{seconds}', String(cooldownSeconds))
      : t('auth.resendEmail');

  return (
    <div className="shrink-0 border-t border-amber-500/30 bg-amber-500/10 px-4 py-2.5 backdrop-blur-sm">
      <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-3 gap-y-2">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-amber-500/20 text-amber-600 dark:text-amber-400">
          {sentTo ? <MailCheck className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
        </span>
        <p className="min-w-0 flex-1 text-sm leading-snug text-foreground">
          {sentTo ? (
            <span className="inline-flex items-center gap-1.5">
              <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              {t('auth.resendCheckInbox').replace('{email}', sentTo)}
            </span>
          ) : (
            <>
              <span className="font-medium">{t('auth.emailNotVerified')}</span>
              {user?.email ? (
                <span className="ms-1.5 text-muted-foreground">({user.email})</span>
              ) : null}
            </>
          )}
        </p>
        <button
          onClick={handleResend}
          disabled={sending || isCoolingDown}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-amber-500 px-3 py-1.5 text-xs font-semibold text-amber-950 shadow-sm transition-colors hover:bg-amber-500/90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {buttonLabel}
        </button>
        <button
          onClick={dismiss}
          aria-label="dismiss"
          className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

export function AppLayout() {
  const { dir } = useI18n();
  const { user } = useAuth();
  const { workspace, notFound, isLoading } = useActiveWorkspace();
  const showVerificationBanner = user && !user.emailVerified;
  // Presence heartbeat → powers the "Operator activity" report.
  useOperatorHeartbeat(workspace?.id);
  // Inbox is a full-bleed workspace surface: no page gutters, no page scroll.
  const { pathname } = useLocation();
  const isFullBleed =
    /\/inbox(\/|$)/.test(pathname) ||
    /\/settings(\/|$)/.test(pathname) ||
    /\/ai-agent(\/|$)/.test(pathname);

  // Strict: if slug doesn't match any workspace, show 404
  if (!isLoading && notFound) {
    return <WorkspaceNotFound />;
  }

  return (
    <div dir={dir} className="app-scope flex h-screen overflow-hidden bg-background text-foreground">
      <OperatorCallProvider>
        <CommandPalette />
        <AppSidebar />
        <div className="flex flex-1 flex-col overflow-hidden">
          <AppTopBar />
          <DegradedModeBanner />
          <main
            className={
              isFullBleed
                ? 'flex-1 overflow-hidden p-0'
                : 'flex-1 overflow-y-auto px-4 pb-8 pt-4 sm:px-6 sm:pb-10 sm:pt-5 lg:px-8'
            }
          >
            <Outlet />
          </main>
          {/* Verification notice sits at the BOTTOM so it never pushes the
              page header down; resend is wired to the self-hosted mailer. */}
          {showVerificationBanner && <EmailVerificationBar />}
        </div>
        {/* Survives route changes — reads the same LiveKit room as the
            sidebar surface so navigation never disconnects the call. */}
        <FloatingOperatorCallWindow />
      </OperatorCallProvider>
    </div>
  );
}
