import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useVisitorDetail, useVisitorPageHistory } from '@/hooks/useVisitors';
import { useNavigate } from 'react-router-dom';
import { useWorkspacePath } from '@/hooks/useWorkspace';
import { useState } from 'react';
import {
  Copy, MessageSquare, User, Globe, Monitor, MapPin, Clock, ExternalLink, History,
  Wifi, ShieldCheck, ShieldAlert, ShieldX, ArrowLeft, LogIn, Navigation, Send, Loader2,
} from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { useTranslation } from '@/i18n';
import { contactDisplayName } from '@/lib/contact-display';
import { formatDateTime, formatRelative } from '@/lib/date';
import { OsAvatar } from '@/components/visitors/OsIcon';
import { conversationsApi } from '@/lib/conversations-api';
import { localizedLocationLabel } from '@/lib/geo/localizedGeo';

interface Props {
  workspaceId: string | undefined;
  sessionId: string;
  onBack: () => void;
}

/**
 * Inline visitor detail panel — replaces the side drawer with an in-column
 * detail view (Crisp-style). The list column swaps to this view when a
 * visitor is selected, with a back button to return to the list.
 */
export function VisitorDetailPanel({ workspaceId, sessionId, onBack }: Props) {
  const { t, locale } = useTranslation();
  const { data, isLoading } = useVisitorDetail(workspaceId, sessionId);
  const history = useVisitorPageHistory(workspaceId, sessionId);
  const navigate = useNavigate();
  const wsPath = useWorkspacePath();
  const [showAllPages, setShowAllPages] = useState(false);
  const [startingChat, setStartingChat] = useState(false);

  const copy = (label: string, value: string) => {
    navigator.clipboard.writeText(value);
    toast({ title: t('visitors.copied'), description: label });
  };

  /**
   * Operator outreach: open existing conversation if one exists for this
   * visitor session, otherwise spin up a new one and jump to the inbox so
   * the operator can compose the first message.
   */
  async function handleStartChat() {
    if (!workspaceId || !data) return;
    setStartingChat(true);
    try {
      const result = await conversationsApi.startFromVisitor({
        workspace_id: workspaceId,
        visitor_session_id: data.id,
      });
      navigate(`${wsPath('/inbox')}?c=${result.conversation_id}`);
    } catch (err: any) {
      toast({
        title: t('common.error' as 'common.copy') || 'Error',
        description: err?.message || 'Failed to start chat',
        variant: 'destructive',
      });
    } finally {
      setStartingChat(false);
    }
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Sticky header with back button */}
      <div className="flex items-center gap-2 p-3 border-b border-border bg-card/50 backdrop-blur-sm">
        <Button
          size="sm"
          variant="ghost"
          onClick={onBack}
          className="h-8 px-2 -ms-1"
          aria-label={t('common.back')}
        >
          <ArrowLeft className="w-4 h-4 me-1.5 rtl:rotate-180" />
          {t('common.back')}
        </Button>
        <span className="text-xs font-medium text-muted-foreground ms-auto truncate">
          {t('visitors.drawerTitle')}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto p-4 animate-fade-in">
        {isLoading || !data ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            {t('visitors.drawerLoading')}
          </div>
        ) : (
          <div className="space-y-5">
            {/* Identity row */}
            <div className="flex items-center gap-3">
              <OsAvatar
                os={data.os}
                device={data.device}
                className="w-10 h-10 shrink-0"
                iconClassName="w-5 h-5"
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium truncate">
                    {data.contact ? contactDisplayName(data.contact, data.contact.id, t, data.geo, locale) : `Visitor ${data.visitor_id.slice(0, 8)}`}
                  </span>
                  <Badge variant="outline" className="text-[10px]">{data.status}</Badge>
                </div>
                {data.contact?.email && (
                  <p className="text-xs text-muted-foreground truncate">{data.contact.email}</p>
                )}
              </div>
            </div>

            {/* Quick actions */}
            <div className="grid grid-cols-2 gap-2">
              {data.conversation ? (
                <Button size="sm" variant="default"
                  onClick={() => navigate(`${wsPath('/inbox')}?c=${data.conversation!.id}`)}>
                  <MessageSquare className="w-3.5 h-3.5 me-1.5" />
                  {t('visitors.openChat')}
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="default"
                  onClick={handleStartChat}
                  disabled={startingChat}
                >
                  {startingChat ? (
                    <Loader2 className="w-3.5 h-3.5 me-1.5 animate-spin" />
                  ) : (
                    <Send className="w-3.5 h-3.5 me-1.5" />
                  )}
                  {t('visitors.startChat')}
                </Button>
              )}
              {data.contact && (
                <Button size="sm" variant="outline"
                  onClick={() => navigate(wsPath(`/contacts/${data.contact!.id}`))}>
                  <User className="w-3.5 h-3.5 me-1.5" />
                  {t('visitors.openContact')}
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={() => copy('Session ID', data.id)}>
                <Copy className="w-3.5 h-3.5 me-1.5" />
                {t('visitors.copySession')}
              </Button>
              <Button size="sm" variant="outline" onClick={() => copy('Visitor ID', data.visitor_id)}>
                <Copy className="w-3.5 h-3.5 me-1.5" />
                {t('visitors.copyVisitor')}
              </Button>
            </div>

            {/* Info grid */}
            <div className="space-y-3 text-sm">
              <Row icon={<Globe className="w-3.5 h-3.5" />} label={t('visitors.currentPage')} value={data.current_page} truncate />
              <LocationRow data={data} t={t} locale={locale} />
              <IpRow data={data} t={t} onCopy={copy} />
              <Row icon={<Monitor className="w-3.5 h-3.5" />} label={t('visitors.browser')}
                value={[data.browser, data.os].filter(Boolean).join(' · ') || '—'} />
              <Row icon={<Monitor className="w-3.5 h-3.5" />} label={t('visitors.device')} value={data.device || '—'} />
              <Row icon={<ExternalLink className="w-3.5 h-3.5" />} label={t('visitors.referrer')} value={data.referrer || '—'} truncate />
              <Row icon={<Clock className="w-3.5 h-3.5" />} label={t('visitors.lastActivity')}
                value={formatDateTime(data.last_activity_at)} />
            </div>

            {/* Page-history timeline */}
            <div className="pt-2 border-t border-border">
              <div className="flex items-center gap-2 mb-2">
                <History className="w-3.5 h-3.5 text-muted-foreground" />
                <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  {t('visitors.pageHistory')}
                </span>
                {history.data?.items?.length ? (
                  <Badge variant="outline" className="text-[10px] ms-auto">
                    {history.data.items.length}
                  </Badge>
                ) : null}
              </div>
              {history.isLoading ? (
                <p className="text-xs text-muted-foreground">{t('visitors.pageHistoryLoading')}</p>
              ) : (
                <PageJourney
                  entry={history.data?.entry ?? null}
                  current={history.data?.current ?? null}
                  items={history.data?.items ?? []}
                  showAll={showAllPages}
                  onToggle={() => setShowAllPages((v) => !v)}
                  t={t}
                />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ icon, label, value, hint, truncate }: {
  icon: React.ReactNode; label: string; value: string | null; hint?: string; truncate?: boolean;
}) {
  return (
    <div className="flex items-start gap-2.5">
      <span className="mt-0.5 text-muted-foreground">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-[11px] text-muted-foreground uppercase tracking-wide">{label}</div>
        <div className={`text-sm text-foreground ${truncate ? 'truncate' : ''}`}>
          {value || '—'}{hint && <span className="ms-1 text-[11px] text-muted-foreground">({hint})</span>}
        </div>
      </div>
    </div>
  );
}

/**
 * Visitor journey: shows where the visitor entered from (referrer + landing
 * page), the current page they're on, and the navigation timeline between.
 */
function PageJourney({
  entry,
  current,
  items,
  showAll,
  onToggle,
  t,
}: {
  entry: { landing_url: string | null; landing_title?: string | null; landed_at: string | null; referrer: string | null } | null;
  current: { url: string; title?: string | null; viewed_at: string | null } | null;
  items: Array<{ id: number; url: string; title?: string | null; viewed_at: string }>;
  showAll: boolean;
  onToggle: () => void;
  t: (k: string, vars?: Record<string, string>) => string;
}) {
  const hasAny = !!entry?.landing_url || !!current?.url || items.length > 0;
  if (!hasAny) {
    return <p className="text-xs text-muted-foreground">{t('visitors.pageHistoryEmpty')}</p>;
  }

  // Pretty-format a referrer URL → hostname only (or "Direct visit").
  const refSource = (() => {
    const r = entry?.referrer?.trim();
    if (!r) return null;
    try {
      return new URL(r).hostname.replace(/^www\./, '');
    } catch {
      return r;
    }
  })();

  // The "between" pages = all items except the most-recent (current) one.
  const middle = items.length > 1 ? items.slice(1) : [];
  const CAP = 6;
  const visibleMiddle = showAll ? middle : middle.slice(0, CAP);
  const hiddenCount = middle.length - visibleMiddle.length;

  return (
    <div className="space-y-3">
      {/* Entry point card */}
      {entry?.landing_url && (
        <div className="rounded-md border border-success/20 bg-success/5 p-2.5">
          <div className="flex items-center gap-1.5 mb-1">
            <LogIn className="w-3 h-3 text-success" />
            <span className="text-[10px] uppercase tracking-wide text-success font-medium">
              {t('visitors.entryPoint')}
            </span>
          </div>
          {entry.landing_title && (
            <div className="text-xs text-foreground truncate font-medium" title={entry.landing_title}>
              {entry.landing_title}
            </div>
          )}
          <div className={`text-[11px] truncate ${entry.landing_title ? 'text-muted-foreground/90 font-mono' : 'text-foreground font-medium'}`} title={entry.landing_url}>
            {entry.landing_url}
          </div>
          <div className="text-[10px] text-muted-foreground mt-0.5 flex items-center gap-1.5 flex-wrap">
            {entry.landed_at && <span>{relativeTime(entry.landed_at, t)}</span>}
            <span className="opacity-50">·</span>
            <span>
              {refSource
                ? t('visitors.cameFrom', { source: refSource })
                : t('visitors.cameFromDirect')}
            </span>
          </div>
        </div>
      )}

      {/* Currently on card */}
      {current?.url && (
        <div className="rounded-md border border-primary/20 bg-primary/5 p-2.5">
          <div className="flex items-center gap-1.5 mb-1">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-primary" />
            </span>
            <span className="text-[10px] uppercase tracking-wide text-primary font-medium">
              {t('visitors.currentlyOn')}
            </span>
          </div>
          {current.title && (
            <div className="text-xs text-foreground truncate font-medium" title={current.title}>
              {current.title}
            </div>
          )}
          <div className={`text-[11px] truncate ${current.title ? 'text-muted-foreground/90 font-mono' : 'text-foreground font-medium'}`} title={current.url}>
            {current.url}
          </div>
          {current.viewed_at && (
            <div className="text-[10px] text-muted-foreground mt-0.5">
              {relativeTime(current.viewed_at, t)}
            </div>
          )}
        </div>
      )}

      {/* Journey between entry and current */}
      {middle.length > 0 && (
        <div className="pt-1">
          <div className="flex items-center gap-1.5 mb-2">
            <Navigation className="w-3 h-3 text-muted-foreground" />
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {t('visitors.pageJourney')}
            </span>
            <Badge variant="outline" className="text-[10px] ms-auto">
              {middle.length}
            </Badge>
          </div>
          <ol className="relative ms-1.5 border-s border-border/70 space-y-2 pt-1">
            {visibleMiddle.map((p) => (
              <li key={p.id} className="ps-3 relative">
                <span className="absolute -start-[5px] top-1.5 w-2 h-2 rounded-full bg-muted-foreground/50 ring-2 ring-background" />
                {p.title && (
                  <div className="text-xs text-foreground truncate font-medium" title={p.title}>{p.title}</div>
                )}
                <div className={`text-[11px] truncate ${p.title ? 'text-muted-foreground/90 font-mono' : 'text-xs text-foreground'}`} title={p.url}>
                  {p.url}
                </div>
                <div className="text-[10px] text-muted-foreground">
                  {relativeTime(p.viewed_at, t)}
                </div>
              </li>
            ))}
          </ol>
          {(hiddenCount > 0 || showAll) && middle.length > CAP && (
            <button
              type="button"
              onClick={onToggle}
              className="mt-2 text-[11px] text-primary hover:underline"
            >
              {showAll
                ? t('visitors.pageHistoryShowLess')
                : t('visitors.pageHistoryShowAll', { n: String(middle.length) })}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Lightweight relative-time formatter used inside the journey cards.
 * Falls back to a localized date string for anything older than ~7 days.
 */
function relativeTime(iso: string, t: (k: string, vars?: Record<string, string>) => string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const diffSec = Math.max(0, Math.round((Date.now() - then) / 1000));
  const when = diffSec < 7 * 86400 ? formatRelative(iso) : formatDateTime(iso);
  return t('visitors.landedAt', { when });
}

function LocationRow({ data, t, locale }: { data: any; t: (k: string) => string; locale?: string }) {
  const loc = localizedLocationLabel(data.geo, locale ?? 'en') ?? '';
  const src = data.geo.source as 'cache' | 'provider' | 'centroid' | 'session' | 'disabled' | 'none';
  const isPrecise = src === 'provider' || src === 'cache';
  const isApprox = src === 'centroid';
  const isDisabled = src === 'disabled';
  const Icon = isPrecise ? ShieldCheck : isApprox ? ShieldAlert : ShieldX;
  const cls = isPrecise
    ? 'text-success bg-success/10 border-success/20'
    : isApprox
      ? 'text-warning bg-warning/10 border-warning/20'
      : isDisabled
        ? 'text-info bg-info/10 border-info/20'
        : 'text-muted-foreground bg-muted/40 border-border';
  const label = isPrecise
    ? t('visitors.geoPrecise')
    : isApprox
      ? t('visitors.geoApproximate')
      : isDisabled
        ? t('visitors.geoExternalDisabled')
        : t('visitors.geoUnavailable');
  return (
    <div className="flex items-start gap-2.5">
      <span className="mt-0.5 text-muted-foreground"><MapPin className="w-3.5 h-3.5" /></span>
      <div className="min-w-0 flex-1">
        <div className="text-[11px] text-muted-foreground uppercase tracking-wide">
          {t('visitors.location')}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm text-foreground">{loc || '—'}</span>
          <span className={`inline-flex items-center gap-1 px-1.5 h-4 rounded text-[10px] border ${cls}`}>
            <Icon className="w-2.5 h-2.5" />
            {label}
          </span>
        </div>
        {!loc && (
          <div className="text-[11px] text-muted-foreground mt-0.5">
            {isDisabled ? t('visitors.noLocationReasonDisabled') : t('visitors.noLocationReason')}
          </div>
        )}
      </div>
    </div>
  );
}

function IpRow({ data, t, onCopy }: {
  data: any; t: (k: string) => string; onCopy: (label: string, value: string) => void;
}) {
  if (data.ip_locked) {
    return (
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 text-muted-foreground"><Wifi className="w-3.5 h-3.5" /></span>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] text-muted-foreground uppercase tracking-wide">
            {t('visitors.ipAddress')}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="inline-flex items-center gap-1 px-1.5 h-5 rounded text-[10px] border border-warning/30 bg-warning/10 text-warning">
              {t('visitors.ipPlanLocked')}
            </span>
          </div>
          <div className="text-[11px] text-muted-foreground mt-0.5">
            {t('visitors.ipPlanLockedHint')}
          </div>
        </div>
      </div>
    );
  }
  const value = data.ip_raw || data.ip_display || '—';
  return (
    <div className="flex items-start gap-2.5">
      <span className="mt-0.5 text-muted-foreground"><Wifi className="w-3.5 h-3.5" /></span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground uppercase tracking-wide">
            {t('visitors.ipAddress')}
          </span>
          {!data.can_view_raw_ip && (
            <span className="text-[10px] text-muted-foreground/80">{t('visitors.ipMasked')}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <code className="text-sm text-foreground font-mono truncate">{value}</code>
          {value !== '—' && (
            <button
              type="button"
              onClick={() => onCopy(t('visitors.ipAddress'), value)}
              className="text-muted-foreground hover:text-foreground"
              aria-label={t('common.copy')}
            >
              <Copy className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}