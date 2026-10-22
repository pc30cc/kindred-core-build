import { useEffect, useId, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Lock, Shield, Activity, MessageSquare, Info } from 'lucide-react';
import type { WidgetPlatformSettings } from '@/hooks/useWidgetPlatformSettings';
import { useTranslation, type TranslationKey } from '@/i18n';
import { cn } from '@/lib/utils';
import {
  PLATFORM_TUNING_RANGES,
  parsePlatformTuningValue,
  type PlatformTuningKey,
} from '../../../../shared/platformTuning';

interface Props {
  /** The stored settings with the page's draft over them. */
  settings: WidgetPlatformSettings;
  /** A switch: saved at once. */
  onSave: (patch: Partial<WidgetPlatformSettings>) => void;
  /** A typed value: saved once the typing stops. */
  onDraft: (patch: Partial<WidgetPlatformSettings>) => void;
}

/**
 * One tuning number. The field keeps what is typed; only a whole number in
 * the key's range (shared/platformTuning.ts) is drafted, so an emptied or
 * out-of-range field saves nothing and says why, and leaving it puts the
 * stored value back.
 */
export function TuningNumberField({
  field, label, rangeKey, value, disabled, onDraft,
}: {
  field: PlatformTuningKey;
  label: string;
  /** The range line, with {{min}} and {{max}} in its unit. */
  rangeKey: TranslationKey;
  value: number;
  disabled?: boolean;
  onDraft: (patch: Partial<WidgetPlatformSettings>) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const range = PLATFORM_TUNING_RANGES[field];
  const [text, setText] = useState(String(value));
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setText(String(value));
  }, [value, editing]);
  const invalid = parsePlatformTuningValue(field, text) === null;
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs text-muted-foreground">{label}</Label>
      <Input
        id={id}
        type="text"
        inputMode="numeric"
        dir="ltr"
        disabled={disabled}
        value={text}
        aria-invalid={invalid || undefined}
        aria-describedby={`${id}-range`}
        data-tuning-field={field}
        className={cn('max-w-32', invalid && 'border-destructive focus-visible:ring-destructive')}
        onFocus={() => setEditing(true)}
        onBlur={() => {
          setEditing(false);
          setText(String(value));
        }}
        onChange={(e) => {
          setText(e.target.value);
          const next = parsePlatformTuningValue(field, e.target.value);
          if (next !== null && next !== value) onDraft({ [field]: next } as Partial<WidgetPlatformSettings>);
        }}
      />
      <p id={`${id}-range`} className="text-[10px] text-muted-foreground">
        {t(rangeKey, { min: range.min, max: range.max })}
      </p>
      {invalid && (
        <p role="alert" className="text-[11px] text-destructive">
          {t('admin.widgetSettingsPage.hardening.outOfRange', { min: range.min, max: range.max })}
        </p>
      )}
    </div>
  );
}

/**
 * Phase 1 — Realtime / Transport: the realtime client's recovery and memory
 * values and the token lifetime. Each one is read: jitter, the pending cap
 * and the dedupe window by the realtime client (platform public config), the
 * token lifetime by the token routes (server/routes/realtime.ts). The
 * stale-socket guard switch and the idle-disposal time are gone: the guard is
 * always on in the client and nothing disposes an idle socket by time.
 */
export function RealtimeTransportSection({ settings, onSave, onDraft }: Props) {
  const { t } = useTranslation();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Activity className="h-4 w-4 text-primary" />
          {t('admin.widgetSettingsPage.hardening.realtime.title')}
        </CardTitle>
        <CardDescription>
          {t('admin.widgetSettingsPage.hardening.realtime.description')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Phase 2 — reconnect jitter */}
        <div className="rounded-lg border border-border p-4 space-y-2">
          <p className="text-sm font-medium">{t('admin.widgetSettingsPage.hardening.realtime.jitter')}</p>
          <p className="text-xs text-muted-foreground">
            {t('admin.widgetSettingsPage.hardening.realtime.jitterHint')}
          </p>
          <TuningNumberField
            field="realtime_reconnect_jitter_pct"
            label={t('admin.widgetSettingsPage.hardening.realtime.jitterValue')}
            rangeKey="admin.widgetSettingsPage.hardening.realtime.jitterRange"
            value={settings.realtime_reconnect_jitter_pct}
            onDraft={onDraft}
          />
        </div>

        {/* Phase 2 — token lifetime */}
        <div className="rounded-lg border border-border p-4 space-y-2">
          <p className="text-sm font-medium">{t('admin.widgetSettingsPage.hardening.realtime.tokenTtl')}</p>
          <p className="text-xs text-muted-foreground">
            {t('admin.widgetSettingsPage.hardening.realtime.tokenTtlHint')}
          </p>
          <TuningNumberField
            field="realtime_token_ttl_seconds"
            label={t('admin.widgetSettingsPage.hardening.realtime.tokenTtlValue')}
            rangeKey="admin.widgetSettingsPage.hardening.realtime.tokenRange"
            value={settings.realtime_token_ttl_seconds}
            onDraft={onDraft}
          />
        </div>

        {/* Phase 2 — pending cap */}
        <div className="rounded-lg border border-border p-4 space-y-2">
          <p className="text-sm font-medium">{t('admin.widgetSettingsPage.hardening.realtime.memory')}</p>
          <TuningNumberField
            field="realtime_pending_max"
            label={t('admin.widgetSettingsPage.hardening.realtime.pendingCap')}
            rangeKey="admin.widgetSettingsPage.hardening.realtime.pendingRange"
            value={settings.realtime_pending_max}
            onDraft={onDraft}
          />
          <p className="text-[10px] text-muted-foreground">
            {t('admin.widgetSettingsPage.hardening.realtime.pendingHint')}
          </p>
        </div>

        {/* Phase 2 — message dedupe */}
        <div className="rounded-lg border border-border p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5 max-w-xl">
              <Label className="text-sm font-medium">{t('admin.widgetSettingsPage.hardening.realtime.dedupe')}</Label>
              <p className="text-xs text-muted-foreground">
                {t('admin.widgetSettingsPage.hardening.realtime.dedupeBefore')} <code className="bg-muted px-1 rounded">payload.id</code>{' '}
                {t('admin.widgetSettingsPage.hardening.realtime.dedupeAfter')}
              </p>
            </div>
            <Switch
              aria-label={t('admin.widgetSettingsPage.hardening.realtime.dedupe')}
              checked={settings.realtime_message_dedupe_enabled}
              onCheckedChange={(v) => onSave({ realtime_message_dedupe_enabled: v })}
            />
          </div>
          <TuningNumberField
            field="realtime_message_dedupe_window"
            label={t('admin.widgetSettingsPage.hardening.realtime.ringWindow')}
            rangeKey="admin.widgetSettingsPage.hardening.realtime.ringRange"
            value={settings.realtime_message_dedupe_window}
            disabled={!settings.realtime_message_dedupe_enabled}
            onDraft={onDraft}
          />
        </div>

        <div className="flex items-start gap-2 bg-muted/40 rounded-md p-2 text-xs text-muted-foreground">
          <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <p>
            {t('admin.widgetSettingsPage.hardening.realtime.clamped')}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Phase 1 — Security / Isolation
 * Read-only diagnostics describing the channel-ownership policy. The strict
 * format check is always enforced server-side (no toggle).
 */
export function SecurityIsolationSection() {
  const { t } = useTranslation();
  const enforced = (
    <Badge variant="default" className="gap-1 text-xs">
      <Lock className="h-3 w-3" />
      {t('admin.widgetSettingsPage.hardening.security.enforced')}
    </Badge>
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Shield className="h-4 w-4 text-primary" />
          {t('admin.widgetSettingsPage.hardening.security.title')}
        </CardTitle>
        <CardDescription>
          {t('admin.widgetSettingsPage.hardening.security.description')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="rounded-lg border border-border p-4 space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-sm font-medium">{t('admin.widgetSettingsPage.hardening.security.channelPolicy')}</Label>
            {enforced}
          </div>
          <p className="text-xs text-muted-foreground">
            {t('admin.widgetSettingsPage.hardening.security.channelHint')}
          </p>
          <ul className="text-xs font-mono space-y-1 text-muted-foreground ps-2">
            <li>• ws:&#123;workspaceId&#125;:inbox</li>
            <li>• ws:&#123;workspaceId&#125;:visitors</li>
            <li>• ws:&#123;workspaceId&#125;:conv:&#123;conversationId&#125;</li>
          </ul>
        </div>

        <div className="rounded-lg border border-border p-4 space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-sm font-medium">{t('admin.widgetSettingsPage.hardening.security.strictValidation')}</Label>
            {enforced}
          </div>
          <p className="text-xs text-muted-foreground">
            {t('admin.widgetSettingsPage.hardening.security.strictHint')}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Phase 1 — Flood / Abuse Protection
 * Server-side typing rate limit — per-conversation sliding window with
 * silent overflow drop (services/widget/typingRateLimit.ts).
 */
export function FloodProtectionSection({ settings, onSave, onDraft }: Props) {
  const { t } = useTranslation();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-primary" />
          {t('admin.widgetSettingsPage.hardening.flood.title')}
        </CardTitle>
        <CardDescription>
          {t('admin.widgetSettingsPage.hardening.flood.description')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-lg border border-border p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5 max-w-xl">
              <Label className="text-sm font-medium">{t('admin.widgetSettingsPage.hardening.flood.typingLimit')}</Label>
              <p className="text-xs text-muted-foreground">
                {t('admin.widgetSettingsPage.hardening.flood.typingBefore')} <code className="bg-muted px-1 rounded">action=typing</code>{' '}
                {t('admin.widgetSettingsPage.hardening.flood.typingAfter')}
              </p>
            </div>
            <Switch
              aria-label={t('admin.widgetSettingsPage.hardening.flood.typingLimit')}
              checked={settings.typing_rate_limit_enabled}
              onCheckedChange={(v) => onSave({ typing_rate_limit_enabled: v })}
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
            <TuningNumberField
              field="typing_rate_limit_window_ms"
              label={t('admin.widgetSettingsPage.hardening.flood.window')}
              rangeKey="admin.widgetSettingsPage.hardening.flood.windowRange"
              value={settings.typing_rate_limit_window_ms}
              disabled={!settings.typing_rate_limit_enabled}
              onDraft={onDraft}
            />
            <TuningNumberField
              field="typing_rate_limit_max_events"
              label={t('admin.widgetSettingsPage.hardening.flood.maxEvents')}
              rangeKey="admin.widgetSettingsPage.hardening.flood.eventsRange"
              value={settings.typing_rate_limit_max_events}
              disabled={!settings.typing_rate_limit_enabled}
              onDraft={onDraft}
            />
          </div>

          <div className="flex items-start gap-2 bg-muted/40 rounded-md p-2 text-xs text-muted-foreground">
            <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <p>
              {t('admin.widgetSettingsPage.hardening.flood.defaultBehavior')}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
