/**
 * Where the desktop app looks for updates, and which versions the platform
 * still accepts.
 *
 * The feed is either a GitHub releases repository (the native app reads its
 * releases; the Electron app reads `…/releases/latest/download` as a generic
 * feed) or any HTTPS folder serving the release files. The desktop app reads
 * these values from GET /api/platform/desktop-app on every launch, so a change
 * here reaches installed copies without a new build.
 */
import { Download, Info } from 'lucide-react';
import { useTranslation } from '@/i18n';
import {
  SettingsSection, FieldGrid, TextField, TextAreaField, SwitchField, SelectField,
} from '@/components/admin/settings/SettingsFields';
import type { DesktopAppSettings } from '@/hooks/useDesktopApp';

const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const isHttpsOrEmpty = (value: string | null) => !value || /^https:\/\//i.test(value.trim());
const isVersionOrEmpty = (value: string | null) => !value || VERSION_RE.test(value.trim());

export function DesktopUpdatesTab({
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
        icon={Download}
        heading={t('admin.desktopApp.updates.title')}
        caption={t('admin.desktopApp.updates.caption')}
      >
        <div className="flex items-start gap-2 rounded-xl bg-primary/5 p-3 text-xs text-muted-foreground">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <p>{t('admin.desktopApp.updates.feedHelp')}</p>
        </div>
        <TextField
          label={t('admin.desktopApp.updates.feedUrl')}
          hint={t('admin.desktopApp.updates.feedUrlHint')}
          value={draft.update_feed_url ?? ''}
          dir="ltr"
          invalid={!isHttpsOrEmpty(draft.update_feed_url)}
          onChange={(value) => set({ update_feed_url: value || null })}
        />
        <FieldGrid>
          <SelectField
            label={t('admin.desktopApp.updates.channel')}
            hint={t('admin.desktopApp.updates.channelHint')}
            value={draft.update_channel}
            onChange={(value) => set({ update_channel: value as DesktopAppSettings['update_channel'] })}
            options={[
              { value: 'stable', label: t('admin.desktopApp.updates.channelStable') },
              { value: 'beta', label: t('admin.desktopApp.updates.channelBeta') },
            ]}
          />
          <TextField
            label={t('admin.desktopApp.updates.downloadUrl')}
            hint={t('admin.desktopApp.updates.downloadUrlHint')}
            value={draft.download_url ?? ''}
            dir="ltr"
            invalid={!isHttpsOrEmpty(draft.download_url)}
            onChange={(value) => set({ download_url: value || null })}
          />
          <TextField
            label={t('admin.desktopApp.updates.latestVersion')}
            hint={t('admin.desktopApp.updates.latestVersionHint')}
            value={draft.latest_version ?? ''}
            dir="ltr"
            invalid={!isVersionOrEmpty(draft.latest_version)}
            onChange={(value) => set({ latest_version: value || null })}
          />
          <TextField
            label={t('admin.desktopApp.updates.minimumVersion')}
            hint={t('admin.desktopApp.updates.minimumVersionHint')}
            value={draft.minimum_supported_version ?? ''}
            dir="ltr"
            invalid={!isVersionOrEmpty(draft.minimum_supported_version)}
            onChange={(value) => set({ minimum_supported_version: value || null })}
          />
        </FieldGrid>
        <FieldGrid>
          <SwitchField
            label={t('admin.desktopApp.updates.autoUpdate')}
            hint={t('admin.desktopApp.updates.autoUpdateHint')}
            checked={draft.auto_update_enabled}
            onChange={(auto_update_enabled) => set({ auto_update_enabled })}
          />
          <TextField
            type="number"
            label={t('admin.desktopApp.updates.checkInterval')}
            hint={t('admin.desktopApp.updates.checkIntervalHint')}
            value={String(draft.update_check_interval_minutes)}
            dir="ltr"
            disabled={!draft.auto_update_enabled}
            invalid={draft.update_check_interval_minutes < 15 || draft.update_check_interval_minutes > 1440}
            onChange={(value) => set({ update_check_interval_minutes: Number(value) || 0 })}
          />
        </FieldGrid>
        <TextAreaField
          label={t('admin.desktopApp.updates.releaseNotes')}
          hint={t('admin.desktopApp.updates.releaseNotesHint')}
          value={draft.release_notes ?? ''}
          rows={6}
          counter={4000}
          onChange={(value) => set({ release_notes: value || null })}
        />
      </SettingsSection>
    </div>
  );
}
