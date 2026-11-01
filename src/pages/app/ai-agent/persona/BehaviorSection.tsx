import { Link } from 'react-router-dom';
import type { AgentMode, DiagnosticsResponse } from '@/lib/ai-agent-api';
import { operatorAvailabilityStatus } from '@/lib/ai-agent/assistant';
import { Badge } from '@/components/ui/badge';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { AlertTriangle, Check, Info, Power, X } from 'lucide-react';
import type { HandoffPolicy, ReplyLanguage } from './personaForm';
import type { PersonaForm } from './usePersonaForm';
import { languageName } from './text';
import { ChoiceList, Field, SectionCard, SwitchRow } from './ui';

/** What turning the assistant on needs, as the server checks it (PUT /settings). */
function readiness(diag: DiagnosticsResponse | undefined, answerOnlyFromKb: boolean) {
  if (!diag) return null;
  const provider = diag.checks.ai_provider_configured;
  const moduleOn = diag.checks.module_enabled;
  const knowledge = diag.checks.has_knowledge;
  return {
    provider,
    moduleOn,
    knowledge,
    knowledgeRequired: answerOnlyFromKb,
    blocking: !provider || !moduleOn || (answerOnlyFromKb && !knowledge),
  };
}

function CheckRow({ state, label, hint, children }: {
  state: 'ok' | 'missing' | 'optional';
  label: string;
  hint?: string;
  children?: React.ReactNode;
}) {
  return (
    <li data-readiness={state} className="flex items-start gap-2.5 py-1.5">
      <span className={cn(
        'mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full',
        state === 'ok' && 'bg-success/15 text-success',
        state === 'missing' && 'bg-destructive/15 text-destructive',
        state === 'optional' && 'bg-amber-500/15 text-amber-600',
      )}>
        {state === 'ok' ? <Check className="h-3 w-3" /> : state === 'missing' ? <X className="h-3 w-3" /> : <Info className="h-3 w-3" />}
      </span>
      <span className="min-w-0 text-sm">
        <span className="font-medium">{label}</span>
        {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
        {children}
      </span>
    </li>
  );
}

/**
 * C) When the assistant answers (`enabled` + `mode`, the five modes the
 * server stores), with what turning it on still needs; the reply language
 * (`instructions.reply_language`); clarifying questions; and what happens
 * when a visitor asks for a person (`handoff_policy`).
 */
export function BehaviorSection({
  form, diag, knowledgeBaseHref, primary, multiLanguage,
}: {
  form: PersonaForm;
  diag: DiagnosticsResponse | undefined;
  knowledgeBaseHref: string;
  primary: string;
  multiLanguage: boolean;
}) {
  const { t } = useTranslation();
  const { values } = form;
  const ready = readiness(diag, values.answer_only_from_kb);
  const off = values.mode === 'off';
  const showChecklist = !!ready && (off || ready.blocking);
  const availability = diag?.operator_availability;
  const availabilityStatus = operatorAvailabilityStatus(availability);

  const modes: { value: AgentMode; title: string; hint: string }[] = [
    { value: 'off', title: t('aiAgent.persona.behavior.modeOff'), hint: t('aiAgent.persona.behavior.modeOffHint') },
    { value: 'suggest_only', title: t('aiAgent.persona.behavior.modeSuggest'), hint: t('aiAgent.persona.behavior.modeSuggestHint') },
    { value: 'auto_reply_until_human_joins', title: t('aiAgent.persona.behavior.modeUntilHuman'), hint: t('aiAgent.persona.behavior.modeUntilHumanHint') },
    { value: 'auto_reply_when_offline', title: t('aiAgent.persona.behavior.modeOffline'), hint: t('aiAgent.persona.behavior.modeOfflineHint') },
    { value: 'auto_reply_always', title: t('aiAgent.persona.behavior.modeAlways'), hint: t('aiAgent.persona.behavior.modeAlwaysHint') },
  ];

  return (
    <SectionCard
      id="behavior"
      icon={Power}
      tone="bg-emerald-500/10 text-emerald-600 ring-emerald-500/20 dark:text-emerald-300"
      title={t('aiAgent.persona.behavior.title')}
      desc={t('aiAgent.persona.behavior.desc')}
    >
      <Field label={t('aiAgent.persona.behavior.mode')}>
        <ChoiceList<AgentMode>
          id="persona-mode"
          label={t('aiAgent.persona.behavior.mode')}
          value={values.mode}
          onChange={(v) => form.set('mode', v)}
          options={modes}
        />

        {values.mode === 'auto_reply_when_offline' && availability && typeof availability.online_count === 'number' && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span
              aria-hidden
              className={cn('h-2 w-2 rounded-full', availabilityStatus === 'online' ? 'bg-success' : 'bg-muted-foreground/40')}
            />
            <span>
              {t('aiAgent.persona.behavior.operatorsNow', {
                online: String(availability.online_count),
                total: String(availability.total_count ?? '?'),
              })}
            </span>
            {availabilityStatus === 'offline' && (
              <Badge variant="secondary">{t('aiAgent.persona.behavior.answersNow')}</Badge>
            )}
          </div>
        )}

        {showChecklist && ready && (
          <div data-persona-readiness className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2.5">
            {!off && ready.blocking ? (
              <p role="alert" className="mb-1 flex items-start gap-2 text-sm font-medium text-amber-700 dark:text-amber-300">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                {t('aiAgent.persona.behavior.notReady')}
              </p>
            ) : (
              <p className="mb-1 text-xs font-medium text-muted-foreground">{t('aiAgent.persona.behavior.readyTitle')}</p>
            )}
            <ul>
              <CheckRow
                state={ready.provider ? 'ok' : 'missing'}
                label={t('aiAgent.persona.behavior.checkProvider')}
                hint={ready.provider ? undefined : t('aiAgent.persona.behavior.checkProviderHint')}
              />
              <CheckRow
                state={ready.knowledge ? 'ok' : ready.knowledgeRequired ? 'missing' : 'optional'}
                label={t('aiAgent.persona.behavior.checkKnowledge')}
                hint={ready.knowledge
                  ? t('aiAgent.persona.behavior.checkKnowledgeCount', {
                    published: String(diag?.knowledge?.published ?? 0),
                    qna: String(diag?.knowledge?.qna_count ?? 0),
                  })
                  : ready.knowledgeRequired
                    ? t('aiAgent.persona.behavior.checkKnowledgeHint')
                    : t('aiAgent.persona.behavior.checkKnowledgeOptional')}
              >
                {!ready.knowledge && (
                  <Link to={knowledgeBaseHref} className="mt-0.5 inline-block text-xs font-medium text-primary underline-offset-4 hover:underline">
                    {t('aiAgent.persona.behavior.checkKnowledgeLink')}
                  </Link>
                )}
              </CheckRow>
              <CheckRow
                state={ready.moduleOn ? 'ok' : 'missing'}
                label={t('aiAgent.persona.behavior.checkModule')}
                hint={ready.moduleOn ? undefined : t('aiAgent.persona.behavior.checkModuleHint')}
              />
            </ul>
          </div>
        )}
      </Field>

      {multiLanguage && (
        <Field label={t('aiAgent.persona.behavior.replyLanguage')}>
          <ChoiceList<ReplyLanguage>
            id="persona-reply-language"
            label={t('aiAgent.persona.behavior.replyLanguage')}
            columns={2}
            value={values.reply_language}
            onChange={(v) => form.set('reply_language', v)}
            options={[
              { value: 'visitor', title: t('aiAgent.persona.behavior.replyVisitor'), hint: t('aiAgent.persona.behavior.replyVisitorHint') },
              {
                value: 'workspace_default',
                title: t('aiAgent.persona.behavior.replyWorkspace'),
                hint: t('aiAgent.persona.behavior.replyWorkspaceHint', { language: languageName(t, primary) }),
              },
            ]}
          />
        </Field>
      )}

      <SwitchRow
        id="persona-clarify"
        label={t('aiAgent.persona.behavior.clarify')}
        hint={t('aiAgent.persona.behavior.clarifyHint')}
        checked={values.allow_clarifying_questions}
        onChange={(v) => form.set('allow_clarifying_questions', v)}
      />

      <Field label={t('aiAgent.persona.behavior.handoff')}>
        <ChoiceList<HandoffPolicy>
          id="persona-handoff-policy"
          label={t('aiAgent.persona.behavior.handoff')}
          value={values.handoff_policy}
          onChange={(v) => form.set('handoff_policy', v)}
          options={[
            { value: 'immediate', title: t('aiAgent.persona.behavior.handoffImmediate'), hint: t('aiAgent.persona.behavior.handoffImmediateHint') },
            { value: 'assist_first', title: t('aiAgent.persona.behavior.handoffAssistFirst'), hint: t('aiAgent.persona.behavior.handoffAssistFirstHint') },
            { value: 'adaptive', title: t('aiAgent.persona.behavior.handoffAdaptive'), hint: t('aiAgent.persona.behavior.handoffAdaptiveHint') },
          ]}
        />
        {form.settings.handoff_on_human_request === false && (
          <p className="flex items-start gap-2 text-xs text-muted-foreground">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {t('aiAgent.persona.behavior.handoffSwitchOff')}
          </p>
        )}
      </Field>
    </SectionCard>
  );
}
