/**
 * Capabilities and entitlements. Each switch here adds a real entitlement to
 * `ios/App/App/App.entitlements` — enabling one that the App ID does not
 * carry in the Apple Developer portal fails the build, which is exactly why
 * the hints name the portal step next to each toggle.
 */
import { Bell, KeyRound, ToggleRight, Camera } from 'lucide-react';
import { useTranslation } from '@/i18n';
import {
  SettingsSection, FieldGrid, SwitchField, TextField,
} from '@/components/admin/settings/SettingsFields';
import type { MobileAppPayload, MobileAppSettings } from '@/hooks/useMobileApp';

export function MobileCapabilitiesTab({
  draft,
  set,
  environment,
}: {
  draft: MobileAppSettings;
  set: (patch: Partial<MobileAppSettings>) => void;
  environment: MobileAppPayload['environment'];
}) {
  const { t } = useTranslation();

  return (
    <div className="space-y-4">
      <SettingsSection
        icon={Bell}
        heading={t('admin.mobileApp.capabilities.push')}
        caption={t('admin.mobileApp.capabilities.pushHint')}
      >
        <FieldGrid>
          <SwitchField
            label={t('admin.mobileApp.capabilities.pushNotifications')}
            hint={t('admin.mobileApp.capabilities.pushNotificationsHint')}
            checked={draft.cap_push_notifications}
            onChange={(cap_push_notifications) => set({ cap_push_notifications })}
          />
          <SwitchField
            label={t('admin.mobileApp.capabilities.backgroundRemote')}
            hint={t('admin.mobileApp.capabilities.backgroundRemoteHint')}
            checked={draft.cap_background_remote_notifications}
            onChange={(value) => set({ cap_background_remote_notifications: value })}
            disabled={!draft.cap_push_notifications}
          />
          <SwitchField
            label={t('admin.mobileApp.capabilities.backgroundFetch')}
            hint={t('admin.mobileApp.capabilities.backgroundFetchHint')}
            checked={draft.cap_background_fetch}
            onChange={(cap_background_fetch) => set({ cap_background_fetch })}
          />
        </FieldGrid>
        {draft.cap_push_notifications && !environment.pushConfigured && (
          <p className="rounded-xl bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
            {t('admin.mobileApp.capabilities.pushNotConfigured')}
          </p>
        )}
      </SettingsSection>

      <SettingsSection
        icon={Camera}
        heading={t('admin.mobileApp.capabilities.device')}
        caption={t('admin.mobileApp.capabilities.deviceHint')}
      >
        <FieldGrid>
          <SwitchField
            label={t('admin.mobileApp.capabilities.camera')}
            hint={t('admin.mobileApp.capabilities.cameraHint')}
            checked={draft.cap_camera}
            onChange={(cap_camera) => set({ cap_camera })}
          />
          <SwitchField
            label={t('admin.mobileApp.capabilities.microphone')}
            hint={t('admin.mobileApp.capabilities.microphoneHint')}
            checked={draft.cap_microphone}
            onChange={(cap_microphone) => set({ cap_microphone })}
          />
          <SwitchField
            label={t('admin.mobileApp.capabilities.photoLibrary')}
            hint={t('admin.mobileApp.capabilities.photoLibraryHint')}
            checked={draft.cap_photo_library}
            onChange={(cap_photo_library) => set({ cap_photo_library })}
          />
          <SwitchField
            label={t('admin.mobileApp.capabilities.location')}
            hint={t('admin.mobileApp.capabilities.locationHint')}
            checked={draft.cap_location}
            onChange={(cap_location) => set({ cap_location })}
          />
          <SwitchField
            label={t('admin.mobileApp.capabilities.faceId')}
            hint={t('admin.mobileApp.capabilities.faceIdHint')}
            checked={draft.cap_face_id}
            onChange={(cap_face_id) => set({ cap_face_id })}
          />
        </FieldGrid>
      </SettingsSection>

      <SettingsSection
        icon={KeyRound}
        heading={t('admin.mobileApp.capabilities.entitlements')}
        caption={t('admin.mobileApp.capabilities.entitlementsHint')}
      >
        <FieldGrid>
          <SwitchField
            label={t('admin.mobileApp.capabilities.associatedDomains')}
            hint={t('admin.mobileApp.capabilities.associatedDomainsHint')}
            checked={draft.cap_associated_domains}
            onChange={(cap_associated_domains) => set({ cap_associated_domains })}
          />
          <SwitchField
            label={t('admin.mobileApp.capabilities.keychainSharing')}
            hint={t('admin.mobileApp.capabilities.keychainSharingHint')}
            checked={draft.cap_keychain_sharing}
            onChange={(cap_keychain_sharing) => set({ cap_keychain_sharing })}
          />
          <SwitchField
            label={t('admin.mobileApp.capabilities.signInWithApple')}
            hint={t('admin.mobileApp.capabilities.signInWithAppleHint')}
            checked={draft.cap_sign_in_with_apple}
            onChange={(cap_sign_in_with_apple) => set({ cap_sign_in_with_apple })}
          />
          <SwitchField
            label={t('admin.mobileApp.capabilities.appGroups')}
            hint={t('admin.mobileApp.capabilities.appGroupsHint')}
            checked={draft.cap_app_groups}
            onChange={(cap_app_groups) => set({ cap_app_groups })}
          />
        </FieldGrid>
        {draft.cap_app_groups && (
          <TextField
            label={t('admin.mobileApp.capabilities.appGroupId')}
            hint={t('admin.mobileApp.capabilities.appGroupIdHint')}
            value={draft.app_group_id ?? ''}
            dir="ltr"
            onChange={(value) => set({ app_group_id: value || null })}
          />
        )}
      </SettingsSection>
    </div>
  );
}
