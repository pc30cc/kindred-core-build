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
        <CardContent>
          <Badge variant="outline" className="text-[10px] mb-2">Removed</Badge>
          <p className="text-xs text-muted-foreground leading-relaxed">
            The legacy Supabase Auth provider has been removed from the application's runtime
            source entirely — it is no longer selectable, registered, or reachable by any code
            path. Auth0, Clerk, and Firebase Auth are shown elsewhere in this admin area as
            historical configuration entries only — none of them are wired to login, signup, or
            session validation.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
