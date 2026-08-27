/**
 * Super Admin — Authentication status card.
 *
 * Drop-in replacement for AdminProviderCard when type === 'auth' (same
 * pattern as AdminRealtimeCard for type === 'realtime').
 *
 * Why this exists: the generic provider card treats every provider type as
 * a normal, freely-switchable runtime vendor — pick one from a dropdown,
 * fill in credentials, save, and it becomes the "global default." That is
 * correct for CDN/storage/SMS/etc, but wrong for auth: first-party
 * authentication (server/routes/auth.ts, gs_session HttpOnly cookie) is
 * the ONLY implemented identity system in this application. Supabase
 * Auth/Auth0/Clerk/Firebase are not wired to anything — login, signup,
 * session validation, and every authorization check
 * (server/lib/workspaceAuth.ts) exclusively use first-party sessions.
 * Presenting them as selectable "providers" implied a real, safe runtime
 * switch existed when saving one would do nothing except store dead
 * configuration, misleading a super admin into believing they had changed
 * how the application authenticates.
 *
 * This card is intentionally static and non-interactive: no vendor
 * picker, no config form, no save action. If a genuine multi-provider
 * identity migration is ever built, it needs its own dedicated,
 * production-safe flow — not a reuse of this generic card.
 */

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ShieldCheck, KeyRound, History } from 'lucide-react';

export function AdminAuthStatusCard() {
  return (
    <div className="space-y-4">
      <Card className="border-border/60">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-primary" />
            First-party Auth
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2">
            <Badge className="bg-emerald-500/10 text-emerald-500 border-emerald-500/20 text-[10px]">Active</Badge>
            <span className="text-xs text-muted-foreground">The only implemented authentication system</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
            <div className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/20 p-2.5">
              <KeyRound className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <div>
                <div className="text-muted-foreground">Session</div>
                <div className="text-foreground font-medium">Opaque HttpOnly Cookie</div>
              </div>
            </div>
            <div className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/20 p-2.5">
              <ShieldCheck className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <div>
                <div className="text-muted-foreground">Password hashing</div>
                <div className="text-foreground font-medium">Argon2id</div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="border-border/60 bg-muted/10">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground">
            <History className="h-4 w-4" />
            Legacy Supabase Auth
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Badge variant="outline" className="text-[10px]">Login provider removed</Badge>
          <p className="text-xs text-muted-foreground leading-relaxed">
            The legacy Supabase Auth provider is no longer selectable or registered: login,
            signup, password reset and session validation never touch GoTrue. Auth0, Clerk and
            Firebase Auth appear elsewhere in this admin area as historical configuration
            entries only.
          </p>
        </CardContent>
      </Card>

      <Card className="border-amber-500/30 bg-amber-500/5">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2 text-amber-600 dark:text-amber-400">
            <History className="h-4 w-4" />
            GoTrue cutover readiness
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Badge variant="outline" className="text-[10px] border-amber-500/40 text-amber-600 dark:text-amber-400">
            Legacy runtime dependency remains
          </Badge>
          <p className="text-xs text-muted-foreground leading-relaxed">
            GoTrue is not used for identity, and no <code>/auth/v1</code> request is made at
            runtime — but the browser Supabase client still has session persistence and token
            auto-refresh enabled, and a small set of admin/settings screens still read or write
            Supabase tables through RLS policies scoped to <code>auth.uid()</code>. Those screens
            run as the anonymous role today and must be moved behind the first-party backend
            before Supabase Auth can be switched off at the project level.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

