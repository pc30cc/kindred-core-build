import { useEffect, useMemo, useState } from 'react';
import { useTranslation, useI18n } from '@/i18n';
import { usePlatformRegion } from '@/hooks/usePlatformRegion';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Plus, Trash2, Copy, Clock, Globe2, Mail, AlertCircle, CheckCircle2 } from 'lucide-react';
import type { WidgetSettings, BusinessHoursConfig } from '@/types/models';
import { toast } from '@/hooks/use-toast';
import { API_BASE } from '@/lib/apiBase';

const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
type DayKey = (typeof DAY_KEYS)[number];

const LOCALES = ['en', 'fa', 'tr'] as const;
type Locale = (typeof LOCALES)[number];
const LOCALE_LABELS: Record<Locale, string> = { en: 'English', fa: 'فارسی', tr: 'Türkçe' };

// Common IANA timezones — extend later if needed.
const TIMEZONES = [
  'UTC',
  'Europe/Istanbul',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Paris',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'Asia/Tehran',
  'Asia/Dubai',
  'Asia/Tokyo',
  'Asia/Singapore',
  'Australia/Sydney',
];

function LocaleFields({
  loc,
  t,
  labels,
  localizedMsg,
  setLabel,
  setLocalizedMessage,
}: {
  loc: Locale;
  t: ReturnType<typeof useTranslation>['t'];
  labels: Record<string, { online?: string; offline?: string }>;
  localizedMsg: Record<string, string>;
  setLabel: (locale: Locale, kind: 'online' | 'offline', value: string) => void;
  setLocalizedMessage: (locale: Locale, value: string) => void;
}) {
  const dir = loc === 'fa' ? 'rtl' : 'ltr';
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs">{t('widgetPage.availability.onlineLabel')}</Label>
          <Input
            dir={dir}
            value={labels[loc]?.online || ''}
            placeholder={t('widgetPage.availability.onlinePlaceholder')}
            onChange={(e) => setLabel(loc, 'online', e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">{t('widgetPage.availability.offlineLabel')}</Label>
          <Input
            dir={dir}
            value={labels[loc]?.offline || ''}
            placeholder={t('widgetPage.availability.offlinePlaceholder')}
            onChange={(e) => setLabel(loc, 'offline', e.target.value)}
          />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs">{t('widgetPage.availability.offlineMessage')}</Label>
        <Textarea
          dir={dir}
          rows={4}
          value={localizedMsg[loc] || ''}
          placeholder={t('widgetPage.availability.offlineMessagePlaceholder')}
          onChange={(e) => setLocalizedMessage(loc, e.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          {t('widgetPage.availability.offlineMessageHint')}
        </p>
      </div>
    </>
  );
}

function tzLabel(tz: string, locale: string): string {
  try {
    const parts = new Intl.DateTimeFormat(locale, { timeZone: tz, timeZoneName: 'long' }).formatToParts(new Date());
    const name = parts.find((p) => p.type === 'timeZoneName')?.value;
    if (name && name !== tz) return name;
  } catch {
    /* ignore */
  }
  return tz;
}

function tzOffset(tz: string): string {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' })
      .formatToParts(new Date())
      .find((p) => p.type === 'timeZoneName');
    return part?.value?.replace('GMT', 'UTC') || 'UTC';
  } catch {
    return 'UTC';
  }
}

interface Interval {
  from: string;
  to: string;
}

const DEFAULT_HOURS: BusinessHoursConfig = {
  enabled: false,
  timezone: 'UTC',
  weekly: {
    mon: [{ from: '09:00', to: '18:00' }],
    tue: [{ from: '09:00', to: '18:00' }],
    wed: [{ from: '09:00', to: '18:00' }],
    thu: [{ from: '09:00', to: '18:00' }],
    fri: [{ from: '09:00', to: '18:00' }],
    sat: [],
    sun: [],
  },
  overrides: [],
};

function normalizeHours(input: WidgetSettings['business_hours']): BusinessHoursConfig {
  const raw = (input || {}) as Partial<BusinessHoursConfig>;
  const weekly: BusinessHoursConfig['weekly'] = {};
  for (const d of DAY_KEYS) {
    const list = raw.weekly && (raw.weekly as any)[d];
    weekly[d] = Array.isArray(list) ? list.filter((it: any) => it && typeof it.from === 'string' && typeof it.to === 'string') : [];
  }
  return {
    enabled: !!raw.enabled,
    timezone: typeof raw.timezone === 'string' && raw.timezone ? raw.timezone : 'UTC',
    weekly,
    overrides: Array.isArray(raw.overrides) ? raw.overrides : [],
  };
}

function intervalsValid(list: Interval[] | undefined): { ok: boolean; reason?: 'invalidTime' | 'endAfterStart' } {
  if (!list || list.length === 0) return { ok: true };
  for (const it of list) {
    if (!/^\d{1,2}:\d{2}$/.test(it.from) || !/^\d{1,2}:\d{2}$/.test(it.to)) {
      return { ok: false, reason: 'invalidTime' as const };
    }
    const [fh, fm] = it.from.split(':').map(Number);
    const [th, tm] = it.to.split(':').map(Number);
    const f = fh * 60 + fm;
    const t = th * 60 + tm;
    if (!(t > f)) return { ok: false, reason: 'endAfterStart' as const };
  }
  return { ok: true };
}

function previewState(hours: BusinessHoursConfig, liveChatEnabled: boolean, now: Date = new Date()): {
  state: 'online' | 'offline';
  reason: string;
} {
  if (!hours.enabled) return { state: 'online', reason: 'reasonDisabled' };
  if (!liveChatEnabled) return { state: 'offline', reason: 'reasonChatDisabled' };
  // Use Intl to read the current weekday + minutes in tz
  let parts: Intl.DateTimeFormatPart[] = [];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: hours.timezone || 'UTC',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
  } catch {
    return { state: 'offline', reason: 'reasonInvalidTz' };
  }
  const get = (t: string) => parts.find((p) => p.type === t)?.value || '';
  const dowMap: Record<string, DayKey> = { Mon: 'mon', Tue: 'tue', Wed: 'wed', Thu: 'thu', Fri: 'fri', Sat: 'sat', Sun: 'sun' };
  const dow = dowMap[get('weekday')];
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  const ov = hours.overrides?.find((o) => o.date === date);
  let intervals: Interval[] = [];
  if (ov) {
    if (ov.closed) return { state: 'offline', reason: 'reasonOverrideClosed' };
    intervals = ov.intervals || [];
  } else {
    intervals = (dow && hours.weekly[dow]) || [];
  }
  const anyDefined =
    DAY_KEYS.some((k) => (hours.weekly[k] || []).length > 0) ||
    (hours.overrides || []).some((o) => (o.intervals || []).length > 0);
  if (!anyDefined) return { state: 'offline', reason: 'reasonNoIntervals' };
  if (!intervals.length) return { state: 'offline', reason: 'reasonClosedToday' };
  const h = Number(get('hour') === '24' ? '0' : get('hour'));
  const m = Number(get('minute'));
  const cur = h * 60 + m;
  for (const it of intervals) {
    const [fh, fm] = it.from.split(':').map(Number);
    const [th, tm] = it.to.split(':').map(Number);
    if (fh * 60 + fm <= cur && cur < th * 60 + tm) return { state: 'online', reason: 'reasonWithin' };
  }
  return { state: 'offline', reason: 'reasonOutside' };
}

export function AvailabilitySection({
  workspaceId,
  settings,
  onSave,
  saving,
}: {
  workspaceId: string | undefined;
  settings: WidgetSettings;
  onSave: (patch: Partial<WidgetSettings>) => void;
  saving: boolean;
}) {
  const { t, dir } = useTranslation();
  const { locale } = useI18n();
  // The platform's active region/language mode decides which languages are
  // editable here — a single-language platform (e.g. Persian-only) must not
  // show a language picker or fields for languages it never speaks.
  const { allowedLocales } = usePlatformRegion();
  const activeLocales = (allowedLocales.length ? allowedLocales : LOCALES) as Locale[];
  const DAY_LABELS: Record<DayKey, string> = {
    mon: t('widgetPage.availability.days.mon'),
    tue: t('widgetPage.availability.days.tue'),
    wed: t('widgetPage.availability.days.wed'),
    thu: t('widgetPage.availability.days.thu'),
    fri: t('widgetPage.availability.days.fri'),
    sat: t('widgetPage.availability.days.sat'),
    sun: t('widgetPage.availability.days.sun'),
  };
  const hours = useMemo(() => normalizeHours(settings.business_hours), [settings.business_hours]);
  const offlineMode = (settings.offline_mode || 'capture_message') as WidgetSettings['offline_mode'];
  const liveChatEnabled = settings.live_chat_enabled !== false;
  const labels = (settings.availability_labels || {}) as Record<string, { online?: string; offline?: string }>;
  const localizedMsg = (settings.offline_message_localized || {}) as Record<string, string>;
  const [activeLocale, setActiveLocale] = useState<Locale>(activeLocales[0] || 'en');
  useEffect(() => {
    if (activeLocales.length && !activeLocales.includes(activeLocale)) {
      setActiveLocale(activeLocales[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeLocales.join(',')]);
  const [testEmail, setTestEmail] = useState('');
  const [testing, setTesting] = useState(false);

  const updateHours = (next: BusinessHoursConfig) => onSave({ business_hours: next as any });

  const setDayIntervals = (day: DayKey, list: Interval[]) =>
    updateHours({ ...hours, weekly: { ...hours.weekly, [day]: list } });

  const addInterval = (day: DayKey) => {
    const list = (hours.weekly[day] || []).slice();
    list.push({ from: '09:00', to: '17:00' });
    setDayIntervals(day, list);
  };
  const removeInterval = (day: DayKey, idx: number) => {
    const list = (hours.weekly[day] || []).slice();
    list.splice(idx, 1);
    setDayIntervals(day, list);
  };
  const updateInterval = (day: DayKey, idx: number, patch: Partial<Interval>) => {
    const list = (hours.weekly[day] || []).slice();
    list[idx] = { ...list[idx], ...patch };
    setDayIntervals(day, list);
  };

  const copyMonToFri = () => {
    const src = hours.weekly.mon || [];
    updateHours({
      ...hours,
      weekly: { ...hours.weekly, tue: [...src], wed: [...src], thu: [...src], fri: [...src] },
    });
    toast({ title: t('widgetPage.availability.copied') });
  };

  const addOverride = () => {
    const today = new Date().toISOString().slice(0, 10);
    const next = [...(hours.overrides || []), { date: today, closed: true }];
    updateHours({ ...hours, overrides: next });
  };
  const updateOverride = (idx: number, patch: Partial<NonNullable<BusinessHoursConfig['overrides']>[number]>) => {
    const list = (hours.overrides || []).slice();
    list[idx] = { ...list[idx], ...patch };
    updateHours({ ...hours, overrides: list });
  };
  const removeOverride = (idx: number) => {
    const list = (hours.overrides || []).slice();
    list.splice(idx, 1);
    updateHours({ ...hours, overrides: list });
  };

  const setLabel = (locale: Locale, kind: 'online' | 'offline', value: string) => {
    const next = { ...labels, [locale]: { ...(labels[locale] || {}), [kind]: value } };
    onSave({ availability_labels: next as any });
  };

  const setLocalizedMessage = (locale: Locale, value: string) => {
    const next = { ...localizedMsg, [locale]: value };
    onSave({ offline_message_localized: next as any });
  };

  const preview = previewState(hours, liveChatEnabled);

  const sendTestEmail = async () => {
    if (!testEmail || !workspaceId) return;
    setTesting(true);
    try {
      const apiBase = API_BASE;
      const res = await fetch(`${apiBase}/api/widget/admin/test-offline-email`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: workspaceId, to: testEmail, locale: activeLocale }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast({ title: t('widgetPage.availability.testSent'), description: t('widgetPage.availability.testSentDescription', { email: testEmail }) });
    } catch (e: any) {
      toast({ title: t('widgetPage.availability.testFailed'), description: e?.message || t('common.error'), variant: 'destructive' });
    } finally {
      setTesting(false);
    }
  };

  const anyIntervalDefined =
    DAY_KEYS.some((k) => (hours.weekly[k] || []).length > 0) ||
    (hours.overrides || []).some((o) => (o.intervals || []).length > 0);

  return (
    <div className="space-y-4" dir={dir}>
      {/* Live preview */}
      <Card className="card-elevated">
        <CardContent className="p-4 flex items-center gap-3">
          {preview.state === 'online' ? (
            <CheckCircle2 className="h-5 w-5 text-success" />
          ) : (
            <AlertCircle className="h-5 w-5 text-warning" />
          )}
          <div className="flex-1">
            <div className="text-sm font-medium">
              {t('widgetPage.availability.now')}:{' '}
              <Badge variant={preview.state === 'online' ? 'default' : 'secondary'} className="ms-1">
                {preview.state === 'online' ? t('widgetPage.availability.online') : t('widgetPage.availability.offline')}
              </Badge>
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">
              {t(`widgetPage.availability.${preview.reason}` as any)} · {t('widgetPage.availability.timezoneLabel', { tz: hours.timezone })}
            </div>
          </div>
          {!hours.enabled && (
            <Badge variant="outline" className="text-xs">{t('widgetPage.availability.forcedOnline')}</Badge>
          )}
        </CardContent>
      </Card>

      {/* Master controls */}
      <Card className="card-elevated">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Clock className="h-4 w-4" /> {t('widgetPage.availability.hoursTitle')}
          </CardTitle>
          <CardDescription>
            {t('widgetPage.availability.hoursDescription')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between rounded-lg border border-border p-3">
            <div>
              <Label className="text-sm font-medium">{t('widgetPage.availability.enableHours')}</Label>
              <p className="text-xs text-muted-foreground mt-0.5">
                {t('widgetPage.availability.enableHoursHint')}
              </p>
            </div>
            <Switch
              checked={hours.enabled}
              onCheckedChange={(v) => updateHours({ ...hours, enabled: v })}
            />
          </div>

          <div className="flex items-center justify-between rounded-lg border border-border p-3">
            <div>
              <Label className="text-sm font-medium">{t('widgetPage.availability.liveChatEnabled')}</Label>
              <p className="text-xs text-muted-foreground mt-0.5">
                {t('widgetPage.availability.liveChatHint')}
              </p>
            </div>
            <Switch
              checked={liveChatEnabled}
              onCheckedChange={(v) => onSave({ live_chat_enabled: v })}
            />
          </div>

          <div className="space-y-2">
            <Label className="text-xs font-medium flex items-center gap-1.5">
              <Globe2 className="h-3.5 w-3.5" /> {t('widgetPage.availability.timezone')}
            </Label>
            <Select
              value={hours.timezone}
              onValueChange={(v) => updateHours({ ...hours, timezone: v })}
              disabled={!hours.enabled}
            >
              <SelectTrigger className="max-w-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIMEZONES.map((tz) => (
                  <SelectItem key={tz} value={tz}>
                    {tzLabel(tz, locale)} <span dir="ltr">({tzOffset(tz)})</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Weekly schedule */}
          <div className="space-y-2 pt-2">
            <div className="flex items-center justify-between">
              <Label className="text-sm font-medium">{t('widgetPage.availability.weekly')}</Label>
              <Button
                variant="ghost"
                size="sm"
                onClick={copyMonToFri}
                disabled={!hours.enabled}
                className="h-7 text-xs"
              >
                <Copy className="h-3 w-3 me-1" /> {t('widgetPage.availability.copyMonFri')}
              </Button>
            </div>

            <div className="space-y-2">
              {DAY_KEYS.map((day) => {
                const list = hours.weekly[day] || [];
                const valid = intervalsValid(list);
                return (
                  <div
                    key={day}
                    className="rounded-lg border border-border p-3 space-y-2 bg-muted/20"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium w-24">{DAY_LABELS[day]}</span>
                        {list.length === 0 && (
                          <Badge variant="outline" className="text-[10px]">{t('widgetPage.availability.closed')}</Badge>
                        )}
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => addInterval(day)}
                        disabled={!hours.enabled}
                        className="h-7 text-xs"
                      >
                        <Plus className="h-3 w-3 me-1" /> {t('widgetPage.availability.addInterval')}
                      </Button>
                    </div>
                    {list.map((it, idx) => (
                      <div key={idx} className="flex items-center gap-2">
                        <Input
                          type="time"
                          value={it.from}
                          onChange={(e) => updateInterval(day, idx, { from: e.target.value })}
                          disabled={!hours.enabled}
                          className="w-32"
                        />
                        <span className="text-xs text-muted-foreground">{t('widgetPage.availability.to')}</span>
                        <Input
                          type="time"
                          value={it.to}
                          onChange={(e) => updateInterval(day, idx, { to: e.target.value })}
                          disabled={!hours.enabled}
                          className="w-32"
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => removeInterval(day, idx)}
                          disabled={!hours.enabled}
                          className="h-8 w-8 text-destructive hover:text-destructive"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))}
                    {!valid.ok && (
                      <p className="text-xs text-destructive">{t(`widgetPage.availability.${valid.reason}` as any)}</p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Overrides */}
          <div className="space-y-2 pt-2">
            <div className="flex items-center justify-between">
              <Label className="text-sm font-medium">{t('widgetPage.availability.overrides')}</Label>
              <Button
                variant="ghost"
                size="sm"
                onClick={addOverride}
                disabled={!hours.enabled}
                className="h-7 text-xs"
              >
                <Plus className="h-3 w-3 me-1" /> {t('widgetPage.availability.addOverride')}
              </Button>
            </div>
            <div className="space-y-2">
              {(hours.overrides || []).map((ov, idx) => (
                <div
                  key={idx}
                  className="rounded-lg border border-border p-3 space-y-2 bg-muted/20"
                >
                  <div className="flex items-center gap-2">
                    <Input
                      type="date"
                      value={ov.date}
                      onChange={(e) => updateOverride(idx, { date: e.target.value })}
                      disabled={!hours.enabled}
                      className="w-44"
                    />
                    <Input
                      placeholder={t('widgetPage.availability.overrideLabel')}
                      value={ov.label || ''}
                      onChange={(e) => updateOverride(idx, { label: e.target.value })}
                      disabled={!hours.enabled}
                      className="flex-1"
                    />
                    <div className="flex items-center gap-2">
                      <Label className="text-xs">{t('widgetPage.availability.overrideClosed')}</Label>
                      <Switch
                        checked={!!ov.closed}
                        onCheckedChange={(v) => updateOverride(idx, { closed: v, intervals: v ? undefined : (ov.intervals || []) })}
                        disabled={!hours.enabled}
                      />
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => removeOverride(idx)}
                      disabled={!hours.enabled}
                      className="h-8 w-8 text-destructive hover:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
              {(hours.overrides || []).length === 0 && (
                <p className="text-xs text-muted-foreground">{t('widgetPage.availability.noOverrides')}</p>
              )}
            </div>
          </div>

          {hours.enabled && !anyIntervalDefined && (
            <div className="flex items-start gap-2 rounded-lg bg-warning/10 border border-warning/30 p-3 text-xs">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0 text-warning" />
              <p>
                {t('widgetPage.availability.noIntervalsWarning')}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Offline mode */}
      <Card className="card-elevated">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t('widgetPage.availability.offlineTitle')}</CardTitle>
          <CardDescription>
            {t('widgetPage.availability.offlineDescription')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {[
            {
              v: 'capture_message',
              t: t('widgetPage.availability.modeCapture'),
              d: t('widgetPage.availability.modeCaptureDesc'),
            },
            {
              v: 'show_offline_message',
              t: t('widgetPage.availability.modeShow'),
              d: t('widgetPage.availability.modeShowDesc'),
            },
            {
              v: 'hide_widget',
              t: t('widgetPage.availability.modeHide'),
              d: t('widgetPage.availability.modeHideDesc'),
            },
          ].map((opt) => (
            <label
              key={opt.v}
              className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${
                offlineMode === opt.v ? 'border-primary bg-primary/5' : 'border-border'
              } ${!hours.enabled ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              <input
                type="radio"
                name="offline_mode"
                value={opt.v}
                checked={offlineMode === opt.v}
                onChange={() => onSave({ offline_mode: opt.v as any })}
                disabled={!hours.enabled}
                className="mt-1"
              />
              <div>
                <div className="text-sm font-medium">{opt.t}</div>
                <div className="text-xs text-muted-foreground mt-0.5">{opt.d}</div>
              </div>
            </label>
          ))}
        </CardContent>
      </Card>

      {/* Localized labels + offline message */}
      <Card className="card-elevated">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t('widgetPage.availability.copyTitle')}</CardTitle>
          <CardDescription>
            {t('widgetPage.availability.copyDescription')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {activeLocales.length > 1 ? (
            <Tabs value={activeLocale} onValueChange={(v) => setActiveLocale(v as Locale)}>
              <TabsList>
                {activeLocales.map((loc) => (
                  <TabsTrigger key={loc} value={loc}>{LOCALE_LABELS[loc]}</TabsTrigger>
                ))}
              </TabsList>
              {activeLocales.map((loc) => (
                <TabsContent key={loc} value={loc} className="space-y-4 pt-3">
                  <LocaleFields
                    loc={loc}
                    t={t}
                    labels={labels}
                    localizedMsg={localizedMsg}
                    setLabel={setLabel}
                    setLocalizedMessage={setLocalizedMessage}
                  />
                </TabsContent>
              ))}
            </Tabs>
          ) : (
            <div className="space-y-4">
              <LocaleFields
                loc={activeLocales[0]}
                t={t}
                labels={labels}
                localizedMsg={localizedMsg}
                setLabel={setLabel}
                setLocalizedMessage={setLocalizedMessage}
              />
            </div>
          )}
        </CardContent>
      </Card>

      {/* Test email */}
      <Card className="card-elevated">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Mail className="h-4 w-4" /> {t('widgetPage.availability.testTitle')}
          </CardTitle>
          <CardDescription>
            {t('widgetPage.availability.testDescription')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-end gap-2">
            <div className="flex-1 space-y-1.5">
              <Label className="text-xs">{t('widgetPage.availability.recipient')}</Label>
              <Input
                type="email"
                placeholder="you@example.com"
                value={testEmail}
                onChange={(e) => setTestEmail(e.target.value)}
              />
            </div>
            <Button onClick={sendTestEmail} disabled={!testEmail || testing || saving}>
              {testing ? t('widgetPage.availability.sending') : t('widgetPage.availability.send')}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            {t('widgetPage.availability.templateNote', { locale: activeLocale.toUpperCase() })}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

export default AvailabilitySection;