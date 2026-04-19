/**
 * Phase 4c — Timeline section.
 * Reads conversation_events via useConversationTimeline. Renders a vertical
 * timeline with toned event icons, primary/secondary labels, and relative time.
 * "Load more" is client-side: backend returns up to ~200 events, we reveal in pages.
 */
import { useState, useMemo } from 'react';
import { Loader2, Clock, AlertCircle, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { useConversationTimeline } from '@/hooks/useConversationTimeline';
import { actorLabel, describeEvent, getTimelineMeta, toneClasses } from './timelineMeta';
import { formatRelativeShort, formatAbsoluteTooltip } from './relativeTime';

const PAGE = 25;

interface Props {
  conversationId: string;
  workspaceId: string;
  t: (key: string) => string;
}

export function TimelineSection({ conversationId, workspaceId, t }: Props) {
  const [visible, setVisible] = useState(PAGE);
  const q = useConversationTimeline(conversationId, workspaceId);

  const events = useMemo(() => q.data ?? [], [q.data]);
  const shown = events.slice(0, visible);
  const hasMore = events.length > visible;

  return (
    <section aria-labelledby="timeline-heading">
      <div className="flex items-center justify-between mb-2">
        <h4 id="timeline-heading" className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
          <Clock className="w-3 h-3" />
          {t('inbox.timeline') || 'Timeline'}
          {events.length > 0 && (
            <span className="ms-1 text-[10px] font-normal text-muted-foreground/70">({events.length})</span>
          )}
        </h4>
      </div>

      {q.isLoading && (
        <div className="space-y-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-3/4" />
        </div>
      )}

      {q.isError && !q.isLoading && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-[11px] text-destructive flex items-start gap-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <div className="flex-1">
            <div className="font-medium">{t('inbox.timelineLoadFailed') || 'Could not load timeline'}</div>
            <button onClick={() => q.refetch()} className="underline mt-1 hover:no-underline">
              {t('common.retry') || 'Retry'}
            </button>
          </div>
        </div>
      )}

      {!q.isLoading && !q.isError && events.length === 0 && (
        <div className="rounded-lg border border-dashed border-border/60 py-4 text-center">
          <Clock className="w-4 h-4 text-muted-foreground/60 mx-auto mb-1" />
          <div className="text-[11px] text-muted-foreground">
            {t('inbox.noActivity') || 'No activity recorded yet'}
          </div>
        </div>
      )}

      {shown.length > 0 && (
        <ol className="space-y-3 relative ms-2 ps-4 border-s border-border/40">
          {shown.map((ev) => {
            const { Icon, tone } = getTimelineMeta(ev.event_type);
            const tones = toneClasses(tone);
            const { primary, secondary } = describeEvent(ev, t);
            return (
              <li key={ev.id} className="relative">
                <div
                  className={cn(
                    'absolute -start-[22px] top-0.5 w-4 h-4 rounded-full ring-2 flex items-center justify-center bg-card',
                    tones.dot, tones.ring,
                  )}
                  aria-hidden
                >
                  <Icon className={cn('w-2.5 h-2.5', tones.text)} />
                </div>
                <div className="text-[11px] text-foreground leading-tight">
                  <span className="font-medium">{actorLabel(ev, t)}</span>{' '}
                  <span className="text-muted-foreground">{primary}</span>
                  {secondary && (
                    <span className="text-muted-foreground/80"> — <span className="text-foreground/90">{secondary}</span></span>
                  )}
                </div>
                <div
                  className="text-[10px] text-muted-foreground mt-0.5"
                  title={formatAbsoluteTooltip(ev.created_at)}
                >
                  {formatRelativeShort(ev.created_at)}
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {hasMore && (
        <div className="mt-3 flex justify-center">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setVisible((v) => v + PAGE)}
            className="h-7 text-[11px] text-muted-foreground"
          >
            <ChevronDown className="w-3 h-3 me-1" />
            {t('inbox.loadMore') || 'Load more'}
            <span className="ms-1 opacity-70">({events.length - visible})</span>
          </Button>
        </div>
      )}

      {q.isFetching && !q.isLoading && (
        <div className="mt-2 text-[10px] text-muted-foreground/60 text-center flex items-center justify-center gap-1">
          <Loader2 className="w-2.5 h-2.5 animate-spin" />
          {t('inbox.refreshing') || 'Refreshing…'}
        </div>
      )}
    </section>
  );
}
