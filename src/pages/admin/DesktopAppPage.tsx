/**
 * Super Admin → Desktop app (Windows).
 *
 * Where the desktop app looks for updates, which versions are still
 * supported, and how it tunes realtime, polling and features. The desktop
 * app reads the public projection of these values from
 * GET /api/platform/desktop-app on every launch, so a save here reaches
 * installed copies without shipping a new build.
 *
 * Editing model: one draft held here, tabs mutate it through `set`, and a
 * single sticky bar saves. A tab switch never loses an unsaved edit, and the
 * server's normalized row replaces the draft on success so what is shown is
 * always what was stored.
 */
import { useEffect, useMemo, useState } from 'react';
import { Monitor, Download, SlidersHorizontal, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { toast } from '@/hooks/use-toast';
import { useTranslation, type TranslationKey } from '@/i18n';
import {
  useDesktopAppSettings,
  useSaveDesktopAppSettings,
  type DesktopAppSettings,
} from '@/hooks/useDesktopApp';
import { DesktopUpdatesTab } from '@/components/admin/desktop/DesktopUpdatesTab';
import { DesktopBehaviourTab } from '@/components/admin/desktop/DesktopBehaviourTab';

const TABS = [
  { value: 'updates', icon: Download },
  { value: 'behaviour', icon: SlidersHorizontal },
] as const;

export default function DesktopAppPage() {
  const { t } = useTranslation();
  const { data, isLoading, error } = useDesktopAppSettings();
  const save = useSaveDesktopAppSettings();

  const [tab, setTab] = useState<string>('updates');
  const [draft, setDraft] = useState<DesktopAppSettings | null>(null);

  // The saved row is authoritative: adopt it on load and after every save, so
  // a value the server normalized (trimmed, defaulted) is what stays on screen.
  useEffect(() => {
    if (data?.settings) setDraft(data.settings);
  }, [data?.settings]);

  const dirty = useMemo(() => {
    if (!draft || !data?.settings) return false;
    return JSON.stringify(draft) !== JSON.stringify(data.settings);
  }, [draft, data?.settings]);

  const set = (patch: Partial<DesktopAppSettings>) =>
    setDraft((previous) => (previous ? { ...previous, ...patch } : previous));

  const onSave = async () => {
    if (!draft) return;
    // `updated_at` is owned by the database — sending it back would fight it.
    const { updated_at, ...payload } = draft;
    try {
      await save.mutateAsync(payload);
      toast({ title: t('admin.desktopApp.common.saved') });
    } catch (e) {
      toast({
        title: t('admin.desktopApp.common.saveFailed'),
        description: e instanceof Error ? e.message : undefined,
        variant: 'destructive',
      });
    }
  };

  if (error && !data) {
    return (
      <div className="p-6">
        <p className="rounded-xl bg-destructive/10 p-3 text-sm text-destructive">
          {t('admin.desktopApp.common.loadFailed')}
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

  return (
    <div className="space-y-6 p-6 pb-28">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Monitor className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-xl font-bold">{t('admin.desktopApp.title')}</h1>
            <p className="text-sm text-muted-foreground">{t('admin.desktopApp.subtitle')}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="secondary">
            {data.settings.update_channel === 'beta'
              ? t('admin.desktopApp.updates.channelBeta')
              : t('admin.desktopApp.updates.channelStable')}
          </Badge>
          {data.settings.latest_version && (
            <Badge variant="outline" dir="ltr">
              {t('admin.desktopApp.common.versionBadge', { version: data.settings.latest_version })}
            </Badge>
          )}
        </div>
      </header>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex h-auto w-full flex-wrap justify-start gap-1">
          {TABS.map((entry) => (
            <TabsTrigger key={entry.value} value={entry.value} className="gap-1.5">
              <entry.icon className="h-4 w-4" />
              {t(`admin.desktopApp.tabs.${entry.value}` as TranslationKey)}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="updates" className="space-y-4">
          <DesktopUpdatesTab draft={draft} set={set} />
        </TabsContent>
        <TabsContent value="behaviour" className="space-y-4">
          <DesktopBehaviourTab draft={draft} set={set} />
        </TabsContent>
      </Tabs>

      {/* Sticky save bar: an edit is never lost behind a tab switch, and the
          operator always sees whether the draft differs from what is stored. */}
      {dirty && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border/70 bg-card/95 px-6 py-3 backdrop-blur-xl lg:start-72">
          <div className="mx-auto flex max-w-5xl items-center justify-between gap-4">
            <p className="text-sm text-muted-foreground">{t('admin.desktopApp.common.unsaved')}</p>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => setDraft(data.settings)}>
                {t('admin.desktopApp.common.discard')}
              </Button>
              <Button size="sm" onClick={onSave} disabled={save.isPending}>
                {save.isPending && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
                {t('admin.desktopApp.common.save')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
