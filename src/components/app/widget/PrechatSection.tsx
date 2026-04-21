import { useWidgetPrechatSettings, useUpdateWidgetPrechatSettings, type WidgetPrechatSettings } from '@/hooks/useWidgetIdentity';
import { useWidgetPlatformSettings, type PreChatPolicy } from '@/hooks/useWidgetPlatformSettings';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { User, Mail, Phone, ShieldCheck, Lock, Info, Clock } from 'lucide-react';
import { toast } from '@/hooks/use-toast';

interface Props {
  workspaceId: string | undefined;
}

type FieldKey = 'name' | 'email' | 'phone';

const FIELD_META: Record<FieldKey, { label: string; icon: React.ComponentType<{ className?: string }>; canVerify: boolean }> = {
  name: { label: 'Name', icon: User, canVerify: false },
  email: { label: 'Email', icon: Mail, canVerify: true },
  phone: { label: 'Phone', icon: Phone, canVerify: true },
};

/**
 * Resolves how a platform-level PreChatPolicy constrains the workspace toggle:
 *  - force_on  → ask=ON locked, require=ON locked
 *  - force_off → ask=OFF locked (require irrelevant)
 *  - default_* → workspace can override freely
 */
function resolveLock(policy: PreChatPolicy | undefined) {
  if (policy === 'force_on') return { askLocked: true, askValue: true, requireLocked: true, requireValue: true, label: 'Forced ON by admin' };
  if (policy === 'force_off') return { askLocked: true, askValue: false, requireLocked: true, requireValue: false, label: 'Forced OFF by admin' };
  return { askLocked: false, askValue: undefined, requireLocked: false, requireValue: undefined, label: '' };
}

export function PrechatSection({ workspaceId }: Props) {
  const { data: settings, isLoading } = useWidgetPrechatSettings(workspaceId);
  const { data: platform } = useWidgetPlatformSettings();
  const updateMut = useUpdateWidgetPrechatSettings(workspaceId);

  const update = (patch: Partial<WidgetPrechatSettings>) => {
    updateMut.mutate(patch, {
      onSuccess: () => toast({ title: 'Saved', description: 'Pre-chat settings updated' }),
      onError: (e: any) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
    });
  };

  if (isLoading) return <div className="text-sm text-muted-foreground">Loading…</div>;

  // Defaults if no row yet — match server fallback in widgetIdentity.ts
  const s: WidgetPrechatSettings = settings || {
    workspace_id: workspaceId || '',
    ask_name: true, ask_email: true, ask_phone: false,
    require_name: true, require_email: true, require_phone: false,
    verify_email: false, verify_phone: false,
    history_continue_window_hours: 24,
  };

  const policyByField: Record<FieldKey, PreChatPolicy | undefined> = {
    name: platform?.prechat_name_policy,
    email: platform?.prechat_email_policy,
    phone: platform?.prechat_phone_policy,
  };

  return (
    <div className="space-y-4">
      <Card className="card-elevated">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <ShieldCheck className="h-4 w-4" /> Pre-chat form fields
          </CardTitle>
          <CardDescription>
            Choose what visitors must provide before they can send the first message. Fields locked by your platform
            admin cannot be changed here.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {(Object.keys(FIELD_META) as FieldKey[]).map((key) => {
            const meta = FIELD_META[key];
            const Icon = meta.icon;
            const lock = resolveLock(policyByField[key]);
            const askField = `ask_${key}` as keyof WidgetPrechatSettings;
            const requireField = `require_${key}` as keyof WidgetPrechatSettings;
            const verifyField = `verify_${key}` as keyof WidgetPrechatSettings;
            const askValue = lock.askLocked ? lock.askValue! : (s[askField] as boolean);
            const requireValue = lock.requireLocked ? lock.requireValue! : (s[requireField] as boolean);
            const verifyValue = (s[verifyField as keyof WidgetPrechatSettings] as boolean) ?? false;

            return (
              <div key={key} className="rounded-lg border border-border p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <div className="p-2 rounded-lg bg-primary/10">
                      <Icon className="h-4 w-4 text-primary" />
                    </div>
                    <Label className="text-sm font-medium">{meta.label}</Label>
                    {lock.askLocked && (
                      <Badge variant="destructive" className="gap-1 text-[10px]">
                        <Lock className="h-3 w-3" /> {lock.label}
                      </Badge>
                    )}
                  </div>
                  <Switch
                    checked={askValue}
                    disabled={lock.askLocked || updateMut.isPending}
                    onCheckedChange={(v) => update({ [askField]: v } as any)}
                  />
                </div>

                {askValue && (
                  <div className="ms-11 space-y-2 pt-1">
                    <div className="flex items-center justify-between">
                      <Label className="text-xs text-muted-foreground">Required field</Label>
                      <Switch
                        checked={requireValue}
                        disabled={lock.requireLocked || updateMut.isPending}
                        onCheckedChange={(v) => update({ [requireField]: v } as any)}
                      />
                    </div>
                    {meta.canVerify && (
                      <div className="flex items-center justify-between">
                        <div>
                          <Label className="text-xs text-muted-foreground">
                            Verify {meta.label.toLowerCase()} (OTP)
                          </Label>
                          <p className="text-[11px] text-muted-foreground/80">
                            Send a one-time code before the conversation starts.
                          </p>
                        </div>
                        <Switch
                          checked={verifyValue}
                          disabled={updateMut.isPending}
                          onCheckedChange={(v) => update({ [verifyField]: v } as any)}
                        />
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>

      <Card className="card-elevated">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Clock className="h-4 w-4" /> Conversation continuity
          </CardTitle>
          <CardDescription>
            How long a returning visitor can resume their previous conversation without re-entering pre-chat info.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Label className="text-xs font-medium">Continue window (hours)</Label>
          <Input
            type="number"
            min={0}
            max={720}
            value={s.history_continue_window_hours}
            onChange={(e) => update({ history_continue_window_hours: parseInt(e.target.value || '24', 10) })}
            className="max-w-32"
          />
          <p className="text-[11px] text-muted-foreground">
            Set to 0 to always show the pre-chat form on a new visit.
          </p>
        </CardContent>
      </Card>

      <div className="flex items-start gap-2 bg-muted/40 rounded-lg p-3 text-xs text-muted-foreground">
        <Info className="h-4 w-4 mt-0.5 shrink-0" />
        <p>
          Platform admins set field policies under <strong>Super Admin → Widget Settings → Pre-chat fields</strong>. Any
          field marked <strong>Force ON / Force OFF</strong> is locked here.
        </p>
      </div>
    </div>
  );
}
