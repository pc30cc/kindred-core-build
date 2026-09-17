/**
 * Super Admin → Mobile App (iOS).
 *
 * The single place an operator configures the native app and proves it is
 * ready for the App Store. Everything on this screen is real configuration —
 * the values here are what `npm run ios:sync` writes into the Xcode project
 * (Info.plist, entitlements, privacy manifest, build settings), and the
 * readiness verdicts are recomputed server-side on every read and save.
 *
 * Editing model: one draft held here, sections mutate it through `set`, and a
 * single sticky bar saves. A tab switch never loses an unsaved edit, and the
 * server's normalized row replaces the draft on success so what is shown is
 * always what was stored.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Smartphone, Fingerprint, Hammer, ToggleRight, ShieldCheck, ClipboardCheck,
  UserCheck, Rocket, Terminal, Loader2, AlertTriangle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { toast } from '@/hooks/use-toast';
import { useTranslation, type TranslationKey } from '@/i18n';
import {
  useMobileAppSettings,
  useSaveMobileAppSettings,
  type MobileAppSettings,
} from '@/hooks/useMobileApp';
import { MobileOverviewTab } from '@/components/admin/mobile/MobileOverviewTab';
import { MobileIdentityTab } from '@/components/admin/mobile/MobileIdentityTab';
import { MobileBuildTab } from '@/components/admin/mobile/MobileBuildTab';
import { MobileCapabilitiesTab } from '@/components/admin/mobile/MobileCapabilitiesTab';
import { MobilePrivacyTab } from '@/components/admin/mobile/MobilePrivacyTab';
import { MobileAppStoreTab } from '@/components/admin/mobile/MobileAppStoreTab';
import { MobileReviewTab } from '@/components/admin/mobile/MobileReviewTab';
import { MobileReleaseTab } from '@/components/admin/mobile/MobileReleaseTab';
import { MobileBuildGuideTab } from '@/components/admin/mobile/MobileBuildGuideTab';

const TABS = [
  { value: 'overview', icon: Smartphone },
  { value: 'identity', icon: Fingerprint },
  { value: 'build', icon: Hammer },
  { value: 'capabilities', icon: ToggleRight },
  { value: 'privacy', icon: ShieldCheck },
  { value: 'appStore', icon: ClipboardCheck },
  { value: 'review', icon: UserCheck },
  { value: 'release', icon: Rocket },
  { value: 'buildGuide', icon: Terminal },
] as const;

export default function MobileAppPage() {
  const { t } = useTranslation();
  const { data, isLoading, error } = useMobileAppSettings();
  const save = useSaveMobileAppSettings();

  const [tab, setTab] = useState<string>('overview');
  const [draft, setDraft] = useState<MobileAppSettings | null>(null);

  // The saved row is authoritative: adopt it on load and after every save, so
  // a value the server normalized (trimmed, defaulted) is what stays on screen.
  useEffect(() => {
    if (data?.settings) setDraft(data.settings);
  }, [data?.settings]);

  const dirty = useMemo(() => {
    if (!draft || !data?.settings) return false;
    return JSON.stringify(draft) !== JSON.stringify(data.settings);
  }, [draft, data?.settings]);

  const set = (patch: Partial<MobileAppSettings>) =>
    setDraft((previous) => (previous ? { ...previous, ...patch } : previous));

  const onSave = async () => {
    if (!draft) return;
    // `checklist` is owned by the acknowledge endpoint and `updated_at` by the
    // database — sending either back would fight them.
    const { checklist, updated_at, ...payload } = draft;
    try {
      await save.mutateAsync(payload);
      toast({ title: t('admin.mobileApp.common.saved') });
    } catch (e) {
      toast({
        title: t('admin.mobileApp.common.saveFailed'),
        description: e instanceof Error ? e.message : undefined,
        variant: 'destructive',
      });
    }
  };

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
            <Smartphone className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-xl font-bold">{t('admin.mobileApp.title')}</h1>
            <p className="text-sm text-muted-foreground">{t('admin.mobileApp.subtitle')}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={data.summary.submittable ? 'default' : 'secondary'}>
            {t('admin.mobileApp.overview.scoreBadge', { score: data.summary.score })}
          </Badge>
          {data.summary.blockers > 0 && (
            <Badge variant="destructive" className="gap-1">
              <AlertTriangle className="h-3 w-3" />
              {t('admin.mobileApp.overview.blockersBadge', { count: data.summary.blockers })}
            </Badge>
          )}
        </div>
      </header>

      {error && (
        <p className="rounded-xl bg-destructive/10 p-3 text-sm text-destructive">
          {t('admin.mobileApp.common.loadFailed')}
        </p>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex h-auto w-full flex-wrap justify-start gap-1">
          {TABS.map((entry) => (
            <TabsTrigger key={entry.value} value={entry.value} className="gap-1.5">
              <entry.icon className="h-4 w-4" />
              {t(`admin.mobileApp.tabs.${entry.value}` as TranslationKey)}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          <MobileOverviewTab data={data} onGoToTab={setTab} />
        </TabsContent>
        <TabsContent value="identity" className="space-y-4">
          <MobileIdentityTab draft={draft} set={set} />
        </TabsContent>
        <TabsContent value="build" className="space-y-4">
          <MobileBuildTab draft={draft} set={set} />
        </TabsContent>
        <TabsContent value="capabilities" className="space-y-4">
          <MobileCapabilitiesTab draft={draft} set={set} environment={data.environment} />
        </TabsContent>
        <TabsContent value="privacy" className="space-y-4">
          <MobilePrivacyTab draft={draft} set={set} />
        </TabsContent>
        <TabsContent value="appStore" className="space-y-4">
          <MobileAppStoreTab checks={data.checks} summary={data.summary} settings={data.settings} />
        </TabsContent>
        <TabsContent value="review" className="space-y-4">
          <MobileReviewTab draft={draft} set={set} />
        </TabsContent>
        <TabsContent value="release" className="space-y-4">
          <MobileReleaseTab draft={draft} set={set} />
        </TabsContent>
        <TabsContent value="buildGuide" className="space-y-4">
          <MobileBuildGuideTab active={tab === 'buildGuide'} settings={data.settings} />
        </TabsContent>
      </Tabs>

      {/* Sticky save bar: an edit is never lost behind a tab switch, and the
          operator always sees whether the draft differs from what is stored. */}
      {dirty && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border/70 bg-card/95 px-6 py-3 backdrop-blur-xl lg:start-72">
          <div className="mx-auto flex max-w-5xl items-center justify-between gap-4">
            <p className="text-sm text-muted-foreground">{t('admin.mobileApp.common.unsaved')}</p>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => setDraft(data.settings)}>
                {t('admin.mobileApp.common.discard')}
              </Button>
              <Button size="sm" onClick={onSave} disabled={save.isPending}>
                {save.isPending && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
                {t('admin.mobileApp.common.save')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
