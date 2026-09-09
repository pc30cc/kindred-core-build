import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { BarChart3, ChevronDown } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { useWorkspacePath } from '@/hooks/useWorkspace';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { WEB_ANALYTICS_NAV, type WebAnalyticsNavGroup, type WebAnalyticsNavLeaf } from './webAnalyticsNavTree';

function SubNavLeafLink({ leaf, active }: { leaf: WebAnalyticsNavLeaf; active: boolean }) {
  const { t } = useTranslation();
  const wsPath = useWorkspacePath();
  return (
    <Link
      to={wsPath(`/analytics/${leaf.key}`)}
      className={cn(
        'flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-sm transition-colors',
        active ? 'bg-primary/10 font-medium text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      <span className="truncate">{t(leaf.labelKey as any)}</span>
      {!leaf.built && <Badge variant="outline" className="shrink-0 text-[9px] font-normal text-muted-foreground">{t('seo.nav.soon' as any)}</Badge>}
    </Link>
  );
}

function SubNavGroup({ group, activeSubsectionKey }: { group: WebAnalyticsNavGroup; activeSubsectionKey: string | undefined }) {
  const { t } = useTranslation();
  const hasActiveChild = group.children.some((c) => c.key === activeSubsectionKey);
  // Desktop expectation: every report group is expanded on arrival, so the
  // full report tree is visible without extra clicks.
  const [open, setOpen] = useState(true);

  useEffect(() => {
    if (hasActiveChild) setOpen(true);
  }, [hasActiveChild]);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
        <span className="truncate font-medium">{t(group.labelKey as any)}</span>
        <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 transition-transform', open && 'rotate-180')} />
      </CollapsibleTrigger>
      <CollapsibleContent className="ms-2 space-y-0.5 border-s border-border/60 ps-2 pt-0.5">
        {group.children.map((child) => (
          <SubNavLeafLink key={child.key} leaf={child} active={child.key === activeSubsectionKey} />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

export function WebAnalyticsSectionNav({ activeSubsectionKey }: { activeSubsectionKey: string | undefined }) {
  const { t } = useTranslation();
  return (
    <div className="flex h-full w-60 shrink-0 flex-col gap-0.5 overflow-y-auto border-e border-border/60 bg-card p-3">
      <div className="px-2 pb-3">
        <h2 className="flex items-center gap-2 truncate text-sm font-semibold text-foreground">
          <BarChart3 className="h-4 w-4 shrink-0" />
          {t('nav.webAnalytics' as any)}
        </h2>
        <p className="mt-1 text-[11px] leading-snug text-muted-foreground/80">
          {t('seo.webAnalytics.pageSubtitle' as any)}
        </p>
      </div>
      {WEB_ANALYTICS_NAV.map((item) => (
        item.type === 'leaf'
          ? <SubNavLeafLink key={item.key} leaf={item} active={item.key === activeSubsectionKey} />
          : <SubNavGroup key={item.key} group={item} activeSubsectionKey={activeSubsectionKey} />
      ))}
    </div>
  );
}

