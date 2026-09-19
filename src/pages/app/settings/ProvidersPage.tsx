import { useState, useMemo } from 'react';
import { useTranslation } from '@/i18n';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Mail, Brain, Webhook, Check, AlertCircle, Loader2, Trash2, Eye, EyeOff } from 'lucide-react';
import { toast } from '@/lib/toast';
import {
  useWorkspaceProviders, useUpsertWsProvider, useDeleteWsProvider,
  maskSecret, getProviderStatus,
  type WsProviderType, type WsProviderSetting,
} from '@/hooks/useWorkspaceProviders';
import { WorkspacePrivacyStorageCard } from '@/features/providers/WorkspacePrivacyStorageCard';
import { WorkspaceCallSettingsCard } from '@/features/providers/WorkspaceCallSettingsCard';
import { WorkspaceRolePermissionsCard } from '@/features/providers/WorkspaceRolePermissionsCard';
import { useWorkspaceRole } from '@/hooks/useWorkspaceRole';
import { SkeletonCard } from '@/components/common/Skeletons';

// ─── Status Badge ────────────────────────────────────────────────

function StatusBadge({ status }: { status: 'workspace' | 'platform' | 'none' }) {
  if (status === 'workspace')
    return <Badge className="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30 text-xs">Using workspace config</Badge>;
  if (status === 'platform')
    return <Badge variant="secondary" className="text-xs">Using platform default</Badge>;
  return <Badge variant="outline" className="text-xs text-muted-foreground">Not configured</Badge>;
}

// ─── Email Provider ─────────────────────────────────────────────
//
// There is no Email card here, and its absence is the rule rather than an
// omission. Email transport is platform infrastructure: one provider for the
// whole platform, configured by a platform admin in
// Super Admin → Providers → Communication → Email.
//
// A workspace-level card let a workspace admin put their own Resend key,
// SMTP credentials and From address in front of mail the platform sends on
// its own behalf — password resets, verification codes, invitations. The
// backend refuses `provider_type: "email"` on this route now too
// (server/routes/workspaceIntegrations.ts), so this is not a UI-only rule.

// ─── AI Provider Card ────────────────────────────────────────────

function AIProviderCard({ workspaceId, settings }: { workspaceId: string; settings: WsProviderSetting[] | undefined }) {
  const existing = settings?.find((s) => s.provider_type === 'ai');
  const status = getProviderStatus(settings, 'ai');
  const upsert = useUpsertWsProvider(workspaceId);
  const del = useDeleteWsProvider(workspaceId);

  const [providerName, setProviderName] = useState(existing?.provider_name || 'disabled');
  const [enabled, setEnabled] = useState(existing?.enabled ?? false);
  const [config, setConfig] = useState<Record<string, string>>({
    model: String(existing?.config?.model ?? ''),
    base_url: String(existing?.config?.base_url ?? ''),
  });
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const hasExistingKey = !!existing?.secrets?.api_key;

  const handleSave = () => {
    const secretsToSave: Record<string, string> = {};
    if (apiKey) secretsToSave.api_key = apiKey;
    const mergedSecrets = { ...(existing?.secrets ?? {}), ...secretsToSave };

    upsert.mutate({
      provider_type: 'ai',
      provider_name: providerName,
      enabled: providerName !== 'disabled' && enabled,
      config,
      secrets: mergedSecrets,
    }, {
      onSuccess: () => toast.success('AI provider settings saved'),
      onError: (e) => toast.error('Failed to save: ' + e.message),
    });
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-violet-500/10"><Brain className="h-5 w-5 text-violet-500" /></div>
            <div>
              <CardTitle className="text-base">AI Provider</CardTitle>
              <CardDescription className="text-xs mt-0.5">Language model for chatbot & auto-replies</CardDescription>
            </div>
          </div>
          <StatusBadge status={status} />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Provider Type</Label>
            <Select value={providerName} onValueChange={setProviderName}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="disabled">Disabled (use platform default)</SelectItem>
                <SelectItem value="openai">OpenAI</SelectItem>
                <SelectItem value="openrouter">OpenRouter</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {providerName !== 'disabled' && (
            <>
              <div className="flex items-center gap-2">
                <Switch checked={enabled} onCheckedChange={setEnabled} />
                <Label className="text-xs">Enable workspace AI</Label>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">
                  API Key {hasExistingKey && <span className="text-muted-foreground">(saved: {maskSecret(existing?.secrets?.api_key)})</span>}
                </Label>
                <div className="relative">
                  <Input
                    type={showKey ? 'text' : 'password'}
                    value={apiKey}
                    onChange={e => setApiKey(e.target.value)}
                    placeholder={hasExistingKey ? 'Leave empty to keep current' : 'sk-xxxx...'}
                  />
                  <button type="button" onClick={() => setShowKey(!showKey)} className="absolute end-2 top-2.5 text-muted-foreground hover:text-foreground">
                    {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">Model</Label>
                <Input
                  value={config.model}
                  onChange={e => setConfig(c => ({ ...c, model: e.target.value }))}
                  placeholder={providerName === 'openai' ? 'gpt-5-nano' : 'meta-llama/llama-3-8b'}
                  list={providerName === 'openai' ? 'openai-model-suggestions' : undefined}
                />
                {providerName === 'openai' && (
                  <datalist id="openai-model-suggestions">
                    {['gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo', 'o1', 'o1-mini'].map(m => (
                      <option key={m} value={m} />
                    ))}
                  </datalist>
                )}
              </div>

              {providerName === 'openrouter' && (
                <div className="space-y-1.5">
                  <Label className="text-xs">Base URL (optional)</Label>
                  <Input value={config.base_url} onChange={e => setConfig(c => ({ ...c, base_url: e.target.value }))} placeholder="https://openrouter.ai/api/v1" />
                </div>
              )}
            </>
          )}
        </div>

        <Separator />
        <div className="flex items-center justify-between">
          <Button onClick={handleSave} disabled={upsert.isPending} size="sm">
            {upsert.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin me-1.5" />}
            Save
          </Button>
          {existing && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive">
                  <Trash2 className="h-3.5 w-3.5 me-1" />Remove
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Remove AI provider config?</AlertDialogTitle>
                  <AlertDialogDescription>This workspace will revert to using the platform default AI configuration.</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={() => del.mutate('ai', {
                    onSuccess: () => toast.success('AI config removed'),
                    onError: (e) => toast.error(e.message),
                  })}>Remove</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Webhook Card ────────────────────────────────────────────────

function WebhookCard({ workspaceId, settings }: { workspaceId: string; settings: WsProviderSetting[] | undefined }) {
  const existing = settings?.find((s) => s.provider_type === 'webhook');
  const status = getProviderStatus(settings, 'webhook');
  const upsert = useUpsertWsProvider(workspaceId);
  const del = useDeleteWsProvider(workspaceId);

  const [enabled, setEnabled] = useState(existing?.enabled ?? false);
  const [config, setConfig] = useState<Record<string, unknown>>({
    webhook_url: String(existing?.config?.webhook_url ?? ''),
    notify_messages: existing?.config?.notify_messages !== false,
    notify_offline_leads: existing?.config?.notify_offline_leads !== false,
  });
  const [signingKey, setSigningKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const hasExistingKey = !!existing?.secrets?.signing_key;

  const handleSave = () => {
    const secretsToSave: Record<string, string> = {};
    if (signingKey) secretsToSave.signing_key = signingKey;
    const mergedSecrets = { ...(existing?.secrets ?? {}), ...secretsToSave };

    upsert.mutate({
      provider_type: 'webhook',
      provider_name: 'webhook',
      enabled,
      config: config as Record<string, unknown>,
      secrets: mergedSecrets,
    }, {
      onSuccess: () => toast.success('Webhook settings saved'),
      onError: (e) => toast.error('Failed to save: ' + e.message),
    });
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-amber-500/10"><Webhook className="h-5 w-5 text-amber-500" /></div>
            <div>
              <CardTitle className="text-base">Webhook / Notifications</CardTitle>
              <CardDescription className="text-xs mt-0.5">Receive real-time events to your endpoint</CardDescription>
            </div>
          </div>
          <StatusBadge status={status} />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3">
          <div className="flex items-center gap-2">
            <Switch checked={enabled} onCheckedChange={setEnabled} />
            <Label className="text-xs">Enable webhook notifications</Label>
          </div>

          {enabled && (
            <>
              <div className="space-y-1.5">
                <Label className="text-xs">Webhook URL</Label>
                <Input value={config.webhook_url as string} onChange={e => setConfig(c => ({ ...c, webhook_url: e.target.value }))} placeholder="https://example.com/webhook" />
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">
                  Signing Key {hasExistingKey && <span className="text-muted-foreground">(saved: {maskSecret(existing?.secrets?.signing_key)})</span>}
                </Label>
                <div className="relative">
                  <Input
                    type={showKey ? 'text' : 'password'}
                    value={signingKey}
                    onChange={e => setSigningKey(e.target.value)}
                    placeholder={hasExistingKey ? 'Leave empty to keep current' : 'whsec_xxxx...'}
                  />
                  <button type="button" onClick={() => setShowKey(!showKey)} className="absolute end-2 top-2.5 text-muted-foreground hover:text-foreground">
                    {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              <Separator className="my-1" />

              <div className="flex items-center justify-between">
                <Label className="text-xs">Notify on new messages</Label>
                <Switch checked={config.notify_messages as boolean} onCheckedChange={v => setConfig(c => ({ ...c, notify_messages: v }))} />
              </div>
              <div className="flex items-center justify-between">
                <Label className="text-xs">Notify on offline leads</Label>
                <Switch checked={config.notify_offline_leads as boolean} onCheckedChange={v => setConfig(c => ({ ...c, notify_offline_leads: v }))} />
              </div>
            </>
          )}
        </div>

        <Separator />
        <div className="flex items-center justify-between">
          <Button onClick={handleSave} disabled={upsert.isPending} size="sm">
            {upsert.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin me-1.5" />}
            Save
          </Button>
          {existing && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive">
                  <Trash2 className="h-3.5 w-3.5 me-1" />Remove
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Remove webhook config?</AlertDialogTitle>
                  <AlertDialogDescription>Webhook notifications will be disabled for this workspace.</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={() => del.mutate('webhook', {
                    onSuccess: () => toast.success('Webhook config removed'),
                    onError: (e) => toast.error(e.message),
                  })}>Remove</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Main Page ───────────────────────────────────────────────────

export default function SettingsProvidersPage() {
  const workspace = useCurrentWorkspace();
  const { data: settings, isLoading } = useWorkspaceProviders(workspace?.id);
  const { data: role } = useWorkspaceRole(workspace?.id);
  const isWorkspaceAdmin = role === 'owner' || role === 'admin';

  if (!workspace) return null;

  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Provider Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Connect your own services for email, AI, and notifications. If you leave them empty, the default platform configuration will be used automatically.
        </p>
      </div>

      {isLoading ? (
        <div className="space-y-5">
          <SkeletonCard lines={4} />
          <SkeletonCard lines={4} />
          <SkeletonCard lines={3} />
        </div>
      ) : (
        <div className="space-y-5">
          <AIProviderCard workspaceId={workspace.id} settings={settings} />
          <WebhookCard workspaceId={workspace.id} settings={settings} />
          <WorkspacePrivacyStorageCard workspaceId={workspace.id} />
          {isWorkspaceAdmin && (
            <>
              <Separator className="my-2" />
              <div>
                <h2 className="text-lg font-semibold text-foreground">Voice & Video Channels</h2>
                <p className="text-xs text-muted-foreground mt-1">
                  Workspace-level call channel toggles and per-role call permissions. Subject to platform-wide gates.
                </p>
              </div>
              <WorkspaceCallSettingsCard workspaceId={workspace.id} />
              <WorkspaceRolePermissionsCard workspaceId={workspace.id} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
