/**
 * Super Admin → Desktop app → Live.
 *
 * How many copies of the Windows app are running right now, and a way to
 * send every one of them a notification. Both live only in the server's
 * memory (server/services/desktopApp/live.ts): nothing is written to the
 * database. Each copy checks in every ~45 s, so the count is at most a
 * minute or so behind and a broadcast lands within one check-in.
 */
import { useState } from 'react';
import { Activity, Users, Building2, Send, Trash2, Loader2, Radio } from 'lucide-react';
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
  type CampaignSeverity,
} from '@/hooks/useDesktopApp';

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

export function DesktopLiveTab() {
  const { t, locale } = useTranslation();
  const { data, isLoading } = useDesktopLive();
  const send = useSendDesktopBroadcast();
  const remove = useDeleteDesktopBroadcast();
  const [draft, setDraft] = useState({ title: '', body: '', severity: 'info' as CampaignSeverity, url: '' });

  const fmt = (n: number) => n.toLocaleString(locale);
  const live = data?.live;

  const onSend = async () => {
    try {
      await send.mutateAsync(draft);
      toast({ title: t('admin.desktopApp.live.sent') });
      setDraft({ title: '', body: '', severity: 'info', url: '' });
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
        caption={t('admin.desktopApp.live.caption')}
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
            {live.versions.length > 0 && (
              <div className="grid gap-2">
                <Label>{t('admin.desktopApp.live.versions')}</Label>
                <div className="flex flex-wrap gap-2">
                  {live.versions.map((v) => (
                    <Badge key={v.version} variant="secondary" className="gap-1.5 rounded-full px-3 py-1" dir="ltr">
                      {v.version}
                      <span className="rounded-full bg-background px-1.5 text-[11px] tabular-nums">{fmt(v.count)}</span>
                    </Badge>
                  ))}
                </div>
              </div>
            )}
            <p className="text-xs text-muted-foreground">{t('admin.desktopApp.live.memoryNote')}</p>
          </>
        )}
      </SettingsSection>

      <SettingsSection icon={Send} heading={t('admin.desktopApp.live.broadcastTitle')} caption={t('admin.desktopApp.live.broadcastCaption')}>
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
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            {live ? t('admin.desktopApp.live.willReach', { count: fmt(live.online) }) : ''}
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
