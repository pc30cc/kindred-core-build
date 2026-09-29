/**
 * How the installed Android app behaves — applied live.
 *
 * The app reads these from `GET /api/mobile-app/config` when it signs in and
 * whenever it comes back to the foreground, so a switch flipped here reaches
 * every phone without a new build or a Play release. Each switch ships at
 * the value the app already behaved with, except the name on the profile,
 * which is read-only unless allowed here.
 *
 * The default language and the maintenance notice are needed before anyone
 * signs in, so the app also reads those two from the public
 * `GET /api/mobile-app/public-config?platform=android`.
 */
import { Languages, LayoutGrid, Settings2, UserRound, Wrench, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { useTranslation, type TranslationKey } from '@/i18n';
import {
  SettingsSection, FieldGrid, SwitchField, SelectField, TextField, TextAreaField,
} from '@/components/admin/settings/SettingsFields';
import { fromLocalInput, isValidDateOrEmpty, toLocalInput } from '@/components/admin/macos/macosModel';
import { MacosNote } from '@/components/admin/macos/MacosNote';
import {
  ANDROID_LANGUAGES,
  ANDROID_MAINTENANCE_MESSAGE_MAX,
  type AndroidLanguage,
  type MobileAppSettings,
} from '@/hooks/useMobileApp';

export function AndroidInAppTab({
  draft,
  set,
}: {
  draft: MobileAppSettings;
  set: (patch: Partial<MobileAppSettings>) => void;
}) {
  const { t } = useTranslation();
  const message = draft.android_maintenance_message;
  const until = draft.android_maintenance_until;
  const untilPassed = !!until && Date.parse(until) <= Date.now();

  const setMessage = (language: AndroidLanguage, value: string) => {
    const next = { ...message };
    // An emptied language is dropped rather than stored as "", as the server does.
    if (value) next[language] = value;
    else delete next[language];
    set({ android_maintenance_message: next });
  };

  return (
    <div className="space-y-4">
      <SettingsSection
        icon={Settings2}
        heading={t('admin.mobileApp.android.inApp.settingsHeading')}
        caption={t('admin.mobileApp.android.inApp.settingsCaption')}
      >
        <FieldGrid>
          <SwitchField
            label={t('admin.mobileApp.android.inApp.showStorage')}
            hint={t('admin.mobileApp.android.inApp.showStorageHint')}
            checked={draft.android_app_show_storage}
            onChange={(android_app_show_storage) => set({ android_app_show_storage })}
          />
          <SwitchField
            label={t('admin.mobileApp.android.inApp.showSecurity')}
            hint={t('admin.mobileApp.android.inApp.showSecurityHint')}
            checked={draft.android_app_show_security}
            onChange={(android_app_show_security) => set({ android_app_show_security })}
          />
          <SwitchField
            label={t('admin.mobileApp.android.inApp.showNotificationSettings')}
            hint={t('admin.mobileApp.android.inApp.showNotificationSettingsHint')}
            checked={draft.android_app_show_notification_settings}
            onChange={(android_app_show_notification_settings) => set({ android_app_show_notification_settings })}
          />
          <SwitchField
            label={t('admin.mobileApp.android.inApp.allowWallpaperColors')}
            hint={t('admin.mobileApp.android.inApp.allowWallpaperColorsHint')}
            checked={draft.android_app_allow_wallpaper_colors}
            onChange={(android_app_allow_wallpaper_colors) => set({ android_app_allow_wallpaper_colors })}
          />
        </FieldGrid>
      </SettingsSection>

      <SettingsSection
        icon={LayoutGrid}
        heading={t('admin.mobileApp.android.inApp.tabsHeading')}
        caption={t('admin.mobileApp.android.inApp.tabsCaption')}
      >
        <FieldGrid>
          <SwitchField
            label={t('admin.mobileApp.android.inApp.showVisitors')}
            hint={t('admin.mobileApp.android.inApp.showVisitorsHint')}
            checked={draft.android_app_show_visitors}
            onChange={(android_app_show_visitors) => set({ android_app_show_visitors })}
          />
          <SwitchField
            label={t('admin.mobileApp.android.inApp.showWebAnalytics')}
            hint={t('admin.mobileApp.android.inApp.showWebAnalyticsHint')}
            checked={draft.android_app_show_web_analytics}
            onChange={(android_app_show_web_analytics) => set({ android_app_show_web_analytics })}
          />
        </FieldGrid>
      </SettingsSection>

      <SettingsSection
        icon={UserRound}
        heading={t('admin.mobileApp.android.inApp.profileHeading')}
        caption={t('admin.mobileApp.android.inApp.profileCaption')}
      >
        <FieldGrid>
          <SwitchField
            label={t('admin.mobileApp.android.inApp.profileNameEditable')}
            hint={t('admin.mobileApp.android.inApp.profileNameEditableHint')}
            checked={draft.android_app_profile_name_editable}
            onChange={(android_app_profile_name_editable) => set({ android_app_profile_name_editable })}
          />
          <SwitchField
            label={t('admin.mobileApp.android.inApp.profilePhoneEditable')}
            hint={t('admin.mobileApp.android.inApp.profilePhoneEditableHint')}
            checked={draft.android_app_profile_phone_editable}
            onChange={(android_app_profile_phone_editable) => set({ android_app_profile_phone_editable })}
          />
          <SwitchField
            label={t('admin.mobileApp.android.inApp.profilePhotoEditable')}
            hint={t('admin.mobileApp.android.inApp.profilePhotoEditableHint')}
            checked={draft.android_app_profile_photo_editable}
            onChange={(android_app_profile_photo_editable) => set({ android_app_profile_photo_editable })}
          />
        </FieldGrid>
      </SettingsSection>

      <SettingsSection
        icon={Languages}
        heading={t('admin.mobileApp.android.inApp.languageHeading')}
        caption={t('admin.mobileApp.android.inApp.languageCaption')}
      >
        <FieldGrid>
          <SelectField
            label={t('admin.mobileApp.android.inApp.defaultLanguage')}
            hint={t('admin.mobileApp.android.inApp.defaultLanguageHint')}
            value={draft.android_default_language}
            onChange={(value) => set({ android_default_language: value as AndroidLanguage })}
            options={ANDROID_LANGUAGES.map((language) => ({
              value: language,
              // Each language in its own name, so it can be found whatever this screen is in.
              label: t(`admin.mobileApp.android.inApp.languages.${language}` as TranslationKey),
            }))}
          />
        </FieldGrid>
      </SettingsSection>

      <SettingsSection
        icon={Wrench}
        heading={t('admin.mobileApp.android.inApp.maintenanceHeading')}
        caption={t('admin.mobileApp.android.inApp.maintenanceCaption')}
      >
        <FieldGrid>
          <SwitchField
            label={t('admin.mobileApp.android.inApp.maintenanceEnabled')}
            hint={t('admin.mobileApp.android.inApp.maintenanceEnabledHint')}
            checked={draft.android_maintenance_enabled}
            onChange={(android_maintenance_enabled) => set({ android_maintenance_enabled })}
          />
          <div className="grid gap-1.5">
            <TextField
              type="datetime-local"
              label={t('admin.mobileApp.android.inApp.maintenanceUntil')}
              hint={t('admin.mobileApp.android.inApp.maintenanceUntilHint')}
              value={toLocalInput(until)}
              dir="ltr"
              invalid={!isValidDateOrEmpty(until)}
              onChange={(value) => set({ android_maintenance_until: fromLocalInput(value) })}
            />
            {until && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 w-fit px-2 text-xs"
                onClick={() => set({ android_maintenance_until: null })}
              >
                <X className="me-1 h-3.5 w-3.5" />
                {t('admin.mobileApp.android.inApp.maintenanceClearUntil')}
              </Button>
            )}
          </div>
        </FieldGrid>

        {draft.android_maintenance_enabled && untilPassed && (
          <MacosNote tone="warning">{t('admin.mobileApp.android.inApp.maintenanceUntilPast')}</MacosNote>
        )}

        <div className="grid gap-3">
          <div>
            <Label>{t('admin.mobileApp.android.inApp.maintenanceMessages')}</Label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('admin.mobileApp.android.inApp.maintenanceMessagesHint')}
            </p>
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            {ANDROID_LANGUAGES.map((language) => (
              <TextAreaField
                key={language}
                label={t(`admin.mobileApp.android.inApp.languages.${language}` as TranslationKey)}
                value={message[language] ?? ''}
                rows={4}
                dir={language === 'fa' ? 'rtl' : 'ltr'}
                counter={ANDROID_MAINTENANCE_MESSAGE_MAX}
                invalid={(message[language] ?? '').trim().length > ANDROID_MAINTENANCE_MESSAGE_MAX}
                onChange={(value) => setMessage(language, value)}
              />
            ))}
          </div>
        </div>
      </SettingsSection>
    </div>
  );
}
