/**
 * Platform defaults.
 *
 * These apply ONLY to an operator who has never saved their own notification
 * preferences — a personal setting always wins. The hint on every field says
 * so, because "default" that silently overrode a user's choice would be a
 * privacy problem, not a convenience.
 */
import { SlidersHorizontal, Moon, Gauge } from 'lucide-react';
import { useTranslation, type TranslationKey } from '@/i18n';
import {
  SettingsSection, FieldGrid, SelectField, SwitchField, TextField,
} from '@/components/admin/settings/SettingsFields';
import type { PushPlatformSettings, PushScope } from '@/hooks/useAdminNotifications';

export function NotificationPolicyTab({
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
        icon={SlidersHorizontal}
        heading={t('admin.notifications.policy.title')}
        caption={t('admin.notifications.policy.caption')}
      >
        <FieldGrid>
          <SelectField
            label={t('admin.notifications.policy.scope')}
            hint={t('admin.notifications.policy.scopeHint')}
            value={draft.default_scope}
            onChange={(value) => set({ default_scope: value as PushScope })}
            options={(['all', 'assigned', 'mentions', 'none'] as PushScope[]).map((value) => ({
              value,
              label: t(`admin.notifications.policy.scopeOption.${value}` as TranslationKey),
            }))}
          />
          <SwitchField
            label={t('admin.notifications.policy.preview')}
            hint={t('admin.notifications.policy.previewHint')}
            checked={draft.default_preview}
            onChange={(default_preview) => set({ default_preview })}
          />
          <SwitchField
            label={t('admin.notifications.policy.internalNotes')}
            hint={t('admin.notifications.policy.internalNotesHint')}
            checked={draft.default_internal_notes}
            onChange={(default_internal_notes) => set({ default_internal_notes })}
          />
          <SwitchField
            label={t('admin.notifications.policy.sound')}
            hint={t('admin.notifications.policy.soundHint')}
            checked={draft.default_sound}
            onChange={(default_sound) => set({ default_sound })}
          />
        </FieldGrid>
      </SettingsSection>

      <SettingsSection
        icon={Moon}
        heading={t('admin.notifications.policy.quietHours')}
        caption={t('admin.notifications.policy.quietHoursHint')}
      >
        <SwitchField
          label={t('admin.notifications.policy.quietEnabled')}
          hint={t('admin.notifications.policy.quietEnabledHint')}
          checked={draft.default_quiet_hours_enabled}
          onChange={(default_quiet_hours_enabled) => set({ default_quiet_hours_enabled })}
        />
        <FieldGrid cols={3}>
          <TextField
            label={t('admin.notifications.policy.quietStart')}
            value={draft.default_quiet_hours_start}
            dir="ltr"
            type="time"
            onChange={(default_quiet_hours_start) => set({ default_quiet_hours_start })}
          />
          <TextField
            label={t('admin.notifications.policy.quietEnd')}
            value={draft.default_quiet_hours_end}
            dir="ltr"
            type="time"
            onChange={(default_quiet_hours_end) => set({ default_quiet_hours_end })}
          />
          <TextField
            label={t('admin.notifications.policy.quietTimezone')}
            hint={t('admin.notifications.policy.quietTimezoneHint')}
            value={draft.default_quiet_hours_timezone ?? ''}
            dir="ltr"
            onChange={(value) => set({ default_quiet_hours_timezone: value || null })}
          />
        </FieldGrid>
        <SwitchField
          label={t('admin.notifications.policy.mentionBypass')}
          hint={t('admin.notifications.policy.mentionBypassHint')}
          checked={draft.mention_bypasses_quiet_hours}
          onChange={(mention_bypasses_quiet_hours) => set({ mention_bypasses_quiet_hours })}
        />
        <p className="rounded-xl bg-muted/60 p-3 text-xs text-muted-foreground">
          {t('admin.notifications.policy.quietWrapNote')}
        </p>
      </SettingsSection>

      <SettingsSection
        icon={Gauge}
        heading={t('admin.notifications.policy.guardrails')}
        caption={t('admin.notifications.policy.guardrailsHint')}
      >
        <FieldGrid>
          <TextField
            label={t('admin.notifications.policy.throttle')}
            hint={t('admin.notifications.policy.throttleHint')}
            value={String(draft.throttle_per_user_per_minute)}
            dir="ltr"
            type="number"
            onChange={(value) =>
              set({ throttle_per_user_per_minute: Math.min(600, Math.max(1, Number(value) || 1)) })
            }
          />
          <TextField
            label={t('admin.notifications.policy.logRetention')}
            hint={t('admin.notifications.policy.logRetentionHint')}
            value={String(draft.dispatch_log_retention_days)}
            dir="ltr"
            type="number"
            onChange={(value) =>
              set({ dispatch_log_retention_days: Math.min(365, Math.max(1, Number(value) || 1)) })
            }
          />
        </FieldGrid>
      </SettingsSection>
    </div>
  );
}
