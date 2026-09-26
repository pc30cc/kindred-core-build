/**
 * Runtime tuning for the desktop app: realtime, the polling that covers for
 * it, and feature switches. Read by the app from GET /api/platform/desktop-app
 * on launch, so a change here needs no new build.
 */
import { Radio, PhoneCall } from 'lucide-react';
import { useTranslation } from '@/i18n';
import {
  SettingsSection, FieldGrid, TextField, SwitchField,
} from '@/components/admin/settings/SettingsFields';
import type { DesktopAppSettings } from '@/hooks/useDesktopApp';

export function DesktopBehaviourTab({
  draft,
  set,
}: {
  draft: DesktopAppSettings;
  set: (patch: Partial<DesktopAppSettings>) => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="space-y-4">
      <SettingsSection
        icon={Radio}
        heading={t('admin.desktopApp.behaviour.realtimeTitle')}
        caption={t('admin.desktopApp.behaviour.realtimeCaption')}
      >
        <SwitchField
          label={t('admin.desktopApp.behaviour.realtime')}
          hint={t('admin.desktopApp.behaviour.realtimeHint')}
          checked={draft.realtime_enabled}
          onChange={(realtime_enabled) => set({ realtime_enabled })}
        />
        <FieldGrid>
          <TextField
            type="number"
            label={t('admin.desktopApp.behaviour.pollInterval')}
            hint={t('admin.desktopApp.behaviour.pollIntervalHint')}
            value={String(draft.poll_interval_seconds)}
            dir="ltr"
            invalid={draft.poll_interval_seconds < 5 || draft.poll_interval_seconds > 300}
            onChange={(value) => set({ poll_interval_seconds: Number(value) || 0 })}
          />
          <TextField
            type="number"
            label={t('admin.desktopApp.behaviour.pollIntervalRealtime')}
            hint={t('admin.desktopApp.behaviour.pollIntervalRealtimeHint')}
            value={String(draft.poll_interval_realtime_seconds)}
            dir="ltr"
            disabled={!draft.realtime_enabled}
            invalid={draft.poll_interval_realtime_seconds < 15 || draft.poll_interval_realtime_seconds > 900}
            onChange={(value) => set({ poll_interval_realtime_seconds: Number(value) || 0 })}
          />
        </FieldGrid>
      </SettingsSection>

      <SettingsSection
        icon={PhoneCall}
        heading={t('admin.desktopApp.behaviour.featuresTitle')}
        caption={t('admin.desktopApp.behaviour.featuresCaption')}
      >
        <SwitchField
          label={t('admin.desktopApp.behaviour.calls')}
          hint={t('admin.desktopApp.behaviour.callsHint')}
          checked={draft.calls_enabled}
          onChange={(calls_enabled) => set({ calls_enabled })}
        />
        <SwitchField
          label={t('admin.desktopApp.behaviour.storageSettings')}
          hint={t('admin.desktopApp.behaviour.storageSettingsHint')}
          checked={draft.storage_settings_visible}
          onChange={(storage_settings_visible) => set({ storage_settings_visible })}
        />
      </SettingsSection>
    </div>
  );
}
