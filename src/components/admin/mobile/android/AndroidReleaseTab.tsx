/**
 * The current Android release, as it stands in the Play Console: the
 * version, the SDK range, the track and how far a staged rollout has gone,
 * and the "What's new" text in each of the app's three languages.
 *
 * The build does not read this row — Gradle takes its version from
 * `-Pwebyar.versionName` / `-Pwebyar.versionCode` (see
 * `android/app/build.gradle.kts`). So the tab ends with the exact command,
 * which is what keeps the number recorded here and the number uploaded to
 * Play the same number.
 */
import { Rocket, ScrollText, Terminal } from 'lucide-react';
import { useTranslation, type TranslationKey } from '@/i18n';
import {
  SettingsSection, FieldGrid, TextField, TextAreaField, SelectField, CodeBlock,
} from '@/components/admin/settings/SettingsFields';
import type { MobileAppSettings } from '@/hooks/useMobileApp';

const LOCALES = ['en', 'fa', 'tr'] as const;
const VERSION = /^\d+(\.\d+){0,3}([-+][0-9A-Za-z.]+)?$/;

function toInt(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function AndroidReleaseTab({
  draft,
  set,
}: {
  draft: MobileAppSettings;
  set: (patch: Partial<MobileAppSettings>) => void;
}) {
  const { t } = useTranslation();
  const notes = draft.android_release_notes ?? {};
  const command = [
    'cd android',
    `./gradlew :app:bundleRelease -Pwebyar.versionName=${draft.android_version_name} -Pwebyar.versionCode=${draft.android_version_code}`,
  ].join('\n');

  return (
    <div className="space-y-4">
      <SettingsSection
        icon={Rocket}
        heading={t('admin.mobileApp.android.release.heading')}
        caption={t('admin.mobileApp.android.release.caption')}
      >
        <FieldGrid>
          <TextField
            label={t('admin.mobileApp.android.release.versionName')}
            hint={t('admin.mobileApp.android.release.versionNameHint')}
            value={draft.android_version_name}
            dir="ltr"
            invalid={!VERSION.test(draft.android_version_name)}
            onChange={(android_version_name) => set({ android_version_name })}
          />
          <TextField
            label={t('admin.mobileApp.android.release.versionCode')}
            hint={t('admin.mobileApp.android.release.versionCodeHint')}
            value={String(draft.android_version_code)}
            type="number"
            dir="ltr"
            onChange={(value) => set({ android_version_code: Math.max(1, toInt(value, 1)) })}
          />
          <TextField
            label={t('admin.mobileApp.android.release.minSdk')}
            hint={t('admin.mobileApp.android.release.minSdkHint')}
            value={String(draft.android_min_sdk)}
            type="number"
            dir="ltr"
            invalid={draft.android_min_sdk > draft.android_target_sdk}
            onChange={(value) => set({ android_min_sdk: toInt(value, 24) })}
          />
          <TextField
            label={t('admin.mobileApp.android.release.targetSdk')}
            hint={t('admin.mobileApp.android.release.targetSdkHint')}
            value={String(draft.android_target_sdk)}
            type="number"
            dir="ltr"
            onChange={(value) => set({ android_target_sdk: toInt(value, 37) })}
          />
          <SelectField
            label={t('admin.mobileApp.android.release.track')}
            hint={t('admin.mobileApp.android.release.trackHint')}
            value={draft.android_release_track}
            onChange={(value) => set({ android_release_track: value as MobileAppSettings['android_release_track'] })}
            options={[
              { value: 'internal', label: t('admin.mobileApp.android.release.trackInternal') },
              { value: 'closed', label: t('admin.mobileApp.android.release.trackClosed') },
              { value: 'open', label: t('admin.mobileApp.android.release.trackOpen') },
              { value: 'production', label: t('admin.mobileApp.android.release.trackProduction') },
            ]}
          />
          <TextField
            label={t('admin.mobileApp.android.release.rollout')}
            hint={t('admin.mobileApp.android.release.rolloutHint')}
            value={String(draft.android_rollout_percent)}
            type="number"
            dir="ltr"
            disabled={draft.android_release_track !== 'production'}
            onChange={(value) => set({ android_rollout_percent: Math.min(100, Math.max(1, toInt(value, 100))) })}
          />
        </FieldGrid>
      </SettingsSection>

      <SettingsSection
        icon={ScrollText}
        heading={t('admin.mobileApp.android.release.notesHeading')}
        caption={t('admin.mobileApp.android.release.notesCaption')}
      >
        {LOCALES.map((locale) => (
          <TextAreaField
            key={locale}
            label={t(`admin.mobileApp.android.release.notes_${locale}` as TranslationKey)}
            value={notes[locale] ?? ''}
            rows={4}
            counter={500}
            dir={locale === 'fa' ? 'rtl' : 'ltr'}
            onChange={(value) => set({ android_release_notes: { ...notes, [locale]: value } })}
          />
        ))}
      </SettingsSection>

      <SettingsSection
        icon={Terminal}
        heading={t('admin.mobileApp.android.release.buildHeading')}
        caption={t('admin.mobileApp.android.release.buildCaption')}
      >
        <CodeBlock value={command} />
      </SettingsSection>
    </div>
  );
}
