/**
 * WorkspaceRedirect: Redirects /app to /app/w/:slug using the user's first workspace.
 * If user has no workspaces, auto-provisions one.
 */
import { Navigate, useLocation } from 'react-router-dom';
import { useWorkspaces, useAccount, useCreateWorkspace } from '@/hooks/useWorkspace';
import { useAuth } from '@/features/auth/AuthContext';
import { useProfile } from '@/hooks/useProfile';
import { useTranslation } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Building2, LogOut, RefreshCw, HeadsetIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
// Same-origin in dev/preview (Vite proxy), configured origin in production.
// Using import.meta.env directly here bypassed that and produced blocked
// cross-origin calls in the preview.
import { API_BASE } from '@/lib/apiBase';


export function WorkspaceRedirect() {
  const { data: workspaces, isLoading, refetch } = useWorkspaces();
  const { data: account, isLoading: accountLoading } = useAccount();
  const { data: profile } = useProfile();
  const { signOut, user } = useAuth();
  const createWorkspace = useCreateWorkspace();
  const { t, dir } = useTranslation();
  const [provisioning, setProvisioning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attempted = useRef(false);
  const location = useLocation();

  // Preserve any legacy non-workspace path (e.g. a payment-gateway callback
  // landing on /app/billing?callback=true) so the redirect keeps the target
  // page and its query string instead of dumping the user on the overview.
  const legacySuffix = (() => {
    const p = location.pathname;
    if (!p.startsWith('/app')) return '';
    const rest = p.slice('/app'.length).replace(/\/+$/, '');
    if (!rest || rest.startsWith('/w/')) return '';
    return rest;
  })();


  // Auto-provision workspace if user has account but no workspaces
  useEffect(() => {
    if (isLoading || accountLoading || attempted.current || provisioning) return;
    if (workspaces && workspaces.length === 0 && user) {
      attempted.current = true;
      setProvisioning(true);

      (async () => {
        try {
          let accountId = account?.id;

          // If no account exists, provision one. Routed through the backend
          // (POST /api/workspaces/provision-account) rather than a direct
          // supabase.rpc call — see server/routes/workspaces.ts for why:
          // the RPC takes _user_id with no internal check that it matches
          // the caller, so it must only ever be invoked with a
          // session-derived id, never a client-supplied one.
          if (!accountId) {
            const res = await fetch(`${API_BASE}/api/workspaces/provision-account`, {
              method: 'POST',
              credentials: 'include',
            });
            if (!res.ok) {
              const body = await res.json().catch(() => ({ error: res.statusText }));
              throw new Error(body.error || `API error: ${res.status}`);
            }
            // Refetch to pick up the new workspace
            await refetch();
            setProvisioning(false);
            return;
          }

          // Account exists but no workspace — create one
          const name = profile?.company_name || user.metadata?.full_name || 'My Workspace';
          await createWorkspace.mutateAsync({
            accountId,
            name: typeof name === 'string' ? name : 'My Workspace',
          });
          await refetch();
        } catch (err: any) {
          console.error('Auto-provision failed:', err);
          const raw = String(err?.message || '');
          if (raw === 'email_verification_required') {
            setError(t('workspaceRedirect.emailVerificationRequired'));
          } else if (err instanceof TypeError || /failed to fetch|network/i.test(raw)) {
            setError(t('workspaceRedirect.connectionFailed'));
          } else {
            setError(raw || t('workspaceRedirect.createFailed'));
          }
        } finally {

          setProvisioning(false);
        }
      })();
    }
  }, [isLoading, accountLoading, workspaces, account, user]);

  if (isLoading || accountLoading || provisioning) {
    return (
      <div dir={dir} className="flex min-h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4">
          <div className="relative">
            <div className="h-12 w-12 rounded-xl bg-primary/10 flex items-center justify-center">
              <Building2 className="h-6 w-6 text-primary animate-pulse" />
            </div>
          </div>
          <p className="text-sm text-muted-foreground">
            {provisioning ? t('workspaceRedirect.provisioning') : t('workspaceRedirect.loading')}
          </p>
        </div>
      </div>
    );
  }

  if (workspaces?.length) {
    return <Navigate to={`/${workspaces[0].slug}${legacySuffix}${location.search}`} replace />;
  }

  return (
    <div dir={dir} className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-md text-center space-y-6">
        <div className="mx-auto w-20 h-20 rounded-2xl bg-muted flex items-center justify-center">
          <Building2 className="h-10 w-10 text-muted-foreground/60" />
        </div>

        <div className="space-y-2">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            {t('workspaceRedirect.title')}
          </h1>
          <p className="text-muted-foreground text-sm leading-relaxed max-w-sm mx-auto">
            {error
              ? t('workspaceRedirect.errorPrefix', { message: error })
              : t('workspaceRedirect.description')}
          </p>
        </div>

        <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
          <Button
            variant="default"
            onClick={() => { attempted.current = false; setError(null); refetch(); }}
            className="w-full sm:w-auto gap-2"
          >
            <RefreshCw className="h-4 w-4" />
            {t('workspaceRedirect.tryAgain')}
          </Button>
          <Button
            variant="outline"
            onClick={() => signOut()}
            className="w-full sm:w-auto gap-2"
          >
            <LogOut className="h-4 w-4" />
            {t('workspaceRedirect.signOut')}
          </Button>
        </div>

        <div className="pt-4 border-t border-border">
          <p className="text-xs text-muted-foreground flex items-center justify-center gap-1.5">
            <HeadsetIcon className="h-3.5 w-3.5" />
            {t('workspaceRedirect.help')}
          </p>
        </div>
      </div>
    </div>
  );
}

