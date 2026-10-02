/**
 * Which tabs the installed iOS app shows, in its bottom bar and in its
 * Inbox, and which sections its Settings screen has — applied live.
 *
 * The app reads these from `GET /api/mobile-app/config?platform=ios` when it
 * signs in and whenever it comes back to the foreground, so a switch flipped
 * here reaches every iPhone without a new build or an App Store release. The
 * default language is read before sign-in instead, from
 * `GET /api/mobile-app/public-config?platform=ios`.
 */
import { Inbox, Languages, LayoutGrid, Settings2 } from 'lucide-react';
import { useTranslation, type TranslationKey } from '@/i18n';
import { Label } from '@/components/ui/label';
import { SettingsSection, FieldGrid, SwitchField, SelectField, TextField } from '@/components/admin/settings/SettingsFields';
import { ANDROID_LANGUAGES, type AndroidLanguage, type MobileAppSettings } from '@/hooks/useMobileApp';

/** As long as the server takes a Website name in one language. */
const WEBSITE_LABEL_MAX = 40;

export function IosInAppTab({
  draft,
  set,
}: {
  draft: MobileAppSettings;
  set: (patch: Partial<MobileAppSettings>) => void;
}) {
  const { t } = useTranslation();
  const websiteLabel = draft.ios_app_website_label ?? {};

  const setWebsiteLabel = (language: AndroidLanguage, value: string) => {
    const next = { ...websiteLabel };
    // An emptied language is dropped rather than stored as "", as the server does.
    if (value) next[language] = value;
    else delete next[language];
    set({ ios_app_website_label: next });
  };

  return (
    <div className="space-y-4">
      <SettingsSection
        icon={Languages}
        heading={t('admin.mobileApp.iosInApp.languageHeading')}
        caption={t('admin.mobileApp.iosInApp.languageCaption')}
      >
        <FieldGrid>
          <SelectField
            label={t('admin.mobileApp.iosInApp.defaultLanguage')}
            hint={t('admin.mobileApp.iosInApp.defaultLanguageHint')}
            value={draft.ios_default_language}
            onChange={(value) => set({ ios_default_language: value as AndroidLanguage })}
            options={ANDROID_LANGUAGES.map((language) => ({
              value: language,
              // Each language in its own name, so it can be found whatever this screen is in.
              label: t(`admin.mobileApp.android.inApp.languages.${language}` as TranslationKey),
            }))}
          />
        </FieldGrid>
      </SettingsSection>

      <SettingsSection
        icon={LayoutGrid}
        heading={t('admin.mobileApp.iosInApp.tabsHeading')}
        caption={t('admin.mobileApp.iosInApp.tabsCaption')}
      >
        <FieldGrid>
          <SwitchField
            label={t('admin.mobileApp.iosInApp.showContacts')}
            hint={t('admin.mobileApp.iosInApp.showContactsHint')}
            checked={draft.ios_app_show_contacts}
            onChange={(ios_app_show_contacts) => set({ ios_app_show_contacts })}
          />
          <SwitchField
            label={t('admin.mobileApp.iosInApp.showVisitors')}
            hint={t('admin.mobileApp.iosInApp.showVisitorsHint')}
            checked={draft.ios_app_show_visitors}
            onChange={(ios_app_show_visitors) => set({ ios_app_show_visitors })}
          />
          <SwitchField
            label={t('admin.mobileApp.iosInApp.showWebAnalytics')}
            hint={t('admin.mobileApp.iosInApp.showWebAnalyticsHint')}
            checked={draft.ios_app_show_web_analytics}
            onChange={(ios_app_show_web_analytics) => set({ ios_app_show_web_analytics })}
          />
        </FieldGrid>
      </SettingsSection>

      <SettingsSection
        icon={Inbox}
        heading={t('admin.mobileApp.iosInApp.inboxHeading')}
        caption={t('admin.mobileApp.iosInApp.inboxCaption')}
      >
        <FieldGrid>
          <SwitchField
            label={t('admin.mobileApp.iosInApp.showAIQueue')}
            hint={t('admin.mobileApp.iosInApp.showAIQueueHint')}
            checked={draft.ios_app_show_ai_queue}
            onChange={(ios_app_show_ai_queue) => set({ ios_app_show_ai_queue })}
          />
          <SwitchField
            label={t('admin.mobileApp.iosInApp.showColleagues')}
            hint={t('admin.mobileApp.iosInApp.showColleaguesHint')}
            checked={draft.ios_app_show_colleagues}
            onChange={(ios_app_show_colleagues) => set({ ios_app_show_colleagues })}
          />
        </FieldGrid>
      </SettingsSection>

      <SettingsSection
        icon={Settings2}
        heading={t('admin.mobileApp.iosInApp.settingsHeading')}
        caption={t('admin.mobileApp.iosInApp.settingsCaption')}
      >
        <FieldGrid>
          <SwitchField
            label={t('admin.mobileApp.iosInApp.showStorage')}
            hint={t('admin.mobileApp.iosInApp.showStorageHint')}
            checked={draft.ios_app_show_storage}
            onChange={(ios_app_show_storage) => set({ ios_app_show_storage })}
          />
          <SwitchField
            label={t('admin.mobileApp.iosInApp.showSupport')}
            hint={t('admin.mobileApp.iosInApp.showSupportHint')}
            checked={draft.ios_app_show_support}
            onChange={(ios_app_show_support) => set({ ios_app_show_support })}
          />
          <TextField
            label={t('admin.mobileApp.iosInApp.supportUrl')}
            hint={t('admin.mobileApp.iosInApp.supportUrlHint')}
            value={draft.ios_app_support_url ?? ''}
            placeholder="https://t.me/…"
            dir="ltr"
            onChange={(value) => set({ ios_app_support_url: value || null })}
          />
          <TextField
            label={t('admin.mobileApp.iosInApp.websiteUrl')}
            hint={t('admin.mobileApp.iosInApp.websiteUrlHint')}
            value={draft.ios_app_website_url ?? ''}
            placeholder="https://…"
            dir="ltr"
            invalid={!!draft.ios_app_website_url && !/^https:\/\//i.test(draft.ios_app_website_url.trim())}
            onChange={(value) => set({ ios_app_website_url: value || null })}
          />
        </FieldGrid>
        <div className="mt-4 grid gap-3">
          <div>
            <Label>{t('admin.mobileApp.iosInApp.websiteLabel')}</Label>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('admin.mobileApp.iosInApp.websiteLabelHint')}</p>
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            {ANDROID_LANGUAGES.map((language) => (
              <TextField
                key={language}
                label={t(`admin.mobileApp.android.inApp.languages.${language}` as TranslationKey)}
                value={websiteLabel[language] ?? ''}
                dir={language === 'fa' ? 'rtl' : 'ltr'}
                maxLength={WEBSITE_LABEL_MAX}
                onChange={(value) => setWebsiteLabel(language, value)}
              />
            ))}
          </div>
        </div>
      </SettingsSection>
    </div>
  );
}
