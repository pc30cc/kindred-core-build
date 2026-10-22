import { Link } from 'react-router-dom';
import { useWidgetPlatformSettings, useUpdateWidgetPlatformSettings, type PreChatPolicy, type WidgetPlatformSettings } from '@/hooks/useWidgetPlatformSettings';
import { useWidgetPlatformSettingsDraft } from '@/hooks/useWidgetPlatformSettingsDraft';
import { WidgetSaveStatus } from '@/components/app/widget/WidgetSaveStatus';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { MessageSquare, Mail, Phone, Settings, Lock, Info, Rocket, Activity, Zap, Video, ArrowRight, Sparkles, LayoutTemplate, NotebookPen, Crown } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { DeploymentUrlsSection } from '@/components/admin/widget/DeploymentUrlsSection';
import {
  RealtimeTransportSection,
  SecurityIsolationSection,
  FloodProtectionSection,
} from '@/components/admin/widget/HardeningSection';
import { AdvancedRoutingSection } from '@/components/admin/widget/AdvancedRoutingSection';
import { WidgetCatalogSection } from '@/components/admin/widget/WidgetCatalogSection';
import { useTranslation, type TranslationKey } from '@/i18n';

const PRECHAT_OPTIONS: PreChatPolicy[] = ['force_on', 'default_on', 'default_off', 'force_off'];

function PolicyBadge({ policy }: { policy: PreChatPolicy }) {
  const { t } = useTranslation();
  if (policy === 'force_on' || policy === 'force_off') {
    return <Badge variant="destructive" className="gap-1 text-xs"><Lock className="h-3 w-3" />{t('admin.widgetSettingsPage.locked')}</Badge>;
  }
  return <Badge variant="secondary" className="text-xs">{t('admin.widgetSettingsPage.overrideAllowed')}</Badge>;
}

import { PoweredBySection } from './widget-settings/PoweredBySection';

export default function AdminWidgetSettingsPage() {
  const { t, locale } = useTranslation();
  const { data: settings, isLoading, error, refetch, isFetching } = useWidgetPlatformSettings();
  const updateMut = useUpdateWidgetPlatformSettings();
  // Typed fields (the welcome text, the notes, the tuning numbers) save once
  // the typing stops, quietly: the status line says when they are stored.
  const draft = useWidgetPlatformSettingsDraft(settings, {
    onError: (e) => toast({ title: t('admin.widgetSettingsPage.error'), description: e.message, variant: 'destructive' }),
  });

  // Voice / video gates live in the dedicated Voice & Video Center to avoid
  // duplicated admin surfaces. See /admin/voice-video.

  if (isLoading) {
    return <div className="text-sm text-muted-foreground">{t('admin.widgetSettingsPage.loading')}</div>;
  }

  if (error || !settings || !draft.live) {
    return (
      <Card>
        <CardContent className="p-6 space-y-3">
          <p className="text-sm font-medium text-destructive">
            {t('admin.widgetSettingsPage.loadFailed')}
          </p>
          <p className="text-xs text-muted-foreground break-all whitespace-pre-wrap">
            {error instanceof Error
              ? error.message
              : t('admin.widgetSettingsPage.noSettingsRow')}
          </p>
          <p className="text-xs text-muted-foreground">
            {t('admin.widgetSettingsPage.selfHostBefore')} <code className="mx-1">/api/</code>
            {t('admin.widgetSettingsPage.selfHostAfter')}
          </p>

          <Button size="sm" variant="outline" onClick={() => refetch()} disabled={isFetching}>
            {isFetching ? t('admin.widgetSettingsPage.retrying') : t('admin.widgetSettingsPage.retry')}
          </Button>
        </CardContent>
      </Card>
    );
  }


  const live = draft.live;

  // A switch, a choice or a section's Save button: saved at once, and said so.
  const update = (patch: Partial<WidgetPlatformSettings>) => {
    updateMut.mutate(
      { id: settings.id, updates: patch },
      {
        onSuccess: () => toast({ title: t('admin.widgetSettingsPage.saved'), description: t('admin.widgetSettingsPage.savedDescription') }),
        onError: (e: Error) => toast({ title: t('admin.widgetSettingsPage.error'), description: e.message, variant: 'destructive' }),
      },
    );
  };

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t('admin.widgetSettingsPage.title')}</h1>
          <p className="text-sm text-muted-foreground mt-1">{t('admin.widgetSettingsPage.subtitle')}</p>
        </div>
        <WidgetSaveStatus status={draft.status} errorMessage={draft.errorMessage} className="mt-1" />
      </div>

      <Tabs defaultValue="urls" className="space-y-4">
        <TabsList className="bg-secondary/50 border border-border flex-wrap h-auto">
          <TabsTrigger value="urls" className="gap-1.5 text-xs"><Rocket className="h-3.5 w-3.5" />{t('admin.widgetSettingsPage.tabs.urls')}</TabsTrigger>
          <TabsTrigger value="templates" className="gap-1.5 text-xs"><LayoutTemplate className="h-3.5 w-3.5" />{t('widgetCatalog.admin.tab')}</TabsTrigger>
          <TabsTrigger value="prechat" className="gap-1.5 text-xs"><MessageSquare className="h-3.5 w-3.5" />{t('admin.widgetSettingsPage.tabs.prechat')}</TabsTrigger>
          <TabsTrigger value="features" className="gap-1.5 text-xs"><Settings className="h-3.5 w-3.5" />{t('admin.widgetSettingsPage.tabs.features')}</TabsTrigger>
          <TabsTrigger value="poweredby" className="gap-1.5 text-xs"><Sparkles className="h-3.5 w-3.5" />{t('admin.widgetSettingsPage.tabs.poweredBy')}</TabsTrigger>
          <TabsTrigger value="notes" className="gap-1.5 text-xs"><NotebookPen className="h-3.5 w-3.5" />{t('admin.widgetSettingsPage.tabs.notes')}</TabsTrigger>
          <TabsTrigger value="realtime" className="gap-1.5 text-xs"><Activity className="h-3.5 w-3.5" />{t('admin.widgetSettingsPage.tabs.realtime')}</TabsTrigger>
          <TabsTrigger value="security" className="gap-1.5 text-xs"><Lock className="h-3.5 w-3.5" />{t('admin.widgetSettingsPage.tabs.security')}</TabsTrigger>
          <TabsTrigger value="flood" className="gap-1.5 text-xs"><Zap className="h-3.5 w-3.5" />{t('admin.widgetSettingsPage.tabs.flood')}</TabsTrigger>
          <TabsTrigger value="routing" className="gap-1.5 text-xs"><Activity className="h-3.5 w-3.5" />{t('admin.widgetSettingsPage.tabs.routing')}</TabsTrigger>
        </TabsList>

        {/* Deployment URLs (single source of truth) */}
        <TabsContent value="urls">
          <DeploymentUrlsSection
            settings={settings}
            onSave={update}
            saving={updateMut.isPending}
          />
        </TabsContent>

        {/* Chat widget templates: the catalog workspaces pick from (loads its own data) */}
        <TabsContent value="templates">
          <WidgetCatalogSection />
        </TabsContent>

        {/* Platform-owned powered-by footer */}
        <TabsContent value="poweredby">
          <PoweredBySection settings={settings} onSave={update} saving={updateMut.isPending} />
        </TabsContent>

        {/* Pre-chat */}
        <TabsContent value="prechat">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('admin.widgetSettingsPage.prechat.title')}</CardTitle>
              <CardDescription>{t('admin.widgetSettingsPage.prechat.description')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="rounded-lg border border-border p-4 space-y-2 bg-muted/20">
                <div className="flex items-center gap-2">
                  <MessageSquare className="h-4 w-4 text-primary" />
                  <Label className="text-sm font-medium">{t('admin.widgetSettingsPage.prechat.welcome')}</Label>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t('admin.widgetSettingsPage.prechat.welcomeHint')}
                </p>
                <Textarea
                  rows={2}
                  value={live.default_welcome_message || ''}
                  maxLength={2000}
                  onChange={(e) => draft.setFields({ default_welcome_message: e.target.value })}
                  placeholder={t('admin.widgetSettingsPage.prechat.welcomePlaceholder')}
                  className="resize-none"
                />
              </div>

              {[
                { key: 'prechat_name_policy', labelKey: 'name', icon: MessageSquare },
                { key: 'prechat_email_policy', labelKey: 'email', icon: Mail },
                { key: 'prechat_phone_policy', labelKey: 'phone', icon: Phone },
              ].map((field) => {
                const value = settings[field.key as keyof typeof settings] as PreChatPolicy;
                return (
                  <div key={field.key} className="rounded-lg border border-border p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <field.icon className="h-4 w-4 text-primary" />
                        <Label className="text-sm font-medium">{t(`admin.widgetSettingsPage.prechat.fields.${field.labelKey}` as TranslationKey)}</Label>
                      </div>
                      <PolicyBadge policy={value} />
                    </div>
                    <Select value={value} onValueChange={(v) => update({ [field.key]: v } as Partial<WidgetPlatformSettings>)}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {PRECHAT_OPTIONS.map((opt) => (
                          <SelectItem key={opt} value={opt}>
                            <div className="flex flex-col">
                              <span className="text-sm">{t(`admin.widgetSettingsPage.prechat.options.${opt}.label` as TranslationKey)}</span>
                              <span className="text-xs text-muted-foreground">{t(`admin.widgetSettingsPage.prechat.options.${opt}.description` as TranslationKey)}</span>
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
              <CardTitle className="text-base">{t('admin.widgetSettingsPage.features.title')}</CardTitle>
              <CardDescription>{t('admin.widgetSettingsPage.features.description')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              {/* No platform locks here: chat, the knowledge base and visitor
                  tracking are plan capabilities (Plans) under each
                  workspace's own switches (Widget → Behavior). The old
                  "Always enabled / Always disabled" locks were stored and
                  read by nothing. */}
              <div className="rounded-lg border border-border bg-muted/30 p-4 flex items-start gap-3" data-features-plans>
                <Crown className="h-4 w-4 text-primary mt-0.5 shrink-0" />
                <div className="flex-1 text-xs">
                  <div className="text-sm font-medium text-foreground">{t('admin.widgetSettingsPage.features.plansTitle')}</div>
                  <p className="text-muted-foreground mt-1">{t('admin.widgetSettingsPage.features.plansHint')}</p>
                  <Link to="/admin/plans" className="inline-flex items-center gap-1 mt-2 text-primary hover:underline">
                    {t('admin.widgetSettingsPage.features.openPlans')} <ArrowRight className="h-3 w-3 rtl:rotate-180" />
                  </Link>
                </div>
              </div>

          {/* Voice / Video gates moved to the Voice & Video Center to avoid duplicated admin surfaces. */}
          <div className="rounded-lg border border-border bg-muted/30 p-4 flex items-start gap-3">
            <Video className="h-4 w-4 text-primary mt-0.5 shrink-0" />
            <div className="flex-1 text-xs">
              <div className="text-sm font-medium text-foreground">{t('admin.widgetSettingsPage.features.voiceVideo')}</div>
              <p className="text-muted-foreground mt-1">
                {t('admin.widgetSettingsPage.features.voiceVideoHint')}
              </p>
              <Link to="/admin/voice-video" className="inline-flex items-center gap-1 mt-2 text-primary hover:underline">
                {t('admin.widgetSettingsPage.features.openVoiceVideo')} <ArrowRight className="h-3 w-3 rtl:rotate-180" />
              </Link>
            </div>
          </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Administrator notes. The domain policy and message limits that
            used to share these tabs were stored and read by nothing: a
            widget's sites are its own Widget → Domains list under the plan,
            and a visitor message is at most 5000 characters, 15 a minute. */}
        <TabsContent value="notes">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('admin.widgetSettingsPage.notes.title')}</CardTitle>
              <CardDescription>{t('admin.widgetSettingsPage.notes.description')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="space-y-2 rounded-lg border border-border p-4">
                <Label htmlFor="widget-admin-notes" className="text-sm font-medium">{t('admin.widgetSettingsPage.notes.adminNotes')}</Label>
                <Textarea
                  id="widget-admin-notes"
                  rows={4}
                  maxLength={10000}
                  value={live.admin_notes || ''}
                  onChange={(e) => draft.setFields({ admin_notes: e.target.value })}
                  placeholder={t('admin.widgetSettingsPage.notes.adminNotesPlaceholder')}
                />
              </div>

              <div className="flex items-start gap-2 bg-muted/40 rounded-lg p-3 text-xs text-muted-foreground">
                <Info className="h-4 w-4 mt-0.5 shrink-0" />
                <p>
                  {t('admin.widgetSettingsPage.notes.lastUpdated', {
                    date: new Date(settings.updated_at).toLocaleString(locale === 'fa' ? 'fa-IR' : locale === 'tr' ? 'tr-TR' : 'en-US'),
                  })}
                </p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Phase 1 hardening — Realtime / Transport */}
        <TabsContent value="realtime">
          <RealtimeTransportSection settings={live} onSave={update} onDraft={draft.setFields} />
        </TabsContent>

        {/* Phase 1 hardening — Security / Isolation (read-only diagnostics) */}
        <TabsContent value="security">
          <SecurityIsolationSection />
        </TabsContent>

        {/* Phase 1 hardening — Flood / Abuse Protection */}
        <TabsContent value="flood">
          <FloodProtectionSection settings={live} onSave={update} onDraft={draft.setFields} />
        </TabsContent>

        {/* Global Advanced Routing — platform-wide owner-fallback / general-pool policy. */}
        <TabsContent value="routing">
          <AdvancedRoutingSection />
        </TabsContent>
      </Tabs>
    </div>
  );
}
