/**
 * Super Admin → macOS app → Features.
 *
 * Platform-wide off switches for sections of the Mac app. The app ANDs each
 * one with what the workspace's plan includes, so a switch here can only
 * take a feature away, never grant one a plan does not have.
 */
import { Blocks } from 'lucide-react';
import { useTranslation, type TranslationKey } from '@/i18n';
import { SettingsSection, FieldGrid, SwitchField } from '@/components/admin/settings/SettingsFields';
import type { MacosAppSettings } from '@/hooks/useMacosApp';
import { MACOS_FEATURES } from './macosModel';
import { MacosNote } from './MacosNote';

export function MacosFeaturesTab({
  draft,
  set,
}: {
  draft: MacosAppSettings;
  set: (patch: Partial<MacosAppSettings>) => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="space-y-4">
      <SettingsSection
        icon={Blocks}
        heading={t('admin.macosApp.features.title')}
        caption={t('admin.macosApp.features.caption')}
      >
        <MacosNote>{t('admin.macosApp.features.planNote')}</MacosNote>
        <FieldGrid>
          {MACOS_FEATURES.map(({ key, copy }) => {
            // Video rides on the call stack: with calls off it is off too,
            // whatever its own switch says (the public config ANDs them).
            const needsCalls = key === 'video_calls_enabled' && !draft.calls_enabled;
            return (
              <SwitchField
                key={key}
                label={t(`admin.macosApp.features.${copy}` as TranslationKey)}
                hint={
                  needsCalls
                    ? t('admin.macosApp.features.videoCallsNeedsCalls')
                    : t(`admin.macosApp.features.${copy}Hint` as TranslationKey)
                }
                checked={needsCalls ? false : draft[key]}
                disabled={needsCalls}
                onChange={(value) => set({ [key]: value } as Partial<MacosAppSettings>)}
              />
            );
          })}
        </FieldGrid>
      </SettingsSection>
    </div>
  );
}
