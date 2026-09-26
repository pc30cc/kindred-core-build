/**
 * The Android app as Google Play knows it: its name, its package and where
 * its listing is. The privacy policy and support links are the same for
 * both platforms, so they are edited here and on iOS alike.
 */
import { Fingerprint, Link2 } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { SettingsSection, FieldGrid, TextField } from '@/components/admin/settings/SettingsFields';
import type { MobileAppSettings } from '@/hooks/useMobileApp';

const PACKAGE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;
const HTTPS = /^https:\/\//i;

export function AndroidIdentityTab({
  draft,
  set,
}: {
  draft: MobileAppSettings;
  set: (patch: Partial<MobileAppSettings>) => void;
}) {
  const { t } = useTranslation();
  const httpsInvalid = (value: string | null) => Boolean(value) && !HTTPS.test(value ?? '');

  return (
    <div className="space-y-4">
      <SettingsSection
        icon={Fingerprint}
        heading={t('admin.mobileApp.android.identity.heading')}
        caption={t('admin.mobileApp.android.identity.caption')}
      >
        <FieldGrid>
          <TextField
            label={t('admin.mobileApp.android.identity.appName')}
            hint={t('admin.mobileApp.android.identity.appNameHint')}
            value={draft.android_app_name}
            maxLength={50}
            onChange={(android_app_name) => set({ android_app_name })}
          />
          <TextField
            label={t('admin.mobileApp.android.identity.packageName')}
            hint={t('admin.mobileApp.android.identity.packageNameHint')}
            value={draft.android_package_name}
            dir="ltr"
            invalid={!PACKAGE.test(draft.android_package_name)}
            onChange={(android_package_name) => set({ android_package_name })}
          />
        </FieldGrid>
      </SettingsSection>

      <SettingsSection
        icon={Link2}
        heading={t('admin.mobileApp.android.identity.linksHeading')}
        caption={t('admin.mobileApp.android.identity.linksCaption')}
      >
        <FieldGrid>
          <TextField
            label={t('admin.mobileApp.android.identity.playStoreUrl')}
            hint={t('admin.mobileApp.android.identity.playStoreUrlHint')}
            value={draft.android_play_store_url ?? ''}
            dir="ltr"
            placeholder="https://"
            invalid={httpsInvalid(draft.android_play_store_url)}
            onChange={(value) => set({ android_play_store_url: value || null })}
          />
          <TextField
            label={t('admin.mobileApp.android.identity.privacyPolicyUrl')}
            hint={t('admin.mobileApp.android.identity.sharedWithIos')}
            value={draft.privacy_policy_url ?? ''}
            dir="ltr"
            placeholder="https://"
            invalid={httpsInvalid(draft.privacy_policy_url)}
            onChange={(value) => set({ privacy_policy_url: value || null })}
          />
          <TextField
            label={t('admin.mobileApp.android.identity.supportUrl')}
            hint={t('admin.mobileApp.android.identity.sharedWithIos')}
            value={draft.support_url ?? ''}
            dir="ltr"
            placeholder="https://"
            invalid={httpsInvalid(draft.support_url)}
            onChange={(value) => set({ support_url: value || null })}
          />
        </FieldGrid>
      </SettingsSection>
    </div>
  );
}
