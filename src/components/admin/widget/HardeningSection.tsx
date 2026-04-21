import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Lock, Shield, Activity, MessageSquare, Info } from 'lucide-react';
import type { WidgetPlatformSettings } from '@/hooks/useWidgetPlatformSettings';

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
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Activity className="h-4 w-4 text-primary" />
          Realtime / Transport
        </CardTitle>
        <CardDescription>
          Transport-level safety controls for the realtime layer. These flags affect every
          workspace and are designed with safe defaults — only flip them if you have a specific
          reason.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-lg border border-border p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5 max-w-xl">
              <Label className="text-sm font-medium">Stale resubscribe guard</Label>
              <p className="text-xs text-muted-foreground">
                When the operator socket dies during a resubscribe pass, abort the loop instead
                of continuing per-channel against a dead connection. Prevents{' '}
                <code className="bg-muted px-1 rounded">socket_closed</code> log floods and
                ensures exactly one fresh socket owns recovery. Recommended: leave on.
              </p>
            </div>
            <Switch
              checked={settings.realtime_stale_resubscribe_guard_enabled}
              onCheckedChange={(v) =>
                onSave({ realtime_stale_resubscribe_guard_enabled: v })
              }
            />
          </div>
          <div className="flex items-start gap-2 bg-muted/40 rounded-md p-2 text-xs text-muted-foreground">
            <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <p>
              Enforced in the operator-side Centrifugo client. Diagnostic flag — the guard is
              always present in code; this toggle only controls whether the runtime treats it
              as advisory or strict. Future transport hardening flags (jitter, etc.) will land
              here in Phase 2.
            </p>
          </div>
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
  const enforced = (
    <Badge variant="default" className="gap-1 text-xs">
      <Lock className="h-3 w-3" />
      Always enforced
    </Badge>
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Shield className="h-4 w-4 text-primary" />
          Security / Isolation
        </CardTitle>
        <CardDescription>
          Multi-tenant channel-isolation guarantees enforced by the realtime token issuer and
          publish helpers. These checks cannot be disabled.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="rounded-lg border border-border p-4 space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-sm font-medium">Channel format policy</Label>
            {enforced}
          </div>
          <p className="text-xs text-muted-foreground">
            Only three channel shapes are accepted by the realtime token issuer:
          </p>
          <ul className="text-xs font-mono space-y-1 text-muted-foreground pl-2">
            <li>• ws:&#123;workspaceId&#125;:inbox</li>
            <li>• ws:&#123;workspaceId&#125;:visitors</li>
            <li>• ws:&#123;workspaceId&#125;:conv:&#123;conversationId&#125;</li>
          </ul>
        </div>

        <div className="rounded-lg border border-border p-4 space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-sm font-medium">Strict workspace channel validation</Label>
            {enforced}
          </div>
          <p className="text-xs text-muted-foreground">
            Loose prefix matching is rejected. The conversation segment is constrained to
            URL-safe characters (1–128 chars, alphanumerics / underscore / dash). Widget tokens
            can never be issued for the operator-only inbox or visitors channels.
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
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-primary" />
          Flood / Abuse Protection
        </CardTitle>
        <CardDescription>
          Server-side controls that protect realtime fan-out from abusive clients. Limits are
          enforced per conversation and overflow is silently dropped — the widget never sees
          an error.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-lg border border-border p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5 max-w-xl">
              <Label className="text-sm font-medium">Typing rate limit</Label>
              <p className="text-xs text-muted-foreground">
                Cap how often <code className="bg-muted px-1 rounded">action=typing</code>{' '}
                events are republished on the realtime channel for a single conversation.
                Does not affect message sending.
              </p>
            </div>
            <Switch
              checked={settings.typing_rate_limit_enabled}
              onCheckedChange={(v) => onSave({ typing_rate_limit_enabled: v })}
            />
          </div>

          <div className="grid grid-cols-2 gap-3 pt-2">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Window (ms)</Label>
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
              <Label className="text-xs text-muted-foreground">Max events / window</Label>
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
              <p className="text-[10px] text-muted-foreground">1 – 100 events</p>
            </div>
          </div>

          <div className="flex items-start gap-2 bg-muted/40 rounded-md p-2 text-xs text-muted-foreground">
            <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <p>
              Default: <strong>2 events per 2000 ms</strong> per conversation. Overflow is
              silently dropped — typing is best-effort and visitors never see an error.
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
