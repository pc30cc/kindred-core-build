import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from '@/i18n';
import { usePlatformRegion } from '@/hooks/usePlatformRegion';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Clock, Mail, AlertCircle, CheckCircle2 } from 'lucide-react';
import type { WidgetSettings, BusinessHoursConfig } from '@/types/models';
import { toast } from '@/hooks/use-toast';
import { API_BASE } from '@/lib/apiBase';
import { WeeklyHoursEditor } from './WeeklyHoursEditor';

const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
type DayKey = (typeof DAY_KEYS)[number];

const LOCALES = ['en', 'fa', 'tr'] as const;
type Locale = (typeof LOCALES)[number];
const LOCALE_LABELS: Record<Locale, string> = { en: 'English', fa: 'فارسی', tr: 'Türkçe' };

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

interface Interval {
  from: string;
  to: string;
}

type ReasonKey =
  | 'reasonDisabled' | 'reasonChatDisabled' | 'reasonInvalidTz' | 'reasonOverrideClosed'
  | 'reasonNoIntervals' | 'reasonClosedToday' | 'reasonWithin' | 'reasonOutside';

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
    const list: unknown = raw.weekly && (raw.weekly as Record<string, unknown>)[d];
    weekly[d] = Array.isArray(list)
      ? list.filter((it): it is Interval => !!it && typeof it.from === 'string' && typeof it.to === 'string')
      : [];
  }
  return {
    enabled: !!raw.enabled,
    timezone: typeof raw.timezone === 'string' && raw.timezone ? raw.timezone : 'UTC',
    weekly,
    overrides: Array.isArray(raw.overrides) ? raw.overrides : [],
  };
}

function previewState(hours: BusinessHoursConfig, liveChatEnabled: boolean, now: Date = new Date()): {
  state: 'online' | 'offline';
  reason: ReasonKey;
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
  // The platform's active region/language mode decides which languages are
  // editable here — a single-language platform (e.g. Persian-only) must not
  // show a language picker or fields for languages it never speaks.
  const { allowedLocales } = usePlatformRegion();
  const activeLocales = (allowedLocales.length ? allowedLocales : LOCALES) as Locale[];
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

  const updateHours = (next: BusinessHoursConfig) => onSave({ business_hours: next });

  const setLabel = (locale: Locale, kind: 'online' | 'offline', value: string) => {
    const next = { ...labels, [locale]: { ...(labels[locale] || {}), [kind]: value } };
    onSave({ availability_labels: next });
  };

  const setLocalizedMessage = (locale: Locale, value: string) => {
    const next = { ...localizedMsg, [locale]: value };
    onSave({ offline_message_localized: next });
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
    } catch (e: unknown) {
      toast({ title: t('widgetPage.availability.testFailed'), description: (e instanceof Error && e.message) || t('common.error'), variant: 'destructive' });
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
              {t(`widgetPage.availability.${preview.reason}`)} · {t('widgetPage.availability.timezoneLabel', { tz: hours.timezone })}
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

          <WeeklyHoursEditor hours={hours} onChange={updateHours} disabled={!hours.enabled} />

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
          {([
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
          ] satisfies Array<{ v: WidgetSettings['offline_mode']; t: string; d: string }>).map((opt) => (
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
                onChange={() => onSave({ offline_mode: opt.v })}
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