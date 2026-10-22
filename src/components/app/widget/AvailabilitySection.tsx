/**
 * Widget → Availability: business hours, the offline behaviour and the
 * status copy, and a "Now" card that says what visitors see right now.
 *
 * The card asks the server (GET /api/widget-settings/:id/availability, the
 * resolver the widget itself uses), because availability has two inputs:
 * the schedule, and whether any operator is available by their own status
 * and personal hours. With business hours off there is no schedule, so the
 * operators alone decide; the widget is offline (and the offline behaviour
 * applies) whenever nobody is available.
 *
 * Every edit goes through `onChange`, which drafts it at once and saves it
 * after `delay` (WidgetPage's useWidgetSettingsDraft), so typing is never
 * lost to a save in flight. Hours with an interval that would never match
 * stay a draft (`draftOnly`) until fixed: the server keeps the last valid
 * schedule.
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from '@/i18n';
import { usePlatformRegion } from '@/hooks/usePlatformRegion';
import { useEdition } from '@/hooks/useEdition';
import { useWidgetAvailabilityNow, type WidgetAvailabilityNow } from '@/hooks/useWidgetSettings';
import { defaultCallbackHours } from '@/lib/call-center-api';
import { intlLocaleFor } from '@/lib/region';
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
import { hoursProblem } from './businessHoursProblems';
import { MAX_INTERVALS_PER_DAY } from '../../../../shared/callbackSlots';

const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

/** The chat's hours as the server accepts them (server/routes/widgetSettings.ts businessHoursSchema). */
const CHAT_HOURS_LIMITS = { intervalsPerDay: MAX_INTERVALS_PER_DAY, overrides: 366, labelLength: 120 };
/** The server's caps on the status labels and the offline message. */
const LABEL_MAX = 100;
const MESSAGE_MAX = 2000;

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
            maxLength={LABEL_MAX}
            value={labels[loc]?.online || ''}
            placeholder={t('widgetPage.availability.onlinePlaceholder')}
            onChange={(e) => setLabel(loc, 'online', e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">{t('widgetPage.availability.offlineLabel')}</Label>
          <Input
            dir={dir}
            maxLength={LABEL_MAX}
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
          maxLength={MESSAGE_MAX}
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
  | 'reasonDisabled' | 'reasonNoOperators' | 'reasonChatDisabled' | 'reasonOverrideClosed'
  | 'reasonNoIntervals' | 'reasonWithin' | 'reasonOutside';

function anyInterval(hours: BusinessHoursConfig): boolean {
  return DAY_KEYS.some((k) => (hours.weekly[k] || []).length > 0)
    || (hours.overrides || []).some((o) => !o.closed && (o.intervals || []).length > 0);
}

const isInterval = (it: unknown): it is Interval =>
  !!it && typeof (it as Interval).from === 'string' && typeof (it as Interval).to === 'string';

/**
 * The stored hours as the editor shows them: every day present, the dated
 * overrides with the fields the server keeps. The zone is the one the server
 * uses (UTC when none is stored) once the hours are on or name an interval;
 * before that, `startZone`, which turning them on writes.
 */
function normalizeHours(input: WidgetSettings['business_hours'] | undefined, startZone: string): BusinessHoursConfig {
  const raw = (input || {}) as Partial<BusinessHoursConfig>;
  const weekly: BusinessHoursConfig['weekly'] = {};
  for (const d of DAY_KEYS) {
    const list: unknown = raw.weekly && (raw.weekly as Record<string, unknown>)[d];
    weekly[d] = Array.isArray(list) ? list.filter(isInterval).map(({ from, to }) => ({ from, to })) : [];
  }
  const overrides = (Array.isArray(raw.overrides) ? raw.overrides : [])
    .filter((o): o is NonNullable<BusinessHoursConfig['overrides']>[number] => !!o && typeof o.date === 'string')
    .map((o) => ({
      date: o.date,
      ...(o.closed !== undefined ? { closed: !!o.closed } : {}),
      ...(Array.isArray(o.intervals) ? { intervals: o.intervals.filter(isInterval).map(({ from, to }) => ({ from, to })) } : {}),
      ...(typeof o.label === 'string' && o.label ? { label: o.label } : {}),
    }));
  const stored = typeof raw.timezone === 'string' && raw.timezone ? raw.timezone : null;
  const hours: BusinessHoursConfig = { enabled: !!raw.enabled, timezone: 'UTC', weekly, overrides };
  const configured = hours.enabled || anyInterval(hours);
  hours.timezone = configured ? (stored || 'UTC') : (stored && stored !== 'UTC' ? stored : startZone);
  return hours;
}

/** The browser's own zone (an International workspace's hours start in it). */
function browserTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/** The server's reason, in the panel's words (always_offline has two causes the settings tell apart). */
function nowReason(now: WidgetAvailabilityNow, hours: BusinessHoursConfig, liveChatEnabled: boolean): ReasonKey {
  switch (now.reason) {
    case 'disabled': return 'reasonDisabled';
    case 'no_operators_online': return 'reasonNoOperators';
    case 'within_hours': return 'reasonWithin';
    case 'outside_hours': return 'reasonOutside';
    case 'override_closed': return 'reasonOverrideClosed';
    default: return hours.enabled && !liveChatEnabled ? 'reasonChatDisabled' : 'reasonNoIntervals';
  }
}

function formatNextOpen(iso: string, timeZone: string, locale: string): string {
  try {
    return new Intl.DateTimeFormat(intlLocaleFor(locale as 'en' | 'fa' | 'tr'), {
      timeZone, weekday: 'long', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export function AvailabilitySection({
  workspaceId,
  settings,
  onChange,
  saving,
}: {
  workspaceId: string | undefined;
  /** The settings with the page's draft over them. */
  settings: Partial<WidgetSettings>;
  /** Draft `patch` and save it `delay` ms later; `draftOnly` keeps it unsaved. */
  onChange: (patch: Partial<WidgetSettings>, opts?: { delay?: number; draftOnly?: boolean }) => void;
  saving: boolean;
}) {
  const { t, dir, locale } = useTranslation();
  const { edition } = useEdition();
  // The edition's working week (Iran: Saturday to Wednesday, Tehran time;
  // International: Monday to Friday, the admin's zone), as the call center's
  // callback hours start from.
  const startHours = useMemo(() => defaultCallbackHours(edition, browserTimeZone()), [edition]);
  const firstDay = edition === 'international' ? 'mon' : 'sat';
  const now = useWidgetAvailabilityNow(workspaceId, locale);
  // The platform's active region/language mode decides which languages are
  // editable here — a single-language platform (e.g. Persian-only) must not
  // show a language picker or fields for languages it never speaks.
  const { allowedLocales } = usePlatformRegion();
  const activeLocales = (allowedLocales.length ? allowedLocales : LOCALES) as Locale[];
  const hours = useMemo(() => normalizeHours(settings.business_hours, startHours.timezone), [settings.business_hours, startHours.timezone]);
  // An old stored value (accept_messages / contact_fallback, before 279)
  // means the form, as the server reads it.
  const offlineMode: WidgetSettings['offline_mode'] =
    settings.offline_mode === 'hide_widget' || settings.offline_mode === 'show_offline_message' ? settings.offline_mode : 'capture_message';
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

  // Hours on with an interval that would never match are kept as a draft
  // only (the server refuses them); hours off apply to nothing and save.
  const updateHours = (next: BusinessHoursConfig, delay = 500) =>
    onChange({ business_hours: next }, { delay, draftOnly: next.enabled && hoursProblem(next) !== null });

  // Turning the hours on with no interval anywhere starts the edition's
  // working week, instead of an empty schedule that is offline for everyone.
  const setHoursEnabled = (on: boolean) => {
    if (on && !anyInterval(hours)) {
      updateHours({ ...hours, enabled: true, weekly: startHours.weekly }, 0);
    } else {
      updateHours({ ...hours, enabled: on }, 0);
    }
  };

  const setLabel = (loc: Locale, kind: 'online' | 'offline', value: string) => {
    const next = { ...labels, [loc]: { ...(labels[loc] || {}), [kind]: value } };
    onChange({ availability_labels: next });
  };

  const setLocalizedMessage = (loc: Locale, value: string) => {
    const next = { ...localizedMsg, [loc]: value };
    onChange({ offline_message_localized: next });
  };

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

  const anyIntervalDefined = anyInterval(hours);
  const nowData = now.data;

  return (
    <div className="space-y-4" dir={dir}>
      {/* What visitors see right now (the widget's own resolver) */}
      <Card className="card-elevated" data-availability-now={nowData?.state ?? (now.isError ? 'error' : 'loading')}>
        <CardContent className="p-4 flex items-start gap-3">
          {nowData?.state === 'online' ? (
            <CheckCircle2 className="h-5 w-5 mt-0.5 text-success" aria-hidden="true" />
          ) : (
            <AlertCircle className="h-5 w-5 mt-0.5 text-warning" aria-hidden="true" />
          )}
          <div className="flex-1 min-w-0" aria-live="polite">
            <div className="text-sm font-medium">
              {t('widgetPage.availability.now')}:{' '}
              {nowData ? (
                <Badge variant={nowData.state === 'online' ? 'default' : 'secondary'} className="ms-1">
                  {nowData.state === 'online' ? t('widgetPage.availability.online') : t('widgetPage.availability.offline')}
                </Badge>
              ) : (
                <span className="text-muted-foreground">
                  {now.isError ? t('widgetPage.availability.nowUnavailable') : t('widgetPage.availability.nowChecking')}
                </span>
              )}
            </div>
            {nowData && (
              <div className="text-xs text-muted-foreground mt-1 space-y-0.5">
                <p>
                  {t(`widgetPage.availability.${nowReason(nowData, hours, liveChatEnabled)}`)}
                  {nowData.next_open_at && (
                    <> {t('widgetPage.availability.nextOpen', { time: formatNextOpen(nowData.next_open_at, nowData.timezone, locale) })}</>
                  )}
                </p>
                <p>
                  {t('widgetPage.availability.operatorsNow', { available: nowData.operators.available, members: nowData.operators.members })}
                  {hours.enabled && <> · {t('widgetPage.availability.timezoneLabel', { tz: nowData.timezone })}</>}
                </p>
                {!nowData.business_hours_allowed && <p>{t('widgetPage.availability.planNotApplied')}</p>}
              </div>
            )}
          </div>
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
              aria-label={t('widgetPage.availability.enableHours')}
              onCheckedChange={setHoursEnabled}
            />
          </div>

          {/* Only with a schedule: off shows the offline behaviour all day,
              inside the hours too (the resolver's always_offline). */}
          <div className={`flex items-center justify-between rounded-lg border border-border p-3 ${!hours.enabled ? 'opacity-60' : ''}`}>
            <div>
              <Label className="text-sm font-medium">{t('widgetPage.availability.liveChatEnabled')}</Label>
              <p className="text-xs text-muted-foreground mt-0.5">
                {t(hours.enabled ? 'widgetPage.availability.liveChatHint' : 'widgetPage.availability.liveChatHintHoursOff')}
              </p>
            </div>
            <Switch
              checked={liveChatEnabled}
              disabled={!hours.enabled}
              aria-label={t('widgetPage.availability.liveChatEnabled')}
              onCheckedChange={(v) => onChange({ live_chat_enabled: v }, { delay: 0 })}
            />
          </div>

          <WeeklyHoursEditor
            hours={hours}
            onChange={(next) => updateHours(next)}
            disabled={!hours.enabled}
            firstDay={firstDay}
            limits={CHAT_HOURS_LIMITS}
          />

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
              }`}
            >
              {/* Applies with or without business hours: the widget is
                  offline whenever no operator is available too. */}
              <input
                type="radio"
                name="offline_mode"
                value={opt.v}
                checked={offlineMode === opt.v}
                onChange={() => onChange({ offline_mode: opt.v }, { delay: 0 })}
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