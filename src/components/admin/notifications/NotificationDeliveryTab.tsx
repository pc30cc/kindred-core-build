/**
 * APNs delivery semantics.
 *
 * Every control maps to one documented Apple key, named in its hint, so an
 * operator can look up exactly what they are changing. The two dangerous ones
 * are guarded: critical alerts need an Apple entitlement most teams do not
 * have, and a `time-sensitive` interruption level needs the matching Focus
 * entitlement — both say so instead of silently failing at send time.
 */
import { Bell, Layers3, Volume2 } from 'lucide-react';
import { useTranslation, type TranslationKey } from '@/i18n';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import {
  SettingsSection, FieldGrid, SelectField, SwitchField, TextField,
} from '@/components/admin/settings/SettingsFields';
import type {
  InterruptionLevel, PushPlatformSettings, ThreadStrategy,
} from '@/hooks/useAdminNotifications';

export function NotificationDeliveryTab({
  draft,
  set,
}: {
  draft: PushPlatformSettings;
  set: (patch: Partial<PushPlatformSettings>) => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="space-y-4">
      <SettingsSection
        icon={Bell}
        heading={t('admin.notifications.delivery.title')}
        caption={t('admin.notifications.delivery.caption')}
      >
        <FieldGrid>
          <SelectField
            label={t('admin.notifications.delivery.priority')}
            hint={t('admin.notifications.delivery.priorityHint')}
            value={String(draft.apns_priority)}
            onChange={(value) => set({ apns_priority: Number(value) })}
            options={[
              { value: '10', label: t('admin.notifications.delivery.priority10') },
              { value: '5', label: t('admin.notifications.delivery.priority5') },
              { value: '1', label: t('admin.notifications.delivery.priority1') },
            ]}
          />
          <TextField
            label={t('admin.notifications.delivery.ttl')}
            hint={t('admin.notifications.delivery.ttlHint')}
            value={String(draft.apns_ttl_seconds)}
            dir="ltr"
            type="number"
            onChange={(value) =>
              set({ apns_ttl_seconds: Math.min(2_419_200, Math.max(0, Number(value) || 0)) })
            }
          />
          <SelectField
            label={t('admin.notifications.delivery.interruption')}
            hint={t('admin.notifications.delivery.interruptionHint')}
            value={draft.interruption_level}
            onChange={(value) => set({ interruption_level: value as InterruptionLevel })}
            options={(['passive', 'active', 'time-sensitive', 'critical'] as InterruptionLevel[]).map(
              (value) => ({
                value,
                label: t(`admin.notifications.delivery.interruptionOption.${value}` as TranslationKey),
              }),
            )}
          />
          <SelectField
            label={t('admin.notifications.delivery.thread')}
            hint={t('admin.notifications.delivery.threadHint')}
            value={draft.thread_id_strategy}
            onChange={(value) => set({ thread_id_strategy: value as ThreadStrategy })}
            options={(['conversation', 'workspace', 'none'] as ThreadStrategy[]).map((value) => ({
              value,
              label: t(`admin.notifications.delivery.threadOption.${value}` as TranslationKey),
            }))}
          />
        </FieldGrid>

        {(draft.interruption_level === 'time-sensitive' ||
          draft.interruption_level === 'critical') && (
          <p className="rounded-xl bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
            {t('admin.notifications.delivery.entitlementWarning')}
          </p>
        )}

        <div className="grid gap-1.5">
          <div className="flex items-center justify-between">
            <Label>{t('admin.notifications.delivery.relevance')}</Label>
            <span className="text-xs tabular-nums text-muted-foreground">
              {draft.relevance_score.toFixed(2)}
            </span>
          </div>
          <Slider
            value={[Math.round(draft.relevance_score * 100)]}
            max={100}
            step={5}
            onValueChange={([value]) => set({ relevance_score: value / 100 })}
          />
          <p className="text-xs text-muted-foreground">
            {t('admin.notifications.delivery.relevanceHint')}
          </p>
        </div>
      </SettingsSection>

      <SettingsSection
        icon={Layers3}
        heading={t('admin.notifications.delivery.grouping')}
        caption={t('admin.notifications.delivery.groupingHint')}
      >
        <FieldGrid>
          <SwitchField
            label={t('admin.notifications.delivery.collapse')}
            hint={t('admin.notifications.delivery.collapseHint')}
            checked={draft.collapse_enabled}
            onChange={(collapse_enabled) => set({ collapse_enabled })}
          />
          <SwitchField
            label={t('admin.notifications.delivery.badge')}
            hint={t('admin.notifications.delivery.badgeHint')}
            checked={draft.badge_enabled}
            onChange={(badge_enabled) => set({ badge_enabled })}
          />
          <SwitchField
            label={t('admin.notifications.delivery.mutableContent')}
            hint={t('admin.notifications.delivery.mutableContentHint')}
            checked={draft.mutable_content}
            onChange={(mutable_content) => set({ mutable_content })}
          />
          <SwitchField
            label={t('admin.notifications.delivery.provisional')}
            hint={t('admin.notifications.delivery.provisionalHint')}
            checked={draft.provisional_authorization}
            onChange={(provisional_authorization) => set({ provisional_authorization })}
          />
        </FieldGrid>
      </SettingsSection>

      <SettingsSection
        icon={Volume2}
        heading={t('admin.notifications.delivery.sound')}
        caption={t('admin.notifications.delivery.soundHint')}
      >
        <FieldGrid>
          <TextField
            label={t('admin.notifications.delivery.soundName')}
            hint={t('admin.notifications.delivery.soundNameHint')}
            value={draft.sound_name}
            dir="ltr"
            onChange={(sound_name) => set({ sound_name })}
          />
          <TextField
            label={t('admin.notifications.delivery.androidChannel')}
            hint={t('admin.notifications.delivery.androidChannelHint')}
            value={draft.android_channel_id}
            dir="ltr"
            onChange={(android_channel_id) => set({ android_channel_id })}
          />
        </FieldGrid>
        <SwitchField
          label={t('admin.notifications.delivery.criticalAlerts')}
          hint={t('admin.notifications.delivery.criticalAlertsHint')}
          checked={draft.critical_alerts_enabled}
          onChange={(critical_alerts_enabled) => set({ critical_alerts_enabled })}
        />
        {draft.critical_alerts_enabled && (
          <div className="grid gap-1.5">
            <div className="flex items-center justify-between">
              <Label>{t('admin.notifications.delivery.criticalVolume')}</Label>
              <span className="text-xs tabular-nums text-muted-foreground">
                {draft.critical_alert_volume.toFixed(2)}
              </span>
            </div>
            <Slider
              value={[Math.round(draft.critical_alert_volume * 100)]}
              max={100}
              step={5}
              onValueChange={([value]) => set({ critical_alert_volume: value / 100 })}
            />
            <p className="rounded-xl bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
              {t('admin.notifications.delivery.criticalWarning')}
            </p>
          </div>
        )}
      </SettingsSection>
    </div>
  );
}
