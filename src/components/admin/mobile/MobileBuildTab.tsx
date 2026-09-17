/**
 * Build settings — versioning, deployment target, devices, orientation and
 * signing. These map 1:1 onto `ios/generated.xcconfig`, which the Xcode
 * project reads, so nothing here is advisory: it is the build.
 */
import { Hammer, PenLine, Link2 } from 'lucide-react';
import { useTranslation, type TranslationKey } from '@/i18n';
import {
  SettingsSection, FieldGrid, TextField, SelectField, SwitchField, ListField,
} from '@/components/admin/settings/SettingsFields';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import type { MobileAppSettings } from '@/hooks/useMobileApp';

const ORIENTATIONS = ['portrait', 'portrait-upside-down', 'landscape-left', 'landscape-right'] as const;

export function MobileBuildTab({
  draft,
  set,
}: {
  draft: MobileAppSettings;
  set: (patch: Partial<MobileAppSettings>) => void;
}) {
  const { t } = useTranslation();

  const toggleOrientation = (value: string, on: boolean) => {
    const next = on
      ? [...draft.orientations, value]
      : draft.orientations.filter((entry) => entry !== value);
    // Every iOS app must support at least one orientation; refuse to empty it.
    set({ orientations: next.length ? next : draft.orientations });
  };

  return (
    <div className="space-y-4">
      <SettingsSection
        icon={Hammer}
        heading={t('admin.mobileApp.build.title')}
        caption={t('admin.mobileApp.build.caption')}
      >
        <FieldGrid>
          <TextField
            label={t('admin.mobileApp.build.version')}
            hint={t('admin.mobileApp.build.versionHint')}
            value={draft.marketing_version}
            dir="ltr"
            onChange={(marketing_version) => set({ marketing_version })}
            invalid={!/^\d+(\.\d+){0,2}$/.test(draft.marketing_version)}
          />
          <TextField
            label={t('admin.mobileApp.build.buildNumber')}
            hint={t('admin.mobileApp.build.buildNumberHint')}
            value={String(draft.build_number)}
            dir="ltr"
            type="number"
            onChange={(value) => set({ build_number: Math.max(1, Number(value) || 1) })}
          />
          <SelectField
            label={t('admin.mobileApp.build.minimumOs')}
            hint={t('admin.mobileApp.build.minimumOsHint')}
            value={draft.minimum_os_version}
            onChange={(minimum_os_version) => set({ minimum_os_version })}
            options={['13.0', '14.0', '15.0', '16.0', '17.0', '18.0'].map((value) => ({
              value,
              label: `iOS ${value}`,
            }))}
          />
          <SelectField
            label={t('admin.mobileApp.build.deviceFamily')}
            hint={t('admin.mobileApp.build.deviceFamilyHint')}
            value={draft.device_family}
            onChange={(value) => set({ device_family: value as MobileAppSettings['device_family'] })}
            options={[
              { value: 'iphone', label: t('admin.mobileApp.build.deviceIphone') },
              { value: 'universal', label: t('admin.mobileApp.build.deviceUniversal') },
            ]}
          />
        </FieldGrid>

        <div className="grid gap-1.5">
          <Label>{t('admin.mobileApp.build.orientations')}</Label>
          <div className="grid gap-2 sm:grid-cols-2">
            {ORIENTATIONS.map((value) => (
              <label
                key={value}
                className="flex items-center justify-between gap-3 rounded-xl border border-border/70 p-3"
              >
                <span className="text-sm">{t(`admin.mobileApp.build.orientation.${value}` as TranslationKey)}</span>
                <Switch
                  checked={draft.orientations.includes(value)}
                  onCheckedChange={(on) => toggleOrientation(value, on)}
                />
              </label>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            {t('admin.mobileApp.build.orientationsHint')}
          </p>
        </div>

        <FieldGrid>
          <SwitchField
            label={t('admin.mobileApp.build.requiresFullScreen')}
            hint={t('admin.mobileApp.build.requiresFullScreenHint')}
            checked={draft.requires_full_screen}
            onChange={(requires_full_screen) => set({ requires_full_screen })}
          />
          <SwitchField
            label={t('admin.mobileApp.build.supportsDarkMode')}
            hint={t('admin.mobileApp.build.supportsDarkModeHint')}
            checked={draft.supports_dark_mode}
            onChange={(supports_dark_mode) => set({ supports_dark_mode })}
          />
        </FieldGrid>
      </SettingsSection>

      <SettingsSection
        icon={PenLine}
        heading={t('admin.mobileApp.build.signing')}
        caption={t('admin.mobileApp.build.signingHint')}
      >
        <SwitchField
          label={t('admin.mobileApp.build.automaticSigning')}
          hint={t('admin.mobileApp.build.automaticSigningHint')}
          checked={draft.automatic_signing}
          onChange={(automatic_signing) => set({ automatic_signing })}
        />
        <FieldGrid>
          <SelectField
            label={t('admin.mobileApp.build.configuration')}
            hint={t('admin.mobileApp.build.configurationHint')}
            value={draft.build_configuration}
            onChange={(build_configuration) => set({ build_configuration })}
            options={[
              { value: 'Release', label: t('admin.mobileApp.build.configRelease') },
              { value: 'Debug', label: t('admin.mobileApp.build.configDebug') },
            ]}
          />
          {!draft.automatic_signing && (
            <TextField
              label={t('admin.mobileApp.build.provisioningProfile')}
              hint={t('admin.mobileApp.build.provisioningProfileHint')}
              value={draft.provisioning_profile ?? ''}
              dir="ltr"
              onChange={(value) => set({ provisioning_profile: value || null })}
            />
          )}
        </FieldGrid>
      </SettingsSection>

      <SettingsSection
        icon={Link2}
        heading={t('admin.mobileApp.build.deepLinks')}
        caption={t('admin.mobileApp.build.deepLinksHint')}
      >
        <TextField
          label={t('admin.mobileApp.build.urlScheme')}
          hint={t('admin.mobileApp.build.urlSchemeHint')}
          value={draft.url_scheme ?? ''}
          dir="ltr"
          onChange={(value) => set({ url_scheme: value.trim().toLowerCase() || null })}
        />
        <ListField
          label={t('admin.mobileApp.build.associatedDomains')}
          hint={t('admin.mobileApp.build.associatedDomainsHint')}
          values={draft.associated_domains}
          onChange={(associated_domains) => set({ associated_domains })}
          addLabel={t('admin.mobileApp.common.addEntry')}
          removeLabel={t('admin.mobileApp.common.removeEntry')}
        />
      </SettingsSection>
    </div>
  );
}
