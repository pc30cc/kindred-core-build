import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useVisitorDetail, useVisitorPageHistory } from '@/hooks/useVisitors';
import { useNavigate } from 'react-router-dom';
import { useWorkspacePath } from '@/hooks/useWorkspace';
import { useState } from 'react';
import {
  Copy, MessageSquare, User, Globe, Monitor, MapPin, Clock, ExternalLink, History,
} from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { useTranslation } from '@/i18n';

interface Props {
  workspaceId: string | undefined;
  sessionId: string | null;
  onClose: () => void;
}

export function VisitorDrawer({ workspaceId, sessionId, onClose }: Props) {
  const { t } = useTranslation();
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
              <Row icon={<MapPin className="w-3.5 h-3.5" />} label="Location"
                value={[data.geo.city, data.geo.country].filter(Boolean).join(', ') || '—'}
                hint={data.geo.source !== 'none' ? `via ${data.geo.source}` : undefined} />
              <Row icon={<Monitor className="w-3.5 h-3.5" />} label="Browser / OS"
                value={[data.browser, data.os].filter(Boolean).join(' · ') || '—'} />
              <Row icon={<Monitor className="w-3.5 h-3.5" />} label="Device" value={data.device || '—'} />
              <Row icon={<ExternalLink className="w-3.5 h-3.5" />} label="Referrer" value={data.referrer || '—'} truncate />
              <Row icon={<Clock className="w-3.5 h-3.5" />} label="Last activity"
                value={new Date(data.last_activity_at).toLocaleString()} />
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
                              {new Date(p.viewed_at).toLocaleString()}
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