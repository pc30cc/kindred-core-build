import { Textarea } from '@/components/ui/textarea';
import { useTranslation } from '@/i18n';
import { MessageSquareText } from 'lucide-react';
import type { AnswerLength, Tone } from './personaForm';
import type { PersonaForm } from './usePersonaForm';
import { GuidanceRulesList } from './GuidanceRulesList';
import { fieldErrorText } from './text';
import { ChoiceList, Field, InstantNote, SectionCard } from './ui';

/**
 * B) How the assistant sounds: tone and answer length (`instructions.tone`,
 * `instructions.max_answer_length`), what it always or never does
 * (`instructions.do_list` / `dont_list`), and the workspace's answer rules,
 * which save through their own dialog, at once.
 */
export function StyleSection({ form, workspaceId }: { form: PersonaForm; workspaceId: string }) {
  const { t } = useTranslation();
  const { values } = form;

  return (
    <SectionCard
      id="style"
      icon={MessageSquareText}
      tone="bg-sky-500/10 text-sky-600 ring-sky-500/20 dark:text-sky-300"
      title={t('aiAgent.persona.style.title')}
      desc={t('aiAgent.persona.style.desc')}
    >
      <Field label={t('aiAgent.persona.style.tone')}>
        <ChoiceList<Tone>
          id="persona-tone"
          label={t('aiAgent.persona.style.tone')}
          columns={3}
          value={values.tone}
          onChange={(v) => form.set('tone', v)}
          options={[
            { value: 'friendly', title: t('aiAgent.behavior.tone.friendly'), hint: t('aiAgent.persona.style.toneFriendlyHint') },
            { value: 'formal', title: t('aiAgent.behavior.tone.formal'), hint: t('aiAgent.persona.style.toneFormalHint') },
            { value: 'professional', title: t('aiAgent.behavior.tone.professional'), hint: t('aiAgent.persona.style.toneProfessionalHint') },
          ]}
        />
      </Field>

      <Field label={t('aiAgent.persona.style.length')}>
        <ChoiceList<AnswerLength>
          id="persona-length"
          label={t('aiAgent.persona.style.length')}
          columns={3}
          value={values.max_answer_length}
          onChange={(v) => form.set('max_answer_length', v)}
          options={[
            { value: 'short', title: t('aiAgent.behavior.style.short'), hint: t('aiAgent.persona.style.lengthShortHint') },
            { value: 'medium', title: t('aiAgent.behavior.style.medium'), hint: t('aiAgent.persona.style.lengthMediumHint') },
            { value: 'long', title: t('aiAgent.behavior.style.long'), hint: t('aiAgent.persona.style.lengthLongHint') },
          ]}
        />
      </Field>

      <div className="grid gap-4 md:grid-cols-2">
        <Field
          label={t('aiAgent.persona.style.always')}
          htmlFor="persona-do-list"
          hint={t('aiAgent.persona.style.onePerLine')}
          error={fieldErrorText(t, form.errors.do_list)}
        >
          <Textarea
            id="persona-do-list"
            rows={5}
            dir="auto"
            placeholder={t('aiAgent.persona.style.alwaysPlaceholder')}
            value={values.do_list}
            aria-invalid={form.errors.do_list ? true : undefined}
            onChange={(e) => form.set('do_list', e.target.value)}
          />
        </Field>
        <Field
          label={t('aiAgent.persona.style.never')}
          htmlFor="persona-dont-list"
          hint={t('aiAgent.persona.style.onePerLine')}
          error={fieldErrorText(t, form.errors.dont_list)}
        >
          <Textarea
            id="persona-dont-list"
            rows={5}
            dir="auto"
            placeholder={t('aiAgent.persona.style.neverPlaceholder')}
            value={values.dont_list}
            aria-invalid={form.errors.dont_list ? true : undefined}
            onChange={(e) => form.set('dont_list', e.target.value)}
          />
        </Field>
      </div>

      <section aria-labelledby="persona-rules-title" className="space-y-3 rounded-xl border border-border/60 bg-muted/20 p-4">
        <div className="space-y-1">
          <h3 id="persona-rules-title" className="text-sm font-semibold">{t('aiAgent.persona.style.rulesTitle')}</h3>
          <p className="text-xs text-muted-foreground">{t('aiAgent.persona.style.rulesDesc')}</p>
          <InstantNote>{t('aiAgent.persona.style.rulesInstant')}</InstantNote>
        </div>
        <GuidanceRulesList workspaceId={workspaceId} variant="embedded" />
      </section>
    </SectionCard>
  );
}
