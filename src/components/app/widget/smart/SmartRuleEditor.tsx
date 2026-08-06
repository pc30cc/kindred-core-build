/**
 * Smart Engagement rule editor.
 *
 * A guided, step-based builder rendered inline (never a cramped modal or
 * iframe). Every change is pushed to the parent so the real widget Live
 * Preview updates as the operator types.
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import {
  SMART_ACTIONS, SMART_CONDITION_FIELDS, SMART_FREQUENCY_MODES, SMART_LIMITS,
  SMART_OPERATORS, SMART_PRESENTATIONS, SMART_TRIGGERS, SMART_VARIABLES,
  validateSmartRuleForPublish, type SmartRuleDraft,
} from '@/lib/widget/smartRules';
import { isSafeSmartUrl } from '@/lib/widget/smartEngine';
import { AlertTriangle, ArrowLeft, ArrowRight, Check, Loader2 } from 'lucide-react';

const STEPS = ['trigger', 'audience', 'message', 'schedule', 'review'] as const;
type Step = (typeof STEPS)[number];

const NUMERIC_FIELDS = new Set(['session_page_count']);

const FIELD_CHOICES: Partial<Record<string, string[]>> = {
  device: ['desktop', 'mobile', 'tablet'],
  visitor_type: ['new', 'returning'],
  availability: ['online', 'offline'],
};

export interface SmartRuleEditorProps {
  value: SmartRuleDraft;
  locales: string[];
  localeLabels: Record<string, string>;
  kbArticles?: { title: string; slug?: string | null }[];
  saving?: boolean;
  onChange: (next: SmartRuleDraft) => void;
  onCancel: () => void;
  onSave: (status: 'draft' | 'active') => void;
}

export function SmartRuleEditor({
  value, locales, localeLabels, kbArticles, saving, onChange, onCancel, onSave,
}: SmartRuleEditorProps) {
  const { t, dir } = useTranslation();
  const rtl = dir === 'rtl';
  const [step, setStep] = useState<Step>('trigger');
  const [contentLocale, setContentLocale] = useState(value.content_config.default_locale);

  useEffect(() => {
    if (!value.content_config.locales[contentLocale]) {
      setContentLocale(value.content_config.default_locale);
    }
  }, [value.content_config, contentLocale]);

  const patch = (next: Partial<SmartRuleDraft>) => onChange({ ...value, ...next });
  const patchIn = <K extends keyof SmartRuleDraft>(key: K, next: any) =>
    onChange({ ...value, [key]: { ...(value[key] as any), ...next } });

  const issues = useMemo(
    () => validateSmartRuleForPublish({
      ...value,
      status: 'active',
      id: value.id || '00000000-0000-0000-0000-000000000000',
      workspace_id: value.workspace_id || '00000000-0000-0000-0000-000000000000',
    }),
    [value],
  );

  const content = value.content_config.locales[contentLocale]
    || { title: '', body: '', cta_label: '' };
  const setContent = (nextPart: Partial<typeof content>) =>
    patchIn('content_config', {
      locales: { ...value.content_config.locales, [contentLocale]: { ...content, ...nextPart } },
    });

  const stepIndex = STEPS.indexOf(step);

  return (
    <Card className="card-elevated overflow-hidden" dir={dir}>
      <div className="flex flex-wrap items-center gap-2 border-b border-border/70 bg-secondary/30 p-3">
        {STEPS.map((s, i) => (
          <button
            key={s}
            type="button"
            onClick={() => setStep(s)}
            className={cn(
              'flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
              step === s ? 'bg-primary text-primary-foreground shadow-sm' : 'bg-background/70 hover:bg-background',
            )}
          >
            <span className="grid h-4 w-4 place-items-center rounded-full bg-black/10 text-[10px]">{i + 1}</span>
            {t(`widgetPage.smart.steps.${s}` as any)}
          </button>
        ))}
      </div>

      <CardContent className="space-y-5 p-5">
        {/* Name + priority are always visible — they identify the rule. */}
        <div className="grid gap-4 sm:grid-cols-[1fr_140px]">
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">{t('widgetPage.smart.fields.name')}</Label>
            <Input
              value={value.name}
              placeholder={t('widgetPage.smart.fields.namePlaceholder')}
              maxLength={SMART_LIMITS.maxNameLength}
              onChange={(e) => patch({ name: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">{t('widgetPage.smart.fields.priority')}</Label>
            <Input
              type="number" min={0} max={1000} dir="ltr"
              value={value.priority}
              onChange={(e) => patch({ priority: Math.max(0, Math.min(1000, Number(e.target.value) || 0)) })}
            />
          </div>
        </div>

        {step === 'trigger' && (
          <section className="space-y-4">
            <h4 className="text-sm font-semibold">{t('widgetPage.smart.trigger.title')}</h4>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {SMART_TRIGGERS.map((type) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => patchIn('trigger_config', {
                    type,
                    seconds: type === 'time_on_page' ? (value.trigger_config.seconds || 20)
                      : type === 'inactivity' ? (value.trigger_config.seconds || 30) : undefined,
                    percent: type === 'scroll_depth' ? (value.trigger_config.percent || 50) : undefined,
                  })}
                  className={cn(
                    'rounded-xl border p-3 text-start text-xs font-medium transition-all',
                    value.trigger_config.type === type
                      ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
                      : 'border-border/70 hover:border-primary/40',
                  )}
                >
                  {t(`widgetPage.smart.trigger.${type}` as any)}
                </button>
              ))}
            </div>
            {(value.trigger_config.type === 'time_on_page' || value.trigger_config.type === 'inactivity') && (
              <div className="max-w-[200px] space-y-1.5">
                <Label className="text-xs">{t('widgetPage.smart.trigger.seconds')}</Label>
                <Input
                  type="number" min={1} max={3600} dir="ltr"
                  value={value.trigger_config.seconds ?? 20}
                  onChange={(e) => patchIn('trigger_config', { seconds: Number(e.target.value) || 1 })}
                />
              </div>
            )}
            {value.trigger_config.type === 'scroll_depth' && (
              <div className="max-w-[200px] space-y-1.5">
                <Label className="text-xs">{t('widgetPage.smart.trigger.percent')}</Label>
                <Input
                  type="number" min={1} max={100} dir="ltr"
                  value={value.trigger_config.percent ?? 50}
                  onChange={(e) => patchIn('trigger_config', { percent: Number(e.target.value) || 1 })}
                />
              </div>
            )}
            {value.trigger_config.type === 'exit_intent' && (
              <p className="flex items-start gap-2 rounded-lg bg-muted/60 p-3 text-[11px] text-muted-foreground">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {t('widgetPage.smart.trigger.exitHint')}
              </p>
            )}
          </section>
        )}

        {step === 'audience' && (
          <section className="space-y-4">
            <h4 className="text-sm font-semibold">{t('widgetPage.smart.audience.title')}</h4>
            <Select
              value={value.audience_config.match}
              onValueChange={(v) => patchIn('audience_config', { match: v })}
            >
              <SelectTrigger className="max-w-[260px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('widgetPage.smart.audience.matchAll')}</SelectItem>
                <SelectItem value="any">{t('widgetPage.smart.audience.matchAny')}</SelectItem>
              </SelectContent>
            </Select>

            {value.audience_config.conditions.length === 0 && (
              <p className="rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
                {t('widgetPage.smart.audience.empty')}
              </p>
            )}

            <div className="space-y-2">
              {value.audience_config.conditions.map((cond, index) => {
                const choices = FIELD_CHOICES[cond.field];
                const update = (next: Partial<typeof cond>) => {
                  const list = value.audience_config.conditions.slice();
                  list[index] = { ...cond, ...next };
                  patchIn('audience_config', { conditions: list });
                };
                return (
                  <div key={index} className="flex flex-wrap items-center gap-2 rounded-xl border border-border/70 bg-background/60 p-2">
                    <Select value={cond.field} onValueChange={(v) => update({ field: v as any, value: '' })}>
                      <SelectTrigger className="h-9 w-[190px] text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {SMART_CONDITION_FIELDS.map((f) => (
                          <SelectItem key={f} value={f}>{t(`widgetPage.smart.audience.fields.${f}` as any)}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select value={cond.operator} onValueChange={(v) => update({ operator: v as any })}>
                      <SelectTrigger className="h-9 w-[150px] text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {SMART_OPERATORS
                          .filter((op) => NUMERIC_FIELDS.has(cond.field) ? true : op !== 'gt' && op !== 'lt')
                          .map((op) => (
                            <SelectItem key={op} value={op}>{t(`widgetPage.smart.audience.operators.${op}` as any)}</SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                    {choices ? (
                      <Select value={cond.value} onValueChange={(v) => update({ value: v })}>
                        <SelectTrigger className="h-9 min-w-[150px] flex-1 text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {choices.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Input
                        className="h-9 min-w-[150px] flex-1 text-xs"
                        dir="ltr"
                        value={cond.value}
                        onChange={(e) => update({ value: e.target.value })}
                      />
                    )}
                    <Button
                      variant="ghost" size="sm" className="h-9 text-xs text-destructive"
                      onClick={() => patchIn('audience_config', {
                        conditions: value.audience_config.conditions.filter((_, i) => i !== index),
                      })}
                    >
                      ×
                    </Button>
                  </div>
                );
              })}
            </div>

            <Button
              variant="outline" size="sm" className="rounded-full text-xs"
              disabled={value.audience_config.conditions.length >= SMART_LIMITS.maxConditionsPerGroup}
              onClick={() => patchIn('audience_config', {
                conditions: [...value.audience_config.conditions, { field: 'page_path', operator: 'contains', value: '' }],
              })}
            >
              {t('widgetPage.smart.audience.addCondition')}
            </Button>
          </section>
        )}

        {step === 'message' && (
          <section className="space-y-4">
            <h4 className="text-sm font-semibold">{t('widgetPage.smart.message.title')}</h4>

            <div className="space-y-1.5">
              <Label className="text-xs">{t('widgetPage.smart.message.presentation')}</Label>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {SMART_PRESENTATIONS.map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => patchIn('presentation_config', { mode })}
                    className={cn(
                      'rounded-xl border p-3 text-start text-xs font-medium transition-all',
                      value.presentation_config.mode === mode
                        ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
                        : 'border-border/70 hover:border-primary/40',
                    )}
                  >
                    {t(`widgetPage.smart.message.modes.${mode}` as any)}
                  </button>
                ))}
              </div>
            </div>

            {locales.length > 1 && (
              <div className="flex flex-wrap gap-1.5">
                {locales.map((loc) => (
                  <button
                    key={loc}
                    type="button"
                    onClick={() => {
                      if (!value.content_config.locales[loc]) {
                        patchIn('content_config', {
                          locales: { ...value.content_config.locales, [loc]: { title: '', body: '', cta_label: '' } },
                        });
                      }
                      setContentLocale(loc);
                    }}
                    className={cn(
                      'rounded-full px-3 py-1 text-xs font-medium transition-colors',
                      contentLocale === loc ? 'bg-primary text-primary-foreground' : 'bg-secondary hover:bg-secondary/70',
                    )}
                  >
                    {localeLabels[loc] || loc}
                  </button>
                ))}
              </div>
            )}

            <div className="space-y-1.5">
              <Label className="text-xs">{t('widgetPage.smart.message.heading')}</Label>
              <Input
                value={content.title || ''}
                maxLength={SMART_LIMITS.maxTitleLength}
                onChange={(e) => setContent({ title: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t('widgetPage.smart.message.body')}</Label>
              <Textarea
                rows={3}
                value={content.body || ''}
                maxLength={SMART_LIMITS.maxBodyLength}
                onChange={(e) => setContent({ body: e.target.value })}
              />
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] text-muted-foreground">{t('widgetPage.smart.message.variables')}:</span>
                {SMART_VARIABLES.map((v) => (
                  <button
                    key={v}
                    type="button"
                    className="rounded-md bg-secondary px-2 py-0.5 font-mono text-[10px] hover:bg-secondary/70"
                    onClick={() => setContent({ body: `${content.body || ''}{{${v}}}` })}
                  >
                    {`{{${v}}}`}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground">{t('widgetPage.smart.message.variablesHint')}</p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-xs">{t('widgetPage.smart.message.cta')}</Label>
                <Input
                  value={content.cta_label || ''}
                  maxLength={SMART_LIMITS.maxCtaLength}
                  onChange={(e) => setContent({ cta_label: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">{t('widgetPage.smart.message.action')}</Label>
                <Select
                  value={value.presentation_config.action}
                  onValueChange={(v) => patchIn('presentation_config', { action: v })}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {SMART_ACTIONS.map((a) => (
                      <SelectItem key={a} value={a}>{t(`widgetPage.smart.message.actions.${a}` as any)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {value.presentation_config.action === 'open_url' && (
              <div className="space-y-1.5">
                <Label className="text-xs">{t('widgetPage.smart.message.url')}</Label>
                <Input
                  dir="ltr" placeholder="https://"
                  value={value.presentation_config.url || ''}
                  onChange={(e) => patchIn('presentation_config', { url: e.target.value })}
                />
                {!!value.presentation_config.url && !isSafeSmartUrl(value.presentation_config.url) && (
                  <p className="text-[11px] text-destructive">{t('widgetPage.smart.message.urlInvalid')}</p>
                )}
                <div className="flex items-center justify-between rounded-lg border border-border/70 p-2.5">
                  <span className="text-xs">{t('widgetPage.smart.message.newTab')}</span>
                  <Switch
                    checked={value.presentation_config.open_in_new_tab !== false}
                    onCheckedChange={(v) => patchIn('presentation_config', { open_in_new_tab: v })}
                  />
                </div>
              </div>
            )}

            {value.presentation_config.action === 'open_article' && (
              <div className="space-y-1.5">
                <Label className="text-xs">{t('widgetPage.smart.message.article')}</Label>
                <Select
                  value={value.presentation_config.article_slug || ''}
                  onValueChange={(v) => patchIn('presentation_config', { article_slug: v })}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(kbArticles || []).filter((a) => a.slug).map((a) => (
                      <SelectItem key={a.slug!} value={a.slug!}>{a.title}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="flex items-center justify-between rounded-lg border border-border/70 p-2.5">
              <span className="text-xs">{t('widgetPage.smart.message.dismissible')}</span>
              <Switch
                checked={value.presentation_config.dismissible !== false}
                onCheckedChange={(v) => patchIn('presentation_config', { dismissible: v })}
              />
            </div>
          </section>
        )}

        {step === 'schedule' && (
          <section className="space-y-4">
            <h4 className="text-sm font-semibold">{t('widgetPage.smart.schedule.title')}</h4>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-xs">{t('widgetPage.smart.schedule.startAt')}</Label>
                <Input
                  type="datetime-local" dir="ltr"
                  value={toLocalInput(value.schedule_config.start_at)}
                  onChange={(e) => patchIn('schedule_config', { start_at: fromLocalInput(e.target.value) })}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">{t('widgetPage.smart.schedule.endAt')}</Label>
                <Input
                  type="datetime-local" dir="ltr"
                  value={toLocalInput(value.schedule_config.end_at)}
                  onChange={(e) => patchIn('schedule_config', { end_at: fromLocalInput(e.target.value) })}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">{t('widgetPage.smart.schedule.timeFrom')}</Label>
                <Input
                  type="time" dir="ltr"
                  value={value.schedule_config.time_from || ''}
                  onChange={(e) => patchIn('schedule_config', { time_from: e.target.value || null })}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">{t('widgetPage.smart.schedule.timeTo')}</Label>
                <Input
                  type="time" dir="ltr"
                  value={value.schedule_config.time_to || ''}
                  onChange={(e) => patchIn('schedule_config', { time_to: e.target.value || null })}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">{t('widgetPage.smart.schedule.weekdays')}</Label>
              <div className="flex flex-wrap gap-1.5">
                {[0, 1, 2, 3, 4, 5, 6].map((day) => {
                  const active = (value.schedule_config.weekdays || []).includes(day);
                  return (
                    <button
                      key={day}
                      type="button"
                      onClick={() => {
                        const list = value.schedule_config.weekdays || [];
                        patchIn('schedule_config', {
                          weekdays: active ? list.filter((d) => d !== day) : [...list, day],
                        });
                      }}
                      className={cn(
                        'h-8 min-w-[46px] rounded-full px-2 text-[11px] font-medium transition-colors',
                        active ? 'bg-primary text-primary-foreground' : 'bg-secondary hover:bg-secondary/70',
                      )}
                    >
                      {weekdayLabel(day, dir)}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-xs">{t('widgetPage.smart.schedule.frequency')}</Label>
                <Select
                  value={value.frequency_config.mode}
                  onValueChange={(v) => patchIn('frequency_config', { mode: v })}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {SMART_FREQUENCY_MODES.map((m) => (
                      <SelectItem key={m} value={m}>{t(`widgetPage.smart.schedule.modes.${m}` as any)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {(value.frequency_config.mode === 'max_per_day' || value.frequency_config.mode === 'max_per_week') && (
                <div className="space-y-1.5">
                  <Label className="text-xs">{t('widgetPage.smart.schedule.count')}</Label>
                  <Input
                    type="number" min={1} max={50} dir="ltr"
                    value={value.frequency_config.count ?? 1}
                    onChange={(e) => patchIn('frequency_config', { count: Number(e.target.value) || 1 })}
                  />
                </div>
              )}
              {value.frequency_config.mode === 'cooldown_hours' && (
                <div className="space-y-1.5">
                  <Label className="text-xs">{t('widgetPage.smart.schedule.hours')}</Label>
                  <Input
                    type="number" min={1} max={720} dir="ltr"
                    value={value.frequency_config.hours ?? 24}
                    onChange={(e) => patchIn('frequency_config', { hours: Number(e.target.value) || 1 })}
                  />
                </div>
              )}
            </div>

            <div className="space-y-2">
              <Label className="text-xs">{t('widgetPage.smart.schedule.behavior')}</Label>
              {([
                ['stop_after_dismiss', 'stopDismiss'],
                ['stop_after_cta', 'stopCta'],
                ['stop_after_widget_open', 'stopOpen'],
                ['stop_after_conversation', 'stopConversation'],
                ['stop_after_visitor_reply', 'stopReply'],
              ] as const).map(([key, label]) => (
                <div key={key} className="flex items-center justify-between rounded-lg border border-border/70 p-2.5">
                  <span className="text-xs">{t(`widgetPage.smart.schedule.${label}` as any)}</span>
                  <Switch
                    checked={(value.behavior_config as any)[key] !== false}
                    onCheckedChange={(v) => patchIn('behavior_config', { [key]: v })}
                  />
                </div>
              ))}
              <div className="flex items-center justify-between rounded-lg border border-border/70 p-2.5">
                <span className="text-xs">{t('widgetPage.smart.schedule.mobile')}</span>
                <Switch
                  checked={value.behavior_config.mobile_enabled !== false}
                  onCheckedChange={(v) => patchIn('behavior_config', { mobile_enabled: v })}
                />
              </div>
              <div className="flex items-center justify-between gap-3 rounded-lg border border-border/70 p-2.5">
                <span className="text-xs">{t('widgetPage.smart.schedule.offline')}</span>
                <Select
                  value={value.behavior_config.offline_mode || 'show'}
                  onValueChange={(v) => patchIn('behavior_config', { offline_mode: v })}
                >
                  <SelectTrigger className="h-8 w-[160px] text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="show">{t('widgetPage.smart.schedule.offlineShow')}</SelectItem>
                    <SelectItem value="hide">{t('widgetPage.smart.schedule.offlineHide')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </section>
        )}

        {step === 'review' && (
          <section className="space-y-4">
            <h4 className="text-sm font-semibold">{t('widgetPage.smart.review.title')}</h4>
            <div className="rounded-xl border border-border/70 bg-secondary/30 p-4 text-xs leading-relaxed">
              <p className="font-medium">{value.name || t('widgetPage.smart.fields.namePlaceholder')}</p>
              <p className="mt-1 text-muted-foreground">
                {t(`widgetPage.smart.trigger.${value.trigger_config.type}` as any)}
                {' · '}
                {t(`widgetPage.smart.message.modes.${value.presentation_config.mode}` as any)}
                {' · '}
                {t(`widgetPage.smart.schedule.modes.${value.frequency_config.mode}` as any)}
              </p>
            </div>
            {issues.length > 0 && (
              <div className="space-y-1.5 rounded-xl border border-destructive/30 bg-destructive/5 p-4">
                <p className="text-xs font-semibold text-destructive">{t('widgetPage.smart.review.issues')}</p>
                <ul className="list-inside list-disc text-[11px] text-destructive/90">
                  {issues.slice(0, 8).map((issue, i) => (
                    <li key={i}><span className="font-mono">{issue.path}</span> — {issue.message}</li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        )}

        {/* Footer navigation + save actions */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/70 pt-4">
          <Button variant="ghost" size="sm" onClick={onCancel}>{t('common.cancel')}</Button>
          <div className="flex flex-wrap items-center gap-2">
            {stepIndex > 0 && (
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setStep(STEPS[stepIndex - 1])}>
                {rtl ? <ArrowRight className="h-3.5 w-3.5" /> : <ArrowLeft className="h-3.5 w-3.5" />}
              </Button>
            )}
            {stepIndex < STEPS.length - 1 && (
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setStep(STEPS[stepIndex + 1])}>
                {rtl ? <ArrowLeft className="h-3.5 w-3.5" /> : <ArrowRight className="h-3.5 w-3.5" />}
              </Button>
            )}
            <Button variant="secondary" size="sm" disabled={saving} onClick={() => onSave('draft')}>
              {saving && <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" />}
              {t('widgetPage.smart.review.saveDraft')}
            </Button>
            <Button size="sm" disabled={saving || issues.length > 0} onClick={() => onSave('active')}>
              <Check className="me-1.5 h-3.5 w-3.5" />
              {t('widgetPage.smart.review.publish')}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function toLocalInput(iso?: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return isNaN(date.getTime()) ? null : date.toISOString();
}

const WEEKDAYS: Record<string, string[]> = {
  ltr: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  rtl: ['یکشنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنجشنبه', 'جمعه', 'شنبه'],
};

function weekdayLabel(day: number, dir: string): string {
  const list = dir === 'rtl' ? WEEKDAYS.rtl : WEEKDAYS.ltr;
  return list[day] || String(day);
}