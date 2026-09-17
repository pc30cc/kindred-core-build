/**
 * iOS notification categories and their action buttons.
 *
 * A category id is what turns a plain banner into one with "Reply" and "Mark
 * as read": the server attaches it to the payload, and the app registers the
 * matching `UNNotificationCategory`. Both halves have to agree, so an id
 * edited here must also exist in the app build — the note at the top says so.
 */
import { Layers, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useTranslation, type TranslationKey } from '@/i18n';
import { SettingsSection, FieldGrid } from '@/components/admin/settings/SettingsFields';
import type {
  PushCategory, PushCategoryAction, PushEventType, PushPlatformSettings,
} from '@/hooks/useAdminNotifications';

const EVENT_TYPES: PushEventType[] = ['new_message', 'internal_note', 'mention'];
const LOCALES = ['en', 'fa', 'tr'] as const;

export function NotificationCategoriesTab({
  draft,
  set,
}: {
  draft: PushPlatformSettings;
  set: (patch: Partial<PushPlatformSettings>) => void;
}) {
  const { t } = useTranslation();

  const update = (index: number, patch: Partial<PushCategory>) => {
    const next = draft.categories.map((category, i) =>
      i === index ? { ...category, ...patch } : category,
    );
    set({ categories: next });
  };

  const addCategory = () =>
    set({
      categories: [
        ...draft.categories,
        { id: 'NEW_CATEGORY', eventTypes: ['new_message'], actions: [] },
      ],
    });

  return (
    <div className="space-y-4">
      <p className="rounded-xl bg-muted/60 p-3 text-xs text-muted-foreground">
        {t('admin.notifications.categories.contract')}
      </p>

      {draft.categories.map((category, index) => (
        <SettingsSection
          key={index}
          icon={Layers}
          heading={category.id || t('admin.notifications.categories.untitled')}
          caption={t('admin.notifications.categories.caption')}
          action={
            <Button
              size="sm"
              variant="ghost"
              onClick={() => set({ categories: draft.categories.filter((_, i) => i !== index) })}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          }
        >
          <FieldGrid>
            <div className="grid gap-1.5">
              <Label>{t('admin.notifications.categories.id')}</Label>
              <Input
                dir="ltr"
                value={category.id}
                onChange={(e) => update(index, { id: e.target.value.toUpperCase() })}
              />
              <p className="text-xs text-muted-foreground">
                {t('admin.notifications.categories.idHint')}
              </p>
            </div>
            <div className="grid gap-1.5">
              <Label>{t('admin.notifications.categories.eventTypes')}</Label>
              <div className="space-y-2">
                {EVENT_TYPES.map((eventType) => (
                  <label key={eventType} className="flex items-center justify-between gap-3 text-sm">
                    <span>{t(`admin.notifications.events.${eventType}` as TranslationKey)}</span>
                    <Switch
                      checked={category.eventTypes.includes(eventType)}
                      onCheckedChange={(on) =>
                        update(index, {
                          eventTypes: on
                            ? [...category.eventTypes, eventType]
                            : category.eventTypes.filter((entry) => entry !== eventType),
                        })
                      }
                    />
                  </label>
                ))}
              </div>
            </div>
          </FieldGrid>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label>{t('admin.notifications.categories.actions')}</Label>
              <Button
                size="sm"
                variant="outline"
                // iOS shows at most four actions on an expanded banner.
                disabled={category.actions.length >= 4}
                onClick={() =>
                  update(index, {
                    actions: [
                      ...category.actions,
                      {
                        id: 'ACTION',
                        titles: { default: '' },
                        foreground: true,
                        destructive: false,
                        textInput: false,
                      },
                    ],
                  })
                }
              >
                <Plus className="me-1.5 h-3.5 w-3.5" />
                {t('admin.notifications.categories.addAction')}
              </Button>
            </div>
            {category.actions.length === 0 && (
              <p className="text-sm text-muted-foreground">
                {t('admin.notifications.categories.noActions')}
              </p>
            )}
            {category.actions.map((action, actionIndex) => (
              <ActionEditor
                key={actionIndex}
                action={action}
                onChange={(patch) =>
                  update(index, {
                    actions: category.actions.map((entry, i) =>
                      i === actionIndex ? { ...entry, ...patch } : entry,
                    ),
                  })
                }
                onRemove={() =>
                  update(index, {
                    actions: category.actions.filter((_, i) => i !== actionIndex),
                  })
                }
              />
            ))}
          </div>
        </SettingsSection>
      ))}

      <Button variant="outline" onClick={addCategory} disabled={draft.categories.length >= 10}>
        <Plus className="me-1.5 h-4 w-4" />
        {t('admin.notifications.categories.addCategory')}
      </Button>
    </div>
  );
}

function ActionEditor({
  action,
  onChange,
  onRemove,
}: {
  action: PushCategoryAction;
  onChange: (patch: Partial<PushCategoryAction>) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3 rounded-xl border border-border/70 p-3">
      <div className="flex items-center gap-2">
        <Input
          dir="ltr"
          className="max-w-[200px]"
          value={action.id}
          onChange={(e) => onChange({ id: e.target.value.toUpperCase() })}
        />
        <Button size="sm" variant="ghost" onClick={onRemove}>
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        {LOCALES.map((locale) => (
          <div key={locale} className="grid gap-1">
            <Label className="text-xs">{t(`admin.brandingPage.languages.${locale}` as TranslationKey)}</Label>
            <Input
              value={action.titles?.[locale] ?? ''}
              onChange={(e) =>
                onChange({
                  titles: {
                    ...action.titles,
                    [locale]: e.target.value,
                    // `default` backs any locale that has no translation.
                    default: action.titles?.default || e.target.value,
                  },
                })
              }
            />
          </div>
        ))}
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        <label className="flex items-center justify-between gap-2 text-xs">
          <span>{t('admin.notifications.categories.foreground')}</span>
          <Switch
            checked={action.foreground}
            onCheckedChange={(foreground) => onChange({ foreground })}
          />
        </label>
        <label className="flex items-center justify-between gap-2 text-xs">
          <span>{t('admin.notifications.categories.destructive')}</span>
          <Switch
            checked={action.destructive}
            onCheckedChange={(destructive) => onChange({ destructive })}
          />
        </label>
        <label className="flex items-center justify-between gap-2 text-xs">
          <span>{t('admin.notifications.categories.textInput')}</span>
          <Switch
            checked={action.textInput}
            onCheckedChange={(textInput) => onChange({ textInput })}
          />
        </label>
      </div>
    </div>
  );
}
