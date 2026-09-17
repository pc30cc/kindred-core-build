/**
 * Privacy: the purpose strings iOS shows in its permission prompts, the App
 * Tracking Transparency declaration, and the two artefacts Apple has required
 * since 2024 — the privacy manifest (required-reason APIs) and the App Store
 * "App Privacy" data declaration.
 *
 * The purpose strings are the single most common rejection in this area: a
 * string that does not say WHY the data is used is rejected under 5.1.1, so
 * the counter and the hints push toward a complete sentence.
 */
import { ShieldCheck, Eye, FileJson } from 'lucide-react';
import { useTranslation, type TranslationKey } from '@/i18n';
import {
  SettingsSection, FieldGrid, TextAreaField, SwitchField, ListField, CodeBlock,
} from '@/components/admin/settings/SettingsFields';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import type { MobileAppSettings } from '@/hooks/useMobileApp';

/** Apple's App Privacy data categories, as declared in App Store Connect. */
const DATA_TYPES = [
  'contactInfo', 'identifiers', 'usageData', 'diagnostics', 'userContent', 'location',
];

export function MobilePrivacyTab({
  draft,
  set,
}: {
  draft: MobileAppSettings;
  set: (patch: Partial<MobileAppSettings>) => void;
}) {
  const { t } = useTranslation();

  const collection = (draft.data_collection ?? {}) as Record<string, unknown>;
  const declaredTypes = Array.isArray(collection.types) ? (collection.types as string[]) : [];

  const toggleType = (value: string, on: boolean) => {
    const next = on ? [...declaredTypes, value] : declaredTypes.filter((entry) => entry !== value);
    set({ data_collection: { ...(draft.data_collection ?? {}), types: next } });
  };

  return (
    <div className="space-y-4">
      <SettingsSection
        icon={ShieldCheck}
        heading={t('admin.mobileApp.privacy.purposeStrings')}
        caption={t('admin.mobileApp.privacy.purposeStringsHint')}
      >
        {draft.cap_camera && (
          <TextAreaField
            label={t('admin.mobileApp.privacy.usageCamera')}
            hint={t('admin.mobileApp.privacy.usageCameraHint')}
            value={draft.usage_camera}
            counter={200}
            onChange={(usage_camera) => set({ usage_camera })}
          />
        )}
        {draft.cap_microphone && (
          <TextAreaField
            label={t('admin.mobileApp.privacy.usageMicrophone')}
            hint={t('admin.mobileApp.privacy.usageMicrophoneHint')}
            value={draft.usage_microphone}
            counter={200}
            onChange={(usage_microphone) => set({ usage_microphone })}
          />
        )}
        {draft.cap_photo_library && (
          <>
            <TextAreaField
              label={t('admin.mobileApp.privacy.usagePhotoLibrary')}
              hint={t('admin.mobileApp.privacy.usagePhotoLibraryHint')}
              value={draft.usage_photo_library}
              counter={200}
              onChange={(usage_photo_library) => set({ usage_photo_library })}
            />
            <TextAreaField
              label={t('admin.mobileApp.privacy.usagePhotoAdd')}
              hint={t('admin.mobileApp.privacy.usagePhotoAddHint')}
              value={draft.usage_photo_library_add ?? ''}
              counter={200}
              onChange={(value) => set({ usage_photo_library_add: value || null })}
            />
          </>
        )}
        {draft.cap_location && (
          <TextAreaField
            label={t('admin.mobileApp.privacy.usageLocation')}
            hint={t('admin.mobileApp.privacy.usageLocationHint')}
            value={draft.usage_location ?? ''}
            counter={200}
            onChange={(value) => set({ usage_location: value || null })}
          />
        )}
        {draft.cap_face_id && (
          <TextAreaField
            label={t('admin.mobileApp.privacy.usageFaceId')}
            hint={t('admin.mobileApp.privacy.usageFaceIdHint')}
            value={draft.usage_face_id ?? ''}
            counter={200}
            onChange={(value) => set({ usage_face_id: value || null })}
          />
        )}
        {!draft.cap_camera && !draft.cap_microphone && !draft.cap_photo_library &&
          !draft.cap_location && !draft.cap_face_id && (
            <p className="text-sm text-muted-foreground">
              {t('admin.mobileApp.privacy.noCapabilities')}
            </p>
          )}
      </SettingsSection>

      <SettingsSection
        icon={Eye}
        heading={t('admin.mobileApp.privacy.tracking')}
        caption={t('admin.mobileApp.privacy.trackingHint')}
      >
        <FieldGrid>
          <SwitchField
            label={t('admin.mobileApp.privacy.attEnabled')}
            hint={t('admin.mobileApp.privacy.attEnabledHint')}
            checked={draft.att_enabled}
            onChange={(att_enabled) => set({ att_enabled })}
          />
          <SwitchField
            label={t('admin.mobileApp.privacy.usesIdfa')}
            hint={t('admin.mobileApp.privacy.usesIdfaHint')}
            checked={draft.uses_idfa}
            onChange={(uses_idfa) => set({ uses_idfa })}
          />
        </FieldGrid>
        {draft.att_enabled && (
          <TextAreaField
            label={t('admin.mobileApp.privacy.usageTracking')}
            hint={t('admin.mobileApp.privacy.usageTrackingHint')}
            value={draft.usage_tracking ?? ''}
            counter={200}
            onChange={(value) => set({ usage_tracking: value || null })}
          />
        )}
      </SettingsSection>

      <SettingsSection
        icon={FileJson}
        heading={t('admin.mobileApp.privacy.dataCollection')}
        caption={t('admin.mobileApp.privacy.dataCollectionHint')}
      >
        <SwitchField
          label={t('admin.mobileApp.privacy.collectsData')}
          hint={t('admin.mobileApp.privacy.collectsDataHint')}
          checked={draft.collects_data}
          onChange={(collects_data) => set({ collects_data })}
        />
        {draft.collects_data && (
          <div className="grid gap-1.5">
            <Label>{t('admin.mobileApp.privacy.dataTypes')}</Label>
            <div className="grid gap-2 sm:grid-cols-2">
              {DATA_TYPES.map((value) => (
                <label
                  key={value}
                  className="flex items-start justify-between gap-3 rounded-xl border border-border/70 p-3"
                >
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">
                      {t(`admin.mobileApp.dataTypes.${value}.label` as TranslationKey)}
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {t(`admin.mobileApp.dataTypes.${value}.hint` as TranslationKey)}
                    </span>
                  </span>
                  <Switch
                    checked={declaredTypes.includes(value)}
                    onCheckedChange={(on) => toggleType(value, on)}
                  />
                </label>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              {t('admin.mobileApp.privacy.dataTypesHint')}
            </p>
          </div>
        )}

        <ListField
          label={t('admin.mobileApp.privacy.thirdPartySdks')}
          hint={t('admin.mobileApp.privacy.thirdPartySdksHint')}
          values={draft.third_party_sdks}
          onChange={(third_party_sdks) => set({ third_party_sdks })}
          addLabel={t('admin.mobileApp.common.addEntry')}
          removeLabel={t('admin.mobileApp.common.removeEntry')}
        />

        <CodeBlock
          label={t('admin.mobileApp.privacy.manifestPreview')}
          value={JSON.stringify(
            {
              NSPrivacyTracking: draft.att_enabled,
              NSPrivacyTrackingDomains: [],
              NSPrivacyCollectedDataTypes: declaredTypes,
              NSPrivacyAccessedAPITypes: [
                { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults', NSPrivacyAccessedAPITypeReasons: ['CA92.1'] },
                { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryFileTimestamp', NSPrivacyAccessedAPITypeReasons: ['C617.1'] },
                { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryDiskSpace', NSPrivacyAccessedAPITypeReasons: ['E174.1'] },
                { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategorySystemBootTime', NSPrivacyAccessedAPITypeReasons: ['35F9.1'] },
              ],
            },
            null,
            2,
          )}
        />
      </SettingsSection>
    </div>
  );
}
