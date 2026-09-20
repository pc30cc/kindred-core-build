/**
 * Release policy and export compliance.
 *
 * Export compliance is answered once here and written into Info.plist as
 * `ITSAppUsesNonExemptEncryption`, which is what stops App Store Connect
 * asking the same question on every upload. HTTPS-only apps qualify for the
 * standard exemption — the hint says so rather than making an operator guess.
 */
import { Rocket, ShieldCheck } from 'lucide-react';
import { useTranslation } from '@/i18n';
import {
  SettingsSection, FieldGrid, TextField, TextAreaField, SwitchField, SelectField,
} from '@/components/admin/settings/SettingsFields';
import type { MobileAppSettings } from '@/hooks/useMobileApp';

export function MobileReleaseTab({
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
        icon={Rocket}
        heading={t('admin.mobileApp.release.title')}
        caption={t('admin.mobileApp.release.caption')}
      >
        <FieldGrid>
          <SelectField
            label={t('admin.mobileApp.release.type')}
            hint={t('admin.mobileApp.release.typeHint')}
            value={draft.release_type}
            onChange={(value) => set({ release_type: value as MobileAppSettings['release_type'] })}
            options={[
              { value: 'manual', label: t('admin.mobileApp.release.typeManual') },
              { value: 'automatic', label: t('admin.mobileApp.release.typeAutomatic') },
              { value: 'scheduled', label: t('admin.mobileApp.release.typeScheduled') },
            ]}
          />
          <TextField
            label={t('admin.mobileApp.release.testflightGroup')}
            hint={t('admin.mobileApp.release.testflightGroupHint')}
            value={draft.testflight_group ?? ''}
            onChange={(value) => set({ testflight_group: value || null })}
          />
        </FieldGrid>
        <SwitchField
          label={t('admin.mobileApp.release.phased')}
          hint={t('admin.mobileApp.release.phasedHint')}
          checked={draft.phased_release}
          onChange={(phased_release) => set({ phased_release })}
        />
        <TextAreaField
          label={t('admin.mobileApp.release.notes')}
          hint={t('admin.mobileApp.release.notesHint')}
          value={draft.release_notes ?? ''}
          rows={6}
          counter={4000}
          onChange={(value) => set({ release_notes: value || null })}
        />
      </SettingsSection>

      <SettingsSection
        icon={ShieldCheck}
        heading={t('admin.mobileApp.release.exportCompliance')}
        caption={t('admin.mobileApp.release.exportComplianceHint')}
      >
        <FieldGrid>
          <SwitchField
            label={t('admin.mobileApp.release.usesEncryption')}
            hint={t('admin.mobileApp.release.usesEncryptionHint')}
            checked={draft.uses_encryption}
            onChange={(uses_encryption) => set({ uses_encryption })}
          />
          <SwitchField
            label={t('admin.mobileApp.release.encryptionExempt')}
            hint={t('admin.mobileApp.release.encryptionExemptHint')}
            checked={draft.encryption_exempt}
            onChange={(encryption_exempt) => set({ encryption_exempt })}
            disabled={!draft.uses_encryption}
          />
        </FieldGrid>
        {draft.uses_encryption && !draft.encryption_exempt && (
          <TextAreaField
            label={t('admin.mobileApp.release.encryptionNotes')}
            hint={t('admin.mobileApp.release.encryptionNotesHint')}
            value={draft.encryption_notes ?? ''}
            rows={4}
            onChange={(value) => set({ encryption_notes: value || null })}
          />
        )}
      </SettingsSection>
    </div>
  );
}
