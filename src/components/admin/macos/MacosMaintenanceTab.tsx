/**
 * Super Admin → macOS app → Maintenance & links.
 *
 * A maintenance notice every Mac shows at the top of the app (planned
 * downtime, a known incident), with an optional end time after which Macs
 * stop showing it by themselves, and the help links the app offers its
 * operators. The server refuses a notice that is switched on with nothing to
 * say, so the same rule is enforced here before Save is allowed.
 */
import { useState } from 'react';
import { Wrench, Link2, Clock, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { useTranslation, type TranslationKey } from '@/i18n';
import {
  SettingsSection, FieldGrid, TextField, TextAreaField, SwitchField,
} from '@/components/admin/settings/SettingsFields';
import {
  MACOS_LIMITS,
  MACOS_MESSAGE_LOCALES,
  type MacMessageLocale,
  type MacosAppSettings,
} from '@/hooks/useMacosApp';
import {
  fromLocalInput,
  hasMaintenanceMessage,
  isHttpsOrEmpty,
  isValidDateOrEmpty,
  toLocalInput,
} from './macosModel';
import { MacosNote } from './MacosNote';
import { cn } from '@/lib/utils';

type Props = {
  draft: MacosAppSettings;
  set: (patch: Partial<MacosAppSettings>) => void;
};

const LINKS = [
  { key: 'support_url', copy: 'support' },
  { key: 'status_page_url', copy: 'status' },
  { key: 'privacy_url', copy: 'privacy' },
  { key: 'terms_url', copy: 'terms' },
] as const;

export function MacosMaintenanceTab({ draft, set }: Props) {
  const { t } = useTranslation();
  const message = draft.maintenance_message;
  const missingMessage = draft.maintenance_enabled && !hasMaintenanceMessage(message);
  const untilPassed = !!draft.maintenance_until && Date.parse(draft.maintenance_until) <= Date.now();

  const setMessage = (locale: MacMessageLocale, value: string) => {
    const next = { ...message };
    // An emptied language is dropped rather than stored as "", as the server does.
    if (value) next[locale] = value;
    else delete next[locale];
    set({ maintenance_message: next });
  };

  return (
    <div className="space-y-4">
      <SettingsSection
        icon={Wrench}
        heading={t('admin.macosApp.maintenance.title')}
        caption={t('admin.macosApp.maintenance.caption')}
      >
        <FieldGrid>
          <SwitchField
            label={t('admin.macosApp.maintenance.enabled')}
            hint={t('admin.macosApp.maintenance.enabledHint')}
            checked={draft.maintenance_enabled}
            onChange={(maintenance_enabled) => set({ maintenance_enabled })}
          />
          <div className="grid gap-1.5">
            <TextField
              type="datetime-local"
              label={t('admin.macosApp.maintenance.until')}
              hint={t('admin.macosApp.maintenance.untilHint')}
              value={toLocalInput(draft.maintenance_until)}
              dir="ltr"
              invalid={!isValidDateOrEmpty(draft.maintenance_until)}
              onChange={(value) => set({ maintenance_until: fromLocalInput(value) })}
            />
            {draft.maintenance_until && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 w-fit px-2 text-xs"
                onClick={() => set({ maintenance_until: null })}
              >
                <X className="me-1 h-3.5 w-3.5" />
                {t('admin.macosApp.maintenance.clearUntil')}
              </Button>
            )}
          </div>
        </FieldGrid>

        {draft.maintenance_enabled && untilPassed && (
          <MacosNote tone="warning">{t('admin.macosApp.maintenance.untilPast')}</MacosNote>
        )}

        <div className="grid gap-3">
          <div>
            <Label>{t('admin.macosApp.maintenance.messagesTitle')}</Label>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('admin.macosApp.maintenance.messagesHint')}</p>
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            {MACOS_MESSAGE_LOCALES.map((locale) => (
              <TextAreaField
                key={locale}
                label={t(`admin.macosApp.maintenance.message.${locale}` as TranslationKey)}
                value={message[locale] ?? ''}
                rows={4}
                dir={locale === 'fa' ? 'rtl' : 'ltr'}
                counter={MACOS_LIMITS.maintenanceMessage}
                invalid={missingMessage || (message[locale] ?? '').trim().length > MACOS_LIMITS.maintenanceMessage}
                onChange={(value) => setMessage(locale, value)}
              />
            ))}
          </div>
          {missingMessage && (
            <p className="text-xs font-medium text-destructive">{t('admin.macosApp.maintenance.messageRequired')}</p>
          )}
        </div>

        <MaintenancePreview draft={draft} />
      </SettingsSection>

      <SettingsSection
        icon={Link2}
        heading={t('admin.macosApp.maintenance.linksTitle')}
        caption={t('admin.macosApp.maintenance.linksCaption')}
      >
        <FieldGrid>
          {LINKS.map(({ key, copy }) => (
            <TextField
              key={key}
              label={t(`admin.macosApp.maintenance.links.${copy}` as TranslationKey)}
              hint={t('admin.macosApp.maintenance.httpsHint')}
              value={draft[key] ?? ''}
              placeholder="https://"
              dir="ltr"
              maxLength={MACOS_LIMITS.url}
              invalid={!isHttpsOrEmpty(draft[key])}
              onChange={(value) => set({ [key]: value || null } as Partial<MacosAppSettings>)}
            />
          ))}
        </FieldGrid>
      </SettingsSection>
    </div>
  );
}

/**
 * How the notice will look at the top of the Mac app's window, one language
 * at a time. Starts on the admin's own language when it has text, else the
 * first language that does.
 */
function MaintenancePreview({ draft }: { draft: MacosAppSettings }) {
  const { t, locale: uiLocale } = useTranslation();
  const message = draft.maintenance_message;
  const initial =
    (MACOS_MESSAGE_LOCALES.includes(uiLocale as MacMessageLocale) && message[uiLocale as MacMessageLocale]
      ? (uiLocale as MacMessageLocale)
      : MACOS_MESSAGE_LOCALES.find((l) => message[l])) ?? 'fa';
  const [locale, setLocale] = useState<MacMessageLocale>(initial);
  const text = (message[locale] ?? '').trim();
  const until = draft.maintenance_until && !Number.isNaN(Date.parse(draft.maintenance_until))
    ? new Date(draft.maintenance_until)
    : null;

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label>{t('admin.macosApp.maintenance.preview')}</Label>
        <div className="inline-flex rounded-lg border border-border/70 p-0.5">
          {MACOS_MESSAGE_LOCALES.map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => setLocale(l)}
              className={cn(
                'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                l === locale ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted',
              )}
            >
              {t(`admin.macosApp.maintenance.message.${l}` as TranslationKey)}
            </button>
          ))}
        </div>
      </div>

      {/* A stylised Mac window: traffic lights, then the notice strip as the app draws it. */}
      <div className={cn('overflow-hidden rounded-xl border border-border/70 bg-muted/30', !draft.maintenance_enabled && 'opacity-60')}>
        <div className="flex items-center gap-1.5 border-b border-border/60 bg-muted/60 px-3 py-2" dir="ltr">
          <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
        </div>
        <div
          dir={locale === 'fa' ? 'rtl' : 'ltr'}
          className="flex items-start gap-3 border-b border-amber-500/30 bg-amber-500/10 px-4 py-3 text-amber-900 dark:text-amber-100"
        >
          <Wrench className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <div className="min-w-0 flex-1 space-y-1">
            {text ? (
              <p className="whitespace-pre-line text-sm">{text}</p>
            ) : (
              <p className="text-sm italic opacity-70">{t('admin.macosApp.maintenance.previewEmpty')}</p>
            )}
            {until && (
              <p className="flex items-center gap-1 text-xs opacity-80">
                <Clock className="h-3 w-3" />
                <span dir="auto">{until.toLocaleString(locale === 'fa' ? 'fa-IR' : locale)}</span>
              </p>
            )}
          </div>
        </div>
        <div className="h-16" />
      </div>
      {!draft.maintenance_enabled && (
        <p className="text-xs text-muted-foreground">{t('admin.macosApp.maintenance.previewOff')}</p>
      )}
    </div>
  );
}
