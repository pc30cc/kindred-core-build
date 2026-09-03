import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Lock, Shield, Activity, MessageSquare, Info } from 'lucide-react';
import type { WidgetPlatformSettings } from '@/hooks/useWidgetPlatformSettings';
import { useTranslation } from '@/i18n';

interface Props {
  settings: WidgetPlatformSettings;
  onSave: (patch: Partial<WidgetPlatformSettings>) => void;
}

/**
 * Phase 1 — Realtime / Transport
 * Houses transport-level safety flags. Each toggle has a safe default and
 * is wired through to server-side runtime via `widget_platform_settings`.
 */
export function RealtimeTransportSection({ settings, onSave }: Props) {
  const { t } = useTranslation();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Activity className="h-4 w-4 text-primary" />
          {t('admin.widgetSettingsPage.hardening.realtime.title' as any)}
        </CardTitle>
        <CardDescription>
          {t('admin.widgetSettingsPage.hardening.realtime.description' as any)}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-lg border border-border p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5 max-w-xl">
              <Label className="text-sm font-medium">{t('admin.widgetSettingsPage.hardening.realtime.staleGuard' as any)}</Label>
              <p className="text-xs text-muted-foreground">
                {t('admin.widgetSettingsPage.hardening.realtime.staleBefore' as any)}{' '}
                <code className="bg-muted px-1 rounded">socket_closed</code>{' '}
                {t('admin.widgetSettingsPage.hardening.realtime.staleAfter' as any)}
              </p>
            </div>
            <Switch
              checked={settings.realtime_stale_resubscribe_guard_enabled}
              onCheckedChange={(v) =>
                onSave({ realtime_stale_resubscribe_guard_enabled: v })
              }
            />
          </div>
        </div>

        {/* Phase 2 — reconnect jitter */}
        <div className="rounded-lg border border-border p-4 space-y-2">
          <Label className="text-sm font-medium">{t('admin.widgetSettingsPage.hardening.realtime.jitter' as any)}</Label>
          <p className="text-xs text-muted-foreground">
            {t('admin.widgetSettingsPage.hardening.realtime.jitterHint' as any)}
          </p>
          <Input
            type="number" min={0} max={50} step={1}
            value={settings.realtime_reconnect_jitter_pct}
            onChange={(e) => onSave({
              realtime_reconnect_jitter_pct: Math.max(0, Math.min(50, parseInt(e.target.value || '20', 10))),
            })}
            className="max-w-32"
          />
          <p className="text-[10px] text-muted-foreground">{t('admin.widgetSettingsPage.hardening.realtime.jitterRange' as any)}</p>
        </div>

        {/* Phase 2 — JWT TTL */}
        <div className="rounded-lg border border-border p-4 space-y-2">
          <Label className="text-sm font-medium">{t('admin.widgetSettingsPage.hardening.realtime.tokenTtl' as any)}</Label>
          <p className="text-xs text-muted-foreground">
            {t('admin.widgetSettingsPage.hardening.realtime.tokenTtlBefore' as any)}{' '}
            <code className="bg-muted px-1 rounded">lovable-realtime</code> /{' '}
            <code className="bg-muted px-1 rounded">centrifugo</code>{' '}
            {t('admin.widgetSettingsPage.hardening.realtime.tokenTtlAfter' as any)}
          </p>
          <Input
            type="number" min={300} max={7200} step={60}
            value={settings.realtime_token_ttl_seconds}
            onChange={(e) => onSave({
              realtime_token_ttl_seconds: Math.max(300, Math.min(7200, parseInt(e.target.value || '1800', 10))),
            })}
            className="max-w-32"
          />
          <p className="text-[10px] text-muted-foreground">{t('admin.widgetSettingsPage.hardening.realtime.tokenRange' as any)}</p>
        </div>

        {/* Phase 2 — idle disposal + pending cap */}
        <div className="rounded-lg border border-border p-4 space-y-3">
          <Label className="text-sm font-medium">{t('admin.widgetSettingsPage.hardening.realtime.memory' as any)}</Label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">{t('admin.widgetSettingsPage.hardening.realtime.idleDisposal' as any)}</Label>
              <Input
                type="number" min={10000} max={1800000} step={1000}
                value={settings.realtime_idle_disposal_ms}
                onChange={(e) => onSave({
                  realtime_idle_disposal_ms: Math.max(10000, Math.min(1800000, parseInt(e.target.value || '60000', 10))),
                })}
              />
              <p className="text-[10px] text-muted-foreground">10000 – 1800000 ms</p>
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">{t('admin.widgetSettingsPage.hardening.realtime.pendingCap' as any)}</Label>
              <Input
                type="number" min={32} max={4096} step={32}
                value={settings.realtime_pending_max}
                onChange={(e) => onSave({
                  realtime_pending_max: Math.max(32, Math.min(4096, parseInt(e.target.value || '256', 10))),
                })}
              />
              <p className="text-[10px] text-muted-foreground">32 – 4096</p>
            </div>
          </div>
          <p className="text-[10px] text-muted-foreground">
            {t('admin.widgetSettingsPage.hardening.realtime.pendingHint' as any)}
          </p>
        </div>

        {/* Phase 2 — message dedupe */}
        <div className="rounded-lg border border-border p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5 max-w-xl">
              <Label className="text-sm font-medium">{t('admin.widgetSettingsPage.hardening.realtime.dedupe' as any)}</Label>
              <p className="text-xs text-muted-foreground">
                {t('admin.widgetSettingsPage.hardening.realtime.dedupeBefore' as any)} <code className="bg-muted px-1 rounded">payload.id</code>{' '}
                {t('admin.widgetSettingsPage.hardening.realtime.dedupeAfter' as any)}
              </p>
            </div>
            <Switch
              checked={settings.realtime_message_dedupe_enabled}
              onCheckedChange={(v) => onSave({ realtime_message_dedupe_enabled: v })}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">{t('admin.widgetSettingsPage.hardening.realtime.ringWindow' as any)}</Label>
            <Input
              type="number" min={16} max={4096} step={16}
              disabled={!settings.realtime_message_dedupe_enabled}
              value={settings.realtime_message_dedupe_window}
              onChange={(e) => onSave({
                realtime_message_dedupe_window: Math.max(16, Math.min(4096, parseInt(e.target.value || '200', 10))),
              })}
              className="max-w-32"
            />
            <p className="text-[10px] text-muted-foreground">{t('admin.widgetSettingsPage.hardening.realtime.ringRange' as any)}</p>
          </div>
        </div>

        <div className="flex items-start gap-2 bg-muted/40 rounded-md p-2 text-xs text-muted-foreground">
          <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <p>
            {t('admin.widgetSettingsPage.hardening.realtime.clamped' as any)}
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
      {t('admin.widgetSettingsPage.hardening.security.enforced' as any)}
    </Badge>
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Shield className="h-4 w-4 text-primary" />
          {t('admin.widgetSettingsPage.hardening.security.title' as any)}
        </CardTitle>
        <CardDescription>
          {t('admin.widgetSettingsPage.hardening.security.description' as any)}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="rounded-lg border border-border p-4 space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-sm font-medium">{t('admin.widgetSettingsPage.hardening.security.channelPolicy' as any)}</Label>
            {enforced}
          </div>
          <p className="text-xs text-muted-foreground">
            {t('admin.widgetSettingsPage.hardening.security.channelHint' as any)}
          </p>
          <ul className="text-xs font-mono space-y-1 text-muted-foreground ps-2">
            <li>• ws:&#123;workspaceId&#125;:inbox</li>
            <li>• ws:&#123;workspaceId&#125;:visitors</li>
            <li>• ws:&#123;workspaceId&#125;:conv:&#123;conversationId&#125;</li>
          </ul>
        </div>

        <div className="rounded-lg border border-border p-4 space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-sm font-medium">{t('admin.widgetSettingsPage.hardening.security.strictValidation' as any)}</Label>
            {enforced}
          </div>
          <p className="text-xs text-muted-foreground">
            {t('admin.widgetSettingsPage.hardening.security.strictHint' as any)}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Phase 1 — Flood / Abuse Protection
 * Server-side typing rate limit — per-conversation sliding window with
 * silent overflow drop. Future flood controls will land here.
 */
export function FloodProtectionSection({ settings, onSave }: Props) {
  const { t } = useTranslation();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-primary" />
          {t('admin.widgetSettingsPage.hardening.flood.title' as any)}
        </CardTitle>
        <CardDescription>
          {t('admin.widgetSettingsPage.hardening.flood.description' as any)}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-lg border border-border p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5 max-w-xl">
              <Label className="text-sm font-medium">{t('admin.widgetSettingsPage.hardening.flood.typingLimit' as any)}</Label>
              <p className="text-xs text-muted-foreground">
                {t('admin.widgetSettingsPage.hardening.flood.typingBefore' as any)} <code className="bg-muted px-1 rounded">action=typing</code>{' '}
                {t('admin.widgetSettingsPage.hardening.flood.typingAfter' as any)}
              </p>
            </div>
            <Switch
              checked={settings.typing_rate_limit_enabled}
              onCheckedChange={(v) => onSave({ typing_rate_limit_enabled: v })}
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">{t('admin.widgetSettingsPage.hardening.flood.window' as any)}</Label>
              <Input
                type="number"
                min={250}
                max={60000}
                step={250}
                disabled={!settings.typing_rate_limit_enabled}
                value={settings.typing_rate_limit_window_ms}
                onChange={(e) =>
                  onSave({
                    typing_rate_limit_window_ms: Math.max(
                      250,
                      Math.min(60000, parseInt(e.target.value || '2000', 10)),
                    ),
                  })
                }
              />
              <p className="text-[10px] text-muted-foreground">250 – 60000 ms</p>
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">{t('admin.widgetSettingsPage.hardening.flood.maxEvents' as any)}</Label>
              <Input
                type="number"
                min={1}
                max={100}
                disabled={!settings.typing_rate_limit_enabled}
                value={settings.typing_rate_limit_max_events}
                onChange={(e) =>
                  onSave({
                    typing_rate_limit_max_events: Math.max(
                      1,
                      Math.min(100, parseInt(e.target.value || '2', 10)),
                    ),
                  })
                }
              />
              <p className="text-[10px] text-muted-foreground">{t('admin.widgetSettingsPage.hardening.flood.eventsRange' as any)}</p>
            </div>
          </div>

          <div className="flex items-start gap-2 bg-muted/40 rounded-md p-2 text-xs text-muted-foreground">
            <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <p>
              {t('admin.widgetSettingsPage.hardening.flood.defaultBehavior' as any)}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
