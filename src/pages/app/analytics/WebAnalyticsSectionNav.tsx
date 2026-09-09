import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown } from 'lucide-react';
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
  const [open, setOpen] = useState(hasActiveChild);

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
    <div className="flex w-56 shrink-0 flex-col gap-0.5 overflow-y-auto rounded-s-xl border border-e-0 border-border/60 bg-card p-3">
      <h3 className="truncate px-2 pb-2 text-sm font-semibold text-foreground">{t('nav.webAnalytics' as any)}</h3>
      {WEB_ANALYTICS_NAV.map((item) => (
        item.type === 'leaf'
          ? <SubNavLeafLink key={item.key} leaf={item} active={item.key === activeSubsectionKey} />
          : <SubNavGroup key={item.key} group={item} activeSubsectionKey={activeSubsectionKey} />
      ))}
    </div>
  );
}
