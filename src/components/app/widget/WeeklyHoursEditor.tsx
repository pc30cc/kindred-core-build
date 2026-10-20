/**
 * A weekly schedule: its time zone, the intervals of each day and the dated
 * overrides (holidays, special days), in the chat widget's business hours
 * shape (BusinessHoursConfig). Every change writes the whole hours object
 * through `onChange`.
 *
 * Shared by the chat's business hours (Widget → Availability, where it
 * started) and the call center's callback hours (Call Center → Settings →
 * Availability, the 2026-10 call widget design). It renders its three blocks
 * as siblings, so the parent's spacing lays them out.
 */
import { Plus, Trash2, Copy, Globe2 } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { toast } from '@/hooks/use-toast';
import type { BusinessHoursConfig } from '@/types/models';

type DayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
type Interval = { from: string; to: string };
type Override = NonNullable<BusinessHoursConfig['overrides']>[number];

/** The week from Monday (the chat, as always) or from Saturday (the Iranian week). */
const WEEKS: Record<'mon' | 'sat', readonly DayKey[]> = {
  mon: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
  sat: ['sat', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri'],
};

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

export interface WeeklyHoursEditorProps {
  /** The hours, every day present (an empty list is a closed day). */
  hours: BusinessHoursConfig;
  onChange: (next: BusinessHoursConfig) => void;
  /** Every control off (the chat while its hours are off, the call center while slots are off). */
  disabled?: boolean;
  /** The first day of the week the days are listed from. */
  firstDay?: 'mon' | 'sat';
  /**
   * Caps for hours that must pass a strict shape (the call center's callback
   * hours: 6 intervals a day, 60 overrides, 120-character labels); the chat
   * sets none.
   */
  limits?: { intervalsPerDay?: number; overrides?: number; labelLength?: number };
}

export function WeeklyHoursEditor({ hours, onChange, disabled = false, firstDay = 'mon', limits }: WeeklyHoursEditorProps) {
  const { t, locale } = useTranslation();
  const days = WEEKS[firstDay];
  // The copy button fills the rest of the working week from its first day.
  const copyFrom = days[0];
  const copyTo = days.slice(1, 5);
  const zones = TIMEZONES.includes(hours.timezone) || !hours.timezone ? TIMEZONES : [...TIMEZONES, hours.timezone];

  const setDayIntervals = (day: DayKey, list: Interval[]) =>
    onChange({ ...hours, weekly: { ...hours.weekly, [day]: list } });

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

  const copyWeek = () => {
    const src = hours.weekly[copyFrom] || [];
    const weekly = { ...hours.weekly };
    for (const day of copyTo) weekly[day] = [...src];
    onChange({ ...hours, weekly });
    toast({ title: t(firstDay === 'sat' ? 'widgetPage.availability.copiedSatWed' : 'widgetPage.availability.copied') });
  };

  const addOverride = () => {
    const today = new Date().toISOString().slice(0, 10);
    const next = [...(hours.overrides || []), { date: today, closed: true }];
    onChange({ ...hours, overrides: next });
  };
  const updateOverride = (idx: number, patch: Partial<Override>) => {
    const list = (hours.overrides || []).slice();
    list[idx] = { ...list[idx], ...patch };
    onChange({ ...hours, overrides: list });
  };
  const removeOverride = (idx: number) => {
    const list = (hours.overrides || []).slice();
    list.splice(idx, 1);
    onChange({ ...hours, overrides: list });
  };

  return (
    <>
      <div className="space-y-2">
        <Label className="text-xs font-medium flex items-center gap-1.5">
          <Globe2 className="h-3.5 w-3.5" /> {t('widgetPage.availability.timezone')}
        </Label>
        <Select
          value={hours.timezone}
          onValueChange={(v) => onChange({ ...hours, timezone: v })}
          disabled={disabled}
        >
          <SelectTrigger className="max-w-xs" data-hours-timezone>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {zones.map((tz) => (
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
            onClick={copyWeek}
            disabled={disabled}
            className="h-7 text-xs"
          >
            <Copy className="h-3 w-3 me-1" /> {t(firstDay === 'sat' ? 'widgetPage.availability.copySatWed' : 'widgetPage.availability.copyMonFri')}
          </Button>
        </div>

        <div className="space-y-2">
          {days.map((day) => {
            const list = hours.weekly[day] || [];
            const valid = intervalsValid(list);
            return (
              <div
                key={day}
                data-hours-day={day}
                className="rounded-lg border border-border p-3 space-y-2 bg-muted/20"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium w-24">{t(`widgetPage.availability.days.${day}`)}</span>
                    {list.length === 0 && (
                      <Badge variant="outline" className="text-[10px]">{t('widgetPage.availability.closed')}</Badge>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => addInterval(day)}
                    disabled={disabled || (limits?.intervalsPerDay !== undefined && list.length >= limits.intervalsPerDay)}
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
                      disabled={disabled}
                      className="w-32"
                    />
                    <span className="text-xs text-muted-foreground">{t('widgetPage.availability.to')}</span>
                    <Input
                      type="time"
                      value={it.to}
                      onChange={(e) => updateInterval(day, idx, { to: e.target.value })}
                      disabled={disabled}
                      className="w-32"
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => removeInterval(day, idx)}
                      disabled={disabled}
                      aria-label={t('widgetPage.availability.removeInterval')}
                      className="h-8 w-8 text-destructive hover:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
                {!valid.ok && valid.reason && (
                  <p className="text-xs text-destructive">{t(`widgetPage.availability.${valid.reason}`)}</p>
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
            disabled={disabled || (limits?.overrides !== undefined && (hours.overrides || []).length >= limits.overrides)}
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
                  disabled={disabled}
                  className="w-44"
                />
                <Input
                  placeholder={t('widgetPage.availability.overrideLabel')}
                  maxLength={limits?.labelLength}
                  value={ov.label || ''}
                  onChange={(e) => updateOverride(idx, { label: e.target.value })}
                  disabled={disabled}
                  className="flex-1"
                />
                <div className="flex items-center gap-2">
                  <Label className="text-xs">{t('widgetPage.availability.overrideClosed')}</Label>
                  <Switch
                    checked={!!ov.closed}
                    onCheckedChange={(v) => updateOverride(idx, { closed: v, intervals: v ? undefined : (ov.intervals || []) })}
                    disabled={disabled}
                  />
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => removeOverride(idx)}
                  disabled={disabled}
                  aria-label={t('widgetPage.availability.removeOverride')}
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
    </>
  );
}
