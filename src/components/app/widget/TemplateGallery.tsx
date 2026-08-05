import { useMemo } from 'react';
import { useTranslation } from '@/i18n';
import { useWorkspaceWidgetTemplates } from '@/hooks/useWorkspaceWidgetTemplates';
import type { WidgetTemplate } from '@/lib/widget-templates-api';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Check, MessageSquare, Sparkles, Star } from 'lucide-react';
import { cn } from '@/lib/utils';

interface TemplateGalleryProps {
  /** Currently selected template slug (workspace value). */
  selectedSlug: string | null | undefined;
  /** Primary color used to tint preview thumbnails. */
  primaryColor: string;
  /** Brand label shown in the preview header. */
  brandLabel: string;
  /** Persists the new selection. */
  onSelect: (slug: string) => void;
  /** Marks the slug as the workspace's default (same call as onSelect for now). */
  onMakeDefault?: (slug: string) => void;
  /** True while a template selection is being persisted. */
  saving?: boolean;
}

/**
 * Mini visual preview of a template. We don't load the real widget runtime
 * here — that would be too heavy for a gallery. Instead we render a faithful
 * static mock that mirrors the runtime's structure (header, bubbles, input).
 * Future templates can supply their own preview shape via `metadata.preview`.
 */
function TemplateThumb({
  template,
  primaryColor,
  brandLabel,
}: {
  template: WidgetTemplate;
  primaryColor: string;
  brandLabel: string;
}) {
  const { t } = useTranslation();
  const sampleMessage = t('widgetPage.preview.sampleMessage');
  const sampleReply = t('widgetPage.preview.sampleReply');
  const sampleOnline = t('widgetPage.preview.onlineNow');
  // Per-template visual variants — each slug renders a faithful mini-mock
  // that mirrors what the visitor will actually see.
  const slug = template.slug;
  const tplPrimary =
    (template.metadata as any)?.primary ||
    (slug === 'template2' ? '#0066ff' : primaryColor);

  // Variant: template2 — curved blue header, rounded 16px panel, pill input
  if (slug === 'template2') {
    const grad = `linear-gradient(160deg, #0052ff 0%, ${tplPrimary} 50%, #2b86ff 100%)`;
    return (
      <div className="relative aspect-[4/3] w-full overflow-hidden rounded-md bg-muted/40 border border-border">
        <div className="absolute inset-0 p-2 space-y-1.5">
          <div className="h-2 w-3/5 bg-muted rounded" />
          <div className="h-1.5 w-full bg-muted/70 rounded" />
          <div className="h-1.5 w-4/5 bg-muted/70 rounded" />
          <div className="h-10 w-full bg-muted/40 rounded mt-1.5" />
        </div>
        <div
          className="absolute right-2 bottom-7 w-[60%] overflow-hidden bg-white border border-black/5"
          style={{ height: '66%', borderRadius: 12, boxShadow: '0 12px 24px -6px rgba(0,82,255,0.32), 0 4px 10px -2px rgba(0,0,0,0.10)' }}
        >
          <div className="relative px-2 pt-2 pb-3" style={{ background: grad }}>
            <div className="text-white text-[8px] font-bold truncate">{brandLabel}</div>
            <div className="text-white/80 text-[6.5px] mt-0.5">{sampleOnline}</div>
            <div
              className="absolute left-0 right-0 -bottom-px h-2 bg-white"
              style={{ borderTopLeftRadius: 10, borderTopRightRadius: 10 }}
            />
          </div>
          <div className="p-1.5 space-y-1 pt-2">
            <div className="rounded-[8px] px-1.5 py-1 text-[7px] text-foreground bg-muted max-w-[88%]" style={{ borderBottomLeftRadius: 3 }}>
              {sampleMessage}
            </div>
            <div
              className="rounded-[8px] px-1.5 py-1 text-[7px] text-white max-w-[78%] ms-auto"
              style={{ background: tplPrimary, borderBottomRightRadius: 3, boxShadow: '0 2px 6px rgba(0,82,255,0.25)' }}
            >
              {sampleReply}
            </div>
          </div>
          <div className="absolute bottom-0 inset-x-0 border-t border-border bg-white px-1.5 py-1">
            <div className="bg-muted h-2" style={{ borderRadius: 999 }} />
          </div>
        </div>
        <div
          className="absolute right-2 bottom-1.5 h-5 w-5 rounded-full flex items-center justify-center"
          style={{ background: grad, boxShadow: '0 8px 16px -4px rgba(0,82,255,0.55), 0 3px 6px rgba(0,0,0,0.16)' }}
        >
          <MessageSquare className="h-2.5 w-2.5 text-white" />
        </div>
      </div>
    );
  }

  // Default variant — classic rounded panel
  const previewKind = (template.metadata as any)?.preview?.kind || 'default';
  return (
    <div className="relative aspect-[4/3] w-full overflow-hidden rounded-md bg-muted/40 border border-border">
      <div className="absolute inset-0 p-2 space-y-1.5">
        <div className="h-2 w-3/5 bg-muted rounded" />
        <div className="h-1.5 w-full bg-muted/70 rounded" />
        <div className="h-1.5 w-4/5 bg-muted/70 rounded" />
        <div className="h-10 w-full bg-muted/40 rounded mt-1.5" />
      </div>
      <div
        className="absolute right-2 bottom-7 w-[58%] rounded-md shadow-md overflow-hidden bg-card border border-border"
        style={{ height: '64%' }}
      >
        <div
          className="px-2 py-1.5 text-white text-[8px] font-semibold truncate"
          style={{ background: tplPrimary }}
        >
          {brandLabel}
        </div>
        <div className="p-1.5 space-y-1">
          <div className="bg-muted rounded px-1.5 py-1 text-[7px] text-muted-foreground max-w-[90%]">
            {sampleMessage}
          </div>
          {previewKind !== 'minimal' && (
            <div
              className="rounded px-1.5 py-1 text-[7px] text-white max-w-[80%] ms-auto"
              style={{ background: tplPrimary }}
            >
              {sampleReply}
            </div>
          )}
        </div>
        <div className="absolute bottom-0 inset-x-0 border-t border-border bg-card px-1.5 py-1">
          <div className="bg-muted rounded-full h-2" />
        </div>
      </div>
      <div
        className="absolute right-2 bottom-1.5 h-4 w-4 rounded-full flex items-center justify-center shadow"
        style={{ background: tplPrimary }}
      >
        <MessageSquare className="h-2 w-2 text-white" />
      </div>
    </div>
  );
}

export function TemplateGallery({
  selectedSlug,
  primaryColor,
  brandLabel,
  onSelect,
  saving,
}: TemplateGalleryProps) {
  const { t, dir } = useTranslation();
  const { data: templates, isLoading, error } = useWorkspaceWidgetTemplates();

  // Always guarantee 'default' is selectable, even if the platform admin
  // somehow excluded it from the listing — runtime fallback is 'default'.
  const list = useMemo(() => {
    const arr = templates ? [...templates] : [];
    if (!arr.some((t) => t.slug === 'default')) {
      arr.unshift({
        id: 'builtin-default',
        slug: 'default',
        name: t('widgetPage.template.defaultName'),
        description: t('widgetPage.template.defaultDescription'),
        status: 'active',
        enabled: true,
        is_builtin: true,
        sort_order: 0,
        metadata: {},
        created_at: '',
        updated_at: '',
      });
    }
    return arr;
  }, [templates, t]);

  const activeSlug = selectedSlug || 'default';

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
        {(error as Error).message}
      </div>
    );
  }

  return (
    <div className="space-y-3" dir={dir}>
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium">{t('widgetPage.template.heading')}</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t('widgetPage.template.description')}
          </p>
        </div>
        <Badge variant="outline" className="text-[10px]">
          {t('widgetPage.template.available', { count: String(list.length) })}
        </Badge>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {list.map((tpl) => {
          const isActive = tpl.slug === activeSlug;
          return (
            <Card
              key={tpl.slug}
              className={cn(
                'relative p-3 cursor-pointer transition-all hover:shadow-md',
                isActive
                  ? 'border-primary ring-2 ring-primary/30'
                  : 'border-border hover:border-primary/40',
              )}
              onClick={() => !saving && !isActive && onSelect(tpl.slug)}
            >
              {isActive && (
                <div className="absolute top-2 end-2 z-10">
                  <Badge className="gap-1 text-[10px] bg-primary text-primary-foreground border-transparent">
                    <Check className="h-2.5 w-2.5" /> {t('widgetPage.template.active')}
                  </Badge>
                </div>
              )}

              <TemplateThumb template={tpl} primaryColor={primaryColor} brandLabel={brandLabel} />

              <div className="mt-3 space-y-1">
                <div className="flex items-center gap-1.5">
                  <h4 className="text-sm font-medium leading-none">{tpl.name}</h4>
                  {tpl.is_builtin && (
                    <Badge variant="outline" className="text-[9px] gap-0.5">
                      <Star className="h-2 w-2" /> {t('widgetPage.template.builtin')}
                    </Badge>
                  )}
                  {tpl.status === 'beta' && (
                    <Badge variant="outline" className="text-[9px] gap-0.5 border-primary/40 text-primary">
                      <Sparkles className="h-2 w-2" /> {t('widgetPage.template.beta')}
                    </Badge>
                  )}
                </div>
                {tpl.description && (
                  <p className="text-[11px] text-muted-foreground line-clamp-2">{tpl.description}</p>
                )}
              </div>

              <div className="mt-3 flex items-center gap-2">
                <Button
                  size="sm"
                  variant={isActive ? 'secondary' : 'default'}
                  className="h-7 text-[11px] flex-1"
                  disabled={isActive || saving}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelect(tpl.slug);
                  }}
                >
                  {isActive ? t('widgetPage.template.inUse') : t('widgetPage.template.use')}
                </Button>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}