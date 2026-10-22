import { useEffect, useState } from 'react';
import { useTranslation, type TranslationKey } from '@/i18n';
import { useWidgetPrechatSettings, useUpdateWidgetPrechatSettings, type WidgetPrechatSettings, type PrechatTiming } from '@/hooks/useWidgetIdentity';
import { useWidgetPlatformPublicSettings, type PreChatPolicy } from '@/hooks/useWidgetPlatformSettings';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { User, Mail, Phone, ShieldCheck, Lock, Info, Clock, Sparkles, UserCheck, EyeOff, FileLock2 } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { defaultPrechatRow, privacyPolicyUrl, PRIVACY_NOTICE_MAX, PRIVACY_URL_MAX } from '../../../../shared/prechatPolicy';


interface Props {
  workspaceId: string | undefined;
}

type FieldKey = 'name' | 'email' | 'phone';

const FIELD_META: Record<FieldKey, { icon: React.ComponentType<{ className?: string }> }> = {
  name: { icon: User },
  email: { icon: Mail },
  phone: { icon: Phone },
};

/**
 * Resolves how a platform-level PreChatPolicy constrains the workspace toggle:
 *  - force_on  → ask=ON locked, require=ON locked
 *  - force_off → ask=OFF locked (require irrelevant)
 *  - default_* → workspace can override freely
 */
function resolveLock(policy: PreChatPolicy | undefined) {
  if (policy === 'force_on') return { askLocked: true, askValue: true, requireLocked: true, requireValue: true, labelKey: 'forcedOn' as const };
  if (policy === 'force_off') return { askLocked: true, askValue: false, requireLocked: true, requireValue: false, labelKey: 'forcedOff' as const };
  return { askLocked: false, askValue: undefined, requireLocked: false, requireValue: undefined, labelKey: null };
}

export function PrechatSection({ workspaceId }: Props) {
  const { t, dir } = useTranslation();
  const { data: settings, isLoading } = useWidgetPrechatSettings(workspaceId);
  // The public projection: workspace owners are not platform admins.
  const { data: platform } = useWidgetPlatformPublicSettings();
  const updateMut = useUpdateWidgetPrechatSettings(workspaceId);

  const update = (patch: Partial<WidgetPrechatSettings>) => {
    updateMut.mutate(patch, {
      onSuccess: () => toast({ title: t('widgetPage.prechat.saved'), description: t('widgetPage.prechat.savedDescription') }),
      onError: (e: Error) => toast({ title: t('common.error'), description: e.message, variant: 'destructive' }),
    });
  };

  if (isLoading) return <div dir={dir} className="text-sm text-muted-foreground">{t('widgetPage.loading')}</div>;

  const policyByField: Record<FieldKey, PreChatPolicy | undefined> = {
    name: platform?.prechat_name_policy,
    email: platform?.prechat_email_policy,
    phone: platform?.prechat_phone_policy,
  };

  // Defaults if no row yet: what the server asks visitors of a workspace
  // that never saved its form (shared/prechatPolicy.ts).
  const s: WidgetPrechatSettings = settings || {
    workspace_id: workspaceId || '',
    ...defaultPrechatRow(policyByField),
    prechat_timing: 'after_handoff',
    history_continue_window_hours: 24,
  };

  const anyFieldAsked = !!(s.ask_name || s.ask_email || s.ask_phone);
  const timing: PrechatTiming = (['always', 'after_handoff', 'never'] as const).includes(s.prechat_timing as PrechatTiming)
    ? (s.prechat_timing as PrechatTiming)
    : 'after_handoff';

  const TIMING_OPTIONS: { value: PrechatTiming; icon: React.ComponentType<{ className?: string }> }[] = [
    { value: 'always', icon: Sparkles },
    { value: 'after_handoff', icon: UserCheck },
    { value: 'never', icon: EyeOff },
  ];

  return (
    <div className="space-y-4" dir={dir}>
      <Card className="card-elevated">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Clock className="h-4 w-4" /> {t('widgetPage.prechat.timingTitle')}
          </CardTitle>
          <CardDescription>{t('widgetPage.prechat.timingDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2.5">
          {TIMING_OPTIONS.map((opt) => {
            const Icon = opt.icon;
            const selected = timing === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                disabled={updateMut.isPending}
                onClick={() => { if (!selected) update({ prechat_timing: opt.value }); }}
                className={`w-full text-start rounded-lg border p-3.5 transition-all flex items-start gap-3 ${
                  selected
                    ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
                    : 'border-border hover:border-primary/40 hover:bg-muted/40'
                } disabled:opacity-60`}
              >
                <div className={`p-2 rounded-lg shrink-0 ${selected ? 'bg-primary/15' : 'bg-muted'}`}>
                  <Icon className={`h-4 w-4 ${selected ? 'text-primary' : 'text-muted-foreground'}`} />
                </div>
                <div className="space-y-0.5">
                  <p className="text-sm font-medium">{t(`widgetPage.prechat.timing_${opt.value}` as TranslationKey)}</p>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    {t(`widgetPage.prechat.timing_${opt.value}_hint` as TranslationKey)}
                  </p>
                </div>
              </button>
            );
          })}
          {timing !== 'never' && !anyFieldAsked && (
            <div className="flex items-start gap-2 bg-amber-500/10 text-amber-700 dark:text-amber-400 rounded-lg p-3 text-xs">
              <Info className="h-4 w-4 mt-0.5 shrink-0" />
              <p>{t('widgetPage.prechat.timingNoFields')}</p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className={`card-elevated transition-opacity ${timing === 'never' ? 'opacity-60' : ''}`}>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">

            <ShieldCheck className="h-4 w-4" /> {t('widgetPage.prechat.title')}
          </CardTitle>
          <CardDescription>
            {t('widgetPage.prechat.description')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {(Object.keys(FIELD_META) as FieldKey[]).map((key) => {
            const meta = FIELD_META[key];
            const fieldLabel = t(`widgetPage.prechat.${key}` as TranslationKey);
            const Icon = meta.icon;
            const lock = resolveLock(policyByField[key]);
            const askField = `ask_${key}` as keyof WidgetPrechatSettings;
            const requireField = `require_${key}` as keyof WidgetPrechatSettings;
            const askValue = lock.askLocked ? lock.askValue! : (s[askField] as boolean);
            const requireValue = lock.requireLocked ? lock.requireValue! : (s[requireField] as boolean);

            return (
              <div key={key} className="rounded-lg border border-border p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <div className="p-2 rounded-lg bg-primary/10">
                      <Icon className="h-4 w-4 text-primary" />
                    </div>
                    <Label className="text-sm font-medium">{fieldLabel}</Label>
                    {lock.askLocked && (
                      <Badge variant="destructive" className="gap-1 text-[10px]">
                        <Lock className="h-3 w-3" /> {lock.labelKey ? t(`widgetPage.prechat.${lock.labelKey}` as TranslationKey) : ''}
                      </Badge>
                    )}
                  </div>
                  <Switch
                    checked={askValue}
                    disabled={lock.askLocked || updateMut.isPending}
                    // A field that is not asked is never required (the server
                    // and the widget read it so too): turning one off clears both.
                    onCheckedChange={(v) => update((v ? { [askField]: true } : { [askField]: false, [requireField]: false }) as Partial<WidgetPrechatSettings>)}
                  />
                </div>

                {askValue && (
                  <div className="ms-11 space-y-2 pt-1">
                    <div className="flex items-center justify-between">
                      <Label className="text-xs text-muted-foreground">{t('widgetPage.prechat.required')}</Label>
                      <Switch
                        checked={requireValue}
                        disabled={lock.requireLocked || updateMut.isPending}
                        onCheckedChange={(v) => update({ [requireField]: v } as Partial<WidgetPrechatSettings>)}
                      />
                    </div>
                    {/* OTP verification toggles removed by product decision. */}

                  </div>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* The privacy line of the pre-chat and leave-a-message forms (P-01,
          migration 281): shown only once the database has its columns (or
          before the first save, when there is no row to tell). */}
      {(!settings || 'privacy_notice_enabled' in settings) && (
        <PrivacyNoticeCard settings={s} busy={updateMut.isPending} onChange={update} />
      )}

      {/* Conversation-continuity window removed: an identified visitor with a
          valid cookie always resumes (platform-fixed 30-day history window). */}


      <div className="flex items-start gap-2 bg-muted/40 rounded-lg p-3 text-xs text-muted-foreground">
        <Info className="h-4 w-4 mt-0.5 shrink-0" />
        <p>
          {t('widgetPage.prechat.adminNote')}
        </p>
      </div>
    </div>
  );
}

/**
 * The privacy line the widget draws above the pre-chat and leave-a-message
 * forms' button in every template (runtime.js identity.privacyInto): the
 * owner's text (or the widget's own sentence), the policy link and an
 * optional consent box. Texts are saved when the field is left.
 */
function PrivacyNoticeCard({ settings, busy, onChange }: {
  settings: WidgetPrechatSettings;
  busy: boolean;
  onChange: (patch: Partial<WidgetPrechatSettings>) => void;
}) {
  const { t } = useTranslation();
  const enabled = settings.privacy_notice_enabled === true;
  const [text, setText] = useState(settings.privacy_notice_text ?? '');
  const [url, setUrl] = useState(settings.privacy_policy_url ?? '');
  useEffect(() => { setText(settings.privacy_notice_text ?? ''); }, [settings.privacy_notice_text]);
  useEffect(() => { setUrl(settings.privacy_policy_url ?? ''); }, [settings.privacy_policy_url]);
  const urlInvalid = url.trim() !== '' && privacyPolicyUrl(url) === null;

  return (
    <Card className="card-elevated">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <FileLock2 className="h-4 w-4" /> {t('widgetPage.prechat.privacyTitle')}
        </CardTitle>
        <CardDescription>{t('widgetPage.prechat.privacyDescription')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="prechat-privacy-enabled" className="text-sm font-medium">{t('widgetPage.prechat.privacyEnable')}</Label>
          <Switch
            id="prechat-privacy-enabled"
            checked={enabled}
            disabled={busy}
            onCheckedChange={(v) => onChange({ privacy_notice_enabled: v })}
          />
        </div>
        {enabled && (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="prechat-privacy-text" className="text-xs">{t('widgetPage.prechat.privacyText')}</Label>
              <Input
                id="prechat-privacy-text"
                value={text}
                maxLength={PRIVACY_NOTICE_MAX}
                onChange={(e) => setText(e.target.value)}
                onBlur={() => {
                  const next = text.replace(/\s+/g, ' ').trim();
                  if (next !== (settings.privacy_notice_text ?? '')) onChange({ privacy_notice_text: next || null });
                }}
              />
              <p className="text-xs text-muted-foreground">{t('widgetPage.prechat.privacyTextHint')}</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="prechat-privacy-url" className="text-xs">{t('widgetPage.prechat.privacyUrl')}</Label>
              <Input
                id="prechat-privacy-url"
                dir="ltr"
                type="url"
                inputMode="url"
                placeholder="https://"
                value={url}
                maxLength={PRIVACY_URL_MAX}
                aria-invalid={urlInvalid}
                onChange={(e) => setUrl(e.target.value)}
                onBlur={() => {
                  const next = url.trim();
                  if (urlInvalid || next === (settings.privacy_policy_url ?? '')) return;
                  onChange({ privacy_policy_url: next || null });
                }}
              />
              <p className={`text-xs ${urlInvalid ? 'text-destructive' : 'text-muted-foreground'}`}>
                {urlInvalid ? t('widgetPage.prechat.privacyUrlInvalid') : t('widgetPage.prechat.privacyUrlHint')}
              </p>
            </div>
            <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-3">
              <div className="space-y-0.5">
                <Label htmlFor="prechat-privacy-consent" className="text-sm">{t('widgetPage.prechat.privacyConsent')}</Label>
                <p className="text-xs text-muted-foreground">{t('widgetPage.prechat.privacyConsentHint')}</p>
              </div>
              <Switch
                id="prechat-privacy-consent"
                checked={settings.privacy_consent_required === true}
                disabled={busy}
                onCheckedChange={(v) => onChange({ privacy_consent_required: v })}
              />
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
