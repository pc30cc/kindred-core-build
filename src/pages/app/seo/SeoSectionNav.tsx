import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { useWorkspacePath } from '@/hooks/useWorkspace';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Badge } from '@/components/ui/badge';
import { SEO_SECTIONS, findSection, firstLeafKey, type SeoNavGroup, type SeoNavLeaf } from './seoNavTree';

function SubNavLeafLink({
  sectionKey, leaf, active,
}: { sectionKey: string; leaf: SeoNavLeaf; active: boolean }) {
  const { t } = useTranslation();
  const wsPath = useWorkspacePath();
  return (
    <Link
      to={wsPath(`/seo/${sectionKey}/${leaf.key}`)}
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

function SubNavGroup({
  sectionKey, group, activeSubsectionKey,
}: { sectionKey: string; group: SeoNavGroup; activeSubsectionKey: string | undefined }) {
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
          <SubNavLeafLink key={child.key} sectionKey={sectionKey} leaf={child} active={child.key === activeSubsectionKey} />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

export function SeoSectionNav({
  activeSectionKey, activeSubsectionKey,
}: { activeSectionKey: string; activeSubsectionKey: string | undefined }) {
  const { t } = useTranslation();
  const wsPath = useWorkspacePath();
  const activeSection = findSection(activeSectionKey);

  return (
    <div className="flex h-full shrink-0">
      {/* Tool switcher — icons + labels */}
      <TooltipProvider delayDuration={150}>
        <nav className="flex w-48 flex-col gap-1 border-e border-border/60 bg-muted/30 p-2 py-3">
          {SEO_SECTIONS.map((s) => {
            const active = s.key === activeSectionKey;
            const Icon = s.icon;
            return (
              <Link
                key={s.key}
                to={wsPath(`/seo/${s.key}/${firstLeafKey(s)}`)}
                className={cn(
                  'flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-sm font-medium transition-colors',
                  active ? 'bg-primary text-primary-foreground shadow-md' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                <Icon className="h-5 w-5 shrink-0" />
                <span className="truncate">{t(s.labelKey as any)}</span>
              </Link>
            );
          })}
        </nav>
      </TooltipProvider>

      {/* Active tool's report list */}
      <div className="flex w-56 flex-col gap-0.5 overflow-y-auto border-e border-border/60 bg-card p-3">
        <div className="px-2 pb-3">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t('seo.title' as any)}</p>
          <p className="mt-1 text-[11px] leading-snug text-muted-foreground/80">{t('seo.subtitle' as any)}</p>
        </div>
        <h3 className="truncate px-2 pb-2 text-sm font-semibold text-foreground">{t(activeSection.labelKey as any)}</h3>

        {activeSection.items.map((item) => (
          item.type === 'leaf'
            ? <SubNavLeafLink key={item.key} sectionKey={activeSection.key} leaf={item} active={item.key === activeSubsectionKey} />
            : <SubNavGroup key={item.key} sectionKey={activeSection.key} group={item} activeSubsectionKey={activeSubsectionKey} />
        ))}
      </div>
    </div>
  );
}
