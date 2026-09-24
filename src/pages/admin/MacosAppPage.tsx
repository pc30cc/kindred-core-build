/**
 * Super Admin → macOS app.
 *
 * Everything the platform decides about the Mac app: where Sparkle looks for
 * updates and which builds are still allowed, realtime and polling, which
 * sections of the app are on, what it may do on the Mac, how a first launch
 * starts, a maintenance notice and the help links. The Mac app reads the
 * public projection of these values from GET /api/platform/macos-app on
 * launch and every hour, so a save here reaches installed copies without
 * shipping a new build.
 *
 * Editing model (same as the Windows page, DesktopAppPage): one draft held
 * here, tabs mutate it through `set`, and a single sticky bar saves. A tab
 * switch never loses an unsaved edit, Save stays disabled while any field
 * breaks a server rule (and says which), and the server's normalized row
 * replaces the draft on success so what is shown is always what was stored.
 *
 * Ads, announcements, live usage and broadcasts are shared with the Windows
 * app and save on their own; here they are scoped to `platform="macos"`.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Apple, LayoutDashboard, Download, SlidersHorizontal, Blocks, AppWindowMac, Wrench, Megaphone, Activity,
  Loader2, AlertCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { toast } from '@/hooks/use-toast';
import { useTranslation, type TranslationKey } from '@/i18n';
import {
  useMacosAppSettings,
  useSaveMacosAppSettings,
  type MacosAppSettings,
} from '@/hooks/useMacosApp';
import { MacosOverviewTab } from '@/components/admin/macos/MacosOverviewTab';
import { MacosUpdatesTab } from '@/components/admin/macos/MacosUpdatesTab';
import { MacosBehaviourTab } from '@/components/admin/macos/MacosBehaviourTab';
import { MacosFeaturesTab } from '@/components/admin/macos/MacosFeaturesTab';
import { MacosIntegrationTab } from '@/components/admin/macos/MacosIntegrationTab';
import { MacosMaintenanceTab } from '@/components/admin/macos/MacosMaintenanceTab';
import { macosProblems, maintenanceShowing, type MacosTab } from '@/components/admin/macos/macosModel';
import { DesktopCampaignsTab } from '@/components/admin/desktop/DesktopCampaignsTab';
import { DesktopLiveTab } from '@/components/admin/desktop/DesktopLiveTab';

const TABS: ReadonlyArray<{ value: MacosTab; icon: typeof Download }> = [
  { value: 'overview', icon: LayoutDashboard },
  { value: 'updates', icon: Download },
  { value: 'behaviour', icon: SlidersHorizontal },
  { value: 'features', icon: Blocks },
  { value: 'integration', icon: AppWindowMac },
  { value: 'maintenance', icon: Wrench },
  { value: 'campaigns', icon: Megaphone },
  { value: 'live', icon: Activity },
];

export default function MacosAppPage() {
  const { t } = useTranslation();
  const { data, isLoading, error } = useMacosAppSettings();
  const save = useSaveMacosAppSettings();

  const [tab, setTab] = useState<MacosTab>('overview');
  const [draft, setDraft] = useState<MacosAppSettings | null>(null);

  // The saved row is authoritative: adopt it on load and after every save, so
  // a value the server normalized (trimmed, defaulted) is what stays on screen.
  useEffect(() => {
    if (data?.settings) setDraft(data.settings);
  }, [data?.settings]);

  const dirty = useMemo(() => {
    if (!draft || !data?.settings) return false;
    return JSON.stringify(draft) !== JSON.stringify(data.settings);
  }, [draft, data?.settings]);

  const problems = useMemo(() => (draft ? macosProblems(draft) : []), [draft]);
  const tabsWithProblems = useMemo(() => new Set(problems.map((p) => p.tab)), [problems]);

  const set = (patch: Partial<MacosAppSettings>) =>
    setDraft((previous) => (previous ? { ...previous, ...patch } : previous));

  const onSave = async () => {
    if (!draft || problems.length > 0) return;
    // `updated_at` is owned by the database — sending it back would fight it.
    const { updated_at, ...payload } = draft;
    try {
      await save.mutateAsync(payload);
      toast({ title: t('admin.macosApp.common.saved') });
    } catch (e) {
      toast({
        title: t('admin.macosApp.common.saveFailed'),
        // The server's 400 names each rejected field ("Invalid input — …").
        description: e instanceof Error ? e.message : undefined,
        variant: 'destructive',
      });
    }
  };

  if (error && !data) {
    return (
      <div className="p-6">
        <p className="rounded-xl bg-destructive/10 p-3 text-sm text-destructive">
          {t('admin.macosApp.common.loadFailed')}
        </p>
      </div>
    );
  }

  if (isLoading || !draft || !data) {
    return (
      <div className="space-y-6 p-6">
        <Skeleton className="h-12 w-72" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const saved = data.settings;
  const firstProblem = problems[0];

  return (
    <div className="space-y-6 p-6 pb-28">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Apple className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-xl font-bold">{t('admin.macosApp.title')}</h1>
            <p className="text-sm text-muted-foreground">{t('admin.macosApp.subtitle')}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {maintenanceShowing(saved) && (
            <Badge variant="destructive" className="gap-1.5">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
              {t('admin.macosApp.common.maintenanceOn')}
            </Badge>
          )}
          <Badge variant="secondary">
            {saved.update_channel === 'beta'
              ? t('admin.macosApp.updates.channelBeta')
              : t('admin.macosApp.updates.channelStable')}
          </Badge>
          {saved.latest_version && (
            <Badge variant="outline" dir="ltr">
              {t('admin.macosApp.common.versionBadge', { version: saved.latest_version })}
            </Badge>
          )}
        </div>
      </header>

      <Tabs value={tab} onValueChange={(value) => setTab(value as MacosTab)}>
        <TabsList className="flex h-auto w-full flex-wrap justify-start gap-1">
          {TABS.map((entry) => (
            <TabsTrigger key={entry.value} value={entry.value} className="gap-1.5">
              <entry.icon className="h-4 w-4" />
              {t(`admin.macosApp.tabs.${entry.value}` as TranslationKey)}
              {/* A tab holding an invalid field is marked, so the reason Save is off is findable. */}
              {tabsWithProblems.has(entry.value) && (
                <span className="h-1.5 w-1.5 rounded-full bg-destructive" aria-hidden="true" />
              )}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          <MacosOverviewTab settings={saved} onNavigate={setTab} />
        </TabsContent>
        <TabsContent value="updates" className="space-y-4">
          <MacosUpdatesTab draft={draft} set={set} />
        </TabsContent>
        <TabsContent value="behaviour" className="space-y-4">
          <MacosBehaviourTab draft={draft} set={set} />
        </TabsContent>
        <TabsContent value="features" className="space-y-4">
          <MacosFeaturesTab draft={draft} set={set} />
        </TabsContent>
        <TabsContent value="integration" className="space-y-4">
          <MacosIntegrationTab draft={draft} set={set} />
        </TabsContent>
        <TabsContent value="maintenance" className="space-y-4">
          <MacosMaintenanceTab draft={draft} set={set} />
        </TabsContent>
        {/* These two save on their own (each row / each broadcast), not through the draft bar. */}
        <TabsContent value="campaigns" className="space-y-4">
          <DesktopCampaignsTab platform="macos" />
        </TabsContent>
        <TabsContent value="live" className="space-y-4">
          <DesktopLiveTab platform="macos" />
        </TabsContent>
      </Tabs>

      {/* Sticky save bar: an edit is never lost behind a tab switch, and the
          operator always sees whether the draft differs from what is stored —
          and, when Save is off, which field is holding it back. */}
      {dirty && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border/70 bg-card/95 px-6 py-3 backdrop-blur-xl lg:start-72">
          <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3">
            {firstProblem ? (
              <div className="flex min-w-0 items-center gap-2 text-sm text-destructive">
                <AlertCircle className="h-4 w-4 shrink-0" />
                <p className="min-w-0">
                  {t('admin.macosApp.common.cannotSave', { reason: t(firstProblem.message) })}
                  {problems.length > 1 && (
                    <span className="ms-1 text-muted-foreground">
                      {t('admin.macosApp.common.moreIssues', { count: problems.length - 1 })}
                    </span>
                  )}
                </p>
                {tab !== firstProblem.tab && (
                  <Button variant="link" size="sm" className="h-auto shrink-0 p-0" onClick={() => setTab(firstProblem.tab)}>
                    {t('admin.macosApp.common.showIssue')}
                  </Button>
                )}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t('admin.macosApp.common.unsaved')}</p>
            )}
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => setDraft(saved)}>
                {t('admin.macosApp.common.discard')}
              </Button>
              <Button
                size="sm"
                onClick={onSave}
                disabled={save.isPending || problems.length > 0}
              >
                {save.isPending && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
                {t('admin.macosApp.common.save')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
