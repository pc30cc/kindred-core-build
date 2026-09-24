/**
 * Super Admin → macOS app → Behaviour.
 *
 * How the Mac app keeps conversations current: the realtime connection and
 * the polling that covers for it. Same rules as the Windows app
 * (DesktopBehaviourTab); the Mac app reads them from
 * GET /api/platform/macos-app, so a change here needs no new build.
 */
import { Radio } from 'lucide-react';
import { useTranslation } from '@/i18n';
import {
  SettingsSection, FieldGrid, TextField, SwitchField,
} from '@/components/admin/settings/SettingsFields';
import type { MacosAppSettings } from '@/hooks/useMacosApp';
import { inBounds } from './macosModel';

export function MacosBehaviourTab({
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
        icon={Radio}
        heading={t('admin.macosApp.behaviour.realtimeTitle')}
        caption={t('admin.macosApp.behaviour.realtimeCaption')}
      >
        <SwitchField
          label={t('admin.macosApp.behaviour.realtime')}
          hint={t('admin.macosApp.behaviour.realtimeHint')}
          checked={draft.realtime_enabled}
          onChange={(realtime_enabled) => set({ realtime_enabled })}
        />
        <FieldGrid>
          <TextField
            type="number"
            label={t('admin.macosApp.behaviour.pollInterval')}
            hint={t('admin.macosApp.behaviour.pollIntervalHint')}
            value={String(draft.poll_interval_seconds)}
            dir="ltr"
            invalid={!inBounds(draft.poll_interval_seconds, 'poll_interval_seconds')}
            onChange={(value) => set({ poll_interval_seconds: Number(value) || 0 })}
          />
          <TextField
            type="number"
            label={t('admin.macosApp.behaviour.pollIntervalRealtime')}
            hint={t('admin.macosApp.behaviour.pollIntervalRealtimeHint')}
            value={String(draft.poll_interval_realtime_seconds)}
            dir="ltr"
            disabled={!draft.realtime_enabled}
            invalid={!inBounds(draft.poll_interval_realtime_seconds, 'poll_interval_realtime_seconds')}
            onChange={(value) => set({ poll_interval_realtime_seconds: Number(value) || 0 })}
          />
        </FieldGrid>
      </SettingsSection>
    </div>
  );
}
