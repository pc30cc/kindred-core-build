/**
 * Which tabs the installed iOS app shows, in its bottom bar and in its
 * Inbox — applied live.
 *
 * The app reads these from `GET /api/mobile-app/config?platform=ios` when it
 * signs in and whenever it comes back to the foreground, so a switch flipped
 * here reaches every iPhone without a new build or an App Store release.
 */
import { Inbox, LayoutGrid } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { SettingsSection, FieldGrid, SwitchField } from '@/components/admin/settings/SettingsFields';
import type { MobileAppSettings } from '@/hooks/useMobileApp';

export function IosInAppTab({
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
    </div>
  );
}
