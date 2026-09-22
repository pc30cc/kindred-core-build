/**
 * Super Admin → Notifications → Email.
 *
 * What a platform admin owns: which operator notification emails exist at
 * all, which transport carries them, when the two scheduled ones go out, and
 * the announcement.
 *
 * What they do not own is any operator's own answer. Every type enabled here
 * is still a switch on the operator's own page — a platform that can mail
 * every operator whatever it likes is not a notification setting.
 *
 * Its own state rather than the page's `draft`: these settings live in their
 * own table behind their own endpoint, and pretending otherwise would put
 * two unrelated saves behind one Save button.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Mail, Send } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/hooks/use-toast';
import { useTranslation, type TranslationKey } from '@/i18n';
import { API_BASE } from '@/lib/apiBase';

type EmailType =
  | 'unread_messages'
  | 'transcripts'
  | 'paid_invoices'
  | 'weekly_summary'
  | 'product_updates';

interface Settings {
  enabled: boolean;
  unread_messages_enabled: boolean;
  transcripts_enabled: boolean;
  paid_invoices_enabled: boolean;
  weekly_summary_enabled: boolean;
  product_updates_enabled: boolean;
  provider_override: string | null;
  unread_after_minutes: number;
  digest_every_minutes: number;
  weekly_summary_dow: number;
  weekly_summary_hour: number;
}

interface AdminEmailState {
  settings: Settings;
  providers: string[];
  provider_configured: boolean;
  types: Array<{ type: EmailType; slug: string; audience: string }>;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers as Record<string, string>) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string })?.error || `Request failed: ${res.status}`);
  return body as T;
}

const TYPES: EmailType[] = [
  'unread_messages',
  'transcripts',
  'paid_invoices',
  'weekly_summary',
  'product_updates',
];

/** Types whose copy has a second line worth reading. */
const WITH_HELP = new Set<EmailType>([
  'unread_messages',
  'transcripts',
  'paid_invoices',
  'product_updates',
]);

export function NotificationEmailTab() {
  const { t } = useTranslation();
  const qc = useQueryClient();

  const { data } = useQuery({
    queryKey: ['admin-notification-email'],
    queryFn: () => api<AdminEmailState>('/api/admin/notification-email'),
  });

  const save = useMutation({
    mutationFn: (patch: Partial<Settings>) =>
      api<{ settings: Settings }>('/api/admin/notification-email', {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    onSuccess: (resp) => {
      qc.setQueryData(['admin-notification-email'], (old: AdminEmailState | undefined) =>
        old ? { ...old, settings: resp.settings } : old,
      );
      // The operator's own page draws its rows from what the platform
      // offers, so it is stale the moment this changes.
      qc.invalidateQueries({ queryKey: ['notification-email-prefs'] });
    },
    onError: (err: Error) => {
      qc.invalidateQueries({ queryKey: ['admin-notification-email'] });
      toast({
        title: t('admin.notifications.common.saveFailed'),
        description: err.message,
        variant: 'destructive',
      });
    },
  });

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');

  const announce = useMutation({
    mutationFn: () =>
      api<{ queued: number }>('/api/admin/notification-email/announce', {
        method: 'POST',
        body: JSON.stringify({ title, body }),
      }),
    onSuccess: (resp) => {
      setTitle('');
      setBody('');
      toast({ title: t('admin.notifications.email.announceSent').replace('{count}', String(resp.queued)) });
    },
    onError: (err: Error) => {
      toast({
        title: t('admin.notifications.common.saveFailed'),
        description: err.message,
        variant: 'destructive',
      });
    },
  });

  // Local mirror so a switch moves under the finger rather than after a
  // round trip, and goes back if the server refuses.
  const [local, setLocal] = useState<Settings | null>(null);
  useEffect(() => {
    if (data?.settings) setLocal(data.settings);
  }, [data?.settings]);

  if (!data || !local) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
        </CardContent>
      </Card>
    );
  }

  const set = (patch: Partial<Settings>) => {
    setLocal({ ...local, ...patch });
    save.mutate(patch);
  };

  const number = (key: keyof Settings, min: number, max: number) => (value: string) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return;
    set({ [key]: Math.min(max, Math.max(min, Math.round(n))) } as Partial<Settings>);
  };

  const announcementsOn = local.enabled && local.product_updates_enabled;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Mail className="h-5 w-5" />
            {t('admin.notifications.email.title')}
          </CardTitle>
          <CardDescription>{t('admin.notifications.email.subtitle')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex items-start justify-between gap-6">
            <div className="min-w-0">
              <div className="text-sm font-medium">{t('admin.notifications.email.masterLabel')}</div>
              <div className="mt-0.5 text-[12.5px] text-muted-foreground">
                {t('admin.notifications.email.masterHelp')}
              </div>
            </div>
            <Switch checked={local.enabled} onCheckedChange={(v) => set({ enabled: v })} />
          </div>

          <div className="space-y-1 border-t border-border/60 pt-4">
            <div className="text-[13px] font-semibold">{t('admin.notifications.email.typesTitle')}</div>
            <div className="divide-y divide-border/60">
              {TYPES.map((type) => (
                <div key={type} className="flex items-start justify-between gap-6 py-3">
                  <div className="min-w-0">
                    <div className="text-sm">{t(`admin.notifications.email.${type}` as TranslationKey)}</div>
                    {WITH_HELP.has(type) && (
                      <div className="mt-0.5 text-[12.5px] text-muted-foreground">
                        {t(`admin.notifications.email.${type}Help` as TranslationKey)}
                      </div>
                    )}
                  </div>
                  <Switch
                    checked={local[`${type}_enabled` as keyof Settings] as boolean}
                    disabled={!local.enabled}
                    onCheckedChange={(v) => set({ [`${type}_enabled`]: v } as Partial<Settings>)}
                  />
                </div>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('admin.notifications.email.timingTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <Label className="text-[12.5px] text-muted-foreground">
              {t('admin.notifications.email.unreadAfter')}
            </Label>
            <Input
              type="number"
              min={5}
              max={1440}
              value={local.unread_after_minutes}
              onChange={(e) => setLocal({ ...local, unread_after_minutes: Number(e.target.value) })}
              onBlur={(e) => number('unread_after_minutes', 5, 1440)(e.target.value)}
              className="mt-1.5"
            />
          </div>
          <div>
            <Label className="text-[12.5px] text-muted-foreground">
              {t('admin.notifications.email.digestEvery')}
            </Label>
            <Input
              type="number"
              min={15}
              max={1440}
              value={local.digest_every_minutes}
              onChange={(e) => setLocal({ ...local, digest_every_minutes: Number(e.target.value) })}
              onBlur={(e) => number('digest_every_minutes', 15, 1440)(e.target.value)}
              className="mt-1.5"
            />
          </div>
          <div>
            <Label className="text-[12.5px] text-muted-foreground">
              {t('admin.notifications.email.weeklyDay')}
            </Label>
            <Input
              type="number"
              min={0}
              max={6}
              value={local.weekly_summary_dow}
              onChange={(e) => setLocal({ ...local, weekly_summary_dow: Number(e.target.value) })}
              onBlur={(e) => number('weekly_summary_dow', 0, 6)(e.target.value)}
              className="mt-1.5"
            />
          </div>
          <div>
            <Label className="text-[12.5px] text-muted-foreground">
              {t('admin.notifications.email.weeklyHour')}
            </Label>
            <Input
              type="number"
              min={0}
              max={23}
              value={local.weekly_summary_hour}
              onChange={(e) => setLocal({ ...local, weekly_summary_hour: Number(e.target.value) })}
              onBlur={(e) => number('weekly_summary_hour', 0, 23)(e.target.value)}
              className="mt-1.5"
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('admin.notifications.email.providerTitle')}</CardTitle>
          <CardDescription>{t('admin.notifications.email.providerHelp')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant={local.provider_override ? 'outline' : 'default'}
              onClick={() => set({ provider_override: null })}
            >
              {t('admin.notifications.email.providerDefault')}
            </Button>
            {data.providers.map((name) => (
              <Button
                key={name}
                type="button"
                size="sm"
                variant={local.provider_override === name ? 'default' : 'outline'}
                onClick={() => set({ provider_override: name })}
              >
                {name}
              </Button>
            ))}
          </div>
          {local.provider_override && !data.provider_configured && (
            <p className="text-[12.5px] text-amber-600 dark:text-amber-500">
              {t('admin.notifications.email.providerMissing')}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('admin.notifications.email.announceTitle')}</CardTitle>
          <CardDescription>
            {announcementsOn
              ? t('admin.notifications.email.announceHelp')
              : t('admin.notifications.email.announceDisabled')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <Label className="text-[12.5px] text-muted-foreground">
              {t('admin.notifications.email.announceSubject')}
            </Label>
            <Input
              value={title}
              disabled={!announcementsOn}
              maxLength={160}
              onChange={(e) => setTitle(e.target.value)}
              className="mt-1.5"
            />
          </div>
          <div>
            <Label className="text-[12.5px] text-muted-foreground">
              {t('admin.notifications.email.announceBody')}
            </Label>
            <Textarea
              value={body}
              disabled={!announcementsOn}
              maxLength={8000}
              rows={6}
              onChange={(e) => setBody(e.target.value)}
              className="mt-1.5"
            />
          </div>
          <Button
            type="button"
            disabled={!announcementsOn || !title.trim() || !body.trim() || announce.isPending}
            onClick={() => announce.mutate()}
            className="gap-2"
          >
            {announce.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            {t('admin.notifications.email.announceSend')}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
