/**
 * Super Admin → macOS app → Updates.
 *
 * Everything Sparkle, the Mac app's updater, is told: which appcast to read,
 * which channel to follow, which builds are too old (minimum version) or
 * known-bad (blocked versions) and must update before they continue, and
 * whether it checks and downloads on its own. The Mac app reads these from
 * GET /api/platform/macos-app on launch and every hour, so a change here
 * reaches installed copies without a new build.
 */
import { useState, type KeyboardEvent } from 'react';
import { Download, RefreshCw, Ban, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useTranslation, type TranslationKey } from '@/i18n';
import {
  SettingsSection, FieldGrid, TextField, TextAreaField, SwitchField, SelectField,
} from '@/components/admin/settings/SettingsFields';
import {
  MACOS_DEFAULT_APPCAST_URL,
  MACOS_LIMITS,
  type MacosAppSettings,
} from '@/hooks/useMacosApp';
import { inBounds, isHttpsOrEmpty, isVersion, isVersionOrEmpty } from './macosModel';
import { MacosNote } from './MacosNote';
import { cn } from '@/lib/utils';

type Props = {
  draft: MacosAppSettings;
  set: (patch: Partial<MacosAppSettings>) => void;
};

export function MacosUpdatesTab({ draft, set }: Props) {
  const { t } = useTranslation();

  return (
    <div className="space-y-4">
      <SettingsSection
        icon={Download}
        heading={t('admin.macosApp.updates.title')}
        caption={t('admin.macosApp.updates.caption')}
      >
        <MacosNote>{t('admin.macosApp.updates.appcastHelp')}</MacosNote>
        <TextField
          label={t('admin.macosApp.updates.appcastUrl')}
          hint={t('admin.macosApp.updates.appcastUrlHint')}
          value={draft.appcast_url ?? ''}
          placeholder={MACOS_DEFAULT_APPCAST_URL}
          dir="ltr"
          maxLength={MACOS_LIMITS.url}
          invalid={!isHttpsOrEmpty(draft.appcast_url)}
          onChange={(value) => set({ appcast_url: value || null })}
        />
        <FieldGrid>
          <SelectField
            label={t('admin.macosApp.updates.channel')}
            hint={t('admin.macosApp.updates.channelHint')}
            value={draft.update_channel}
            onChange={(value) => set({ update_channel: value as MacosAppSettings['update_channel'] })}
            options={[
              { value: 'stable', label: t('admin.macosApp.updates.channelStable') },
              { value: 'beta', label: t('admin.macosApp.updates.channelBeta') },
            ]}
          />
          <TextField
            label={t('admin.macosApp.updates.downloadUrl')}
            hint={t('admin.macosApp.updates.downloadUrlHint')}
            value={draft.download_url ?? ''}
            placeholder="https://"
            dir="ltr"
            maxLength={MACOS_LIMITS.url}
            invalid={!isHttpsOrEmpty(draft.download_url)}
            onChange={(value) => set({ download_url: value || null })}
          />
          <TextField
            label={t('admin.macosApp.updates.latestVersion')}
            hint={t('admin.macosApp.updates.latestVersionHint')}
            value={draft.latest_version ?? ''}
            placeholder="1.4.0"
            dir="ltr"
            maxLength={MACOS_LIMITS.version}
            invalid={!isVersionOrEmpty(draft.latest_version)}
            onChange={(value) => set({ latest_version: value || null })}
          />
          <TextField
            label={t('admin.macosApp.updates.minimumVersion')}
            hint={t('admin.macosApp.updates.minimumVersionHint')}
            value={draft.minimum_supported_version ?? ''}
            placeholder="1.2.0"
            dir="ltr"
            maxLength={MACOS_LIMITS.version}
            invalid={!isVersionOrEmpty(draft.minimum_supported_version)}
            onChange={(value) => set({ minimum_supported_version: value || null })}
          />
        </FieldGrid>
        <BlockedVersionsField
          values={draft.blocked_versions}
          onChange={(blocked_versions) => set({ blocked_versions })}
        />
        <TextAreaField
          label={t('admin.macosApp.updates.releaseNotes')}
          hint={t('admin.macosApp.updates.releaseNotesHint')}
          value={draft.release_notes ?? ''}
          rows={6}
          counter={MACOS_LIMITS.releaseNotes}
          onChange={(value) => set({ release_notes: value || null })}
        />
      </SettingsSection>

      <SettingsSection
        icon={RefreshCw}
        heading={t('admin.macosApp.updates.autoTitle')}
        caption={t('admin.macosApp.updates.autoCaption')}
      >
        <FieldGrid>
          <SwitchField
            label={t('admin.macosApp.updates.autoCheck')}
            hint={t('admin.macosApp.updates.autoCheckHint')}
            checked={draft.auto_update_enabled}
            onChange={(auto_update_enabled) => set({ auto_update_enabled })}
          />
          <SwitchField
            label={t('admin.macosApp.updates.autoDownload')}
            hint={
              draft.auto_update_enabled
                ? t('admin.macosApp.updates.autoDownloadHint')
                : t('admin.macosApp.updates.autoDownloadNeedsCheck')
            }
            // Sparkle cannot download what it never checked for; the public
            // config ANDs the two, so the switch shows what Macs will do.
            checked={draft.auto_update_enabled && draft.auto_download_enabled}
            disabled={!draft.auto_update_enabled}
            onChange={(auto_download_enabled) => set({ auto_download_enabled })}
          />
        </FieldGrid>
        <FieldGrid>
          <TextField
            type="number"
            label={t('admin.macosApp.updates.checkInterval')}
            hint={t('admin.macosApp.updates.checkIntervalHint')}
            value={String(draft.update_check_interval_minutes)}
            dir="ltr"
            disabled={!draft.auto_update_enabled}
            invalid={!inBounds(draft.update_check_interval_minutes, 'update_check_interval_minutes')}
            onChange={(value) => set({ update_check_interval_minutes: Number(value) || 0 })}
          />
        </FieldGrid>
      </SettingsSection>
    </div>
  );
}

/**
 * A tag editor for the blocked builds: type a version, press Enter (or Add),
 * and it becomes a chip. Only well-formed, new versions are accepted, up to
 * the server's limit, so the list itself can never make the draft invalid.
 */
function BlockedVersionsField({ values, onChange }: { values: string[]; onChange: (values: string[]) => void }) {
  const { t } = useTranslation();
  const [input, setInput] = useState('');
  const [error, setError] = useState<TranslationKey | null>(null);
  const full = values.length >= MACOS_LIMITS.blockedVersions;

  const add = () => {
    const version = input.trim();
    if (!version) return;
    if (full) return setError('admin.macosApp.updates.blockedFull');
    if (!isVersion(version)) return setError('admin.macosApp.updates.blockedInvalid');
    if (values.includes(version)) return setError('admin.macosApp.updates.blockedDuplicate');
    onChange([...values, version]);
    setInput('');
    setError(null);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // Enter, comma and space all finish a version, as in any tag field.
    if (e.key === 'Enter' || e.key === ',' || e.key === ' ') {
      e.preventDefault();
      add();
    }
  };

  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between">
        <Label className="flex items-center gap-1.5">
          <Ban className="h-4 w-4 text-muted-foreground" />
          {t('admin.macosApp.updates.blockedTitle')}
        </Label>
        <span className={cn('text-[11px] tabular-nums', full ? 'font-semibold text-amber-600' : 'text-muted-foreground')}>
          {values.length} / {MACOS_LIMITS.blockedVersions}
        </span>
      </div>
      <div className="rounded-xl border border-input p-2">
        {values.length === 0 ? (
          <p className="px-1 py-1 text-xs text-muted-foreground">{t('admin.macosApp.updates.blockedEmpty')}</p>
        ) : (
          <div className="flex flex-wrap gap-1.5" dir="ltr">
            {values.map((version) => (
              <span
                key={version}
                className="inline-flex items-center gap-1 rounded-full border border-rose-500/30 bg-rose-500/10 py-0.5 pe-1 ps-2.5 text-xs font-medium text-rose-700 dark:text-rose-300"
              >
                {version}
                <button
                  type="button"
                  aria-label={t('admin.macosApp.updates.blockedRemove', { version })}
                  onClick={() => onChange(values.filter((v) => v !== version))}
                  className="rounded-full p-0.5 transition-colors hover:bg-rose-500/20"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Input
          dir="ltr"
          value={input}
          disabled={full}
          maxLength={MACOS_LIMITS.version}
          placeholder="1.3.2"
          onKeyDown={onKeyDown}
          onChange={(e) => {
            setInput(e.target.value);
            setError(null);
          }}
          className={cn('max-w-xs', error && 'border-destructive focus-visible:ring-destructive')}
        />
        <Button type="button" variant="outline" size="sm" onClick={add} disabled={full || !input.trim()}>
          <Plus className="me-1.5 h-4 w-4" />
          {t('admin.macosApp.updates.blockedAdd')}
        </Button>
      </div>
      {error ? (
        <p className="text-xs text-destructive">{t(error)}</p>
      ) : (
        <p className="text-xs text-muted-foreground">
          {full ? t('admin.macosApp.updates.blockedFull') : t('admin.macosApp.updates.blockedHint')}
        </p>
      )}
    </div>
  );
}
