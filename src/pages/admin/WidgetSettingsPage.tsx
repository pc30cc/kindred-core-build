import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useWidgetPlatformSettings, useUpdateWidgetPlatformSettings, type PreChatPolicy, type FeatureLockMode, type WidgetPlatformSettings } from '@/hooks/useWidgetPlatformSettings';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { MessageSquare, Mail, Phone, Globe, Shield, Settings, Lock, Info, Bug, Rocket, Layers, Activity, Zap, Video, ArrowRight } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { DeploymentUrlsSection } from '@/components/admin/widget/DeploymentUrlsSection';
import {
  RealtimeTransportSection,
  SecurityIsolationSection,
  FloodProtectionSection,
} from '@/components/admin/widget/HardeningSection';
import { AdvancedRoutingSection } from '@/components/admin/widget/AdvancedRoutingSection';

const PRECHAT_OPTIONS: { value: PreChatPolicy; label: string; desc: string }[] = [
  { value: 'force_on', label: 'Force ON', desc: 'Workspaces cannot disable — field is always required' },
  { value: 'default_on', label: 'Default ON', desc: 'Enabled by default, workspaces can disable' },
  { value: 'default_off', label: 'Default OFF', desc: 'Disabled by default, workspaces can enable' },
  { value: 'force_off', label: 'Force OFF', desc: 'Workspaces cannot enable — field is hidden' },
];

const LOCK_OPTIONS: { value: FeatureLockMode; label: string; desc: string }[] = [
  { value: 'allow', label: 'Allow', desc: 'Each workspace decides' },
  { value: 'force_on', label: 'Force ON', desc: 'Always enabled, cannot be turned off' },
  { value: 'force_off', label: 'Force OFF', desc: 'Always disabled, cannot be turned on' },
];

function policyBadge(p: PreChatPolicy | FeatureLockMode) {
  if (p === 'force_on' || p === 'force_off') {
    return <Badge variant="destructive" className="gap-1 text-xs"><Lock className="h-3 w-3" />Locked</Badge>;
  }
  return <Badge variant="secondary" className="text-xs">Workspace override allowed</Badge>;
}

export default function AdminWidgetSettingsPage() {
  const { data: settings, isLoading } = useWidgetPlatformSettings();
  const updateMut = useUpdateWidgetPlatformSettings();

  // Voice / video gates live in the dedicated Voice & Video Center to avoid
  // duplicated admin surfaces. See /admin/voice-video.

  if (isLoading) {
    return <div className="text-sm text-muted-foreground">Loading...</div>;
  }

  if (!settings) {
    return (
      <Card>
        <CardContent className="p-6">
          <p className="text-sm text-destructive">No platform widget settings row found. Please re-run the migration.</p>
        </CardContent>
      </Card>
    );
  }

  const update = (patch: Partial<typeof settings>) => {
    updateMut.mutate(
      { id: settings.id, updates: patch },
      {
        onSuccess: () => toast({ title: 'Saved', description: 'Platform widget settings updated' }),
        onError: (e: any) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
      },
    );
  };

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Widget Platform Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Global rules applied to all workspaces. Locks here cannot be overridden by workspace admins.
        </p>
      </div>

      <Tabs defaultValue="urls" className="space-y-4">
        <TabsList className="bg-secondary/50 border border-border flex-wrap h-auto">
          <TabsTrigger value="urls" className="gap-1.5 text-xs"><Rocket className="h-3.5 w-3.5" />Deployment & URLs</TabsTrigger>
          <TabsTrigger value="prechat" className="gap-1.5 text-xs"><MessageSquare className="h-3.5 w-3.5" />Pre-chat fields</TabsTrigger>
          <TabsTrigger value="features" className="gap-1.5 text-xs"><Settings className="h-3.5 w-3.5" />Feature locks</TabsTrigger>
          <TabsTrigger value="deployment" className="gap-1.5 text-xs"><Globe className="h-3.5 w-3.5" />Deployment defaults</TabsTrigger>
          <TabsTrigger value="limits" className="gap-1.5 text-xs"><Shield className="h-3.5 w-3.5" />Limits</TabsTrigger>
          <TabsTrigger value="realtime" className="gap-1.5 text-xs"><Activity className="h-3.5 w-3.5" />Realtime / Transport</TabsTrigger>
          <TabsTrigger value="security" className="gap-1.5 text-xs"><Lock className="h-3.5 w-3.5" />Security / Isolation</TabsTrigger>
          <TabsTrigger value="flood" className="gap-1.5 text-xs"><Zap className="h-3.5 w-3.5" />Flood Protection</TabsTrigger>
          <TabsTrigger value="routing" className="gap-1.5 text-xs"><Activity className="h-3.5 w-3.5" />Advanced Routing</TabsTrigger>
        </TabsList>

        {/* Deployment URLs (single source of truth) */}
        <TabsContent value="urls">
          <DeploymentUrlsSection
            settings={settings}
            onSave={update}
            saving={updateMut.isPending}
          />
        </TabsContent>

        {/* Pre-chat */}
        <TabsContent value="prechat">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Pre-chat field policies</CardTitle>
              <CardDescription>
                Whether the widget asks visitors for their name, email, and phone before they can send the first message.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="rounded-lg border border-border p-4 space-y-2 bg-muted/20">
                <div className="flex items-center gap-2">
                  <MessageSquare className="h-4 w-4 text-primary" />
                  <Label className="text-sm font-medium">Default welcome message</Label>
                </div>
                <p className="text-xs text-muted-foreground">
                  Shown as the first operator bubble inside the widget after the pre-chat form is submitted (or immediately, if pre-chat is disabled). Workspaces can override this in their widget settings.
                </p>
                <Textarea
                  rows={2}
                  value={settings.default_welcome_message || ''}
                  onChange={(e) => update({ default_welcome_message: e.target.value })}
                  placeholder="Hello! How can we help you?"
                  className="resize-none"
                />
              </div>

              {[
                { key: 'prechat_name_policy', label: 'Name', icon: MessageSquare },
                { key: 'prechat_email_policy', label: 'Email', icon: Mail },
                { key: 'prechat_phone_policy', label: 'Phone', icon: Phone },
              ].map((field) => {
                const value = settings[field.key as keyof typeof settings] as PreChatPolicy;
                return (
                  <div key={field.key} className="rounded-lg border border-border p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <field.icon className="h-4 w-4 text-primary" />
                        <Label className="text-sm font-medium">{field.label}</Label>
                      </div>
                      {policyBadge(value)}
                    </div>
                    <Select value={value} onValueChange={(v) => update({ [field.key]: v } as any)}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {PRECHAT_OPTIONS.map((opt) => (
                          <SelectItem key={opt.value} value={opt.value}>
                            <div className="flex flex-col">
                              <span className="text-sm">{opt.label}</span>
                              <span className="text-xs text-muted-foreground">{opt.desc}</span>
                            </div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                );
              })}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Feature locks */}
        <TabsContent value="features">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Feature locks</CardTitle>
              <CardDescription>
                Force-enable or force-disable widget features across all workspaces. Useful for plan-based restrictions.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              {[
                { key: 'force_chat_enabled', label: 'Live Chat', icon: MessageSquare },
                { key: 'force_kb_enabled', label: 'Knowledge Base', icon: Globe },
                { key: 'force_visitor_tracking', label: 'Visitor Tracking', icon: Shield },
              ].map((f) => {
                const value = settings[f.key as keyof typeof settings] as FeatureLockMode;
                return (
                  <div key={f.key} className="rounded-lg border border-border p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <f.icon className="h-4 w-4 text-primary" />
                        <Label className="text-sm font-medium">{f.label}</Label>
                      </div>
                      {policyBadge(value)}
                    </div>
                    <Select value={value} onValueChange={(v) => update({ [f.key]: v } as any)}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {LOCK_OPTIONS.map((opt) => (
                          <SelectItem key={opt.value} value={opt.value}>
                            <div className="flex flex-col">
                              <span className="text-sm">{opt.label}</span>
                              <span className="text-xs text-muted-foreground">{opt.desc}</span>
                            </div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                );
              })}

          {/* Voice / Video gates moved to the Voice & Video Center to avoid duplicated admin surfaces. */}
          <div className="rounded-lg border border-border bg-muted/30 p-4 flex items-start gap-3">
            <Video className="h-4 w-4 text-primary mt-0.5 shrink-0" />
            <div className="flex-1 text-xs">
              <div className="text-sm font-medium text-foreground">Voice &amp; Video channels</div>
              <p className="text-muted-foreground mt-1">
                Audio, video, queue and recording gates are now managed in one place.
              </p>
              <Link to="/admin/voice-video" className="inline-flex items-center gap-1 mt-2 text-primary hover:underline">
                Open Voice &amp; Video Center <ArrowRight className="h-3 w-3" />
              </Link>
            </div>
          </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Deployment */}
        <TabsContent value="deployment">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Deployment defaults</CardTitle>
              <CardDescription>
                Defaults applied when a new workspace is created. The deployment tab in the workspace panel has been removed — these values are managed centrally here.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="flex items-center justify-between rounded-lg border border-border p-4">
                <div className="space-y-0.5">
                  <Label className="text-sm font-medium">Default: Allow subdomains</Label>
                  <p className="text-xs text-muted-foreground">
                    New workspaces start with subdomain matching enabled (e.g. shop.example.com matches example.com).
                  </p>
                </div>
                <Switch
                  checked={settings.default_allow_subdomains}
                  onCheckedChange={(v) => update({ default_allow_subdomains: v })}
                />
              </div>

              <div className="flex items-center justify-between rounded-lg border border-border p-4">
                <div className="space-y-0.5">
                  <Label className="text-sm font-medium">Enforce domain validation</Label>
                  <p className="text-xs text-muted-foreground">
                    Reject widget requests from origins not in the workspace's allowed domains list.
                  </p>
                </div>
                <Switch
                  checked={settings.enforce_domain_validation}
                  onCheckedChange={(v) => update({ enforce_domain_validation: v })}
                />
              </div>

              <div className="flex items-center justify-between rounded-lg border border-border p-4">
                <div className="space-y-0.5">
                  <Label className="text-sm font-medium flex items-center gap-2"><Bug className="h-3.5 w-3.5" /> Default debug mode</Label>
                  <p className="text-xs text-muted-foreground">
                    Newly created widgets start with verbose logging enabled.
                  </p>
                </div>
                <Switch
                  checked={settings.default_debug_mode}
                  onCheckedChange={(v) => update({ default_debug_mode: v })}
                />
              </div>

              <div className="space-y-2 rounded-lg border border-border p-4">
                <Label className="text-sm font-medium">Max allowed domains per workspace</Label>
                <Input
                  type="number"
                  min={1}
                  max={1000}
                  value={settings.max_allowed_domains_per_workspace}
                  onChange={(e) => update({ max_allowed_domains_per_workspace: parseInt(e.target.value || '10', 10) })}
                  className="max-w-32"
                />
                <p className="text-xs text-muted-foreground">Hard cap enforced when workspaces try to add domains.</p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Limits */}
        <TabsContent value="limits">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Runtime limits</CardTitle>
              <CardDescription>Hard limits enforced by the widget API server for all workspaces.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="space-y-2 rounded-lg border border-border p-4">
                <Label className="text-sm font-medium">Max message length (characters)</Label>
                <Input
                  type="number"
                  min={100}
                  max={50000}
                  value={settings.max_message_length}
                  onChange={(e) => update({ max_message_length: parseInt(e.target.value || '5000', 10) })}
                  className="max-w-32"
                />
              </div>

              <div className="space-y-2 rounded-lg border border-border p-4">
                <Label className="text-sm font-medium">Rate limit (messages per minute per visitor)</Label>
                <Input
                  type="number"
                  min={1}
                  max={500}
                  value={settings.rate_limit_messages_per_minute}
                  onChange={(e) => update({ rate_limit_messages_per_minute: parseInt(e.target.value || '20', 10) })}
                  className="max-w-32"
                />
              </div>

              <div className="space-y-2 rounded-lg border border-border p-4">
                <Label className="text-sm font-medium">Admin notes (internal)</Label>
                <Textarea
                  rows={4}
                  value={settings.admin_notes || ''}
                  onChange={(e) => update({ admin_notes: e.target.value })}
                  placeholder="Internal notes about why these settings are configured this way..."
                />
              </div>

              <div className="flex items-start gap-2 bg-muted/40 rounded-lg p-3 text-xs text-muted-foreground">
                <Info className="h-4 w-4 mt-0.5 shrink-0" />
                <p>
                  Last updated: {new Date(settings.updated_at).toLocaleString()}
                </p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Phase 1 hardening — Realtime / Transport */}
        <TabsContent value="realtime">
          <RealtimeTransportSection settings={settings} onSave={update} />
        </TabsContent>

        {/* Phase 1 hardening — Security / Isolation (read-only diagnostics) */}
        <TabsContent value="security">
          <SecurityIsolationSection />
        </TabsContent>

        {/* Phase 1 hardening — Flood / Abuse Protection */}
        <TabsContent value="flood">
          <FloodProtectionSection settings={settings} onSave={update} />
        </TabsContent>

        {/* Global Advanced Routing — platform-wide owner-fallback / general-pool policy. */}
        <TabsContent value="routing">
          <AdvancedRoutingSection />
        </TabsContent>
      </Tabs>
    </div>
  );
}
