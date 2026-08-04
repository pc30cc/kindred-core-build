import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '@/i18n';
import { useCurrentWorkspace, useWorkspacePath } from '@/hooks/useWorkspace';
import { useBrandingContext } from '@/features/branding/BrandingContext';
import { useAuth } from '@/features/auth/AuthContext';
import { useConversations } from '@/hooks/useConversations';
import { useOnlineVisitors } from '@/hooks/useVisitors';
import { useKBArticles } from '@/hooks/useKnowledgeBase';
import { useContacts } from '@/hooks/useContacts';
import { useTeamPresence } from '@/hooks/useTeamPresence';
import { useWorkspacePlan } from '@/hooks/usePlans';
import GetStartedWizard from '@/components/app/GetStartedWizard';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Progress } from '@/components/ui/progress';
import {
  Area, AreaChart, ResponsiveContainer, Tooltip as ReTooltip, XAxis, YAxis, CartesianGrid,
} from 'recharts';
import {
  MessageSquare, Users, BookOpen, Eye, Inbox, Bot, ArrowUpRight, ArrowRight,
  Phone, Sparkles, CheckCircle2, Clock, ShieldCheck, CreditCard, Radio,
} from 'lucide-react';

const MODULES = [
  { key: 'inbox', icon: Inbox, labelKey: 'nav.inbox', path: '/inbox' },
  { key: 'visitors', icon: Eye, labelKey: 'nav.visitors', path: '/visitors' },
  { key: 'contacts', icon: Users, labelKey: 'nav.contacts', path: '/contacts' },
  { key: 'ai', icon: Bot, labelKey: 'nav.aiAgent', path: '/ai-agent' },
  { key: 'call', icon: Phone, labelKey: 'nav.callCenter', path: '/call-center' },
  { key: 'kb', icon: BookOpen, labelKey: 'nav.knowledgeBase', path: '/knowledge-base' },
] as const;

export default function OverviewPage() {
  const { t, locale, dir } = useTranslation();
  const workspace = useCurrentWorkspace();
  const { platformName } = useBrandingContext();
  const { user } = useAuth();
  const wsPath = useWorkspacePath();

  const { data: conversations } = useConversations(workspace?.id);
  const { data: visitors } = useOnlineVisitors(workspace?.id);
  const { data: articles } = useKBArticles(workspace?.id);
  const { data: contacts } = useContacts(workspace?.id);
  const { data: teamData } = useTeamPresence(workspace?.id);
  const team = teamData?.presence ?? [];
  const { data: planData } = useWorkspacePlan(workspace?.id);

  const tr = t as unknown as (k: string) => string;
  const isRtl = dir === 'rtl';
  const numberLocale = locale === 'fa' ? 'fa-IR' : locale === 'tr' ? 'tr-TR' : 'en-US';
  const fmt = (v: number) => v.toLocaleString(numberLocale);

  const list = conversations ?? [];
  const openConvos = list.filter((c: any) => c.status === 'open').length;
  const resolved = list.filter((c: any) => c.status === 'resolved' || c.status === 'closed').length;
  const onlineVisitors = (visitors ?? []).filter((v: any) => v.status === 'online').length;
  const teamOnline = team.filter((m: any) => m.state === 'online' || m.status === 'online').length;

  const userName =
    (user?.metadata?.full_name as string) || user?.email?.split('@')[0] || '';

  const greeting = useMemo(() => {
    const h = new Date().getHours();
    if (h < 12) return tr('dashboard.greetingMorning');
    if (h < 18) return tr('dashboard.greetingAfternoon');
    return tr('dashboard.greetingEvening');
  }, [locale]);

  // 14-day conversation trend
  const chartData = useMemo(() => {
    const days: { key: string; label: string; value: number }[] = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - i);
      days.push({
        key: d.toISOString().slice(0, 10),
        label: d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
        value: 0,
      });
    }
    const idx = new Map(days.map((d, i) => [d.key, i]));
    for (const c of list as any[]) {
      const k = c.created_at ? new Date(c.created_at).toISOString().slice(0, 10) : null;
      if (k && idx.has(k)) days[idx.get(k)!].value += 1;
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

  const seatLimit = Number(limits.max_operators ?? limits.max_seats ?? 0);
  const seatUsed = team.length;
  const contactLimit = Number(limits.max_contacts ?? 0);
  const contactUsed = (contacts ?? []).length;

  const moduleAllowed = (key: string) => {
    const map: Record<string, string[]> = {
      inbox: ['inbox', 'live_chat'],
      visitors: ['visitors', 'visitor_intelligence'],
      contacts: ['contacts', 'crm'],
      ai: ['ai_agent', 'ai_assistant'],
      call: ['call_center', 'voice_calls'],
      kb: ['knowledge_base'],
    };
    const candidates = map[key] || [key];
    if (!Object.keys(entitlements).length) return true;
    const hit = candidates.find((c) => c in entitlements);
    return hit ? Boolean(entitlements[hit]) : true;
  };

  const stats = [
    { label: tr('dashboard.statOpenConversations'), value: openConvos, icon: Inbox, tone: 'primary', path: '/inbox' },
    { label: tr('dashboard.statOnlineVisitors'), value: onlineVisitors, icon: Radio, tone: 'success', path: '/visitors' },
    { label: tr('dashboard.statContacts'), value: contactUsed, icon: Users, tone: 'info', path: '/contacts' },
    { label: tr('dashboard.statTeamOnline'), value: teamOnline, icon: ShieldCheck, tone: 'warning', path: '/settings/team' },
  ];

  const toneCls: Record<string, { bg: string; fg: string; ring: string }> = {
    primary: { bg: 'bg-primary/10', fg: 'text-primary', ring: 'ring-primary/20' },
    success: { bg: 'bg-success/10', fg: 'text-success', ring: 'ring-success/20' },
    info: { bg: 'bg-info/10', fg: 'text-info', ring: 'ring-info/20' },
    warning: { bg: 'bg-warning/10', fg: 'text-warning', ring: 'ring-warning/20' },
  };

  const recent = list.slice(0, 6);

  return (
    <div dir={dir} className="space-y-6 animate-fade-in">
      {/* ── Hero ─────────────────────────────────────────── */}
      <section className="relative overflow-hidden rounded-2xl border border-border/60 bg-gradient-to-br from-primary/10 via-background to-background p-6 shadow-sm">
        <div className="pointer-events-none absolute -top-24 end-[-4rem] h-56 w-56 rounded-full bg-primary/20 blur-3xl" />
        <div className="pointer-events-none absolute bottom-[-6rem] start-1/3 h-48 w-48 rounded-full bg-info/10 blur-3xl" />
        <div className="relative flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="mb-2 inline-flex items-center gap-1.5 rounded-full border border-success/25 bg-success/10 px-2.5 py-1 text-[11px] font-medium text-success">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-70" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-success" />
              </span>
              {tr('dashboard.systemHealthy')}
            </div>
            <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
              {greeting}{userName ? `، ${userName}` : ''}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {workspace?.name
                ? `${tr('dashboard.workspaceLabel')}: ${workspace.name}`
                : platformName}
              {' · '}
              {new Date().toLocaleDateString(undefined, {
                weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
              })}
            </p>
          </div>

          <Link
            to={wsPath('/billing')}
            className="group flex items-center gap-3 rounded-xl border border-border/60 bg-card/80 px-4 py-3 backdrop-blur transition-colors hover:border-primary/40"
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
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
            { label: tr('dashboard.openInbox'), icon: Inbox, path: '/inbox' },
            { label: tr('dashboard.manageContacts'), icon: Users, path: '/contacts' },
            { label: tr('dashboard.manageKb'), icon: BookOpen, path: '/knowledge-base' },
            { label: tr('dashboard.aiAgent'), icon: Bot, path: '/ai-agent' },
          ].map((a) => (
            <Link
              key={a.label}
              to={wsPath(a.path)}
              className="inline-flex items-center gap-2 rounded-xl border border-border/60 bg-card/70 px-3.5 py-2 text-xs font-medium text-foreground backdrop-blur transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:text-primary"
            >
              <a.icon className="h-3.5 w-3.5" />
              {a.label}
            </Link>
          ))}
        </div>
      </section>

      {/* ── KPI cards ────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {stats.map((s) => {
          const tone = toneCls[s.tone];
          return (
            <Link
              key={s.label}
              to={wsPath(s.path)}
              className="group relative overflow-hidden rounded-2xl border border-border/60 bg-card p-4 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md"
            >
              <div className="flex items-start justify-between">
                <span className={`flex h-10 w-10 items-center justify-center rounded-xl ring-1 ${tone.bg} ${tone.ring}`}>
                  <s.icon className={`h-4.5 w-4.5 ${tone.fg}`} />
                </span>
                <ArrowUpRight className="h-4 w-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
              </div>
              <div className="mt-3 text-2xl font-bold tabular-nums text-foreground">{fmt(s.value)}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">{s.label}</div>
            </Link>
          );
        })}
      </div>

      {/* ── Main grid ────────────────────────────────────── */}
      <div className="grid gap-4 xl:grid-cols-3">
        {/* Chart */}
        <div className="rounded-2xl border border-border/60 bg-card p-5 shadow-sm xl:col-span-2">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-foreground">{tr('dashboard.activityTitle')}</h2>
              <p className="text-xs text-muted-foreground">{tr('dashboard.activitySubtitle')}</p>
            </div>
            <div className="flex items-center gap-3 text-xs">
              <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                <CheckCircle2 className="h-3.5 w-3.5 text-success" />
                {tr('dashboard.resolvedConversations')}: <b className="text-foreground">{fmt(resolved)}</b>
              </span>
              <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                <Clock className="h-3.5 w-3.5 text-warning" />
                {tr('dashboard.avgResponse')}: <b className="text-foreground">{fmt(openConvos)}</b>
              </span>
            </div>
          </div>
          <div className="h-[240px] w-full" dir="ltr">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 6, right: 6, left: -22, bottom: 0 }}>
                <defs>
                  <linearGradient id="convGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
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
                <Area type="monotone" dataKey="value" stroke="hsl(var(--primary))" strokeWidth={2} fill="url(#convGrad)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Plan & usage */}
        <div className="rounded-2xl border border-border/60 bg-card p-5 shadow-sm">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">{tr('dashboard.planUsage')}</h2>
            <Link to={wsPath('/billing')} className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
              <CreditCard className="h-3.5 w-3.5" />
              {tr('dashboard.manageBilling')}
            </Link>
          </div>

          <div className="rounded-xl border border-primary/20 bg-primary/5 p-3">
            <p className="text-[11px] text-muted-foreground">{tr('dashboard.currentPlan')}</p>
            <p className="text-lg font-bold text-foreground">{planName}</p>
          </div>

          <div className="mt-4 space-y-4">
            {[
              { label: tr('dashboard.statContacts'), used: contactUsed, limit: contactLimit },
              { label: tr('dashboard.statTeamOnline'), used: seatUsed, limit: seatLimit },
              { label: tr('dashboard.statKbArticles'), used: articles?.length ?? 0, limit: Number(limits.max_kb_articles ?? 0) },
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
                  <Progress value={unlimited ? 4 : pct} className="h-1.5" />
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── Recent + team ────────────────────────────────── */}
      <div className="grid gap-4 xl:grid-cols-3">
        {/* Recent conversations */}
        <div className="rounded-2xl border border-border/60 bg-card shadow-sm xl:col-span-2">
          <div className="flex items-center justify-between border-b border-border/60 px-5 py-3.5">
            <h2 className="text-sm font-semibold text-foreground">{tr('dashboard.recentConversations')}</h2>
            <Link to={wsPath('/inbox')} className="text-xs font-medium text-primary hover:underline">
              {tr('dashboard.viewAll')}
            </Link>
          </div>
          {recent.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 px-5 py-12 text-center">
              <MessageSquare className="h-7 w-7 text-muted-foreground/50" />
              <p className="text-sm text-muted-foreground">{tr('dashboard.noConversations')}</p>
            </div>
          ) : (
            <ul className="divide-y divide-border/60">
              {recent.map((c: any) => {
                const name = c.contacts?.name || c.visitor_name || tr('inbox.visitor');
                return (
                  <li key={c.id}>
                    <Link
                      to={wsPath(`/inbox?c=${c.id}`)}
                      className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-muted/50"
                    >
                      <Avatar className="h-8 w-8">
                        {c.contacts?.avatar_url ? <AvatarImage src={c.contacts.avatar_url} alt={name} /> : null}
                        <AvatarFallback className="bg-primary/10 text-[11px] font-semibold text-primary">
                          {String(name).charAt(0).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-foreground">{name}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {c.last_message_preview || c.subject || '—'}
                        </p>
                      </div>
                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                          c.status === 'open'
                            ? 'bg-primary/10 text-primary'
                            : c.status === 'pending'
                            ? 'bg-warning/10 text-warning'
                            : 'bg-success/10 text-success'
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
        <div className="rounded-2xl border border-border/60 bg-card shadow-sm">
          <div className="flex items-center justify-between border-b border-border/60 px-5 py-3.5">
            <h2 className="text-sm font-semibold text-foreground">{tr('dashboard.teamStatus')}</h2>
            <span className="rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-medium text-success">
              {fmt(teamOnline)} {tr('dashboard.liveNow')}
            </span>
          </div>
          {team.length === 0 ? (
            <div className="px-5 py-10 text-center text-sm text-muted-foreground">{tr('dashboard.noTeam')}</div>
          ) : (
            <ul className="max-h-[280px] divide-y divide-border/60 overflow-y-auto">
              {team.slice(0, 8).map((m: any) => {
                const st = m.state || m.status || 'offline';
                const dot =
                  st === 'online' ? 'bg-success' : st === 'away' || st === 'idle' ? 'bg-warning' : 'bg-muted-foreground/40';
                const label = m.full_name || m.name || m.email || '—';
                return (
                  <li key={m.user_id || label} className="flex items-center gap-3 px-5 py-2.5">
                    <div className="relative">
                      <Avatar className="h-8 w-8">
                        {m.avatar_url ? <AvatarImage src={m.avatar_url} alt={label} /> : null}
                        <AvatarFallback className="bg-muted text-[11px] font-semibold">
                          {String(label).charAt(0).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <span className={`absolute -bottom-0.5 -end-0.5 h-2.5 w-2.5 rounded-full border-2 border-card ${dot}`} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-foreground">{label}</p>
                      <p className="truncate text-[11px] capitalize text-muted-foreground">{st}</p>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      {/* ── Modules ──────────────────────────────────────── */}
      <div className="rounded-2xl border border-border/60 bg-card p-5 shadow-sm">
        <h2 className="mb-4 text-sm font-semibold text-foreground">{tr('dashboard.modules')}</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {MODULES.map((m) => {
            const allowed = moduleAllowed(m.key);
            const inner = (
              <>
                <span className={`flex h-10 w-10 items-center justify-center rounded-xl ${allowed ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}>
                  <m.icon className="h-4.5 w-4.5" />
                </span>
                <span className="mt-2 block truncate text-xs font-medium text-foreground">{tr(m.labelKey)}</span>
                <span className="block text-[10px] text-muted-foreground">
                  {allowed ? tr('dashboard.open') : tr('dashboard.moduleLocked')}
                </span>
              </>
            );
            return allowed ? (
              <Link
                key={m.key}
                to={wsPath(m.path)}
                className="rounded-xl border border-border/60 p-3 text-center transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-sm"
              >
                {inner}
              </Link>
            ) : (
              <div key={m.key} className="cursor-not-allowed rounded-xl border border-dashed border-border/60 p-3 text-center opacity-60">
                {inner}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Onboarding ───────────────────────────────────── */}
      <GetStartedWizard />
    </div>
  );
}
