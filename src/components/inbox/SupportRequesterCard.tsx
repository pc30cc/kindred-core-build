/**
 * Who is asking — the card at the top of a platform-support conversation
 * (docs/PLATFORM_SUPPORT.md, "Who is asking"). The server writes it as an
 * internal system notice when the conversation starts
 * (server/services/platformSupport/requester.ts): the site user, and each
 * workspace they belong to with its plan, operators and this month's usage.
 * Only the support team sees it; the site user never does.
 */
import { Building2, UserRound } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { CLIENT_PLATFORM_NAMES, resolveClientPlatform } from './clientPlatform';
import type { Metered, RequesterCardMeta } from './requesterMeta';

type T = (key: string, params?: Record<string, string | number>) => string;

/** The key's text, or [fallback] when the key is not in the locale. */
function say(t: T, key: string, fallback: string, params?: Record<string, string | number>): string {
  const value = t(key, params);
  return value && value !== key ? value : fallback;
}

function formatBytes(bytes: number, locale: string): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: unit ? 1 : 0 }).format(value)} ${units[unit]}`;
}

export function SupportRequesterCard({ meta }: { meta: RequesterCardMeta }) {
  const { t: rawT, locale, dir } = useTranslation();
  const t = rawT as unknown as T;
  const number = (n: number) => new Intl.NumberFormat(locale).format(n);
  const date = (iso?: string | null) => {
    if (!iso) return null;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(d);
  };
  /** "12 / 200", "900 / ∞", or just "12" when the plan sets no limit. */
  const metered = (m?: Metered) => {
    const used = number(Number(m?.used ?? 0));
    const limit = m?.limit;
    if (limit === null || limit === undefined) return used;
    return `${used} / ${limit < 0 ? '∞' : number(limit)}`;
  };

  const user = meta.user ?? {};
  const workspaces = meta.workspaces ?? [];
  const total = Number(meta.workspace_count ?? workspaces.length);
  const platform = resolveClientPlatform(user);
  const since = date(user.member_since);
  const asOf = date(meta.captured_at);

  const facts = [
    since && say(t, 'inbox.requester.memberSince', `Member since ${since}`, { date: since }),
    platform && say(t, 'inbox.requester.via', `Wrote from ${CLIENT_PLATFORM_NAMES[platform]}`, {
      app: CLIENT_PLATFORM_NAMES[platform],
    }),
    user.source_workspace &&
      say(t, 'inbox.requester.fromWorkspace', `From ${user.source_workspace}`, { name: user.source_workspace }),
  ].filter(Boolean) as string[];

  return (
    <div className="my-3 flex justify-center" dir={dir} data-testid="support-requester-card">
      <div className="w-full max-w-xl overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm">
        <div className="flex items-center gap-2 border-b border-border/60 bg-muted/40 px-4 py-2 text-xs font-semibold text-muted-foreground">
          <UserRound className="h-3.5 w-3.5 shrink-0" />
          <span>{say(t, 'inbox.requester.title', 'Who is asking')}</span>
          <span className="ms-auto font-normal">{say(t, 'inbox.requester.teamOnly', 'Only your team sees this')}</span>
        </div>

        <div className="space-y-1 px-4 py-3">
          {user.name && <div className="text-sm font-semibold text-foreground">{user.name}</div>}
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-foreground/90" dir="ltr">
            {user.email && <a className="hover:underline" href={`mailto:${user.email}`}>{user.email}</a>}
            {user.phone && <a className="hover:underline" href={`tel:${user.phone}`}>{user.phone}</a>}
            {user.website && <span>{user.website}</span>}
          </div>
          {user.company && <div className="text-xs text-muted-foreground">{user.company}</div>}
          {facts.length > 0 && <div className="text-xs text-muted-foreground">{facts.join(' · ')}</div>}
        </div>

        {workspaces.length > 0 && (
          <div className="space-y-2 border-t border-border/60 px-4 py-3">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {say(t, 'inbox.requester.workspaceCount', `${total} workspaces`, { count: number(total) })}
            </div>
            {workspaces.map((ws, index) => {
              const plan = ws.plan;
              const planName = plan ? plan.names?.[locale] ?? plan.name ?? '' : say(t, 'inbox.requester.noPlan', 'No plan');
              const status = plan?.status
                ? say(t, `inbox.requester.planStatus.${plan.status}`, plan.status)
                : null;
              const when = plan?.status === 'trialing' && date(plan.trial_end)
                ? say(t, 'inbox.requester.trialEnds', `Trial ends ${date(plan.trial_end)}`, { date: date(plan.trial_end)! })
                : date(plan?.period_end)
                  ? plan?.cancel_at_period_end
                    ? say(t, 'inbox.requester.ends', `Ends ${date(plan?.period_end)}`, { date: date(plan?.period_end)! })
                    : say(t, 'inbox.requester.renews', `Renews ${date(plan?.period_end)}`, { date: date(plan?.period_end)! })
                  : null;
              const usage = ws.usage ?? {};
              const storageLimit = usage.storage_limit_gb;
              const metrics: Array<[string, string]> = [
                [say(t, 'inbox.requester.operators', 'Operators'), metered(ws.operators)],
                [say(t, 'inbox.requester.conversations', 'Conversations this month'), metered(usage.conversations)],
                [say(t, 'inbox.requester.visitors', 'Visitors this month'), metered(usage.visitors)],
                [say(t, 'inbox.requester.contacts', 'Contacts'), metered(ws.contacts)],
                [say(t, 'inbox.requester.aiCredits', 'AI credits this month'), metered(usage.ai_credits)],
                [say(t, 'inbox.requester.messages', 'Messages this month'), number(Number(usage.messages ?? 0))],
                [
                  say(t, 'inbox.requester.storage', 'Storage'),
                  `${formatBytes(Number(usage.storage_bytes ?? 0), locale)}${
                    storageLimit === null || storageLimit === undefined
                      ? ''
                      : ` / ${storageLimit < 0 ? '∞' : `${number(storageLimit)} GB`}`
                  }`,
                ],
              ];
              return (
                <div key={ws.id ?? index} className="rounded-xl border border-border/60 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Building2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="text-sm font-medium">{ws.name}</span>
                    {ws.role && (
                      <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                        {say(t, `inbox.requester.role.${ws.role}`, ws.role)}
                      </span>
                    )}
                    <span
                      className={cn(
                        'ms-auto rounded-full px-2 py-0.5 text-[11px] font-medium',
                        plan ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
                      )}
                    >
                      {[planName, status].filter(Boolean).join(' · ')}
                    </span>
                  </div>
                  {when && <div className="mt-1 text-[11px] text-muted-foreground">{when}</div>}
                  <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
                    {metrics.map(([label, value]) => (
                      <div key={label} className="min-w-0">
                        <dt className="truncate text-[11px] text-muted-foreground">{label}</dt>
                        <dd className="text-xs font-medium tabular-nums text-foreground" dir="ltr">{value}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              );
            })}
            {total > workspaces.length && (
              <div className="text-[11px] text-muted-foreground">
                {say(t, 'inbox.requester.more', `and ${total - workspaces.length} more`, {
                  count: number(total - workspaces.length),
                })}
              </div>
            )}
          </div>
        )}

        {asOf && (
          <div className="border-t border-border/60 px-4 py-1.5 text-[11px] text-muted-foreground">
            {say(t, 'inbox.requester.asOf', `As of ${asOf}`, { date: asOf })}
          </div>
        )}
      </div>
    </div>
  );
}
