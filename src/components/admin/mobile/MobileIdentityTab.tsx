/**
 * App identity: who the app IS to Apple. These values must match the App
 * Store Connect record exactly — a bundle id or team that disagrees with the
 * signing certificate fails at upload, not at review.
 */
import { Fingerprint, Store } from 'lucide-react';
import { useTranslation, type TranslationKey } from '@/i18n';
import {
  SettingsSection, FieldGrid, TextField, SelectField,
} from '@/components/admin/settings/SettingsFields';
import type { MobileAppSettings } from '@/hooks/useMobileApp';

/** Apple's App Store categories, as their App Store Connect identifiers. */
const CATEGORIES = [
  'BUSINESS', 'PRODUCTIVITY', 'UTILITIES', 'SOCIAL_NETWORKING', 'DEVELOPER_TOOLS',
  'EDUCATION', 'FINANCE', 'LIFESTYLE', 'NEWS', 'REFERENCE', 'SHOPPING', 'TRAVEL',
];

const AGE_RATINGS = ['4+', '9+', '12+', '17+'];

export function MobileIdentityTab({
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
        icon={Fingerprint}
        heading={t('admin.mobileApp.identity.title')}
        caption={t('admin.mobileApp.identity.caption')}
      >
        <FieldGrid>
          <TextField
            label={t('admin.mobileApp.identity.appName')}
            hint={t('admin.mobileApp.identity.appNameHint')}
            value={draft.app_name}
            onChange={(app_name) => set({ app_name })}
          />
          <TextField
            label={t('admin.mobileApp.identity.displayName')}
            hint={t('admin.mobileApp.identity.displayNameHint')}
            value={draft.display_name}
            onChange={(display_name) => set({ display_name })}
            invalid={draft.display_name.trim().length > 30 || !draft.display_name.trim()}
          />
          <TextField
            label={t('admin.mobileApp.identity.bundleId')}
            hint={t('admin.mobileApp.identity.bundleIdHint')}
            value={draft.bundle_id}
            dir="ltr"
            onChange={(bundle_id) => set({ bundle_id })}
            invalid={!/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(draft.bundle_id)}
          />
          <TextField
            label={t('admin.mobileApp.identity.teamId')}
            hint={t('admin.mobileApp.identity.teamIdHint')}
            value={draft.apple_team_id ?? ''}
            dir="ltr"
            onChange={(value) => set({ apple_team_id: value.trim().toUpperCase() || null })}
            invalid={Boolean(draft.apple_team_id) && !/^[A-Z0-9]{10}$/.test(draft.apple_team_id ?? '')}
          />
          <TextField
            label={t('admin.mobileApp.identity.teamName')}
            hint={t('admin.mobileApp.identity.teamNameHint')}
            value={draft.apple_team_name ?? ''}
            onChange={(value) => set({ apple_team_name: value || null })}
          />
          <SelectField
            label={t('admin.mobileApp.identity.primaryLanguage')}
            hint={t('admin.mobileApp.identity.primaryLanguageHint')}
            value={draft.primary_language}
            onChange={(primary_language) => set({ primary_language })}
            options={[
              { value: 'en', label: t('admin.brandingPage.languages.en') },
              { value: 'fa', label: t('admin.brandingPage.languages.fa') },
              { value: 'tr', label: t('admin.brandingPage.languages.tr') },
            ]}
          />
        </FieldGrid>
      </SettingsSection>

      <SettingsSection
        icon={Store}
        heading={t('admin.mobileApp.identity.storeRecord')}
        caption={t('admin.mobileApp.identity.storeRecordHint')}
      >
        <FieldGrid>
          <TextField
            label={t('admin.mobileApp.identity.appleAppId')}
            hint={t('admin.mobileApp.identity.appleAppIdHint')}
            value={draft.apple_app_id ?? ''}
            dir="ltr"
            onChange={(value) => set({ apple_app_id: value.replace(/\D/g, '') || null })}
          />
          <TextField
            label={t('admin.mobileApp.identity.sku')}
            hint={t('admin.mobileApp.identity.skuHint')}
            value={draft.app_sku ?? ''}
            dir="ltr"
            onChange={(value) => set({ app_sku: value || null })}
          />
          <SelectField
            label={t('admin.mobileApp.identity.primaryCategory')}
            hint={t('admin.mobileApp.identity.primaryCategoryHint')}
            value={draft.primary_category}
            onChange={(primary_category) => set({ primary_category })}
            options={CATEGORIES.map((value) => ({
              value,
              label: t(`admin.mobileApp.categories.${value}` as TranslationKey),
            }))}
          />
          <SelectField
            label={t('admin.mobileApp.identity.secondaryCategory')}
            hint={t('admin.mobileApp.identity.secondaryCategoryHint')}
            value={draft.secondary_category ?? 'none'}
            onChange={(value) => set({ secondary_category: value === 'none' ? null : value })}
            options={[
              { value: 'none', label: t('admin.mobileApp.common.none') },
              ...CATEGORIES.map((value) => ({
                value,
                label: t(`admin.mobileApp.categories.${value}` as TranslationKey),
              })),
            ]}
          />
          <SelectField
            label={t('admin.mobileApp.identity.ageRating')}
            hint={t('admin.mobileApp.identity.ageRatingHint')}
            value={draft.age_rating}
            onChange={(age_rating) => set({ age_rating })}
            options={AGE_RATINGS.map((value) => ({ value, label: value }))}
          />
          <TextField
            label={t('admin.mobileApp.identity.copyright')}
            hint={t('admin.mobileApp.identity.copyrightHint')}
            value={draft.copyright ?? ''}
            onChange={(value) => set({ copyright: value || null })}
          />
        </FieldGrid>
      </SettingsSection>

      <SettingsSection
        icon={Store}
        heading={t('admin.mobileApp.identity.urls')}
        caption={t('admin.mobileApp.identity.urlsHint')}
      >
        <FieldGrid>
          <TextField
            label={t('admin.mobileApp.identity.supportUrl')}
            hint={t('admin.mobileApp.identity.supportUrlHint')}
            value={draft.support_url ?? ''}
            dir="ltr"
            onChange={(value) => set({ support_url: value || null })}
          />
          <TextField
            label={t('admin.mobileApp.identity.marketingUrl')}
            hint={t('admin.mobileApp.identity.marketingUrlHint')}
            value={draft.marketing_url ?? ''}
            dir="ltr"
            onChange={(value) => set({ marketing_url: value || null })}
          />
          <TextField
            label={t('admin.mobileApp.identity.privacyPolicyUrl')}
            hint={t('admin.mobileApp.identity.privacyPolicyUrlHint')}
            value={draft.privacy_policy_url ?? ''}
            dir="ltr"
            onChange={(value) => set({ privacy_policy_url: value || null })}
          />
          <TextField
            label={t('admin.mobileApp.identity.termsUrl')}
            hint={t('admin.mobileApp.identity.termsUrlHint')}
            value={draft.terms_url ?? ''}
            dir="ltr"
            onChange={(value) => set({ terms_url: value || null })}
          />
        </FieldGrid>
      </SettingsSection>
    </div>
  );
}
