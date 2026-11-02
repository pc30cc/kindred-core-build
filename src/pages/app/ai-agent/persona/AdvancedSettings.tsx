import { useState } from 'react';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useTranslation } from '@/i18n';
import { AlertTriangle, Info, Loader2, SlidersHorizontal, X } from 'lucide-react';
import type { AnswerGuidance, EscalationStyle } from '@/lib/ai-agent-api';
import {
  MAX_KEYWORDS,
  MAX_LENGTH,
  type FallbackBehavior,
  type LocalizedMap,
} from './personaForm';
import type { PersonaForm } from './usePersonaForm';
import { defaultHandoffMessage, defaultHandoffPrechatMessage, defaultIntro, localeDir } from './defaults';
import { languageName } from './text';
import { ChoiceList, CountField, Field, InstantNote, SwitchRow } from './ui';

/** One group of specialist settings: a title and one line on what is inside. */
function Group({ value, title, desc, children }: { value: string; title: string; desc: string; children: React.ReactNode }) {
  return (
    <AccordionItem value={value} data-persona-advanced={value} className="border-border/60">
      <AccordionTrigger className="gap-3 py-3.5 text-start hover:no-underline">
        <span className="min-w-0">
          <span className="block text-sm font-semibold">{title}</span>
          <span className="mt-0.5 block text-xs font-normal text-muted-foreground">{desc}</span>
        </span>
      </AccordionTrigger>
      <AccordionContent className="space-y-5 pb-5 pt-1">{children}</AccordionContent>
    </AccordionItem>
  );
}

/** One text field per language for a per-language visitor message. */
function MessageFields({
  form, map, languages, multiLanguage, idPrefix, label, placeholder, rows = 2,
}: {
  form: PersonaForm;
  map: LocalizedMap;
  languages: readonly string[];
  multiLanguage: boolean;
  idPrefix: string;
  label: string;
  placeholder: (code: string) => string;
  rows?: number;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      {languages.map((code) => {
        const id = `${idPrefix}-${code}`;
        return (
          <div key={code} className="space-y-1.5">
            <Label htmlFor={id} className={multiLanguage ? 'text-xs text-muted-foreground' : 'sr-only'}>
              {multiLanguage ? languageName(t, code) : label}
            </Label>
            <Textarea
              id={id}
              rows={rows}
              dir={localeDir(code)}
              maxLength={MAX_LENGTH.message}
              placeholder={placeholder(code)}
              value={form.localized(map, code)}
              onChange={(e) => form.setLocalized(map, code, e.target.value)}
            />
          </div>
        );
      })}
    </div>
  );
}

/** Words that call an operator: chips of the form, saved with the page. */
function KeywordChips({ form }: { form: PersonaForm }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const keywords = form.values.handoff_keywords;

  const add = () => {
    const word = draft.trim();
    if (!word) return;
    if (keywords.some((k) => k.toLowerCase() === word.toLowerCase())) {
      setError(t('aiAgent.settings.texts.keywordExists'));
      return;
    }
    if (keywords.length >= MAX_KEYWORDS) {
      setError(t('aiAgent.persona.advanced.keywordsMax', { max: MAX_KEYWORDS }));
      return;
    }
    form.set('handoff_keywords', [...keywords, word]);
    setDraft('');
    setError(null);
  };

  return (
    <Field
      label={t('aiAgent.persona.advanced.keywords')}
      htmlFor="persona-keyword-input"
      hint={t('aiAgent.persona.advanced.keywordsHint')}
      error={error}
    >
      <div className="flex gap-2">
        <Input
          id="persona-keyword-input"
          maxLength={MAX_LENGTH.keyword}
          placeholder={t('aiAgent.settings.texts.keywordPlaceholder')}
          value={draft}
          onChange={(e) => { setDraft(e.target.value); setError(null); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
        />
        <Button type="button" variant="outline" className="shrink-0" onClick={add} disabled={!draft.trim()}>
          {t('aiAgent.settings.texts.add')}
        </Button>
      </div>
      <ul className="flex flex-wrap gap-2" aria-label={t('aiAgent.persona.advanced.keywords')}>
        {keywords.map((word) => (
          <li key={word} className="flex items-center gap-1.5 rounded-full border border-border bg-muted/50 py-1 pe-1.5 ps-3 text-sm">
            <span dir="auto">{word}</span>
            <button
              type="button"
              onClick={() => form.set('handoff_keywords', keywords.filter((k) => k !== word))}
              className="flex h-5 w-5 items-center justify-center rounded-full transition-colors hover:bg-destructive/15 hover:text-destructive"
              aria-label={t('aiAgent.persona.advanced.keywordRemove', { word })}
            >
              <X className="h-3 w-3" />
            </button>
          </li>
        ))}
        {keywords.length === 0 && <li className="text-xs text-muted-foreground">{t('aiAgent.settings.texts.noKeywords')}</li>}
      </ul>
    </Field>
  );
}

/**
 * The specialist settings, in seven groups that start closed. Opening or
 * closing one changes nothing; every control here is part of the page's form
 * except Remove (the saved custom instruction), which applies at once. None
 * repeats a control of the simple view above.
 */
export function AdvancedSettings({
  form, primary, onRemoveCustomInstruction, removing,
}: {
  form: PersonaForm;
  primary: string;
  onRemoveCustomInstruction: () => void;
  removing: boolean;
}) {
  const { t } = useTranslation();
  const { values } = form;
  const languages = form.context.platformLocales;
  const multiLanguage = languages.length > 1;
  const otherLanguages = languages.filter((code) => code !== primary);
  const hasSavedCustom = form.settings.has_custom_system_instruction === true;
  const checkedLocales = values.allowed_locales;

  return (
    <Card data-persona-section="advanced" className="overflow-hidden border-border/60">
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2.5">
          <span className="h-8 w-8 shrink-0 rounded-lg flex items-center justify-center ring-1 bg-amber-500/10 text-amber-600 ring-amber-500/20 dark:text-amber-300">
            <SlidersHorizontal className="h-4 w-4" />
          </span>
          {t('aiAgent.persona.advanced.title')}
        </CardTitle>
        <CardDescription className="ps-[42px]">{t('aiAgent.persona.advanced.desc')}</CardDescription>
      </CardHeader>
      <CardContent className="pt-0">
        <Accordion type="multiple" className="w-full">
          <Group value="identity" title={t('aiAgent.persona.advanced.identityTitle')} desc={t('aiAgent.persona.advanced.identityDesc')}>
            <Field label={t('aiAgent.persona.advanced.brandVoice')} htmlFor="persona-brand-voice" hint={t('aiAgent.persona.advanced.brandVoiceHint')}>
              <Textarea
                id="persona-brand-voice"
                rows={3}
                dir="auto"
                maxLength={MAX_LENGTH.brand_voice}
                placeholder={t('aiAgent.instructions.brandVoice.voiceDescPlaceholder')}
                value={values.brand_voice}
                onChange={(e) => form.set('brand_voice', e.target.value)}
              />
            </Field>
            <Field label={t('aiAgent.persona.advanced.pricing')} htmlFor="persona-pricing">
              <Textarea
                id="persona-pricing"
                rows={3}
                dir="auto"
                maxLength={MAX_LENGTH.pricing_instructions}
                placeholder={t('aiAgent.instructions.topicSpecific.pricingPlaceholder')}
                value={values.pricing_instructions}
                onChange={(e) => form.set('pricing_instructions', e.target.value)}
              />
            </Field>
            <Field label={t('aiAgent.persona.advanced.support')} htmlFor="persona-support">
              <Textarea
                id="persona-support"
                rows={3}
                dir="auto"
                maxLength={MAX_LENGTH.support_instructions}
                placeholder={t('aiAgent.instructions.topicSpecific.supportPlaceholder')}
                value={values.support_instructions}
                onChange={(e) => form.set('support_instructions', e.target.value)}
              />
            </Field>
            <Field
              label={t('aiAgent.persona.advanced.custom')}
              htmlFor="persona-custom-instruction"
              hint={t('aiAgent.instructions.advanced.hint')}
              aside={(
                <span className="inline-flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400">
                  <AlertTriangle className="h-3.5 w-3.5" /> {t('aiAgent.instructions.advanced.badge')}
                </span>
              )}
            >
              {hasSavedCustom && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/60 bg-muted/40 px-3 py-2">
                  <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                    <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    {t('aiAgent.instructions.advanced.savedNote')}
                  </p>
                  <Button type="button" variant="outline" size="sm" onClick={onRemoveCustomInstruction} disabled={removing}>
                    {removing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    {t('aiAgent.persona.advanced.removeCustom')}
                  </Button>
                </div>
              )}
              <Textarea
                id="persona-custom-instruction"
                rows={5}
                dir="auto"
                maxLength={MAX_LENGTH.custom_system_instruction}
                placeholder={t('aiAgent.instructions.advanced.placeholder')}
                value={values.custom_system_instruction}
                onChange={(e) => form.set('custom_system_instruction', e.target.value)}
              />
              {hasSavedCustom && <InstantNote>{t('aiAgent.persona.advanced.removeInstant')}</InstantNote>}
            </Field>
          </Group>

          <Group value="answering" title={t('aiAgent.persona.advanced.answeringTitle')} desc={t('aiAgent.persona.advanced.answeringDesc')}>
            <CountField
              form={form}
              field="max_clarification_attempts"
              id="persona-max-clarify"
              label={t('aiAgent.persona.advanced.maxClarify')}
              hint={values.allow_clarifying_questions
                ? t('aiAgent.persona.advanced.maxClarifyHint')
                : t('aiAgent.persona.advanced.maxClarifyOff')}
              disabled={!values.allow_clarifying_questions}
            />
            <SwitchRow
              id="persona-caveat"
              label={t('aiAgent.persona.advanced.caveat')}
              hint={t('aiAgent.persona.advanced.caveatHint')}
              checked={values.allow_answer_with_caveat}
              onChange={(v) => form.set('allow_answer_with_caveat', v)}
            />
          </Group>

          <Group value="knowledge" title={t('aiAgent.persona.advanced.knowledgeTitle')} desc={t('aiAgent.persona.advanced.knowledgeDesc')}>
            <SwitchRow
              id="persona-only-kb"
              label={t('aiAgent.persona.advanced.onlyKb')}
              hint={t('aiAgent.persona.advanced.onlyKbHint')}
              checked={values.answer_only_from_kb}
              onChange={(v) => form.set('answer_only_from_kb', v)}
            />
            <SwitchRow
              id="persona-strict-scope"
              label={t('aiAgent.persona.advanced.strictScope')}
              hint={t('aiAgent.persona.advanced.strictScopeHint')}
              checked={values.strict_topic_scope}
              onChange={(v) => form.set('strict_topic_scope', v)}
            />
            <Field label={t('aiAgent.persona.advanced.guidance')}>
              <ChoiceList<AnswerGuidance>
                id="persona-guidance"
                label={t('aiAgent.persona.advanced.guidance')}
                value={values.answer_guidance}
                onChange={(v) => form.set('answer_guidance', v)}
                options={[
                  { value: 'conservative', title: t('aiAgent.persona.advanced.guidanceConservative'), hint: t('aiAgent.persona.advanced.guidanceConservativeHint') },
                  { value: 'balanced', title: t('aiAgent.persona.advanced.guidanceBalanced'), hint: t('aiAgent.persona.advanced.guidanceBalancedHint') },
                  { value: 'creative', title: t('aiAgent.persona.advanced.guidanceCreative'), hint: t('aiAgent.persona.advanced.guidanceCreativeHint') },
                ]}
              />
            </Field>
            <div className="space-y-3 rounded-lg border border-border/50 p-3">
              <p className="text-sm font-medium">{t('aiAgent.persona.advanced.notEnough')}</p>
              <ChoiceList<FallbackBehavior>
                id="persona-fallback"
                label={t('aiAgent.persona.advanced.notEnough')}
                columns={2}
                value={values.fallback_behavior}
                onChange={(v) => form.set('fallback_behavior', v)}
                options={[
                  { value: 'handoff', title: t('aiAgent.persona.advanced.fallbackHandoff'), hint: t('aiAgent.persona.advanced.fallbackHandoffHint') },
                  { value: 'silent', title: t('aiAgent.persona.advanced.fallbackSilent'), hint: t('aiAgent.persona.advanced.fallbackSilentHint') },
                ]}
              />
              <SwitchRow
                id="persona-no-match-handoff"
                label={t('aiAgent.persona.advanced.noMatchHandoff')}
                hint={t('aiAgent.persona.advanced.noMatchHandoffHint')}
                checked={values.handoff_when_no_kb_match}
                onChange={(v) => form.set('handoff_when_no_kb_match', v)}
              />
              <Field label={t('aiAgent.persona.advanced.fallbackMessage')} htmlFor="persona-fallback-message" hint={t('aiAgent.persona.advanced.fallbackMessageHint')}>
                <Input
                  id="persona-fallback-message"
                  dir="auto"
                  maxLength={MAX_LENGTH.fallback_message}
                  value={values.fallback_message}
                  onChange={(e) => form.set('fallback_message', e.target.value)}
                />
              </Field>
            </div>
          </Group>

          <Group value="handoff" title={t('aiAgent.persona.advanced.handoffTitle')} desc={t('aiAgent.persona.advanced.handoffDesc')}>
            <Field label={t('aiAgent.persona.advanced.escalation')}>
              <ChoiceList<EscalationStyle>
                id="persona-escalation"
                label={t('aiAgent.persona.advanced.escalation')}
                value={values.escalation_style}
                onChange={(v) => form.set('escalation_style', v)}
                options={[
                  { value: 'conservative', title: t('aiAgent.persona.advanced.escConservative'), hint: t('aiAgent.persona.advanced.escConservativeHint') },
                  { value: 'balanced', title: t('aiAgent.persona.advanced.escBalanced'), hint: t('aiAgent.persona.advanced.escBalancedHint') },
                  { value: 'helpful_first', title: t('aiAgent.persona.advanced.escHelpful'), hint: t('aiAgent.persona.advanced.escHelpfulHint') },
                ]}
              />
            </Field>
            <SwitchRow
              id="persona-low-confidence"
              label={t('aiAgent.persona.advanced.lowConfidence')}
              hint={t('aiAgent.persona.advanced.lowConfidenceHint')}
              checked={values.handoff_on_low_confidence}
              onChange={(v) => form.set('handoff_on_low_confidence', v)}
            />
            <KeywordChips form={form} />
            <Field label={t('aiAgent.persona.advanced.handoffInstructions')} htmlFor="persona-handoff-instructions">
              <Textarea
                id="persona-handoff-instructions"
                rows={3}
                dir="auto"
                maxLength={MAX_LENGTH.handoff_instructions}
                placeholder={t('aiAgent.instructions.topicSpecific.handoffPlaceholder')}
                value={values.handoff_instructions}
                onChange={(e) => form.set('handoff_instructions', e.target.value)}
              />
            </Field>
            <SwitchRow
              id="persona-stop-on-handoff"
              label={t('aiAgent.persona.advanced.stopOnHandoff')}
              hint={t('aiAgent.persona.advanced.stopOnHandoffHint')}
              checked={values.stop_on_handoff}
              onChange={(v) => form.set('stop_on_handoff', v)}
            />
            <SwitchRow
              id="persona-stop-after-human"
              label={t('aiAgent.persona.advanced.stopAfterHuman')}
              hint={t('aiAgent.persona.advanced.stopAfterHumanHint')}
              checked={values.pause_auto_reply_after_human_reply}
              onChange={(v) => form.set('pause_auto_reply_after_human_reply', v)}
            />
          </Group>

          <Group value="limits" title={t('aiAgent.persona.advanced.limitsTitle')} desc={t('aiAgent.persona.advanced.limitsDesc')}>
            <div className="grid gap-4 sm:grid-cols-2">
              <CountField
                form={form}
                field="max_replies_per_conversation"
                id="persona-max-per-conversation"
                label={t('aiAgent.persona.advanced.perConversation')}
                hint={t('aiAgent.persona.advanced.perConversationHint')}
              />
              <CountField
                form={form}
                field="max_replies_per_hour"
                id="persona-max-per-hour"
                label={t('aiAgent.persona.advanced.perHour')}
                hint={t('aiAgent.persona.advanced.perHourHint')}
              />
            </div>
          </Group>

          <Group value="languages" title={t('aiAgent.persona.advanced.languagesTitle')} desc={t('aiAgent.persona.advanced.languagesDesc')}>
            {multiLanguage ? (
              <Field label={t('aiAgent.persona.advanced.allowed')} hint={t('aiAgent.persona.advanced.allowedHint')}>
                <div role="group" aria-label={t('aiAgent.persona.advanced.allowed')} className="flex flex-wrap gap-x-5 gap-y-2">
                  {languages.map((code) => {
                    const checked = checkedLocales.includes(code);
                    const last = checked && checkedLocales.length === 1;
                    return (
                      <div key={code} className="flex items-center gap-2">
                        <Checkbox
                          id={`persona-locale-${code}`}
                          checked={checked}
                          disabled={last}
                          onCheckedChange={(v) => {
                            const next = v === true
                              ? [...checkedLocales, code]
                              : checkedLocales.filter((c) => c !== code);
                            form.set('allowed_locales', languages.filter((l) => next.includes(l)));
                          }}
                        />
                        <Label htmlFor={`persona-locale-${code}`} className="font-normal">{languageName(t, code)}</Label>
                      </div>
                    );
                  })}
                </div>
                {checkedLocales.length === 1 && <p className="text-xs text-muted-foreground">{t('aiAgent.persona.advanced.allowedLastOne')}</p>}
              </Field>
            ) : (
              <p className="flex items-start gap-2 rounded-md bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
                <Info className="mt-0.5 h-4 w-4 shrink-0" />
                {t('aiAgent.persona.advanced.allowedSingle', { language: languageName(t, languages[0]) })}
              </p>
            )}

            {otherLanguages.length > 0 && (
              <Field label={t('aiAgent.persona.advanced.welcomeOther')} hint={t('aiAgent.persona.advanced.welcomeOtherHint')}>
                <MessageFields
                  form={form}
                  map="intro_message_localized"
                  languages={otherLanguages}
                  multiLanguage
                  idPrefix="persona-welcome"
                  label={t('aiAgent.persona.advanced.welcomeOther')}
                  placeholder={(code) => defaultIntro(code, values.agent_name)}
                  rows={3}
                />
              </Field>
            )}

            <Field label={t('aiAgent.persona.advanced.handoffMessage')} hint={t('aiAgent.persona.advanced.handoffMessageHint')}>
              <MessageFields
                form={form}
                map="handoff_message_localized"
                languages={languages}
                multiLanguage={multiLanguage}
                idPrefix="persona-handoff-message"
                label={t('aiAgent.persona.advanced.handoffMessage')}
                placeholder={defaultHandoffMessage}
              />
            </Field>

            <Field label={t('aiAgent.persona.advanced.prechat')} hint={t('aiAgent.persona.advanced.prechatHint')}>
              <MessageFields
                form={form}
                map="handoff_prechat_message_localized"
                languages={languages}
                multiLanguage={multiLanguage}
                idPrefix="persona-prechat-message"
                label={t('aiAgent.persona.advanced.prechat')}
                placeholder={defaultHandoffPrechatMessage}
              />
            </Field>
          </Group>

          <Group value="learning" title={t('aiAgent.persona.advanced.learningTitle')} desc={t('aiAgent.persona.advanced.learningDesc')}>
            <SwitchRow
              id="persona-learning"
              label={t('aiAgent.persona.advanced.learning')}
              hint={t('aiAgent.persona.advanced.learningHint')}
              checked={values.learning_enabled}
              onChange={(v) => form.set('learning_enabled', v)}
            />
            <SwitchRow
              id="persona-learning-auto"
              label={t('aiAgent.persona.advanced.learningAuto')}
              hint={values.learning_enabled
                ? t('aiAgent.persona.advanced.learningAutoHint')
                : t('aiAgent.persona.advanced.learningAutoOff')}
              checked={values.auto_create_learning_candidates}
              disabled={!values.learning_enabled}
              onChange={(v) => form.set('auto_create_learning_candidates', v)}
            />
          </Group>
        </Accordion>
      </CardContent>
    </Card>
  );
}
