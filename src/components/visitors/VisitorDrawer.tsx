import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useVisitorDetail, useVisitorPageHistory } from '@/hooks/useVisitors';
import { useNavigate } from 'react-router-dom';
import { useWorkspacePath } from '@/hooks/useWorkspace';
import { useState } from 'react';
import {
  Copy, MessageSquare, User, Globe, Monitor, MapPin, Clock, ExternalLink, History,
  Wifi, ShieldCheck, ShieldAlert, ShieldX,
} from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { useTranslation } from '@/i18n';
import { formatDateTime, formatRelative } from '@/lib/date';
import { localizedLocationLabel } from '@/lib/geo/localizedGeo';

interface Props {
  workspaceId: string | undefined;
  sessionId: string | null;
  onClose: () => void;
}

export function VisitorDrawer({ workspaceId, sessionId, onClose }: Props) {
  const { t, locale } = useTranslation();
  const { data, isLoading } = useVisitorDetail(workspaceId, sessionId);
  const history = useVisitorPageHistory(workspaceId, sessionId);
  const navigate = useNavigate();
  const wsPath = useWorkspacePath();
  const [showAllPages, setShowAllPages] = useState(false);

  const open = !!sessionId;
  const copy = (label: string, value: string) => {
    navigator.clipboard.writeText(value);
    toast({ title: t('visitors.copied'), description: `${label}` });
  };

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Visitor details</SheetTitle>
        </SheetHeader>

        {isLoading || !data ? (
          <div className="py-10 text-center text-sm text-muted-foreground">Loading...</div>
        ) : (
          <div className="space-y-5 mt-4">
            {/* Status row */}
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-secondary flex items-center justify-center">
                <Monitor className="w-4 h-4 text-muted-foreground" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium truncate">
                    {data.contact?.name || data.contact?.email || `Visitor ${data.visitor_id.slice(0, 8)}`}
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
              {data.conversation && (
                <Button size="sm" variant="default"
                  onClick={() => navigate(`${wsPath('/inbox')}?c=${data.conversation!.id}`)}>
                  <MessageSquare className="w-3.5 h-3.5 me-1.5" />
                  Open chat
                </Button>
              )}
              {data.contact && (
                <Button size="sm" variant="outline"
                  onClick={() => navigate(wsPath(`/contacts/${data.contact!.id}`))}>
                  <User className="w-3.5 h-3.5 me-1.5" />
                  Open contact
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={() => copy('Session ID', data.id)}>
                <Copy className="w-3.5 h-3.5 me-1.5" />
                Copy session
              </Button>
              <Button size="sm" variant="outline" onClick={() => copy('Visitor ID', data.visitor_id)}>
                <Copy className="w-3.5 h-3.5 me-1.5" />
                Copy visitor
              </Button>
            </div>

            {/* Info grid */}
            <div className="space-y-3 text-sm">
              <Row icon={<Globe className="w-3.5 h-3.5" />} label="Current page" value={data.current_page} truncate />
              <LocationRow data={data} t={t} locale={locale} />
              <IpRow data={data} t={t} onCopy={copy} />
              <Row icon={<Monitor className="w-3.5 h-3.5" />} label="Browser / OS"
                value={[data.browser, data.os].filter(Boolean).join(' · ') || '—'} />
              <Row icon={<Monitor className="w-3.5 h-3.5" />} label="Device" value={data.device || '—'} />
              <Row icon={<ExternalLink className="w-3.5 h-3.5" />} label="Referrer" value={data.referrer || '—'} truncate />
              <Row icon={<Clock className="w-3.5 h-3.5" />} label="Last activity"
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
              ) : !history.data?.items?.length ? (
                <p className="text-xs text-muted-foreground">{t('visitors.pageHistoryEmpty')}</p>
              ) : (
                (() => {
                  const items = history.data.items;
                  const CAP = 8;
                  const visible = showAllPages ? items : items.slice(0, CAP);
                  return (
                    <>
                      <ol className="relative ms-1.5 border-s border-border/70 space-y-2 pt-1">
                        {visible.map((p) => (
                          <li key={p.id} className="ps-3 relative">
                            <span className="absolute -start-[5px] top-1.5 w-2 h-2 rounded-full bg-primary/70 ring-2 ring-background" />
                            <div className="text-xs text-foreground truncate" title={p.url}>{p.url}</div>
                            <div className="text-[10px] text-muted-foreground">
                              {formatDateTime(p.viewed_at)}
                            </div>
                          </li>
                        ))}
                      </ol>
                      {items.length > CAP && (
                        <button
                          type="button"
                          onClick={() => setShowAllPages((v) => !v)}
                          className="mt-2 text-[11px] text-primary hover:underline"
                        >
                          {showAllPages
                            ? t('visitors.pageHistoryShowLess')
                            : t('visitors.pageHistoryShowAll', { n: String(items.length) })}
                        </button>
                      )}
                    </>
                  );
                })()
              )}
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
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
 * Location row with privacy-aware geo-source badge:
 *   - cache/provider → "Precise" (green)
 *   - centroid       → "Approximate" (amber)
 *   - session/none   → "Unavailable" (muted)
 */
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

/** IP address row — shows the masked display value; copy is always allowed. */
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