/**
 * Super Admin → Mobile App, for both native apps.
 *
 * The single place an operator configures the iOS and Android apps. A switch
 * at the top picks the platform; each has its own tabs over the same row.
 *
 *   • iOS: everything is real configuration — the values are what
 *     `npm run ios:sync` writes into the Xcode project (Info.plist,
 *     entitlements, privacy manifest, build settings), and the App Store
 *     readiness verdicts are recomputed server-side on every read and save.
 *   • Android: the Play identity and release, and the in-app switches the
 *     installed app reads live from `GET /api/mobile-app/config` — hiding
 *     Storage, locking the name on the profile — without a new build.
 *
 * Promotions are one set of copy shown by both apps, so the tab is the same
 * component under either platform.
 *
 * Editing model: one draft held here, sections mutate it through `set`, and a
 * single sticky bar saves. A tab switch never loses an unsaved edit, and the
 * server's normalized row replaces the draft on success so what is shown is
 * always what was stored.
 */
import { useEffect, useMemo, useState, type SVGProps } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Smartphone, Fingerprint, Hammer, ToggleRight, ShieldCheck, ClipboardCheck,
  UserCheck, Rocket, Terminal, Loader2, AlertTriangle, Megaphone, Apple, Settings2,
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
import { MobilePromotionsTab } from '@/components/admin/mobile/MobilePromotionsTab';
import { AndroidOverviewTab } from '@/components/admin/mobile/android/AndroidOverviewTab';
import { androidChecks } from '@/components/admin/mobile/android/androidChecks';
import { AndroidIdentityTab } from '@/components/admin/mobile/android/AndroidIdentityTab';
import { AndroidReleaseTab } from '@/components/admin/mobile/android/AndroidReleaseTab';
import { AndroidInAppTab } from '@/components/admin/mobile/android/AndroidInAppTab';
import { cn } from '@/lib/utils';

type Platform = 'ios' | 'android';

const IOS_TABS = [
  { value: 'overview', icon: Smartphone },
  { value: 'identity', icon: Fingerprint },
  { value: 'build', icon: Hammer },
  { value: 'capabilities', icon: ToggleRight },
  { value: 'privacy', icon: ShieldCheck },
  { value: 'promotions', icon: Megaphone },
  { value: 'appStore', icon: ClipboardCheck },
  { value: 'review', icon: UserCheck },
  { value: 'release', icon: Rocket },
  { value: 'buildGuide', icon: Terminal },
] as const;

const ANDROID_TABS = [
  { value: 'overview', icon: Smartphone },
  { value: 'identity', icon: Fingerprint },
  { value: 'release', icon: Rocket },
  { value: 'inApp', icon: Settings2 },
  { value: 'promotions', icon: Megaphone },
] as const;

/** The Android robot's head — Lucide ships no brand marks. */
function AndroidGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
      <path d="M17.6 9.48l1.84-3.18a.38.38 0 0 0-.66-.38l-1.87 3.23A11.4 11.4 0 0 0 12 8.1c-1.76 0-3.4.37-4.91 1.05L5.22 5.92a.38.38 0 0 0-.66.38L6.4 9.48A10.8 10.8 0 0 0 1 18h22a10.8 10.8 0 0 0-5.4-8.52zM7 15.25a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5zm10 0a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5z" />
    </svg>
  );
}

function AppleGlyph({ className }: { className?: string }) {
  return <Apple className={className} fill="currentColor" />;
}

const PLATFORMS = [
  { value: 'ios', icon: AppleGlyph },
  { value: 'android', icon: AndroidGlyph },
] as const;

export default function MobileAppPage() {
  const { t } = useTranslation();
  const { data, isLoading, error } = useMobileAppSettings();
  const save = useSaveMobileAppSettings();

  // The platform rides in the URL, so a link can open the Android side.
  const [params, setParams] = useSearchParams();
  const platform: Platform = params.get('platform') === 'android' ? 'android' : 'ios';
  const [tab, setTab] = useState<string>('overview');
  const choosePlatform = (next: Platform) => {
    setTab('overview');
    setParams(
      (previous) => {
        const updated = new URLSearchParams(previous);
        if (next === 'ios') updated.delete('platform');
        else updated.set('platform', next);
        return updated;
      },
      { replace: true },
    );
  };
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

  // Against the draft, so the badge moves as a fix is typed rather than after it is saved.
  const android = androidChecks(draft, data.environment.pushConfigured);
  const androidPassed = android.filter((check) => check.ok).length;
  const androidTotal = android.length;

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
        <div className="flex flex-wrap items-center gap-2">
          <div
            role="radiogroup"
            aria-label={t('admin.mobileApp.platform.label')}
            className="inline-flex rounded-xl border border-border/70 bg-muted/40 p-1"
          >
            {PLATFORMS.map((entry) => (
              <button
                key={entry.value}
                type="button"
                role="radio"
                aria-checked={platform === entry.value}
                onClick={() => choosePlatform(entry.value)}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
                  platform === entry.value
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <entry.icon className="h-4 w-4" />
                {t(`admin.mobileApp.platform.${entry.value}` as TranslationKey)}
              </button>
            ))}
          </div>
          {platform === 'ios' ? (
            <>
              <Badge variant={data.summary.submittable ? 'default' : 'secondary'}>
                {t('admin.mobileApp.overview.scoreBadge', { score: data.summary.score })}
              </Badge>
              {data.summary.blockers > 0 && (
                <Badge variant="destructive" className="gap-1">
                  <AlertTriangle className="h-3 w-3" />
                  {t('admin.mobileApp.overview.blockersBadge', { count: data.summary.blockers })}
                </Badge>
              )}
            </>
          ) : (
            <Badge variant={androidPassed === androidTotal ? 'default' : 'secondary'} className="tabular-nums">
              {t('admin.mobileApp.android.overview.passed', { passed: androidPassed, total: androidTotal })}
            </Badge>
          )}
        </div>
      </header>

      {error && (
        <p className="rounded-xl bg-destructive/10 p-3 text-sm text-destructive">
          {t('admin.mobileApp.common.loadFailed')}
        </p>
      )}

      {platform === 'ios' ? (
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="flex h-auto w-full flex-wrap justify-start gap-1">
            {IOS_TABS.map((entry) => (
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
          <TabsContent value="promotions" className="space-y-4">
            <MobilePromotionsTab draft={draft} set={set} />
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
      ) : (
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="flex h-auto w-full flex-wrap justify-start gap-1">
            {ANDROID_TABS.map((entry) => (
              <TabsTrigger key={entry.value} value={entry.value} className="gap-1.5">
                <entry.icon className="h-4 w-4" />
                {t(`admin.mobileApp.androidTabs.${entry.value}` as TranslationKey)}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="overview" className="space-y-4">
            <AndroidOverviewTab data={{ ...data, settings: draft }} onGoToTab={setTab} />
          </TabsContent>
          <TabsContent value="identity" className="space-y-4">
            <AndroidIdentityTab draft={draft} set={set} />
          </TabsContent>
          <TabsContent value="release" className="space-y-4">
            <AndroidReleaseTab draft={draft} set={set} />
          </TabsContent>
          <TabsContent value="inApp" className="space-y-4">
            <AndroidInAppTab draft={draft} set={set} />
          </TabsContent>
          <TabsContent value="promotions" className="space-y-4">
            <MobilePromotionsTab draft={draft} set={set} />
          </TabsContent>
        </Tabs>
      )}

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
