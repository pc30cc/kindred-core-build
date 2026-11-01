import { useRef, useState } from 'react';
import { aiAgentApi } from '@/lib/ai-agent-api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { toast } from '@/lib/toast';
import { useTranslation } from '@/i18n';
import { Bot, Loader2, Sparkles, Trash2, Upload, UserRound } from 'lucide-react';
import { MAX_LENGTH } from './personaForm';
import type { PersonaForm } from './usePersonaForm';
import { defaultIntro, localeDir } from './defaults';
import { fieldErrorText, languageName } from './text';
import { Field, InstantNote, SectionCard } from './ui';

const AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

/**
 * A) The assistant's identity: name, picture, the business in a few
 * sentences, and the welcome message in the primary language. The picture
 * saves at once (its own upload and remove endpoints); the rest waits for
 * the page's Save.
 */
export function IdentitySection({
  form, workspaceId, primary, multiLanguage, avatarUrl, onAvatarChange,
}: {
  form: PersonaForm;
  workspaceId: string;
  /** The welcome message's language here (personaForm primaryLocale). */
  primary: string;
  multiLanguage: boolean;
  avatarUrl: string | null;
  onAvatarChange: (url: string | null) => void;
}) {
  const { t } = useTranslation();
  const { values } = form;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const welcome = form.localized('intro_message_localized', primary);

  const onAvatarSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!AVATAR_TYPES.includes(file.type)) {
      toast.error(t('aiAgent.settings.uploadOnlyImages'));
      return;
    }
    if (file.size > AVATAR_MAX_BYTES) {
      toast.error(t('aiAgent.settings.uploadTooLarge'));
      return;
    }
    setAvatarBusy(true);
    try {
      const r = await aiAgentApi.uploadAvatar(workspaceId, file);
      onAvatarChange(r.avatar_url);
      toast.success(t('aiAgent.settings.avatarUpdated'));
    } catch {
      toast.error(t('aiAgent.settings.uploadFailed'));
    } finally {
      setAvatarBusy(false);
    }
  };

  const onRemoveAvatar = async () => {
    setAvatarBusy(true);
    try {
      await aiAgentApi.removeAvatar(workspaceId);
      onAvatarChange(null);
      toast.success(t('aiAgent.settings.avatarRemoved'));
    } catch {
      toast.error(t('aiAgent.settings.removeFailed'));
    } finally {
      setAvatarBusy(false);
    }
  };

  const onGenerate = async () => {
    if (values.business_description.trim() && !window.confirm(t('aiAgent.persona.identity.generateConfirm'))) return;
    setGenerating(true);
    try {
      const r = await aiAgentApi.generateBusinessDescription(workspaceId);
      form.set('business_description', String(r.description || '').slice(0, MAX_LENGTH.business_description));
      toast.success(r.source === 'ai' ? t('aiAgent.settings.generated') : t('aiAgent.settings.generatedOffline'));
    } catch (e: unknown) {
      const msg = String((e as { message?: unknown } | null)?.message || '');
      toast.error(msg.includes('ai_credits_exhausted') ? t('aiAgent.settings.creditsExhausted') : t('aiAgent.settings.generationFailed'));
    } finally {
      setGenerating(false);
    }
  };

  return (
    <SectionCard
      id="identity"
      icon={UserRound}
      tone="bg-violet-500/10 text-violet-600 ring-violet-500/20 dark:text-violet-300"
      title={t('aiAgent.persona.identity.title')}
      desc={t('aiAgent.persona.identity.desc')}
    >
      <div className="grid gap-5 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-start">
        <div className="space-y-2">
          <p className="text-sm font-medium leading-none">{t('aiAgent.persona.identity.avatar')}</p>
          <div className="flex items-center gap-3">
            <div className="h-16 w-16 shrink-0 overflow-hidden rounded-full border bg-primary/10 flex items-center justify-center">
              {avatarUrl
                ? <img src={avatarUrl} alt="" className="h-full w-full object-cover" />
                : <Bot className="h-7 w-7 text-primary" aria-hidden />}
            </div>
            <div className="flex flex-col gap-1.5">
              <Button type="button" size="sm" variant="outline" onClick={() => fileInputRef.current?.click()} disabled={avatarBusy}>
                {avatarBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                {avatarUrl ? t('aiAgent.settings.change') : t('aiAgent.settings.upload')}
              </Button>
              {avatarUrl && (
                <Button type="button" size="sm" variant="ghost" onClick={onRemoveAvatar} disabled={avatarBusy}>
                  <Trash2 className="h-3.5 w-3.5" /> {t('aiAgent.settings.remove')}
                </Button>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept={AVATAR_TYPES.join(',')}
                className="hidden"
                data-persona-avatar-input
                onChange={onAvatarSelected}
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">{t('aiAgent.settings.avatarHint')}</p>
          <InstantNote>{t('aiAgent.persona.identity.avatarInstant')}</InstantNote>
        </div>

        <Field
          label={t('aiAgent.persona.identity.name')}
          htmlFor="persona-agent-name"
          hint={t('aiAgent.persona.identity.nameHint')}
          error={fieldErrorText(t, form.errors.agent_name)}
        >
          <Input
            id="persona-agent-name"
            value={values.agent_name}
            maxLength={MAX_LENGTH.agent_name}
            placeholder={t('aiAgent.persona.identity.namePlaceholder')}
            aria-invalid={form.errors.agent_name ? true : undefined}
            onChange={(e) => form.set('agent_name', e.target.value)}
          />
        </Field>
      </div>

      <Field
        label={t('aiAgent.persona.identity.business')}
        htmlFor="persona-business"
        hint={(
          <span className="flex items-start justify-between gap-3">
            <span>{t('aiAgent.persona.identity.businessHint')}</span>
            <span className="shrink-0 tabular-nums">{values.business_description.length}/{MAX_LENGTH.business_description}</span>
          </span>
        )}
        aside={(
          <Button type="button" size="sm" variant="outline" onClick={onGenerate} disabled={generating}>
            {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            {t('aiAgent.settings.generate')}
          </Button>
        )}
      >
        <Textarea
          id="persona-business"
          rows={4}
          maxLength={MAX_LENGTH.business_description}
          placeholder={t('aiAgent.persona.identity.businessPlaceholder')}
          value={values.business_description}
          onChange={(e) => form.set('business_description', e.target.value)}
        />
      </Field>

      <div className="space-y-2">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <Label htmlFor="persona-intro-enabled">{t('aiAgent.persona.identity.welcomeSwitch')}</Label>
            <p className="mt-1 text-xs text-muted-foreground">{t('aiAgent.persona.identity.welcomeHint')}</p>
          </div>
          <Switch
            id="persona-intro-enabled"
            checked={values.ai_intro_enabled}
            onCheckedChange={(v) => form.set('ai_intro_enabled', v)}
          />
        </div>
        {values.ai_intro_enabled ? (
          <>
            <Label htmlFor="persona-welcome" className="sr-only">{t('aiAgent.persona.identity.welcome')}</Label>
            <Textarea
              id="persona-welcome"
              rows={3}
              dir={localeDir(primary)}
              maxLength={MAX_LENGTH.message}
              placeholder={defaultIntro(primary, values.agent_name)}
              value={welcome}
              onChange={(e) => form.setLocalized('intro_message_localized', primary, e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {multiLanguage
                ? t('aiAgent.persona.identity.welcomeLanguage', { language: languageName(t, primary) })
                : t('aiAgent.persona.identity.welcomeEmpty')}
            </p>
          </>
        ) : (
          <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">{t('aiAgent.persona.identity.welcomeOff')}</p>
        )}
      </div>
    </SectionCard>
  );
}
