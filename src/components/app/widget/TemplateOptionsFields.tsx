/**
 * The options of one chat widget template (shared/chatTemplateCatalog.ts),
 * as edited by the Super Admin (the catalog's option defaults) and by a
 * workspace owner (their own widget): Template 1's bottom menu style and
 * labels and its pre-chat form, quick topics (Templates 1 and 2), Template 2's
 * example questions and rating after a chat, the transcript by email
 * (Templates 1 and 2; hidden while visitor email is switched off,
 * shared/visitorEmail.ts), and the International templates' logo direction.
 * Only the keys the template reads are shown.
 *
 * `value` holds what this level sets; a key it leaves out reads `inherited`
 * (the level above). With `allowReset` a key this level sets can be handed
 * back to the level above ("Use the default"). The server cleans what is
 * saved (rows left empty are dropped), so a row being typed stays in the draft.
 */
import type { ReactElement } from 'react';
import { Box, CreditCard, Gift, HelpCircle, MessageCircle, Plus, Ruler, Tag, Clock, Trash2, Truck, Undo2, type LucideIcon } from 'lucide-react';
import { useTranslation, type TranslationKey } from '@/i18n';
import { toPersianDigits } from '@/lib/persian-digits';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import {
  CHAT_TEMPLATE_LIMITS,
  CHAT_TEMPLATE_LOGO_DIRECTIONS,
  CHAT_TEMPLATE_NAV_MODES,
  CHAT_TEMPLATE_NAV_STYLES,
  CHAT_TEMPLATE_PRECHAT_MODES,
  CHAT_TEMPLATE_TOPIC_ICONS,
  chatTemplateOptionKeys,
  type ChatTemplateLogoDirection,
  type ChatTemplateOptionKey,
  type ChatTemplateOptions,
  type ChatTemplateTopic,
  type ChatTemplateTopicIcon,
} from '../../../../shared/chatTemplateCatalog';
import { VISITOR_EMAIL_FEATURES_ENABLED } from '../../../../shared/visitorEmail';

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

/**
 * The brand kit's chat button glyph of each logo direction, on its Ink
 * ground (what the visitor's chat button shows): two message pills, or a
 * bubble and a dot.
 */
const LOGO_GLYPHS: Record<ChatTemplateLogoDirection, ReactElement> = {
  thread: (
    <svg viewBox="0 0 104 92" className="h-3.5 w-3.5" aria-hidden>
      <path fill="#fff" d="M21 0H41A21 21 0 0 1 62 21V21A21 21 0 0 1 41 42H4A4 4 0 0 1 0 38V21A21 21 0 0 1 21 0Z" />
      <path fill="#FF5A3C" d="M43 50H83A21 21 0 0 1 104 71V88A4 4 0 0 1 100 92H43A21 21 0 0 1 22 71V71A21 21 0 0 1 43 50Z" />
    </svg>
  ),
  open: (
    <svg viewBox="0 0 108 108" className="h-3.5 w-3.5" aria-hidden>
      <path fill="#fff" d="M41 0A41 41 0 0 1 82 41L82 78Q82 82 78 82L41 82A41 41 0 0 1 0 41A41 41 0 0 1 41 0Z" />
      <circle fill="#FF5A3C" cx="96" cy="96" r="12" />
    </svg>
  ),
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
  const { t, locale } = useTranslation();
  const tk = (key: string, params?: Record<string, string | number>) => t(key as TranslationKey, params);
  // A row number in a placeholder or a label: attributes are not converted
  // by the Persian digits layer, so it is written in the dashboard's digits here.
  const num = (n: number) => (locale === 'fa' ? toPersianDigits(String(n)) : n);
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
  // Only the floating dock (vb) draws the label modes; the other bars keep
  // their own labels (the design's brief §7a), so there a mode other than
  // "No menu" changes nothing and is shown as what the widget draws.
  const dock = (read('navStyle') ?? CHAT_TEMPLATE_NAV_STYLES[0]) === 'vb';
  const savedMode = read('navMode') ?? CHAT_TEMPLATE_NAV_MODES[0];
  const navMode = dock || savedMode === 'none' ? savedMode : CHAT_TEMPLATE_NAV_MODES[0];

  // An on/off option (both default on): label and hint, the switch, the reset.
  const toggle = (key: 'csat' | 'transcriptEmail', id: string) => (
    <div className="flex items-start justify-between gap-3" data-tpl-toggle={key}>
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-${id}`} className="text-xs font-medium">{tk(`widgetCatalog.options.${key}`)}</Label>
        <p className="text-[11px] text-muted-foreground">{tk(`widgetCatalog.options.${key}Hint`)}</p>
        {resetButton(key)}
      </div>
      <Switch id={`${idPrefix}-${id}`} checked={read(key) !== false} disabled={disabled} onCheckedChange={(on) => set(key, on)} />
    </div>
  );

  const logoDirection = read('logoDirection') ?? CHAT_TEMPLATE_LOGO_DIRECTIONS[0];

  return (
    <div className="space-y-4" data-tpl-options={templateId}>
      {keys.includes('logoDirection') && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <Label id={`${idPrefix}-logo-direction`} className="text-xs font-medium">{t('widgetCatalog.options.logoDirection')}</Label>
            {resetButton('logoDirection')}
          </div>
          <div role="radiogroup" aria-labelledby={`${idPrefix}-logo-direction`} className="grid grid-cols-2 gap-2" data-logo-direction={logoDirection}>
            {CHAT_TEMPLATE_LOGO_DIRECTIONS.map((direction) => (
              <button
                key={direction}
                type="button"
                role="radio"
                aria-checked={logoDirection === direction}
                disabled={disabled}
                data-logo-direction-option={direction}
                onClick={() => set('logoDirection', direction)}
                className={cn(
                  'flex items-center gap-2 rounded-lg border p-2 text-start text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-60',
                  logoDirection === direction ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'border-border hover:bg-muted/60',
                )}
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#16142B]">{LOGO_GLYPHS[direction]}</span>
                <span className="min-w-0">{tk(`widgetCatalog.options.logoDirections.${direction}`)}</span>
              </button>
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground">{t('widgetCatalog.options.logoDirectionHint')}</p>
        </div>
      )}

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
          <Select value={navMode} disabled={disabled} onValueChange={(v) => set('navMode', v as ChatTemplateOptions['navMode'])}>
            <SelectTrigger id={`${idPrefix}-nav-mode`}><SelectValue /></SelectTrigger>
            <SelectContent>
              {CHAT_TEMPLATE_NAV_MODES.filter((mode) => dock || mode === 'active' || mode === 'none').map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {dock || mode !== 'active' ? tk(`widgetCatalog.options.navModes.${mode}`) : t('widgetCatalog.options.navModeOwn')}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {!dock && <p className="text-[11px] text-muted-foreground" data-nav-mode-hint>{t('widgetCatalog.options.navModeDockOnly')}</p>}
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
            const n = num(index + 1);
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
              aria-label={t('widgetCatalog.options.askExample', { n: num(index + 1) })}
              placeholder={t('widgetCatalog.options.askExample', { n: num(index + 1) })}
              onChange={(e) => {
                const next = Array.from({ length: CHAT_TEMPLATE_LIMITS.askExamples }, (_, i) => (i === index ? e.target.value : examples[i] ?? ''));
                while (next.length && !next[next.length - 1]) next.pop();
                set('askExamples', next);
              }}
            />
          ))}
        </div>
      )}

      {keys.includes('prechatMode') && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor={`${idPrefix}-prechat-mode`} className="text-xs font-medium">{t('widgetCatalog.options.prechatMode')}</Label>
            {resetButton('prechatMode')}
          </div>
          <Select value={read('prechatMode') ?? CHAT_TEMPLATE_PRECHAT_MODES[0]} disabled={disabled} onValueChange={(v) => set('prechatMode', v as ChatTemplateOptions['prechatMode'])}>
            <SelectTrigger id={`${idPrefix}-prechat-mode`}><SelectValue /></SelectTrigger>
            <SelectContent>
              {CHAT_TEMPLATE_PRECHAT_MODES.map((mode) => (
                <SelectItem key={mode} value={mode}>{tk(`widgetCatalog.options.prechatModes.${mode}`)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[11px] text-muted-foreground">{t('widgetCatalog.options.prechatModeHint')}</p>
        </div>
      )}

      {keys.includes('csat') && toggle('csat', 'csat')}
      {/* No email to visitors while the platform's switch is off (shared/visitorEmail.ts). */}
      {keys.includes('transcriptEmail') && VISITOR_EMAIL_FEATURES_ENABLED && toggle('transcriptEmail', 'transcript-email')}
    </div>
  );
}
