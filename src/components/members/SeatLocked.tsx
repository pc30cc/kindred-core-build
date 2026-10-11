/**
 * Seats the plan has paused (simple billing phase 4, design §5).
 *
 * When a workspace has more members than its plan's `max_agents`, the most
 * recently joined members past the limit are paused: they keep their
 * membership row, but the server answers `seat_locked` to everything they
 * try in that workspace, they are not routed chats and they get no
 * notifications. The owner and suspended members are never paused, and
 * nothing is paused while the edition's billing locks are off. Nothing is
 * decided here: the server sends `seat_locked` per member (GET
 * /api/workspace-members) and for the caller (GET /api/workspace-members/me).
 *
 *   - SeatLockedBadge: "Paused (plan)" beside a member, for the team pages.
 *   - SeatLockedSummary: "N members are paused…" above the member list.
 *   - SeatLockedNotice: what a paused member sees instead of the workspace
 *     (renders nothing for anyone else).
 *   - SeatLockGate: the app layout's wrapper around the page — the notice
 *     for a paused member, the page for everyone else (also while loading).
 */
import type { ReactNode } from 'react';
import { Lock, PauseCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n';
import { useOwnSeat } from '@/hooks/useOwnSeat';

export function SeatLockedBadge() {
  const { t } = useTranslation();
  return (
    <Badge
      variant="outline"
      title={t('members.seatLocked.tooltip')}
      data-testid="seat-locked-badge"
      className="text-[9px] px-1.5 py-0 gap-1 border-amber-500/40 text-amber-600 dark:text-amber-400"
    >
      <Lock className="w-2.5 h-2.5" aria-hidden />
      {t('members.seatLocked.badge')}
    </Badge>
  );
}

/** The line above a member list while any listed member is paused. */
export function SeatLockedSummary({ count }: { count: number }) {
  const { t, locale } = useTranslation();
  if (count <= 0) return null;
  return (
    <div
      role="status"
      data-testid="seat-locked-summary"
      className="flex items-start gap-2 border-b border-border/60 bg-amber-500/5 px-4 py-2.5 text-xs text-amber-700 dark:text-amber-300"
    >
      <PauseCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden />
      <span>
        {t('members.seatLocked.summary', { count: new Intl.NumberFormat(locale).format(count) })}{' '}
        <span className="text-muted-foreground">{t('members.seatLocked.tooltip')}</span>
      </span>
    </div>
  );
}

/**
 * The page a paused member sees in place of the workspace. Renders nothing
 * unless the server says this caller's seat is paused.
 */
export function SeatLockedNotice({ workspaceId }: { workspaceId: string | null | undefined }) {
  const { t } = useTranslation();
  const { data } = useOwnSeat(workspaceId);
  if (!data?.seat_locked) return null;
  return (
    <div className="flex min-h-[60vh] items-center justify-center p-4" data-testid="seat-locked-notice">
      <Card className="w-full max-w-md border-border/60 p-6 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-amber-500/10">
          <PauseCircle className="h-6 w-6 text-amber-500" aria-hidden />
        </div>
        <h1 className="text-lg font-semibold text-foreground">{t('members.seatLocked.title')}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{t('members.seatLocked.desc')}</p>
        <Button asChild variant="outline" className="mt-5">
          <a href="/app">{t('members.seatLocked.switchWorkspace')}</a>
        </Button>
      </Card>
    </div>
  );
}

/**
 * The page, or the paused-seat notice in its place when the server says this
 * caller's seat is paused. The page renders while the answer is loading or
 * unreadable: the server refuses a paused member's calls on its own.
 */
export function SeatLockGate({ workspaceId, children }: { workspaceId: string | null | undefined; children: ReactNode }) {
  const { data } = useOwnSeat(workspaceId);
  if (data?.seat_locked) return <SeatLockedNotice workspaceId={workspaceId} />;
  return <>{children}</>;
}
