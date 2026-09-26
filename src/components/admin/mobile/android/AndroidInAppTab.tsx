/**
 * How the installed Android app behaves — applied live.
 *
 * The app reads these from `GET /api/mobile-app/config` when it signs in and
 * whenever it comes back to the foreground, so a switch flipped here reaches
 * every phone without a new build or a Play release. Each switch ships at
 * the value the app already behaved with, except the name on the profile,
 * which is read-only unless allowed here.
 */
import { Settings2, UserRound } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { SettingsSection, FieldGrid, SwitchField } from '@/components/admin/settings/SettingsFields';
import type { MobileAppSettings } from '@/hooks/useMobileApp';

export function AndroidInAppTab({
  draft,
  set,
}: {
  draft: MobileAppSettings;
  set: (patch: Partial<MobileAppSettings>) => void;
}) {
  const { t } = useTranslation();

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
    </div>
  );
}
