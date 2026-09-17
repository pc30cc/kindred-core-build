/**
 * Notification copy, per event type and per language.
 *
 * Two variants per event: the normal copy, and the copy used when the
 * recipient turned previews off. The private variant is not cosmetic — it is
 * the text that reaches a locked screen, so it must never contain the message
 * body. The live preview renders both with sample values.
 */
import { Languages, Eye, EyeOff } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useTranslation, type TranslationKey } from '@/i18n';
import { SettingsSection } from '@/components/admin/settings/SettingsFields';
import type { PushEventType, PushPlatformSettings, PushTemplate } from '@/hooks/useAdminNotifications';

const EVENT_TYPES: PushEventType[] = ['new_message', 'internal_note', 'mention'];
const LOCALES = ['en', 'fa', 'tr'] as const;

/** `{{name}}` → sample value; an unknown placeholder is left visible. */
function render(text: string, sample: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    key in sample ? sample[key] : match,
  );
}

export function NotificationTemplatesTab({
  draft,
  set,
}: {
  draft: PushPlatformSettings;
  set: (patch: Partial<PushPlatformSettings>) => void;
}) {
  const { t } = useTranslation();

  // The preview is judged in the reader's own language, so the sample values
  // are translated too rather than pinned to English names.
  const sample = {
    sender: t('admin.notifications.templates.sampleSender'),
    preview: t('admin.notifications.templates.samplePreview'),
    count: '1',
  };

  const update = (eventType: string, patch: Partial<PushTemplate>) =>
    set({
      templates: {
        ...draft.templates,
        [eventType]: { ...(draft.templates?.[eventType] ?? { title: {}, body: {} }), ...patch },
      },
    });

  return (
    <div className="space-y-4">
      <p className="rounded-xl bg-muted/60 p-3 text-xs text-muted-foreground">
        {t('admin.notifications.templates.variables')}
      </p>

      {EVENT_TYPES.map((eventType) => {
        const template = draft.templates?.[eventType] ?? { title: {}, body: {} };
        return (
          <SettingsSection
            key={eventType}
            icon={Languages}
            heading={t(`admin.notifications.events.${eventType}` as TranslationKey)}
            caption={t(`admin.notifications.templates.caption.${eventType}` as TranslationKey)}
          >
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <Eye className="h-3.5 w-3.5" />
                {t('admin.notifications.templates.publicVariant')}
              </div>
              {LOCALES.map((locale) => (
                <div key={locale} className="grid gap-2 sm:grid-cols-2">
                  <div className="grid gap-1">
                    <Label className="text-xs">
                      {t('admin.notifications.templates.titleFor', {
                        language: t(`admin.brandingPage.languages.${locale}` as TranslationKey),
                      })}
                    </Label>
                    <Input
                      value={template.title?.[locale] ?? ''}
                      onChange={(e) =>
                        update(eventType, {
                          title: { ...template.title, [locale]: e.target.value },
                        })
                      }
                    />
                  </div>
                  <div className="grid gap-1">
                    <Label className="text-xs">
                      {t('admin.notifications.templates.bodyFor', {
                        language: t(`admin.brandingPage.languages.${locale}` as TranslationKey),
                      })}
                    </Label>
                    <Input
                      value={template.body?.[locale] ?? ''}
                      onChange={(e) =>
                        update(eventType, {
                          body: { ...template.body, [locale]: e.target.value },
                        })
                      }
                    />
                  </div>
                </div>
              ))}

              <div className="flex items-center gap-2 pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <EyeOff className="h-3.5 w-3.5" />
                {t('admin.notifications.templates.privateVariant')}
              </div>
              <p className="text-xs text-muted-foreground">
                {t('admin.notifications.templates.privateHint')}
              </p>
              {LOCALES.map((locale) => (
                <div key={locale} className="grid gap-2 sm:grid-cols-2">
                  <div className="grid gap-1">
                    <Label className="text-xs">
                      {t('admin.notifications.templates.titleFor', {
                        language: t(`admin.brandingPage.languages.${locale}` as TranslationKey),
                      })}
                    </Label>
                    <Input
                      value={template.privateTitle?.[locale] ?? ''}
                      onChange={(e) =>
                        update(eventType, {
                          privateTitle: { ...(template.privateTitle ?? {}), [locale]: e.target.value },
                        })
                      }
                    />
                  </div>
                  <div className="grid gap-1">
                    <Label className="text-xs">
                      {t('admin.notifications.templates.bodyFor', {
                        language: t(`admin.brandingPage.languages.${locale}` as TranslationKey),
                      })}
                    </Label>
                    <Input
                      value={template.privateBody?.[locale] ?? ''}
                      onChange={(e) =>
                        update(eventType, {
                          privateBody: { ...(template.privateBody ?? {}), [locale]: e.target.value },
                        })
                      }
                    />
                  </div>
                </div>
              ))}

              <NotificationPreview
                title={render(template.title?.en ?? '', sample)}
                body={render(template.body?.en ?? '', sample)}
                appName={t('admin.notifications.templates.previewApp')}
                now={t('admin.notifications.templates.previewNow')}
              />
            </div>
          </SettingsSection>
        );
      })}
    </div>
  );
}

/** An iOS-shaped banner so the copy is judged where it will be read. */
function NotificationPreview({
  title,
  body,
  appName,
  now,
}: {
  title: string;
  body: string;
  appName: string;
  now: string;
}) {
  return (
    <div className="rounded-2xl bg-gradient-to-br from-slate-700 to-slate-900 p-4">
      <div className="mx-auto max-w-sm rounded-[18px] bg-white/90 p-3 shadow-lg backdrop-blur-xl dark:bg-zinc-800/90">
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] bg-primary text-[11px] font-bold text-primary-foreground">
            {appName.slice(0, 2).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-semibold text-zinc-900 dark:text-zinc-50">
              {title || appName}
            </p>
            <p className="line-clamp-2 text-[13px] leading-snug text-zinc-700 dark:text-zinc-300">
              {body}
            </p>
          </div>
          <span className="shrink-0 text-[11px] text-zinc-500">{now}</span>
        </div>
      </div>
    </div>
  );
}
