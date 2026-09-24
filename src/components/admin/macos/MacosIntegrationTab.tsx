/**
 * Super Admin → macOS app → Mac integration.
 *
 * What the app may do on the Mac itself (menu bar item, open at login, Dock
 * badge, system notifications) and how a freshly installed copy starts.
 * First-launch defaults only fill in what an operator has not chosen yet:
 * once they pick a language, an appearance or a login item themselves, their
 * choice wins over anything set here.
 */
import { AppWindowMac, Sparkles } from 'lucide-react';
import { useTranslation, type TranslationKey } from '@/i18n';
import {
  SettingsSection, FieldGrid, SwitchField, SelectField,
} from '@/components/admin/settings/SettingsFields';
import {
  MACOS_APPEARANCES,
  MACOS_LANGUAGES,
  type MacDefaultAppearance,
  type MacDefaultLanguage,
  type MacosAppSettings,
} from '@/hooks/useMacosApp';
import { MACOS_INTEGRATIONS } from './macosModel';
import { MacosNote } from './MacosNote';

export function MacosIntegrationTab({
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
        icon={AppWindowMac}
        heading={t('admin.macosApp.integration.title')}
        caption={t('admin.macosApp.integration.caption')}
      >
        <FieldGrid>
          {MACOS_INTEGRATIONS.map(({ key, copy }) => (
            <SwitchField
              key={key}
              label={t(`admin.macosApp.integration.${copy}` as TranslationKey)}
              hint={t(`admin.macosApp.integration.${copy}Hint` as TranslationKey)}
              checked={draft[key] as boolean}
              onChange={(value) => set({ [key]: value } as Partial<MacosAppSettings>)}
            />
          ))}
        </FieldGrid>
      </SettingsSection>

      <SettingsSection
        icon={Sparkles}
        heading={t('admin.macosApp.integration.defaultsTitle')}
        caption={t('admin.macosApp.integration.defaultsCaption')}
      >
        <MacosNote>{t('admin.macosApp.integration.operatorWins')}</MacosNote>
        <FieldGrid>
          <SelectField
            label={t('admin.macosApp.integration.language')}
            hint={t('admin.macosApp.integration.languageHint')}
            value={draft.default_language}
            onChange={(value) => set({ default_language: value as MacDefaultLanguage })}
            options={MACOS_LANGUAGES.map((language) => ({
              value: language,
              label: t(`admin.macosApp.integration.languages.${language}` as TranslationKey),
            }))}
          />
          <SelectField
            label={t('admin.macosApp.integration.appearance')}
            hint={t('admin.macosApp.integration.appearanceHint')}
            value={draft.default_appearance}
            onChange={(value) => set({ default_appearance: value as MacDefaultAppearance })}
            options={MACOS_APPEARANCES.map((appearance) => ({
              value: appearance,
              label: t(`admin.macosApp.integration.appearances.${appearance}` as TranslationKey),
            }))}
          />
          {/* Each default is shown as Macs will receive it: the public config
              ANDs it with the permission above, so a disabled switch reads off. */}
          <SwitchField
            label={t('admin.macosApp.integration.closeToMenuBar')}
            hint={
              draft.menu_bar_extra_enabled
                ? t('admin.macosApp.integration.closeToMenuBarHint')
                : t('admin.macosApp.integration.closeToMenuBarDisabled')
            }
            checked={draft.menu_bar_extra_enabled && draft.default_close_to_menu_bar}
            disabled={!draft.menu_bar_extra_enabled}
            onChange={(default_close_to_menu_bar) => set({ default_close_to_menu_bar })}
          />
          <SwitchField
            label={t('admin.macosApp.integration.defaultLaunchAtLogin')}
            hint={
              draft.launch_at_login_enabled
                ? t('admin.macosApp.integration.defaultLaunchAtLoginHint')
                : t('admin.macosApp.integration.defaultLaunchAtLoginDisabled')
            }
            checked={draft.launch_at_login_enabled && draft.default_launch_at_login}
            disabled={!draft.launch_at_login_enabled}
            onChange={(default_launch_at_login) => set({ default_launch_at_login })}
          />
        </FieldGrid>
      </SettingsSection>
    </div>
  );
}
