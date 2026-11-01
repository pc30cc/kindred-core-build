import { useEffect, useMemo, useState } from 'react';
import { useActiveWorkspace, useWorkspacePath } from '@/hooks/useWorkspace';
import { useAiAgentDiagnostics, useAiAgentSettings, useUpdateAiAgentSettings } from '@/hooks/useAiAgent';
import { usePlatformRegion } from '@/hooks/usePlatformRegion';
import type { AgentSettings } from '@/lib/ai-agent-api';
import type { Workspace } from '@/types/models';
import { toast } from '@/lib/toast';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { Loader2, Sparkles } from 'lucide-react';
import { AiPageHeader } from '@/components/ai-agent/AiPageHeader';
import { displayMode, primaryLocale, type PersonaContext } from './persona/personaForm';
import { usePersonaForm } from './persona/usePersonaForm';
import { saveErrorText } from './persona/text';
import { IdentitySection } from './persona/IdentitySection';
import { StyleSection } from './persona/StyleSection';
import { BehaviorSection } from './persona/BehaviorSection';
import { AdvancedSettings } from './persona/AdvancedSettings';
import { PersonaPreview } from './persona/PersonaPreview';
import { SaveBar } from './persona/SaveBar';

/** Visitor languages when the platform's are not known yet (as the old settings page did). */
const FALLBACK_LOCALES = ['fa', 'en', 'tr'];

/**
 * «Personality & behavior»: the workspace AI assistant on one page. A few
 * clear settings first (identity, personality and style, behavior), the
 * specialist ones in closed Advanced groups below, a preview beside them,
 * and one Save for all of it (persona/personaForm.ts says what a save
 * sends). The picture, the answer rules and Remove of the saved custom
 * instruction apply at once and say so.
 */
export default function BehaviorPage() {
  const { workspace } = useActiveWorkspace();
  const { data, isLoading, refetch } = useAiAgentSettings(workspace?.id);
  const { dir } = useTranslation();

  if (!workspace || isLoading || !data?.settings) {
    return <div className="flex justify-center py-20" dir={dir}><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }
  // Another workspace's settings start clean.
  return <PersonaEditor key={workspace.id} workspace={workspace} settings={data.settings} refetch={refetch} />;
}

function PersonaEditor({
  workspace, settings, refetch,
}: {
  workspace: Workspace;
  settings: AgentSettings;
  refetch?: () => unknown;
}) {
  const { t, dir } = useTranslation();
  const wsPath = useWorkspacePath();
  const update = useUpdateAiAgentSettings(workspace.id);
  const { data: diag } = useAiAgentDiagnostics(workspace.id);
  const { allowedLocales } = usePlatformRegion();
  const localesKey = (allowedLocales.length ? allowedLocales : FALLBACK_LOCALES).join(',');
  const context = useMemo<PersonaContext>(() => ({ platformLocales: localesKey.split(',') }), [localesKey]);
  const form = usePersonaForm(settings, context);
  const primary = primaryLocale(workspace.default_locale, context.platformLocales);
  const multiLanguage = context.platformLocales.length > 1;

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  // The picture saves at once; until the server's next copy shows it, the
  // page shows the one just uploaded (or none).
  const [avatar, setAvatar] = useState<{ url: string | null; over: AgentSettings } | null>(null);
  const avatarUrl = avatar && avatar.over === settings ? avatar.url : settings.agent_logo_url;

  const blocked = Object.keys(form.errors).length > 0;
  const busy = saving || removing || update.isPending;

  // Leaving the page (reload, closing the tab) with unsaved edits asks first.
  useEffect(() => {
    if (!form.dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [form.dirty]);

  const onSave = async () => {
    if (!form.dirty || blocked || busy) return;
    const sent = form.edits;
    setSaving(true);
    setSaveError(null);
    try {
      await update.mutateAsync(form.patch);
      form.markSaved(sent);
      toast.success(t('aiAgent.persona.save.saved'));
    } catch (e: unknown) {
      const message = saveErrorText(t, e);
      setSaveError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const onDiscard = () => {
    form.discard();
    setSaveError(null);
  };

  const onRemoveCustomInstruction = async () => {
    if (!window.confirm(t('aiAgent.persona.advanced.removeConfirm'))) return;
    setRemoving(true);
    try {
      // Only this key changes; every other edit on the page stays for Save.
      await update.mutateAsync({ instructions: { custom_system_instruction: '' } });
      form.reset('custom_system_instruction');
      toast.success(t('aiAgent.instructions.advanced.removed'));
    } catch (e: unknown) {
      toast.error(saveErrorText(t, e));
    } finally {
      setRemoving(false);
    }
  };

  const onAvatarChange = (url: string | null) => {
    setAvatar({ url, over: settings });
    refetch?.();
  };

  const savedMode = displayMode(settings);
  const state = savedMode === 'off' ? 'off' : savedMode === 'suggest_only' ? 'suggest' : 'on';

  return (
    <div className="space-y-6 animate-fade-in" dir={dir} data-page="ai-persona">
      <AiPageHeader
        icon={Sparkles}
        accent="violet"
        title={t('aiAgent.persona.title')}
        subtitle={t('aiAgent.persona.subtitle')}
        meta={(
          <span
            data-ai-agent-state={state}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium',
              state === 'on' && 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
              state === 'suggest' && 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
              state === 'off' && 'border-border bg-muted text-muted-foreground',
            )}
          >
            <span className={cn(
              'h-1.5 w-1.5 rounded-full',
              state === 'on' && 'bg-emerald-500 animate-pulse',
              state === 'suggest' && 'bg-amber-500',
              state === 'off' && 'bg-muted-foreground/50',
            )} />
            {state === 'on' ? t('aiAgent.menu.stateOn') : state === 'suggest' ? t('aiAgent.menu.stateSuggest') : t('aiAgent.menu.stateOff')}
          </span>
        )}
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-6">
          <IdentitySection
            form={form}
            workspaceId={workspace.id}
            primary={primary}
            multiLanguage={multiLanguage}
            avatarUrl={avatarUrl}
            onAvatarChange={onAvatarChange}
          />
          <StyleSection form={form} workspaceId={workspace.id} />
          <BehaviorSection
            form={form}
            diag={diag}
            knowledgeBaseHref={wsPath('/knowledge-base')}
            primary={primary}
            multiLanguage={multiLanguage}
          />
          <AdvancedSettings
            form={form}
            primary={primary}
            onRemoveCustomInstruction={onRemoveCustomInstruction}
            removing={removing}
          />
        </div>

        <aside
          aria-label={t('aiAgent.persona.preview.title')}
          className="min-w-0 lg:sticky lg:top-4 lg:max-h-[calc(100dvh-6rem)] lg:self-start lg:overflow-y-auto lg:pb-2"
        >
          <PersonaPreview
            agentName={form.values.agent_name}
            avatarUrl={avatarUrl}
            welcomeEnabled={form.values.ai_intro_enabled}
            welcome={form.localized('intro_message_localized', primary)}
            primary={primary}
            tone={form.values.tone}
            length={form.values.max_answer_length}
          />
        </aside>
      </div>

      <SaveBar
        dirty={form.dirty}
        saving={saving}
        busy={busy}
        blocked={blocked}
        error={saveError}
        onSave={onSave}
        onDiscard={onDiscard}
      />
    </div>
  );
}
