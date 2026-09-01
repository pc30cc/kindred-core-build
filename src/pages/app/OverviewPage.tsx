import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '@/i18n';
import { useCurrentWorkspace, useWorkspacePath } from '@/hooks/useWorkspace';
import { useBrandingContext } from '@/features/branding/BrandingContext';
import { useAuth } from '@/features/auth/AuthContext';
import { useConversations } from '@/hooks/useConversations';
import { useOnlineVisitors, useVisitorSessions } from '@/hooks/useVisitors';
import { useKBArticles } from '@/hooks/useKnowledgeBase';
import { useContacts } from '@/hooks/useContacts';
import { useTeamPresence } from '@/hooks/useTeamPresence';
import { useWorkspaceMembers } from '@/hooks/useWorkspaceMembers';
import { useWorkspacePlan, useWorkspaceUsage } from '@/hooks/usePlans';
import { formatLongDate } from '@/lib/date';
import GetStartedWizard from '@/components/app/GetStartedWizard';
import { ContactAvatar } from '@/components/inbox/ContactAvatar';
import { contactDisplayName } from '@/lib/contact-display';
import { IdentityListSkeleton } from '@/components/common/IdentitySkeleton';
import {
  Area, AreaChart, ResponsiveContainer, Tooltip as ReTooltip, XAxis, YAxis, CartesianGrid,
} from 'recharts';
import {
  MessageSquare, Users, BookOpen, Eye, Inbox, Bot, ArrowUpRight, ArrowRight,
  Phone, Sparkles, CheckCircle2, Clock, ShieldCheck, CreditCard, Radio, HardDrive,
} from 'lucide-react';
import { AI_ACCENT, type AiAccent } from '@/components/ai-agent/AiPageHeader';
import { cn } from '@/lib/utils';

/** English placeholder subjects persisted by the widget/AI — localized in the UI. */
const PLACEHOLDER_SUBJECTS = new Set([
  'new conversation', 'new chat', 'untitled conversation', 'untitled', '[attachment]',
]);

/** Human-readable byte size using the active number locale. */
function formatBytes(bytes: number, numberLocale: string): string {
  const nf = (n: number, d = 0) =>
    new Intl.NumberFormat(numberLocale, { maximumFractionDigits: d }).format(n);
  if (!Number.isFinite(bytes) || bytes <= 0) return `${nf(0)} MB`;
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${nf(gb, 2)} GB`;
  const mb = bytes / 1024 ** 2;
  if (mb >= 1) return `${nf(mb, 1)} MB`;
  return `${nf(bytes / 1024, 1)} KB`;
}

export default function OverviewPage() {
  const { t, locale, dir } = useTranslation();
  const workspace = useCurrentWorkspace();
  const { platformName } = useBrandingContext();
  const { user } = useAuth();
  const wsPath = useWorkspacePath();

  const { data: conversations, isPending: conversationsPending } = useConversations(workspace?.id);
  const { data: visitors } = useOnlineVisitors(workspace?.id);
  const { data: sessions } = useVisitorSessions(workspace?.id);
  const { data: articles } = useKBArticles(workspace?.id);
  const { data: contacts } = useContacts(workspace?.id);
  const { data: teamData, isPending: teamPending } = useTeamPresence(workspace?.id);
  const { data: members, isPending: membersPending } = useWorkspaceMembers(workspace?.id);
  // Presence only carries availability; identity comes from the member directory.
  const memberById = useMemo(() => {
    const m = new Map<string, { full_name: string | null; email: string | null; avatar_url: string | null }>();
    for (const x of members ?? []) m.set(x.user_id, x);
    return m;
  }, [members]);
  const team = useMemo(
    () =>
      (teamData?.presence ?? []).map((p: any) => {
        const prof = memberById.get(p.user_id);
        return {
          ...p,
          full_name: p.full_name ?? prof?.full_name ?? null,
          email: p.email ?? prof?.email ?? null,
          avatar_url: p.avatar_url ?? prof?.avatar_url ?? null,
        };
      }),
    [teamData, memberById],
  );
  const { data: planData } = useWorkspacePlan(workspace?.id);
  const { data: usageRow } = useWorkspaceUsage(workspace?.id);

  const tr = t as unknown as (k: string) => string;
  const isRtl = dir === 'rtl';
  const numberLocale = locale === 'fa' ? 'fa-IR' : locale === 'tr' ? 'tr-TR' : 'en-US';
  const fmt = (v: number) => v.toLocaleString(numberLocale);

  const list = conversations ?? [];
  const openConvos = list.filter((c: any) => c.status === 'open').length;
  const resolved = list.filter((c: any) => c.status === 'resolved' || c.status === 'closed').length;
  // Truly online right now: presence status online AND seen in the last 5 minutes
  const onlineVisitors = (visitors ?? []).filter((v: any) => {
    if (v.status !== 'online') return false;
    const ts = v.updated_at || v.last_seen_at;
    if (!ts) return true;
    return Date.now() - new Date(ts).getTime() < 5 * 60 * 1000;
  }).length;
  // Distinct visitors seen today (total visits today)
  const visitsToday = useMemo(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const ids = new Set<string>();
    for (const s of (sessions ?? []) as any[]) {
      const ts = s.started_at || s.created_at || s.first_seen_at || s.last_seen_at;
      if (ts && new Date(ts).getTime() >= start.getTime()) ids.add(s.id ?? s.visitor_id ?? String(ts));
    }
    return ids.size;
  }, [sessions]);
  const teamOnline = team.filter((m: any) => m.state === 'online' || m.status === 'online').length;

  const userName =
    (user?.metadata?.full_name as string) || user?.email?.split('@')[0] || '';

  const greeting = useMemo(() => {
    const h = new Date().getHours();
    if (h < 12) return tr('dashboard.greetingMorning');
    if (h < 18) return tr('dashboard.greetingAfternoon');
    return tr('dashboard.greetingEvening');
  }, [locale]);

  // 14-day conversation trend (falls back to the window around the latest data)
  const chartData = useMemo(() => {
    const localKey = (d: Date) => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    };
    const dateOf = (c: any) => {
      const ts = c.created_at || c.last_message_at || c.updated_at;
      if (!ts) return null;
      const d = new Date(ts);
      return Number.isNaN(d.getTime()) ? null : d;
    };

    const dates = (list as any[]).map(dateOf).filter(Boolean) as Date[];
    const now = new Date();
    const latest = dates.length ? new Date(Math.max(...dates.map((d) => d.getTime()))) : now;
    // if nothing happened in the last 14 days, shift the window to the latest activity
    const cutoff = new Date(now);
    cutoff.setHours(0, 0, 0, 0);
    cutoff.setDate(cutoff.getDate() - 13);
    const anchor = latest.getTime() >= cutoff.getTime() ? now : latest;

    const days: { key: string; label: string; value: number }[] = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(anchor);
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - i);
      days.push({
        key: localKey(d),
        label: d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
        value: 0,
      });
    }
    const idx = new Map(days.map((d, i) => [d.key, i]));
    for (const d of dates) {
      const k = localKey(d);
      if (idx.has(k)) days[idx.get(k)!].value += 1;
    }
    return days;
  }, [list]);

  const planLocalized = (planData?.plan?.localized || {}) as Record<string, { name?: string }>;
  const planName =
    planLocalized[locale]?.name?.trim() ||
    planLocalized['en']?.name?.trim() ||
    planData?.plan?.name ||
    '—';
  const entitlements = (planData?.entitlements || {}) as Record<string, any>;
  const limits = (planData?.limits || {}) as Record<string, number>;
  const usageNum = (k: string) => {
    const v = (usageRow as any)?.[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  };
  const storageBytes = usageNum('storage_bytes');
  const storageLimitGb = Number(limits.storage_gb ?? 0);
  const storagePct = storageLimitGb > 0
    ? Math.min(100, Math.round((storageBytes / (storageLimitGb * 1024 ** 3)) * 100))
    : 0;

  const seatLimit = Number(limits.max_operators ?? limits.max_seats ?? 0);
  const seatUsed = team.length;
  const contactLimit = Number(limits.max_contacts ?? 0);
  const contactUsed = (contacts ?? []).length;

  const stats: { label: string; value: number; icon: React.ElementType; accent: AiAccent; path: string }[] = [
    { label: tr('dashboard.statOpenConversations'), value: openConvos, icon: Inbox, accent: 'indigo', path: '/inbox' },
    { label: tr('dashboard.statOnlineVisitors'), value: onlineVisitors, icon: Radio, accent: 'emerald', path: '/visitors' },
    { label: tr('dashboard.statVisitsToday'), value: visitsToday, icon: Eye, accent: 'sky', path: '/visitors' },
    { label: tr('dashboard.statContacts'), value: contactUsed, icon: Users, accent: 'amber', path: '/contacts' },
    { label: tr('dashboard.statTeamOnline'), value: teamOnline, icon: ShieldCheck, accent: 'rose', path: '/settings/team' },
  ];

  const recent = list.slice(0, 6);

  return (
    <div dir={dir} className="space-y-6 animate-fade-in">
      {/* ── Hero ─────────────────────────────────────────── */}
      <section className="relative overflow-hidden rounded-3xl border border-border/60 bg-gradient-to-br from-indigo-500/[0.14] via-violet-500/[0.08] to-cyan-500/[0.06] p-6 shadow-sm sm:p-7">
        <div className="pointer-events-none absolute -top-24 end-[-4rem] h-64 w-64 rounded-full bg-violet-500/25 blur-3xl" />
        <div className="pointer-events-none absolute bottom-[-7rem] start-1/4 h-56 w-56 rounded-full bg-cyan-500/20 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-16 end-1/3 h-40 w-40 rounded-full bg-amber-500/15 blur-3xl" />
        <div className="relative flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div
              dir={dir}
              className="mb-3 inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-card/70 px-2.5 py-1 text-[11px] font-medium text-muted-foreground shadow-sm backdrop-blur"
            >
              <Sparkles className="h-3 w-3 text-violet-500" />
              <bdi>{formatLongDate(new Date())}</bdi>
            </div>
            <h1 className="text-2xl font-bold tracking-tight sm:text-[32px]">
              <span className="bg-gradient-to-br from-indigo-600 via-violet-600 to-cyan-500 bg-clip-text text-transparent dark:from-indigo-300 dark:via-violet-300 dark:to-cyan-200">
                {greeting}{userName ? `، ${userName}` : ''}
              </span>
            </h1>
            <p className="mt-1.5 text-sm text-muted-foreground">
              {workspace?.name
                ? `${tr('dashboard.workspaceLabel')}: ${workspace.name}`
                : platformName}
            </p>
          </div>

          <Link
            to={wsPath('/billing')}
            className="group flex items-center gap-3 rounded-2xl border border-border/60 bg-card/80 px-4 py-3 shadow-sm backdrop-blur transition-all hover:-translate-y-0.5 hover:border-violet-500/40 hover:shadow-md"
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white shadow-md shadow-violet-500/25">
              <Sparkles className="h-4 w-4" />
            </span>
            <span className="leading-tight">
              <span className="block text-[11px] text-muted-foreground">{tr('dashboard.currentPlan')}</span>
              <span className="block text-sm font-semibold text-foreground">{planName}</span>
            </span>
            <ArrowRight className={`h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 ${isRtl ? 'rotate-180' : ''}`} />
          </Link>
        </div>

        {/* quick actions */}
        <div className="relative mt-5 flex flex-wrap gap-2">
          {[
            { label: tr('dashboard.openInbox'), icon: Inbox, path: '/inbox', accent: 'emerald' as AiAccent },
            { label: tr('dashboard.manageContacts'), icon: Users, path: '/contacts', accent: 'amber' as AiAccent },
            { label: tr('dashboard.manageKb'), icon: BookOpen, path: '/knowledge-base', accent: 'cyan' as AiAccent },
            { label: tr('dashboard.aiAgent'), icon: Bot, path: '/ai-agent', accent: 'violet' as AiAccent },
          ].map((a) => (
            <Link
              key={a.label}
              to={wsPath(a.path)}
              className="group inline-flex items-center gap-2 rounded-2xl border border-border/60 bg-card/70 py-1.5 pe-3.5 ps-1.5 text-xs font-semibold text-foreground shadow-sm backdrop-blur transition-all hover:-translate-y-0.5 hover:shadow-md"
            >
              <span className={cn(
                'flex h-7 w-7 items-center justify-center rounded-xl bg-gradient-to-br text-white shadow-sm transition-transform group-hover:scale-105',
                AI_ACCENT[a.accent].grad,
              )}>
                <a.icon className="h-3.5 w-3.5" />
              </span>
              {a.label}
            </Link>
          ))}
        </div>
      </section>

      {/* ── KPI cards ────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {stats.map((s) => {
          const a = AI_ACCENT[s.accent];
          return (
            <Link
              key={s.label}
              to={wsPath(s.path)}
              className="group relative overflow-hidden rounded-2xl border border-border/60 bg-card p-4 shadow-sm transition-all hover:-translate-y-1 hover:shadow-lg"
            >
              <span className={cn('pointer-events-none absolute inset-x-0 top-0 h-1 bg-gradient-to-r', a.grad)} />
              <span className={cn('pointer-events-none absolute -top-10 -end-8 h-24 w-24 rounded-full blur-2xl opacity-0 transition-opacity duration-300 group-hover:opacity-100', a.glow)} />
              <div className="flex items-start justify-between">
                <span className={cn(
                  'flex h-10 w-10 items-center justify-center rounded-2xl bg-gradient-to-br text-white shadow-md transition-transform duration-300 group-hover:scale-110',
                  a.grad,
                )}>
                  <s.icon className="h-[18px] w-[18px]" />
                </span>
                <ArrowUpRight className="h-4 w-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
              </div>
              <div className="relative mt-3 text-[26px] font-extrabold leading-none tabular-nums text-foreground">{fmt(s.value)}</div>
              <div className="relative mt-1.5 text-xs font-medium text-muted-foreground">{s.label}</div>
            </Link>
          );
        })}
      </div>

      {/* ── Main grid ────────────────────────────────────── */}
      <div className="grid gap-4 xl:grid-cols-3">
        {/* Chart */}
        <div className="relative overflow-hidden rounded-2xl border border-border/60 bg-card p-5 shadow-sm xl:col-span-2">
          <div className="pointer-events-none absolute -top-16 -start-10 h-40 w-40 rounded-full bg-indigo-500/15 blur-3xl" />
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-500 text-white shadow-md shadow-indigo-500/25">
                <MessageSquare className="h-4 w-4" />
              </span>
              <div>
                <h2 className="text-sm font-semibold text-foreground">{tr('dashboard.activityTitle')}</h2>
                <p className="text-xs text-muted-foreground">{tr('dashboard.activitySubtitle')}</p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-emerald-600 ring-1 ring-emerald-500/20 dark:text-emerald-300">
                <CheckCircle2 className="h-3.5 w-3.5" />
                {tr('dashboard.resolvedConversations')}: <b className="text-foreground">{fmt(resolved)}</b>
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 px-2.5 py-1 text-amber-600 ring-1 ring-amber-500/20 dark:text-amber-300">
                <Clock className="h-3.5 w-3.5" />
                {tr('dashboard.avgResponse')}: <b className="text-foreground">{fmt(openConvos)}</b>
              </span>
            </div>
          </div>
          <div className="relative h-[240px] w-full" dir="ltr">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 6, right: 6, left: -22, bottom: 0 }}>
                <defs>
                  <linearGradient id="convGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#8b5cf6" stopOpacity={0.45} />
                    <stop offset="60%" stopColor="#6366f1" stopOpacity={0.15} />
                    <stop offset="100%" stopColor="#06b6d4" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="convStroke" x1="0" y1="0" x2="1" y2="0">
                    <stop offset="0%" stopColor="#6366f1" />
                    <stop offset="50%" stopColor="#8b5cf6" />
                    <stop offset="100%" stopColor="#06b6d4" />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} interval="preserveStartEnd" />
                <YAxis allowDecimals={false} tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} width={36} />
                <ReTooltip
                  contentStyle={{
                    background: 'hsl(var(--popover))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: 12,
                    fontSize: 12,
                    color: 'hsl(var(--popover-foreground))',
                  }}
                  labelStyle={{ color: 'hsl(var(--muted-foreground))' }}
                />
                <Area type="monotone" dataKey="value" stroke="url(#convStroke)" strokeWidth={2.5} fill="url(#convGrad)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Plan & usage */}
        <div className="relative overflow-hidden rounded-2xl border border-border/60 bg-card p-5 shadow-sm">
          <div className="pointer-events-none absolute -top-16 -end-10 h-40 w-40 rounded-full bg-emerald-500/15 blur-3xl" />
          <div className="relative mb-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-500 to-teal-500 text-white shadow-md shadow-emerald-500/25">
                <CreditCard className="h-4 w-4" />
              </span>
              <h2 className="text-sm font-semibold text-foreground">{tr('dashboard.planUsage')}</h2>
            </div>
            <Link to={wsPath('/billing')} className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600 hover:underline dark:text-emerald-300">
              <CreditCard className="h-3.5 w-3.5" />
              {tr('dashboard.manageBilling')}
            </Link>
          </div>

          <div className="relative rounded-2xl border border-emerald-500/20 bg-gradient-to-br from-emerald-500/10 to-teal-500/5 p-3.5">
            <p className="text-[11px] text-muted-foreground">{tr('dashboard.currentPlan')}</p>
            <p className="text-lg font-bold text-foreground">{planName}</p>
          </div>

          {/* Storage consumption (bytes vs. plan storage_gb) */}
          <div className="relative mt-4 rounded-2xl border border-border/60 bg-muted/30 p-3.5">
            <div className="mb-1.5 flex items-center justify-between text-xs">
              <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                <HardDrive className="h-3.5 w-3.5" />
                {tr('dashboard.storageUsed')}
              </span>
              <span className="font-medium tabular-nums text-foreground">
                {formatBytes(storageBytes, numberLocale)}
                {storageLimitGb > 0 ? ` / ${fmt(storageLimitGb)} GB` : ' / ∞'}
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-teal-500 transition-all duration-500"
                style={{ width: `${storageLimitGb > 0 ? Math.max(storagePct, 3) : 6}%` }}
              />
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2">
              {[
                { label: tr('dashboard.usageConversations'), value: fmt(usageNum('conversations_count')) },
                { label: tr('dashboard.usageMessages'), value: fmt(usageNum('messages_count')) },
                { label: tr('dashboard.usageAiCredits'), value: fmt(usageNum('ai_credits_used')) },
              ].map((m) => (
                <div key={m.label} className="rounded-xl border border-border/50 bg-card px-2.5 py-2 text-center">
                  <div className="text-sm font-bold tabular-nums text-foreground">{m.value}</div>
                  <div className="mt-0.5 truncate text-[10px] text-muted-foreground">{m.label}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="relative mt-4 space-y-4">
            {[
              { label: tr('dashboard.statContacts'), used: contactUsed, limit: contactLimit, grad: 'from-amber-500 to-orange-500' },
              { label: tr('dashboard.statTeamOnline'), used: seatUsed, limit: seatLimit, grad: 'from-rose-500 to-pink-500' },
              { label: tr('dashboard.statKbArticles'), used: articles?.length ?? 0, limit: Number(limits.max_kb_articles ?? 0), grad: 'from-cyan-500 to-sky-500' },
            ].map((row) => {
              const unlimited = !row.limit || row.limit <= 0;
              const pct = unlimited ? 0 : Math.min(100, Math.round((row.used / row.limit) * 100));
              return (
                <div key={row.label}>
                  <div className="mb-1.5 flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">{row.label}</span>
                    <span className="font-medium tabular-nums text-foreground">
                      {fmt(row.used)}{unlimited ? ' / ∞' : ` / ${fmt(row.limit)}`}
                    </span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className={cn('h-full rounded-full bg-gradient-to-r transition-all duration-500', row.grad)}
                      style={{ width: `${unlimited ? 6 : Math.max(pct, 3)}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>

        </div>
      </div>

      {/* ── Recent + team ────────────────────────────────── */}
      <div className="grid gap-4 xl:grid-cols-3">
        {/* Recent conversations */}
        <div className="overflow-hidden rounded-2xl border border-border/60 bg-card shadow-sm xl:col-span-2">
          <div className="flex items-center justify-between border-b border-border/60 bg-gradient-to-r from-sky-500/[0.10] to-transparent px-5 py-3.5">
            <div className="flex items-center gap-3">
              <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-sky-500 to-blue-500 text-white shadow-md shadow-sky-500/25">
                <MessageSquare className="h-4 w-4" />
              </span>
              <h2 className="text-sm font-semibold text-foreground">{tr('dashboard.recentConversations')}</h2>
            </div>
            <Link to={wsPath('/inbox')} className="text-xs font-medium text-sky-600 hover:underline dark:text-sky-300">
              {tr('dashboard.viewAll')}
            </Link>
          </div>
          {conversationsPending ? (
            <IdentityListSkeleton rows={5} avatarClassName="h-8 w-8" />
          ) : recent.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 px-5 py-12 text-center">
              <MessageSquare className="h-7 w-7 text-muted-foreground/50" />
              <p className="text-sm text-muted-foreground">{tr('dashboard.noConversations')}</p>
            </div>
          ) : (
            <ul className="divide-y divide-border/60">
              {recent.map((c: any) => {
                const name = c.contacts
                  ? contactDisplayName(c.contacts, c.contact_id ?? c.id, t as any, c.visitor_network?.geo, locale)
                  : (c.visitor_name || tr('contacts.conversationUntitled'));
                const rawPreview = (c.last_message_preview || c.subject || '').trim();
                const preview = PLACEHOLDER_SUBJECTS.has(rawPreview.toLowerCase())
                  ? tr('contacts.conversationUntitled')
                  : (rawPreview || '—');
                return (
                  <li key={c.id}>
                    <Link
                      to={wsPath(`/inbox?c=${c.id}`)}
                      className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-muted/50"
                    >
                      <ContactAvatar
                        name={name}
                        email={c.contacts?.email}
                        avatarUrl={c.contacts?.avatar_url}
                        os={c.visitor_os ?? c.visitor_network?.device?.os}
                        device={c.visitor_device ?? c.visitor_network?.device?.device}
                        countryCode={c.visitor_country_code ?? c.visitor_network?.geo?.country_code}
                        size="sm"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-foreground">{name}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {preview}
                        </p>
                      </div>

                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ${
                          c.status === 'open'
                            ? 'bg-indigo-500/10 text-indigo-600 ring-indigo-500/20 dark:text-indigo-300'
                            : c.status === 'pending'
                            ? 'bg-amber-500/10 text-amber-600 ring-amber-500/20 dark:text-amber-300'
                            : 'bg-emerald-500/10 text-emerald-600 ring-emerald-500/20 dark:text-emerald-300'
                        }`}
                      >
                        {tr(`inbox.${c.status || 'open'}`)}
                      </span>
                      <span className="hidden shrink-0 text-[11px] text-muted-foreground sm:block">
                        {c.updated_at
                          ? new Date(c.updated_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
                          : ''}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Team presence */}
        <div className="overflow-hidden rounded-2xl border border-border/60 bg-card shadow-sm">
          <div className="flex items-center justify-between border-b border-border/60 bg-gradient-to-r from-rose-500/[0.10] to-transparent px-5 py-3.5">
            <div className="flex items-center gap-3">
              <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-rose-500 to-pink-500 text-white shadow-md shadow-rose-500/25">
                <ShieldCheck className="h-4 w-4" />
              </span>
              <h2 className="text-sm font-semibold text-foreground">{tr('dashboard.teamStatus')}</h2>
            </div>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-[10px] font-semibold text-emerald-600 ring-1 ring-emerald-500/20 dark:text-emerald-300">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
              {fmt(teamOnline)} {tr('dashboard.liveNow')}
            </span>
          </div>
          {teamPending || membersPending ? (
            <IdentityListSkeleton rows={4} avatarClassName="h-8 w-8" rowClassName="px-5 py-2.5" />
          ) : team.length === 0 ? (
            <div className="px-5 py-10 text-center text-sm text-muted-foreground">{tr('dashboard.noTeam')}</div>
          ) : (
            <ul className="max-h-[280px] divide-y divide-border/60 overflow-y-auto">
              {team.slice(0, 8).map((m: any) => {
                const st = m.state || m.status || 'offline';
                const label = m.full_name || m.name || m.email || '—';
                const presence: 'online' | 'idle' | 'offline' =
                  st === 'online' ? 'online' : st === 'away' || st === 'idle' ? 'idle' : 'offline';
                const stLabel =
                  presence === 'online'
                    ? tr('dashboard.statusOnline')
                    : presence === 'idle'
                    ? tr('dashboard.statusAway')
                    : tr('dashboard.statusOffline');
                return (
                  <li key={m.user_id || label} className="flex items-center gap-3 px-5 py-2.5">
                    <ContactAvatar
                      name={m.full_name || m.name}
                      email={m.email}
                      avatarUrl={m.avatar_url}
                      size="sm"
                      presence={presence}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-foreground">{label}</p>
                      <p className="truncate text-[11px] text-muted-foreground">{stLabel}</p>
                    </div>
                  </li>
                );

              })}
            </ul>
          )}
        </div>
      </div>

      {/* ── Onboarding ───────────────────────────────────── */}
      <GetStartedWizard />
    </div>
  );
}
