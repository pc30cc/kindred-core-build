/**
 * Smart Engagement tab — master switch, rule list and inline editor.
 * Editing a rule opens the scenario studio next to the builder, so the
 * operator always sees the real widget reacting to the real evaluator.
 */
import { useState } from 'react';
import { useTranslation } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { toast } from '@/hooks/use-toast';
import { Copy, Pencil, Plus, Sparkles, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  useSmartRules, useSaveSmartRule, useSetSmartRuleStatus,
  useDeleteSmartRule, useDuplicateSmartRule, useSmartRuleStats,
} from '@/hooks/useSmartRules';
import { createEmptySmartRule, type SmartRuleDraft, type SmartRuleRow } from '@/lib/widget/smartRules';
import { SmartRuleEditor } from './SmartRuleEditor';
import { SmartRulePreviewStudio } from './SmartRulePreviewStudio';
import { AiProactiveNudgeCard } from './AiProactiveNudgeCard';

export interface SmartRulesTabProps {
  workspaceId: string | undefined;
  masterEnabled: boolean;
  onToggleMaster: (enabled: boolean) => void;
  locale: string;
  locales: string[];
  localeLabels: Record<string, string>;
  kbArticles?: { title: string; slug?: string | null }[];
  /** Real widget settings — the studio renders the production preview with them. */
  previewSettings?: Record<string, any> | null;
  brandName?: string;
  studioKbArticles?: { title: string; excerpt?: string | null; content?: string | null }[];
  studioKbCategories?: { name: string; description?: string | null }[];
}

export function SmartRulesTab({
  workspaceId, masterEnabled, onToggleMaster, locale, locales, localeLabels,
  kbArticles, previewSettings, brandName,
  studioKbArticles, studioKbCategories,
}: SmartRulesTabProps) {
  const { t, dir } = useTranslation();
  const { data: rules } = useSmartRules(workspaceId);
  const { data: stats } = useSmartRuleStats(workspaceId);
  const save = useSaveSmartRule(workspaceId);
  const setStatus = useSetSmartRuleStatus(workspaceId);
  const remove = useDeleteSmartRule(workspaceId);
  const duplicate = useDuplicateSmartRule(workspaceId);

  const [draft, setDraft] = useState<SmartRuleDraft | null>(null);


  const handleSave = async (status: 'draft' | 'active') => {
    if (!draft) return;
    try {
      await save.mutateAsync({ ...draft, status });
      toast({ description: t(status === 'active' ? 'widgetPage.smart.published' : 'widgetPage.smart.saved') });
      setDraft(null);
    } catch (err: any) {
      toast({
        variant: 'destructive',
        description: err?.issues?.length
          ? t('widgetPage.smart.validationFailed')
          : err?.message || t('widgetPage.smart.validationFailed'),
      });
    }
  };

  if (draft) {
    return (
      <div className="grid grid-cols-1 gap-6 2xl:grid-cols-[minmax(0,1fr)_minmax(0,560px)]">
        <SmartRuleEditor
          value={draft}
          locales={locales}
          localeLabels={localeLabels}
          kbArticles={kbArticles}
          saving={save.isPending}
          onChange={setDraft}
          onCancel={() => setDraft(null)}
          onSave={handleSave}
        />
        {/* Scenario studio — a simulator, not the generic tab preview. */}
        <div className="min-w-0">
          <div className="sticky top-6">
            <SmartRulePreviewStudio
              draft={draft}
              settings={previewSettings}
              brandName={brandName || ''}
              locale={locale}
              locales={locales}
              localeLabels={localeLabels}
              kbArticles={studioKbArticles}
              kbCategories={studioKbCategories}
            />
          </div>
        </div>
      </div>
    );
  }

  const list = rules || [];

  return (
    <div className="space-y-4" dir={dir}>
      {/* Master switch */}
      <Card className="card-elevated">
        <CardContent className="flex items-center justify-between gap-4 p-4">
          <div className="min-w-0">
            <p className="text-sm font-semibold">{t('widgetPage.smart.masterTitle')}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('widgetPage.smart.masterHint')}</p>
          </div>
          <Switch checked={masterEnabled} onCheckedChange={onToggleMaster} />
        </CardContent>
      </Card>

      {/* AI Proactive Nudge — extends this same Smart Engagement surface, never a second engine. */}
      <AiProactiveNudgeCard workspaceId={workspaceId} smartEngagementEnabled={masterEnabled} />

      {list.length === 0 ? (
        <Card className="card-elevated overflow-hidden">
          <CardContent className="flex flex-col items-center gap-5 p-10 text-center">
            <div className="relative">
              <div className="absolute inset-0 rounded-2xl bg-primary/20 blur-xl" />
              <div className="relative flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <Sparkles className="h-7 w-7" />
              </div>
            </div>
            <div className="max-w-xl space-y-2">
              <h3 className="text-lg font-semibold">{t('widgetPage.smart.title')}</h3>
              <p className="text-sm leading-relaxed text-muted-foreground">{t('widgetPage.smart.description')}</p>
            </div>
            <p className="text-xs text-muted-foreground">{t('widgetPage.smart.noRules')}</p>
            <Button
              className="gap-2 rounded-full px-5"
              onClick={() => setDraft(createEmptySmartRule(locale, Intl.DateTimeFormat().resolvedOptions().timeZone))}
            >
              <Plus className="h-4 w-4" />
              {t('widgetPage.smart.create')}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold">{t('widgetPage.smart.rulesTitle')}</h3>
            <Button
              size="sm"
              className="gap-1.5 rounded-full"
              onClick={() => setDraft(createEmptySmartRule(locale, Intl.DateTimeFormat().resolvedOptions().timeZone))}
            >
              <Plus className="h-3.5 w-3.5" />
              {t('widgetPage.smart.newRule')}
            </Button>
          </div>

          <div className="space-y-2">
            {list.map((rule: SmartRuleRow) => {
              const stat = stats?.[rule.id];
              return (
                <Card key={rule.id} className="card-elevated">
                  <CardContent className="flex flex-wrap items-center gap-3 p-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-sm font-semibold">{rule.name}</p>
                        <Badge
                          variant="outline"
                          className={cn(
                            'text-[10px]',
                            rule.status === 'active' && 'border-success/40 bg-success/10 text-success',
                            rule.status === 'paused' && 'border-warning/40 bg-warning/10 text-warning',
                          )}
                        >
                          {t(`widgetPage.smart.statusLabel.${rule.status}` as any)}
                        </Badge>
                      </div>
                      <p className="mt-1 truncate text-[11px] text-muted-foreground">
                        {t(`widgetPage.smart.trigger.${rule.trigger_config?.type}` as any)}
                        {' · '}
                        {t(`widgetPage.smart.message.modes.${rule.presentation_config?.mode}` as any)}
                      </p>
                      {stat && (
                        <p className="mt-1 flex flex-wrap gap-3 text-[11px] text-muted-foreground">
                          <span>{t('widgetPage.smart.stats.shown')}: {stat.shown}</span>
                          <span>{t('widgetPage.smart.stats.cta')}: {stat.cta}</span>
                          <span>{t('widgetPage.smart.stats.conversations')}: {stat.conversations}</span>
                        </p>
                      )}
                    </div>

                    <div className="flex items-center gap-1">
                      <Switch
                        checked={rule.status === 'active'}
                        onCheckedChange={(v) =>
                          setStatus.mutate(
                            { rule, status: v ? 'active' : 'paused' },
                            {
                              onError: () =>
                                toast({ variant: 'destructive', description: t('widgetPage.smart.validationFailed') }),
                            },
                          )
                        }
                      />
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setDraft({ ...rule })}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => duplicate.mutate(rule)}>
                        <Copy className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost" size="icon" className="h-8 w-8 text-destructive"
                        onClick={() => {
                          if (!window.confirm(t('widgetPage.smart.review.removeConfirm'))) return;
                          remove.mutate(rule.id, {
                            onSuccess: () => toast({ description: t('widgetPage.smart.deleted') }),
                          });
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}