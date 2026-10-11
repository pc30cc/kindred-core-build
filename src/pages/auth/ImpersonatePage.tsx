import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Loader2, XCircle } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { Button } from '@/components/ui/button';
import { redeemImpersonationToken } from '@/lib/impersonationApi';

/**
 * Landing page of the Super Admin's "Login as User" link
 * (`/impersonate?token=...`). The token is redeemed with a request to the
 * API, so the session cookie is set on the host the panel talks to, then
 * the whole page reloads into the user's panel (a full load, so every
 * cached piece of the admin's state is dropped).
 */
export default function ImpersonatePage() {
  const [searchParams] = useSearchParams();
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  // The token is single-use: StrictMode's second effect run must not spend it again.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const token = searchParams.get('token');
    if (!token) {
      setError(t('impersonation.failedHint'));
      return;
    }
    redeemImpersonationToken(token)
      .then(({ redirect }) => {
        window.location.replace(redirect || '/app');
      })
      .catch((err: unknown) => {
        setError(err instanceof Error && err.message ? err.message : t('impersonation.failedHint'));
      });
  }, [searchParams, t]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      {error ? (
        <div className="w-full max-w-md space-y-4 rounded-xl border bg-card p-6 text-center shadow-sm">
          <XCircle className="mx-auto h-10 w-10 text-destructive" />
          <h1 className="text-lg font-semibold">{t('impersonation.failedTitle')}</h1>
          <p className="text-sm text-muted-foreground">{error}</p>
          <p className="text-xs text-muted-foreground">{t('impersonation.failedHint')}</p>
          <Button onClick={() => window.location.replace('/admin/users')}>{t('impersonation.backToUsers')}</Button>
        </div>
      ) : (
        <div className="flex items-center gap-3 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span>{t('impersonation.signingIn')}</span>
        </div>
      )}
    </div>
  );
}
