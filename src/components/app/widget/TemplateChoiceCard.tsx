/**
 * Widget → Appearance → Widget template: the workspace owner picks one of the
 * templates the Super Admin keeps enabled, and sets that template's options.
 *
 * The picker shows only when two or more templates are enabled; with a single
 * one the card is there only for that template's own options, if it has any
 * (WidgetPage decides, from GET /api/widget-settings/:workspaceId/templates:
 * templateCardVisible). A plan without the Appearance editor sees the choice
 * disabled, with the upgrade hint. The pick and the options go through the
 * page's draft (the live preview follows at once) and the ordinary settings
 * PATCH.
 */
import * as RadioGroupPrimitive from '@radix-ui/react-radio-group';
import { Check, Info, LayoutTemplate } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { templateDescription, templateDisplayName } from '@/lib/widgetTemplateNames';
import type { WorkspaceWidgetCatalog } from '@/hooks/useWidgetCatalog';
import { TemplateSketch } from './TemplateSketch';
import { TemplateOptionsFields } from './TemplateOptionsFields';
import { chatTemplateOptionKeys, readTemplateOptions, type ChatTemplateOptions } from '../../../../shared/chatTemplateCatalog';

export interface TemplateChoiceCardProps {
  view: WorkspaceWidgetCatalog;
  /** What visitors would wear with the current draft. */
  effectiveId: string;
  /** The drafted choice (null = the default). */
  draftId: string | null | undefined;
  /** The drafted options (widget_template_options). */
  draftOptions: unknown;
  /** The plan allows customising the appearance (widget_appearance). */
  planAllows: boolean;
  onChoose: (id: string) => void;
  onOptionsChange: (next: ChatTemplateOptions) => void;
}

export function TemplateChoiceCard({
  view, effectiveId, draftId, draftOptions, planAllows, onChoose, onOptionsChange,
}: TemplateChoiceCardProps) {
  const { t } = useTranslation();
  const locked = !planAllows || !view.planAllowsChoice;
  // Nothing to choose with a single template: only its options.
  const picker = view.templates.length >= 2;
  const defaultEntry = view.templates.find((tpl) => tpl.id === view.defaultId);
  const defaultName = templateDisplayName(t, view.defaultId, defaultEntry?.name);
  const effective = view.templates.find((tpl) => tpl.id === effectiveId);
  // The stored choice is unavailable, and the owner has not picked another.
  const unavailable = view.selectedUnavailable && (draftId ?? null) === view.selectedId;
  const ownOptions = readTemplateOptions(draftOptions);
  // Keep a row the owner is still typing (the cleaner drops empty rows).
  if (draftOptions && typeof draftOptions === 'object') {
    const raw = draftOptions as ChatTemplateOptions;
    if (Array.isArray(raw.topics)) ownOptions.topics = raw.topics;
    if (Array.isArray(raw.askExamples)) ownOptions.askExamples = raw.askExamples;
  }

  return (
    <Card className="card-elevated" data-tpl-card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <LayoutTemplate className="h-4 w-4 text-primary" /> {t('widgetCatalog.workspace.title')}
        </CardTitle>
        {picker && <CardDescription>{t('widgetCatalog.workspace.description')}</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-4 p-6 pt-0">
        {unavailable && (
          <p className="flex items-start gap-2 rounded-lg bg-warning/10 px-3 py-2 text-xs leading-relaxed text-amber-800 dark:text-amber-300">
            <Info className="mt-px h-3.5 w-3.5 shrink-0" />
            <span>{t('widgetCatalog.workspace.unavailable', { name: defaultName })}</span>
          </p>
        )}
        {picker && (
          <RadioGroupPrimitive.Root
            aria-label={t('widgetCatalog.workspace.title')}
            value={effectiveId}
            disabled={locked}
            onValueChange={onChoose}
            className={cn('grid grid-cols-2 gap-3 sm:grid-cols-3', locked && 'opacity-60')}
          >
            {view.templates.map((tpl) => {
              const selected = tpl.id === effectiveId;
              const name = templateDisplayName(t, tpl.id, tpl.name);
              return (
                <RadioGroupPrimitive.Item
                  key={tpl.id}
                  value={tpl.id}
                  data-tpl-choice={tpl.id}
                  className={cn(
                    'group relative flex flex-col gap-2 rounded-xl border bg-background p-2.5 text-start transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                    'disabled:cursor-not-allowed',
                    selected ? 'border-primary ring-1 ring-primary' : 'border-border hover:border-foreground/25',
                  )}
                >
                  <TemplateSketch id={tpl.id} />
                  <span className="flex items-start gap-2 px-0.5">
                    <span
                      aria-hidden
                      className={cn(
                        'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors',
                        selected ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/40',
                      )}
                    >
                      {selected && <Check className="h-3 w-3" strokeWidth={3} />}
                    </span>
                    <span className="min-w-0">
                      <span className="flex flex-wrap items-center gap-1.5 text-sm font-medium leading-5">
                        {name}
                        {tpl.isDefault && <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">{t('widgetCatalog.workspace.default')}</Badge>}
                      </span>
                      <span className="mt-0.5 hidden text-xs leading-snug text-muted-foreground sm:block">{templateDescription(t, tpl.id)}</span>
                    </span>
                  </span>
                </RadioGroupPrimitive.Item>
              );
            })}
          </RadioGroupPrimitive.Root>
        )}
        {locked && <p className="text-[11px] text-primary">{t('plan.locked.upgradeHint')}</p>}

        {effective && !locked && chatTemplateOptionKeys(effective.id).length > 0 && (
          <div className="space-y-3 rounded-lg border border-border/70 p-3">
            <p className="text-xs font-medium">{t('widgetCatalog.workspace.settings')}</p>
            <TemplateOptionsFields
              templateId={effective.id}
              value={ownOptions}
              inherited={effective.options}
              onChange={onOptionsChange}
              allowReset
              idPrefix="ws-template"
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
