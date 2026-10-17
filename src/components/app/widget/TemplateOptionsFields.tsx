/**
 * The options of one chat widget template (shared/chatTemplateCatalog.ts),
 * as edited by the Super Admin (the catalog's option defaults) and by a
 * workspace owner (their own widget): Template 1's bottom menu style and
 * labels, quick topics (Templates 1 and 2), and Template 2's example
 * questions. Only the keys the template reads are shown.
 *
 * `value` holds what this level sets; a key it leaves out reads `inherited`
 * (the level above). With `allowReset` a key this level sets can be handed
 * back to the level above ("Use the default"). The server cleans what is
 * saved (rows left empty are dropped), so a row being typed stays in the draft.
 */
import { Box, CreditCard, Gift, HelpCircle, MessageCircle, Plus, Ruler, Tag, Clock, Trash2, Truck, Undo2, type LucideIcon } from 'lucide-react';
import { useTranslation, type TranslationKey } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  CHAT_TEMPLATE_LIMITS,
  CHAT_TEMPLATE_NAV_MODES,
  CHAT_TEMPLATE_NAV_STYLES,
  CHAT_TEMPLATE_TOPIC_ICONS,
  chatTemplateOptionKeys,
  type ChatTemplateOptionKey,
  type ChatTemplateOptions,
  type ChatTemplateTopic,
  type ChatTemplateTopicIcon,
} from '../../../../shared/chatTemplateCatalog';

const TOPIC_ICONS: Record<ChatTemplateTopicIcon, LucideIcon> = {
  truck: Truck,
  return: Undo2,
  ruler: Ruler,
  card: CreditCard,
  box: Box,
  chat: MessageCircle,
  help: HelpCircle,
  gift: Gift,
  clock: Clock,
  tag: Tag,
};

export interface TemplateOptionsFieldsProps {
  templateId: string;
  /** What this level sets. */
  value: ChatTemplateOptions;
  /** What a key this level leaves out reads (the level above). */
  inherited?: ChatTemplateOptions;
  onChange: (next: ChatTemplateOptions) => void;
  disabled?: boolean;
  /** Offer handing a key back to the level above. */
  allowReset?: boolean;
  /** Prefix of the form controls' ids (two editors may be on one page). */
  idPrefix: string;
}

export function TemplateOptionsFields({
  templateId, value, inherited = {}, onChange, disabled, allowReset, idPrefix,
}: TemplateOptionsFieldsProps) {
  const { t } = useTranslation();
  const tk = (key: string, params?: Record<string, string | number>) => t(key as TranslationKey, params);
  const keys = chatTemplateOptionKeys(templateId);
  if (!keys.length) return null;

  const read = <K extends ChatTemplateOptionKey>(key: K): ChatTemplateOptions[K] =>
    (Object.prototype.hasOwnProperty.call(value, key) ? value[key] : inherited[key]);
  const set = <K extends ChatTemplateOptionKey>(key: K, next: ChatTemplateOptions[K]) => onChange({ ...value, [key]: next });
  const reset = (key: ChatTemplateOptionKey) => {
    const next = { ...value };
    delete next[key];
    onChange(next);
  };
  const resetButton = (key: ChatTemplateOptionKey) =>
    allowReset && Object.prototype.hasOwnProperty.call(value, key) ? (
      <Button type="button" variant="link" size="sm" className="h-auto p-0 text-[11px]" disabled={disabled} onClick={() => reset(key)}>
        {t('widgetCatalog.workspace.useDefault')}
      </Button>
    ) : null;

  const topics = (read('topics') ?? []) as ChatTemplateTopic[];
  const setTopic = (index: number, patch: Partial<ChatTemplateTopic>) =>
    set('topics', topics.map((topic, i) => (i === index ? { ...topic, ...patch } : topic)));
  const examples = (read('askExamples') ?? []) as string[];

  return (
    <div className="space-y-4" data-tpl-options={templateId}>
      {keys.includes('navStyle') && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor={`${idPrefix}-nav-style`} className="text-xs font-medium">{t('widgetCatalog.options.navStyle')}</Label>
            {resetButton('navStyle')}
          </div>
          <Select value={read('navStyle') ?? CHAT_TEMPLATE_NAV_STYLES[0]} disabled={disabled} onValueChange={(v) => set('navStyle', v as ChatTemplateOptions['navStyle'])}>
            <SelectTrigger id={`${idPrefix}-nav-style`}><SelectValue /></SelectTrigger>
            <SelectContent>
              {CHAT_TEMPLATE_NAV_STYLES.map((style) => (
                <SelectItem key={style} value={style}>{tk(`widgetCatalog.options.navStyles.${style}`)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {keys.includes('navMode') && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor={`${idPrefix}-nav-mode`} className="text-xs font-medium">{t('widgetCatalog.options.navMode')}</Label>
            {resetButton('navMode')}
          </div>
          <Select value={read('navMode') ?? CHAT_TEMPLATE_NAV_MODES[0]} disabled={disabled} onValueChange={(v) => set('navMode', v as ChatTemplateOptions['navMode'])}>
            <SelectTrigger id={`${idPrefix}-nav-mode`}><SelectValue /></SelectTrigger>
            <SelectContent>
              {CHAT_TEMPLATE_NAV_MODES.map((mode) => (
                <SelectItem key={mode} value={mode}>{tk(`widgetCatalog.options.navModes.${mode}`)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {keys.includes('topics') && (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <Label className="text-xs font-medium">{t('widgetCatalog.options.topics')}</Label>
            {resetButton('topics')}
          </div>
          <p className="text-[11px] text-muted-foreground">{t('widgetCatalog.options.topicsHint', { max: CHAT_TEMPLATE_LIMITS.topics })}</p>
          {topics.map((topic, index) => {
            const n = index + 1;
            return (
              <div key={index} className="flex items-center gap-2" data-topic-row={index}>
                <Select value={topic.icon} disabled={disabled} onValueChange={(icon) => setTopic(index, { icon: icon as ChatTemplateTopicIcon })}>
                  <SelectTrigger className="w-[132px] shrink-0" aria-label={t('widgetCatalog.options.topicIcon', { n })}><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CHAT_TEMPLATE_TOPIC_ICONS.map((icon) => {
                      const Icon = TOPIC_ICONS[icon];
                      return (
                        <SelectItem key={icon} value={icon}>
                          <span className="flex items-center gap-2"><Icon className="h-3.5 w-3.5" />{tk(`widgetCatalog.options.icons.${icon}`)}</span>
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
                <Input
                  value={topic.label}
                  maxLength={CHAT_TEMPLATE_LIMITS.topicLabel}
                  dir="auto"
                  disabled={disabled}
                  aria-label={t('widgetCatalog.options.topicLabel', { n })}
                  placeholder={t('widgetCatalog.options.topicLabel', { n })}
                  onChange={(e) => setTopic(index, { label: e.target.value })}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9 shrink-0"
                  disabled={disabled}
                  aria-label={t('widgetCatalog.options.removeTopic', { n })}
                  onClick={() => set('topics', topics.filter((_, i) => i !== index))}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            );
          })}
          {topics.length < CHAT_TEMPLATE_LIMITS.topics && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled}
              onClick={() => set('topics', [...topics, { label: '', icon: CHAT_TEMPLATE_TOPIC_ICONS[topics.length % CHAT_TEMPLATE_TOPIC_ICONS.length] }])}
            >
              <Plus className="me-1 h-3.5 w-3.5" />{t('widgetCatalog.options.addTopic')}
            </Button>
          )}
        </div>
      )}

      {keys.includes('askExamples') && (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <Label className="text-xs font-medium">{t('widgetCatalog.options.askExamples')}</Label>
            {resetButton('askExamples')}
          </div>
          <p className="text-[11px] text-muted-foreground">{t('widgetCatalog.options.askExamplesHint', { max: CHAT_TEMPLATE_LIMITS.askExamples })}</p>
          {Array.from({ length: CHAT_TEMPLATE_LIMITS.askExamples }, (_, index) => (
            <Input
              key={index}
              value={examples[index] ?? ''}
              maxLength={CHAT_TEMPLATE_LIMITS.askExample}
              dir="auto"
              disabled={disabled}
              aria-label={t('widgetCatalog.options.askExample', { n: index + 1 })}
              placeholder={t('widgetCatalog.options.askExample', { n: index + 1 })}
              onChange={(e) => {
                const next = Array.from({ length: CHAT_TEMPLATE_LIMITS.askExamples }, (_, i) => (i === index ? e.target.value : examples[i] ?? ''));
                while (next.length && !next[next.length - 1]) next.pop();
                set('askExamples', next);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
