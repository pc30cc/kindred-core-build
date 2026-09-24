/**
 * Super Admin → Desktop app / macOS app → Live.
 *
 * How many copies of a desktop app are running right now, and a way to
 * send every one of them a notification. Both live only in the server's
 * memory (server/services/desktopApp/live.ts): nothing is written to the
 * database. Each copy checks in every ~45 s, so the count is at most a
 * minute or so behind and a broadcast lands within one check-in.
 *
 * With a `platform`, the numbers and the recent broadcasts are that app's,
 * and a new broadcast goes to that app only unless "send to both" is ticked.
 * Without one, everything is counted and a broadcast reaches every app.
 */
import { useState } from 'react';
import { Activity, Users, Building2, Send, Trash2, Loader2, Radio } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/hooks/use-toast';
import { useTranslation, type TranslationKey } from '@/i18n';
import { SettingsSection, FieldGrid, TextField, TextAreaField } from '@/components/admin/settings/SettingsFields';
import {
  useDeleteDesktopBroadcast,
  useDesktopLive,
  useSendDesktopBroadcast,
  DESKTOP_PLATFORMS,
  type CampaignSeverity,
  type DesktopPlatform,
} from '@/hooks/useDesktopApp';
import { PlatformBadge } from '@/components/admin/desktop/DesktopPlatformTargets';

const SEVERITIES: CampaignSeverity[] = ['info', 'success', 'warning', 'critical'];

function Stat({ icon: Icon, label, value, tone }: { icon: typeof Activity; label: string; value: number | string; tone: string }) {
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-border/70 bg-card p-4">
      <span className={`flex h-11 w-11 items-center justify-center rounded-full ${tone}`}>
        <Icon className="h-5 w-5" />
      </span>
      <div>
        <p className="text-2xl font-bold tabular-nums">{value}</p>
        <p className="text-xs text-muted-foreground">{label}</p>
      </div>
    </div>
  );
}

const EMPTY_DRAFT = { title: '', body: '', severity: 'info' as CampaignSeverity, url: '', toBoth: false };

export function DesktopLiveTab({ platform }: { platform?: DesktopPlatform } = {}) {
  const { t, locale } = useTranslation();
  const { data, isLoading } = useDesktopLive(platform);
  const send = useSendDesktopBroadcast(platform);
  const remove = useDeleteDesktopBroadcast();
  const [draft, setDraft] = useState(EMPTY_DRAFT);

  const fmt = (n: number) => n.toLocaleString(locale);
  const live = data?.live;
  const mac = platform === 'macos';
  const otherPlatform = DESKTOP_PLATFORMS.find((p) => p !== platform);
  // Scoped and not widened: this app only. Otherwise every desktop app (empty list).
  const targets: DesktopPlatform[] = platform && !draft.toBoth ? [platform] : [];
  const reach = live
    ? targets.length === 0 && live.platforms
      ? live.platforms.windows + live.platforms.macos
      : live.online
    : null;

  const onSend = async () => {
    const { title, body, severity, url } = draft;
    try {
      await send.mutateAsync({ title, body, severity, url, platforms: targets });
      toast({ title: t('admin.desktopApp.live.sent') });
      setDraft(EMPTY_DRAFT);
    } catch (e) {
      toast({
        title: t('admin.desktopApp.live.sendFailed'),
        description: e instanceof Error ? e.message : undefined,
        variant: 'destructive',
      });
    }
  };

  return (
    <div className="space-y-4">
      <SettingsSection
        icon={Activity}
        heading={t('admin.desktopApp.live.title')}
        caption={t(mac ? 'admin.desktopApp.live.captionMacos' : 'admin.desktopApp.live.caption')}
        action={
          <Badge variant="outline" className="gap-1.5">
            <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" />
            {t('admin.desktopApp.live.autoRefresh')}
          </Badge>
        }
      >
        {isLoading || !live ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <Stat icon={Radio} label={t('admin.desktopApp.live.online')} value={fmt(live.online)} tone="bg-emerald-500/10 text-emerald-600" />
              <Stat icon={Users} label={t('admin.desktopApp.live.users')} value={fmt(live.users)} tone="bg-primary/10 text-primary" />
              <Stat icon={Building2} label={t('admin.desktopApp.live.workspaces')} value={fmt(live.workspaces)} tone="bg-violet-500/10 text-violet-600" />
            </div>
            {live.platforms && (
              <div className="grid gap-2">
                <Label>{t('admin.desktopApp.live.perPlatform')}</Label>
                <div className="flex flex-wrap gap-2">
                  {DESKTOP_PLATFORMS.map((p) => (
                    <Badge
                      key={p}
                      variant={p === platform ? 'default' : 'secondary'}
                      className="gap-1.5 rounded-full px-3 py-1"
                    >
                      {t(`admin.desktopApp.platforms.${p}`)}
                      <span className="rounded-full bg-background px-1.5 text-[11px] tabular-nums text-foreground">
                        {fmt(live.platforms[p])}
                      </span>
                    </Badge>
                  ))}
                </div>
              </div>
            )}
            {live.versions.length > 0 && (
              <CountChips label={t('admin.desktopApp.live.versions')} items={live.versions.map((v) => ({ name: v.version, count: v.count }))} fmt={fmt} />
            )}
            {(live.oses?.length ?? 0) > 0 && (
              <CountChips
                label={t('admin.desktopApp.live.oses')}
                items={live.oses.map((o) => ({ name: o.os === 'unknown' ? t('admin.desktopApp.live.unknownOs') : o.os, count: o.count }))}
                fmt={fmt}
              />
            )}
            <p className="text-xs text-muted-foreground">{t('admin.desktopApp.live.memoryNote')}</p>
          </>
        )}
      </SettingsSection>

      <SettingsSection
        icon={Send}
        heading={t(mac ? 'admin.desktopApp.live.broadcastTitleMacos' : 'admin.desktopApp.live.broadcastTitle')}
        caption={t(mac ? 'admin.desktopApp.live.broadcastCaptionMacos' : 'admin.desktopApp.live.broadcastCaption')}
      >
        <FieldGrid>
          <TextField label={t('admin.desktopApp.campaigns.titleField')} value={draft.title} onChange={(title) => setDraft({ ...draft, title })} />
          <div className="grid gap-1.5">
            <Label>{t('admin.desktopApp.campaigns.severityLabel')}</Label>
            <Select value={draft.severity} onValueChange={(severity) => setDraft({ ...draft, severity: severity as CampaignSeverity })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SEVERITIES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {t(`admin.desktopApp.campaigns.severity.${s}` as TranslationKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </FieldGrid>
        <TextAreaField label={t('admin.desktopApp.campaigns.bodyField')} value={draft.body} counter={600} onChange={(body) => setDraft({ ...draft, body })} />
        <TextField
          label={t('admin.desktopApp.live.link')}
          hint={t('admin.desktopApp.campaigns.httpsOnly')}
          value={draft.url}
          dir="ltr"
          placeholder="https://"
          invalid={!!draft.url && !/^https:\/\//i.test(draft.url)}
          onChange={(url) => setDraft({ ...draft, url })}
        />
        {platform && otherPlatform && (
          <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-border/70 p-3">
            <Checkbox checked={draft.toBoth} onCheckedChange={(v) => setDraft({ ...draft, toBoth: v === true })} />
            <span className="grid gap-0.5">
              <span className="text-sm font-medium">{t('admin.desktopApp.live.sendToBoth')}</span>
              <span className="text-xs text-muted-foreground">
                {t('admin.desktopApp.live.sendToBothHint', { other: t(`admin.desktopApp.platforms.${otherPlatform}`) })}
              </span>
            </span>
          </label>
        )}
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            {reach !== null ? t('admin.desktopApp.live.willReach', { count: fmt(reach) }) : ''}
          </p>
          <Button onClick={onSend} disabled={!draft.title.trim() || send.isPending || (!!draft.url && !/^https:\/\//i.test(draft.url))}>
            {send.isPending ? <Loader2 className="me-2 h-4 w-4 animate-spin" /> : <Send className="me-2 h-4 w-4" />}
            {t('admin.desktopApp.live.send')}
          </Button>
        </div>

        {(data?.broadcasts?.length ?? 0) > 0 && (
          <div className="grid gap-2 pt-2">
            <Label>{t('admin.desktopApp.live.recent')}</Label>
            {data!.broadcasts.map((b) => (
              <div key={b.id} className="flex items-start gap-3 rounded-xl border border-border/70 p-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium">{b.title}</p>
                    <Badge variant="outline">{t(`admin.desktopApp.campaigns.severity.${b.severity}` as TranslationKey)}</Badge>
                    <PlatformBadge platforms={b.platforms} />
                    <span className="text-xs text-muted-foreground">{new Date(b.createdAt).toLocaleString(locale)}</span>
                  </div>
                  {b.body && <p className="mt-1 text-sm text-muted-foreground">{b.body}</p>}
                </div>
                <Button size="icon" variant="ghost" className="rounded-full text-destructive" onClick={() => remove.mutate(b.id)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </SettingsSection>
    </div>
  );
}

function CountChips({
  label,
  items,
  fmt,
}: {
  label: string;
  items: Array<{ name: string; count: number }>;
  fmt: (n: number) => string;
}) {
  return (
    <div className="grid gap-2">
      <Label>{label}</Label>
      <div className="flex flex-wrap gap-2">
        {items.map((item) => (
          <Badge key={item.name} variant="secondary" className="gap-1.5 rounded-full px-3 py-1" dir="ltr">
            {item.name}
            <span className="rounded-full bg-background px-1.5 text-[11px] tabular-nums">{fmt(item.count)}</span>
          </Badge>
        ))}
      </div>
    </div>
  );
}
