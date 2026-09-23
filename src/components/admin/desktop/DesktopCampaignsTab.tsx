/**
 * Super Admin → Desktop app → Ads & announcements.
 *
 * Each row is one creative the Windows app shows: an ad card in the
 * placements ticked here, or an announcement in the banner strip at the top
 * of the app. Targeting is by billing plan (none ticked = every plan) and by
 * schedule; texts are per locale with Persian, then English, as fallbacks.
 * The app fetches GET /api/desktop-app/campaigns every few minutes, so a
 * change here reaches running copies without a restart.
 */
import { useMemo, useState } from 'react';
import { Megaphone, Plus, Pencil, Trash2, Loader2, CalendarClock, Target, Image as ImageIcon, Bell } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/hooks/use-toast';
import { useTranslation, type TranslationKey } from '@/i18n';
import { SettingsSection, FieldGrid, TextField, TextAreaField, SwitchField } from '@/components/admin/settings/SettingsFields';
import {
  useAdminPlanOptions,
  useDeleteDesktopCampaign,
  useDesktopCampaigns,
  useSaveDesktopCampaign,
  type CampaignLocale,
  type CampaignSeverity,
  type DesktopCampaign,
  type DesktopCampaignInput,
  type DesktopPlacement,
} from '@/hooks/useDesktopApp';
import { cn } from '@/lib/utils';

const AD_PLACEMENTS: DesktopPlacement[] = ['inbox_list', 'colleagues_list', 'contacts_list', 'chat_empty', 'settings'];
const ALL_PLACEMENTS: DesktopPlacement[] = ['banner', ...AD_PLACEMENTS];
const SEVERITIES: CampaignSeverity[] = ['info', 'success', 'warning', 'critical'];
const LOCALES: CampaignLocale[] = ['fa', 'en', 'tr'];

const SEVERITY_TONE: Record<CampaignSeverity, string> = {
  info: 'bg-sky-500/10 text-sky-700 dark:text-sky-300 border-sky-500/30',
  success: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30',
  warning: 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30',
  critical: 'bg-rose-500/10 text-rose-700 dark:text-rose-300 border-rose-500/30',
};

const blank = (kind: 'ad' | 'announcement'): DesktopCampaignInput => ({
  kind,
  name: '',
  placements: kind === 'ad' ? ['inbox_list'] : ['banner'],
  target_plans: [],
  text: { fa: {}, en: {}, tr: {} },
  image_url: null,
  cta_url: null,
  severity: 'info',
  dismissible: true,
  priority: 0,
  active: true,
  starts_at: null,
  ends_at: null,
});

/** ISO ↔ the value of an <input type="datetime-local"> in the admin's own time zone. */
const toLocalInput = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fromLocalInput = (value: string) => (value ? new Date(value).toISOString() : null);

/** Same limits as the server's campaignSchema (server/routes/adminDesktopApp.ts). */
const LIMITS = { name: 200, title: 200, body: 2000, cta_label: 60 } as const;

/** "webyar.ai/x" → "https://webyar.ai/x", as the server does; other schemes are left for validation to refuse. */
const normalizeUrl = (value: string | null) => {
  const v = (value ?? '').trim();
  if (!v) return null;
  return /^[a-z][a-z0-9+.-]*:/i.test(v) ? v : `https://${v.replace(/^\/+/, '')}`;
};
const isValidUrl = (value: string | null) => {
  const v = normalizeUrl(value);
  return !v || /^https:\/\/[^\s/?#]+\.[^\s]+$/i.test(v);
};

/** First reason the form can't be saved yet, as a translation key. */
function problemOf(input: DesktopCampaignInput): TranslationKey | null {
  if (input.placements.length === 0) return 'admin.desktopApp.campaigns.placementRequired';
  if (!isValidUrl(input.cta_url) || !isValidUrl(input.image_url)) return 'admin.desktopApp.campaigns.invalidUrl';
  if (input.starts_at && input.ends_at && Date.parse(input.ends_at) <= Date.parse(input.starts_at)) {
    return 'admin.desktopApp.campaigns.scheduleOrder';
  }
  return null;
}

function status(c: DesktopCampaign): 'live' | 'scheduled' | 'ended' | 'off' {
  if (!c.active) return 'off';
  const now = Date.now();
  if (c.starts_at && Date.parse(c.starts_at) > now) return 'scheduled';
  if (c.ends_at && Date.parse(c.ends_at) <= now) return 'ended';
  return 'live';
}

export function DesktopCampaignsTab() {
  const { t, locale } = useTranslation();
  const { data, isLoading } = useDesktopCampaigns();
  const plans = useAdminPlanOptions();
  const save = useSaveDesktopCampaign();
  const remove = useDeleteDesktopCampaign();
  const [editing, setEditing] = useState<{ id?: string; input: DesktopCampaignInput } | null>(null);
  const [deleting, setDeleting] = useState<DesktopCampaign | null>(null);

  const planName = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of plans.data?.plans ?? []) map.set(p.slug, p.name);
    return (slug: string) => map.get(slug) ?? slug;
  }, [plans.data]);

  const titleOf = (c: DesktopCampaign) => {
    const own = c.text?.[locale as CampaignLocale]?.title;
    return c.name || own || c.text?.fa?.title || c.text?.en?.title || t('admin.desktopApp.campaigns.untitled');
  };

  const onSave = async () => {
    if (!editing) return;
    const input = {
      ...editing.input,
      cta_url: normalizeUrl(editing.input.cta_url),
      image_url: normalizeUrl(editing.input.image_url),
    };
    const problem = problemOf(input);
    if (problem) {
      toast({ title: t('admin.desktopApp.common.saveFailed'), description: t(problem), variant: 'destructive' });
      return;
    }
    try {
      await save.mutateAsync({ id: editing.id, input });
      toast({ title: t('admin.desktopApp.common.saved') });
      setEditing(null);
    } catch (e) {
      toast({
        title: t('admin.desktopApp.common.saveFailed'),
        description: e instanceof Error ? e.message : undefined,
        variant: 'destructive',
      });
    }
  };

  const toggleActive = async (c: DesktopCampaign, active: boolean) => {
    try {
      await save.mutateAsync({ id: c.id, input: { active } });
    } catch (e) {
      toast({ title: t('admin.desktopApp.common.saveFailed'), variant: 'destructive' });
    }
  };

  const campaigns = data?.campaigns ?? [];
  const ads = campaigns.filter((c) => c.kind === 'ad');
  const announcements = campaigns.filter((c) => c.kind === 'announcement');

  const list = (items: DesktopCampaign[], kind: 'ad' | 'announcement') => (
    <SettingsSection
      icon={kind === 'ad' ? Megaphone : Bell}
      heading={t(kind === 'ad' ? 'admin.desktopApp.campaigns.adsTitle' : 'admin.desktopApp.campaigns.announcementsTitle')}
      caption={t(kind === 'ad' ? 'admin.desktopApp.campaigns.adsCaption' : 'admin.desktopApp.campaigns.announcementsCaption')}
      action={
        <Button size="sm" onClick={() => setEditing({ input: blank(kind) })}>
          <Plus className="me-1.5 h-4 w-4" />
          {t(kind === 'ad' ? 'admin.desktopApp.campaigns.newAd' : 'admin.desktopApp.campaigns.newAnnouncement')}
        </Button>
      }
    >
      {isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : items.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          {t('admin.desktopApp.campaigns.empty')}
        </p>
      ) : (
        <div className="grid gap-3">
          {items.map((c) => {
            const st = status(c);
            return (
              <div key={c.id} className="flex flex-wrap items-start gap-4 rounded-2xl border border-border/70 bg-card p-4">
                <div
                  className={cn(
                    'flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-full border',
                    kind === 'announcement' ? SEVERITY_TONE[c.severity] : 'bg-primary/10 text-primary border-primary/20',
                  )}
                >
                  {c.image_url ? (
                    <img src={c.image_url} alt="" className="h-full w-full object-cover" />
                  ) : kind === 'ad' ? (
                    <Megaphone className="h-6 w-6" />
                  ) : (
                    <Bell className="h-6 w-6" />
                  )}
                </div>
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate font-semibold">{titleOf(c)}</p>
                    <Badge
                      variant="outline"
                      className={cn(
                        st === 'live' && 'border-emerald-500/40 text-emerald-600',
                        st === 'scheduled' && 'border-sky-500/40 text-sky-600',
                        (st === 'ended' || st === 'off') && 'text-muted-foreground',
                      )}
                    >
                      {t(`admin.desktopApp.campaigns.status.${st}` as TranslationKey)}
                    </Badge>
                    {kind === 'announcement' && (
                      <Badge variant="outline" className={SEVERITY_TONE[c.severity]}>
                        {t(`admin.desktopApp.campaigns.severity.${c.severity}` as TranslationKey)}
                      </Badge>
                    )}
                  </div>
                  <p className="line-clamp-2 text-sm text-muted-foreground">
                    {c.text?.[locale as CampaignLocale]?.body || c.text?.fa?.body || c.text?.en?.body}
                  </p>
                  <div className="flex flex-wrap gap-1.5 text-xs">
                    {c.placements.map((p) => (
                      <Badge key={p} variant="secondary" className="font-normal">
                        {t(`admin.desktopApp.campaigns.placement.${p}` as TranslationKey)}
                      </Badge>
                    ))}
                    <Badge variant="outline" className="gap-1 font-normal">
                      <Target className="h-3 w-3" />
                      {c.target_plans.length === 0
                        ? t('admin.desktopApp.campaigns.allPlans')
                        : c.target_plans.map(planName).join('، ')}
                    </Badge>
                    {(c.starts_at || c.ends_at) && (
                      <Badge variant="outline" className="gap-1 font-normal" dir="ltr">
                        <CalendarClock className="h-3 w-3" />
                        {c.starts_at ? new Date(c.starts_at).toLocaleDateString(locale) : '…'} →{' '}
                        {c.ends_at ? new Date(c.ends_at).toLocaleDateString(locale) : '…'}
                      </Badge>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Switch checked={c.active} onCheckedChange={(v) => toggleActive(c, v)} />
                  <Button
                    size="icon"
                    variant="ghost"
                    className="rounded-full"
                    onClick={() => {
                      const { id, created_at, updated_at, ...input } = c;
                      setEditing({ id, input: { ...input, text: { fa: {}, en: {}, tr: {}, ...input.text } } });
                    }}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button size="icon" variant="ghost" className="rounded-full text-destructive" onClick={() => setDeleting(c)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </SettingsSection>
  );

  return (
    <div className="space-y-4">
      {list(announcements, 'announcement')}
      {list(ads, 'ad')}

      <Dialog open={!!editing} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
          {editing && (
            <CampaignEditor
              value={editing.input}
              onChange={(input) => setEditing({ ...editing, input })}
              planOptions={plans.data?.plans ?? []}
              isNew={!editing.id}
            />
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              {t('admin.desktopApp.common.discard')}
            </Button>
            <Button onClick={onSave} disabled={save.isPending}>
              {save.isPending && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
              {t('admin.desktopApp.common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleting} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('admin.desktopApp.campaigns.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{deleting ? titleOf(deleting) : ''}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('admin.desktopApp.common.discard')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={async () => {
                if (!deleting) return;
                await remove.mutateAsync(deleting.id);
                setDeleting(null);
              }}
            >
              {t('admin.desktopApp.campaigns.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function CampaignEditor({
  value,
  onChange,
  planOptions,
  isNew,
}: {
  value: DesktopCampaignInput;
  onChange: (value: DesktopCampaignInput) => void;
  planOptions: Array<{ slug: string; name: string; is_active?: boolean }>;
  isNew: boolean;
}) {
  const { t } = useTranslation();
  const set = (patch: Partial<DesktopCampaignInput>) => onChange({ ...value, ...patch });
  const setText = (l: CampaignLocale, key: 'title' | 'body' | 'cta_label', v: string) =>
    set({ text: { ...value.text, [l]: { ...(value.text[l] ?? {}), [key]: v } } });
  const togglePlacement = (p: DesktopPlacement, on: boolean) =>
    set({ placements: on ? [...new Set([...value.placements, p])] : value.placements.filter((x) => x !== p) });
  const togglePlan = (slug: string, on: boolean) =>
    set({ target_plans: on ? [...new Set([...value.target_plans, slug])] : value.target_plans.filter((x) => x !== slug) });
  const placements = value.kind === 'ad' ? AD_PLACEMENTS : ALL_PLACEMENTS;
  const preview = value.text.fa?.title || value.text.en?.title ? value.text.fa?.title ? value.text.fa : value.text.en : null;

  return (
    <div className="space-y-5">
      <DialogHeader>
        <DialogTitle>
          {t(
            value.kind === 'ad'
              ? isNew ? 'admin.desktopApp.campaigns.newAd' : 'admin.desktopApp.campaigns.editAd'
              : isNew ? 'admin.desktopApp.campaigns.newAnnouncement' : 'admin.desktopApp.campaigns.editAnnouncement',
          )}
        </DialogTitle>
      </DialogHeader>

      <FieldGrid>
        <TextField
          label={t('admin.desktopApp.campaigns.name')}
          hint={t('admin.desktopApp.campaigns.nameHint')}
          value={value.name ?? ''}
          maxLength={LIMITS.name}
          onChange={(name) => set({ name })}
        />
        {value.kind === 'announcement' ? (
          <div className="grid gap-1.5">
            <Label>{t('admin.desktopApp.campaigns.severityLabel')}</Label>
            <Select value={value.severity} onValueChange={(severity) => set({ severity: severity as CampaignSeverity })}>
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
        ) : (
          <TextField
            type="number"
            label={t('admin.desktopApp.campaigns.priority')}
            hint={t('admin.desktopApp.campaigns.priorityHint')}
            value={String(value.priority)}
            dir="ltr"
            onChange={(v) => set({ priority: Math.max(-100, Math.min(100, Number(v) || 0)) })}
          />
        )}
      </FieldGrid>

      <Tabs defaultValue="fa">
        <TabsList>
          {LOCALES.map((l) => (
            <TabsTrigger key={l} value={l}>
              {t(`admin.desktopApp.campaigns.locale.${l}` as TranslationKey)}
            </TabsTrigger>
          ))}
        </TabsList>
        {LOCALES.map((l) => (
          <TabsContent key={l} value={l} className="space-y-3" dir={l === 'fa' ? 'rtl' : 'ltr'}>
            <TextField
              label={t('admin.desktopApp.campaigns.titleField')}
              value={value.text[l]?.title ?? ''}
              maxLength={LIMITS.title}
              onChange={(v) => setText(l, 'title', v)}
            />
            <TextAreaField
              label={t('admin.desktopApp.campaigns.bodyField')}
              value={value.text[l]?.body ?? ''}
              counter={LIMITS.body}
              maxLength={LIMITS.body}
              onChange={(v) => setText(l, 'body', v)}
            />
            <TextField
              label={t('admin.desktopApp.campaigns.ctaLabel')}
              hint={t('admin.desktopApp.campaigns.ctaLabelHint')}
              value={value.text[l]?.cta_label ?? ''}
              maxLength={LIMITS.cta_label}
              onChange={(v) => setText(l, 'cta_label', v)}
            />
          </TabsContent>
        ))}
      </Tabs>

      <FieldGrid>
        <TextField
          label={t('admin.desktopApp.campaigns.ctaUrl')}
          hint={t('admin.desktopApp.campaigns.httpsOnly')}
          value={value.cta_url ?? ''}
          dir="ltr"
          placeholder="https://"
          invalid={!isValidUrl(value.cta_url)}
          onBlur={() => set({ cta_url: normalizeUrl(value.cta_url) })}
          onChange={(v) => set({ cta_url: v || null })}
        />
        <TextField
          label={t('admin.desktopApp.campaigns.imageUrl')}
          hint={t('admin.desktopApp.campaigns.imageUrlHint')}
          value={value.image_url ?? ''}
          dir="ltr"
          placeholder="https://"
          invalid={!isValidUrl(value.image_url)}
          onBlur={() => set({ image_url: normalizeUrl(value.image_url) })}
          onChange={(v) => set({ image_url: v || null })}
        />
      </FieldGrid>

      <div className="grid gap-2">
        <Label className="flex items-center gap-1.5">
          <ImageIcon className="h-4 w-4" />
          {t('admin.desktopApp.campaigns.placements')}
        </Label>
        <div className="grid gap-2 sm:grid-cols-2">
          {placements.map((p) => (
            <label key={p} className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-border/70 p-3">
              <Checkbox checked={value.placements.includes(p)} onCheckedChange={(v) => togglePlacement(p, v === true)} />
              <span className="grid gap-0.5">
                <span className="text-sm font-medium">{t(`admin.desktopApp.campaigns.placement.${p}` as TranslationKey)}</span>
                <span className="text-xs text-muted-foreground">
                  {t(`admin.desktopApp.campaigns.placementHint.${p}` as TranslationKey)}
                </span>
              </span>
            </label>
          ))}
        </div>
        {value.placements.length === 0 && (
          <p className="text-xs text-destructive">{t('admin.desktopApp.campaigns.placementRequired')}</p>
        )}
      </div>

      <div className="grid gap-2">
        <Label className="flex items-center gap-1.5">
          <Target className="h-4 w-4" />
          {t('admin.desktopApp.campaigns.targetPlans')}
        </Label>
        <p className="text-xs text-muted-foreground">{t('admin.desktopApp.campaigns.targetPlansHint')}</p>
        <div className="flex flex-wrap gap-2">
          {planOptions.map((p) => (
            <label
              key={p.slug}
              className={cn(
                'flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-sm',
                value.target_plans.includes(p.slug) ? 'border-primary bg-primary/10 text-primary' : 'border-border/70',
                p.is_active === false && 'opacity-60',
              )}
            >
              <Checkbox checked={value.target_plans.includes(p.slug)} onCheckedChange={(v) => togglePlan(p.slug, v === true)} />
              {p.name}
            </label>
          ))}
        </div>
      </div>

      <FieldGrid>
        <TextField
          type="datetime-local"
          label={t('admin.desktopApp.campaigns.startsAt')}
          value={toLocalInput(value.starts_at)}
          dir="ltr"
          onChange={(v) => set({ starts_at: fromLocalInput(v) })}
        />
        <TextField
          type="datetime-local"
          label={t('admin.desktopApp.campaigns.endsAt')}
          hint={t('admin.desktopApp.campaigns.scheduleHint')}
          value={toLocalInput(value.ends_at)}
          dir="ltr"
          onChange={(v) => set({ ends_at: fromLocalInput(v) })}
        />
      </FieldGrid>

      <FieldGrid>
        <SwitchField
          label={t('admin.desktopApp.campaigns.active')}
          checked={value.active}
          onChange={(active) => set({ active })}
        />
        <SwitchField
          label={t('admin.desktopApp.campaigns.dismissible')}
          hint={t('admin.desktopApp.campaigns.dismissibleHint')}
          checked={value.dismissible}
          onChange={(dismissible) => set({ dismissible })}
        />
      </FieldGrid>

      {preview && (
        <div className="grid gap-2">
          <Label>{t('admin.desktopApp.campaigns.preview')}</Label>
          <div
            dir="rtl"
            className={cn(
              'flex items-center gap-3 rounded-2xl border p-3',
              value.kind === 'announcement' ? SEVERITY_TONE[value.severity] : 'border-primary/20 bg-primary/5',
            )}
          >
            <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-full bg-background/70">
              {value.image_url ? (
                <img src={value.image_url} alt="" className="h-full w-full object-cover" />
              ) : (
                <Megaphone className="h-5 w-5" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{preview?.title}</p>
              <p className="line-clamp-2 text-xs opacity-80">{preview?.body}</p>
            </div>
            {preview?.cta_label && value.cta_url && (
              <span className="rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground">
                {preview.cta_label}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
