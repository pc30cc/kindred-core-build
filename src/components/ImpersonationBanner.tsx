import { useEffect, useState } from 'react';
import { Loader2, LogOut, UserCheck } from 'lucide-react';
import { useAuth } from '@/features/auth/AuthContext';
import { useTranslation } from '@/i18n';
import { stopImpersonation } from '@/lib/api';
import { toast } from '@/lib/toast';

const BANNER_HEIGHT = 44;

/**
 * Shown on every page while a Super Admin is signed in as another user
 * ("Login as User"): who they are acting as, and the way back to their own
 * Super Admin session. Fixed at the top; the page is pushed down by the
 * same height so nothing hides under it.
 */
export function ImpersonationBanner() {
  const { session } = useAuth();
  const { t, dir } = useTranslation();
  const [leaving, setLeaving] = useState(false);
  const impersonator = session?.impersonator ?? null;

  useEffect(() => {
    if (!impersonator) return;
    const body = document.body;
    const previous = body.style.paddingTop;
    body.style.paddingTop = `${BANNER_HEIGHT}px`;
    return () => {
      body.style.paddingTop = previous;
    };
  }, [impersonator]);

  if (!session || !impersonator) return null;

  const fullName = (session.user.metadata?.full_name as string | undefined) || '';
  const user = fullName ? `${fullName} (${session.user.email})` : session.user.email;

  const goBack = async () => {
    setLeaving(true);
    try {
      const { redirect } = await stopImpersonation();
      window.location.replace(redirect || '/admin/users');
    } catch {
      toast.error(t('impersonation.returnFailed'));
      setLeaving(false);
    }
  };

  return (
    <div
      dir={dir}
      role="status"
      className="fixed inset-x-0 top-0 z-[2147483000] flex items-center justify-between gap-3 bg-amber-500 px-4 text-amber-950 shadow-md"
      style={{ height: BANNER_HEIGHT }}
    >
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <UserCheck className="h-4 w-4 shrink-0" />
        <span className="truncate font-semibold">{t('impersonation.bannerTitle', { user })}</span>
        <span className="hidden truncate opacity-80 md:inline">
          {t('impersonation.bannerHint', { admin: impersonator.email })}
        </span>
      </div>
      <button
        type="button"
        onClick={goBack}
        disabled={leaving}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-amber-950 px-3 py-1.5 text-xs font-semibold text-amber-50 hover:bg-amber-900 disabled:opacity-70"
      >
        {leaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <LogOut className="h-3.5 w-3.5" />}
        {leaving ? t('impersonation.returning') : t('impersonation.backToAdmin')}
      </button>
    </div>
  );
}
