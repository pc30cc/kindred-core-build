/**
 * Account › Availability — Crisp-inspired, modern Lovable polish.
 *
 * Architecture
 *   - GET /api/availability  → { prefs, status }
 *   - PATCH /api/availability → autosaves on every toggle/edit
 *   - The server computes `status` (online/offline + reason) so the
 *     "You are currently seen as: …" banner stays authoritative.
 *
 * UX rules (mirrored from screenshot, but more refined):
 *   - Force offline takes precedence over everything.
 *   - When schedule is OFF, the day chips, timezone, and intervals are
 *     visually disabled but kept editable (so users can pre-fill before
 *     enabling). Crisp does the same.
 *   - Tokens only — no hardcoded colors.
 */

import { useEffect, useMemo, useState } from 'react';
import { useTranslation, useI18n } from '@/i18n';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fetchAvailability,
  updateAvailability,
  type AvailabilityPrefs,
  type AvailabilityResponse,
  type DayKey,
  type AvailabilityInterval,
} from '@/lib/availability-api';
import { Card } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import {
  CheckCircle2,
  Loader2,
  Plus,
  Trash2,
  Clock,
  Globe2,
  AlertCircle,
} from 'lucide-react';

const DAY_KEYS: DayKey[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

const DAY_LABELS_DEFAULT: Record<DayKey, string> = {
  mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu',
  fri: 'Fri', sat: 'Sat', sun: 'Sun',
};

const TIMEZONES = [
  'UTC',
  'Europe/Istanbul',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Paris',
  'Europe/Madrid',
  'Europe/Amsterdam',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Sao_Paulo',
  'Asia/Tehran',
  'Asia/Dubai',
  'Asia/Riyadh',
  'Asia/Karachi',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Asia/Seoul',
  'Australia/Sydney',
  'Pacific/Auckland',
];

function tzLabel(tz: string, locale: string): string {
  try {
    const parts = new Intl.DateTimeFormat(locale, { timeZone: tz, timeZoneName: 'long' })
      .formatToParts(new Date());
    const name = parts.find((p) => p.type === 'timeZoneName')?.value;
    if (name && name !== tz) return name;
  } catch {
    /* ignore */
  }
  return tz;
}

function formatTzOffset(tz: string): string {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      timeZoneName: 'shortOffset',
    });
    const part = fmt.formatToParts(new Date()).find((p) => p.type === 'timeZoneName');
    return part?.value?.replace('GMT', 'UTC') || 'UTC';
  } catch {
    return 'UTC';
  }
}

interface DayChipProps {
  day: DayKey;
  label: string;
  active: boolean;
  disabled?: boolean;
  onToggle: () => void;
}

function DayChip({ label, active, disabled, onToggle }: DayChipProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        'h-9 min-w-[52px] rounded-md border px-3 text-sm font-medium transition-all',
        'disabled:cursor-not-allowed disabled:opacity-50',
        active
          ? 'border-primary bg-primary/10 text-primary shadow-sm hover:bg-primary/15'
          : 'border-border bg-background text-muted-foreground hover:text-foreground hover:bg-accent/40',
      )}
    >
      {label}
    </button>
  );
}

interface IntervalRowProps {
  interval: AvailabilityInterval;
  disabled?: boolean;
  onChange: (next: AvailabilityInterval) => void;
  onRemove: () => void;
  fromLabel: string;
  toLabel: string;
  removeLabel: string;
  rtl: boolean;
}

function IntervalRow({ interval, disabled, onChange, onRemove, fromLabel, toLabel, removeLabel, rtl }: IntervalRowProps) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[11.5px] text-muted-foreground">{fromLabel}</span>
      <Input
        type="time"
        value={interval.from}
        disabled={disabled}
        onChange={(e) => onChange({ ...interval, from: e.target.value })}
        className="w-32"
      />
      <span className="text-xs text-muted-foreground">{rtl ? '←' : '→'}</span>
      <span className="text-[11.5px] text-muted-foreground">{toLabel}</span>
      <Input
        type="time"
        value={interval.to}
        disabled={disabled}
        onChange={(e) => onChange({ ...interval, to: e.target.value })}
        className="w-32"
      />
      <Button
        variant="ghost"
        size="icon"
        disabled={disabled}
        onClick={onRemove}
        aria-label={removeLabel}
        title={removeLabel}
        className="h-8 w-8 text-muted-foreground hover:text-destructive"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

interface SectionHeaderProps {
  icon: React.ElementType;
  title: string;
  hint?: string;
}

function SectionHeader({ icon: Icon, title, hint }: SectionHeaderProps) {
  return (
    <div className="mb-1.5 flex items-center gap-2.5">
      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <div className="text-[13.5px] font-semibold text-foreground">{title}</div>
        {hint && <div className="text-[12px] text-muted-foreground">{hint}</div>}
      </div>
    </div>
  );
}

interface ToggleRowProps {
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}

function ToggleRow({ label, description, checked, disabled, onChange }: ToggleRowProps) {
  return (
    <div
      className={cn(
        'flex items-start justify-between gap-6 py-3.5',
        disabled && 'opacity-60',
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-foreground">{label}</div>
        {description && (
          <div className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">
            {description}
          </div>
        )}
      </div>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  );
}

export function PersonalAvailabilityPanel() {
  const { t } = useTranslation();
  const { locale, dir } = useI18n();
  const rtl = dir === 'rtl';
  const qc = useQueryClient();
  const num = (n: number) => new Intl.NumberFormat(locale).format(n);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['availability', locale],
    queryFn: () => fetchAvailability(locale),
  });

  const [prefs, setPrefs] = useState<AvailabilityPrefs | null>(null);
  useEffect(() => {
    if (data?.prefs) setPrefs(data.prefs);
  }, [data?.prefs]);

  const [savingKey, setSavingKey] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: updateAvailability,
    onSuccess: (resp: AvailabilityResponse) => {
      qc.setQueryData(['availability', locale], resp);
      setPrefs(resp.prefs);
      setSavingKey(null);
      // Invalidate workspace-wide team presence so the dot in Team
      // page / inbox flips immediately for the rest of the team too.
      qc.invalidateQueries({ queryKey: ['team-presence'] });
    },
    onError: (err: Error) => {
      setSavingKey(null);
      toast({
        title: t('availabilityPage.saveError' as any) as string,
        description: err.message,
        variant: 'destructive',
      });
    },
  });

  const update = (
    key: keyof AvailabilityPrefs,
    value: AvailabilityPrefs[keyof AvailabilityPrefs],
  ) => {
    if (!prefs) return;
    setPrefs({ ...prefs, [key]: value } as AvailabilityPrefs);
    setSavingKey(String(key));
    mutation.mutate({ [key]: value } as Partial<AvailabilityPrefs>);
  };

  const updateDay = (day: DayKey, patch: Partial<AvailabilityPrefs['weekly_schedule'][DayKey]>) => {
    if (!prefs) return;
    const next = {
      ...prefs.weekly_schedule,
      [day]: { ...prefs.weekly_schedule[day], ...patch },
    };
    setPrefs({ ...prefs, weekly_schedule: next });
    setSavingKey(`day:${day}`);
    mutation.mutate({ weekly_schedule: { [day]: next[day] } } as Partial<AvailabilityPrefs>);
  };

  const headerStatus = useMemo(() => {
    if (mutation.isPending || savingKey) {
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2.5 py-1 text-[11.5px] font-medium text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          {t('account.saving')}
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[11.5px] font-medium text-emerald-600 dark:text-emerald-400">
        <CheckCircle2 className="h-3 w-3" />
        {t('account.autoSaved')}
      </span>
    );
  }, [mutation.isPending, savingKey, t]);

  if (isLoading || !prefs) {
    return (
      <div className="flex min-h-[400px] items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (isError) {
    return (
      <Card className="border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive">
        {(error as Error)?.message || (t('availabilityPage.loadError' as any) as string)}
      </Card>
    );
  }

  const status = data?.status;
  const scheduleLocked = prefs.force_offline;
  const intervalsLocked = scheduleLocked || !prefs.schedule_enabled;

  return (
    <div className="space-y-5" dir={dir}>
      {/* Section header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold tracking-tight text-foreground">
            {t('availabilityPage.title' as any)}
          </h2>
          <p className="mt-1 text-[13px] text-muted-foreground">
            {t('availabilityPage.subtitle' as any)}
          </p>
        </div>
        {headerStatus}
      </div>

      {/* Live status banner */}
      {status && (
        <Card
          className={cn(
            'p-5',
            status.state === 'online'
              ? 'border-emerald-500/30 bg-emerald-500/5'
              : 'border-amber-500/30 bg-amber-500/5',
          )}
        >
          <div className="flex items-start gap-3">
            <div
              className={cn(
                'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
                status.state === 'online'
                  ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                  : 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
              )}
            >
              {status.state === 'online' ? (
                <CheckCircle2 className="h-4 w-4" />
              ) : (
                <AlertCircle className="h-4 w-4" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm">
                {t('availabilityPage.seenAs' as any)}{' '}
                <span
                  className={cn(
                    'font-semibold',
                    status.state === 'online'
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : 'text-amber-600 dark:text-amber-400',
                  )}
                >
                  {status.state === 'online'
                    ? (t('availabilityPage.online' as any) as string)
                    : (t('availabilityPage.offline' as any) as string)}
                </span>
              </div>
              <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
                {t('availabilityPage.statusHelp' as any)}{' '}
                <span className="font-medium text-foreground">
                  {t('availabilityPage.statusHelpTeam' as any)}
                </span>
              </p>
            </div>
          </div>
        </Card>
      )}

      {/* Toggles */}
      <Card className="overflow-hidden">
        <div className="px-6 divide-y divide-border/60">
          <ToggleRow
            label={t('availabilityPage.forceOffline' as any) as string}
            description={t('availabilityPage.forceOfflineDesc' as any) as string}
            checked={prefs.force_offline}
            onChange={(v) => update('force_offline', v)}
          />
          <ToggleRow
            label={t('availabilityPage.availableWhenUsingApp' as any) as string}
            description={t('availabilityPage.availableWhenUsingAppDesc' as any) as string}
            checked={prefs.available_when_using_app}
            disabled={prefs.force_offline}
            onChange={(v) => update('available_when_using_app', v)}
          />
          <ToggleRow
            label={t('availabilityPage.scheduleEnabled' as any) as string}
            description={t('availabilityPage.scheduleEnabledDesc' as any) as string}
            checked={prefs.schedule_enabled}
            disabled={prefs.force_offline}
            onChange={(v) => update('schedule_enabled', v)}
          />
        </div>
      </Card>

      {/* Days */}
      <Card className="p-6">
        <SectionHeader
          icon={Clock}
          title={t('availabilityPage.days' as any) as string}
          hint={`${num(DAY_KEYS.filter((d) => prefs.weekly_schedule[d]?.enabled).length)}/${num(7)}`}
        />
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {DAY_KEYS.map((day) => (
            <DayChip
              key={day}
              day={day}
              label={(t(`availabilityPage.dayShort.${day}` as any) as string) || DAY_LABELS_DEFAULT[day]}
              active={!!prefs.weekly_schedule[day]?.enabled}
              disabled={scheduleLocked}
              onToggle={() =>
                updateDay(day, { enabled: !prefs.weekly_schedule[day]?.enabled })
              }
            />
          ))}
        </div>
      </Card>

      {/* Timezone */}
      <Card className="p-6">
        <SectionHeader
          icon={Globe2}
          title={t('availabilityPage.timezone' as any) as string}
          hint={String(t('availabilityPage.timezoneHint' as any)).replace('{offset}', formatTzOffset(prefs.timezone))}
        />
        <div className="mt-4 max-w-sm">
          <Select
            value={prefs.timezone}
            disabled={scheduleLocked}
            onValueChange={(v) => update('timezone', v)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TIMEZONES.map((tz) => (
                <SelectItem key={tz} value={tz}>
                  {tzLabel(tz, locale)} <span dir="ltr">({formatTzOffset(tz)})</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </Card>

      {/* Hours per day */}
      <Card className="p-6">
        <SectionHeader
          icon={Clock}
          title={t('availabilityPage.hours' as any) as string}
          hint={t('availabilityPage.hoursHint' as any) as string}
        />
        <div className="mt-4 space-y-3">
          {DAY_KEYS.map((day) => {
            const cfg = prefs.weekly_schedule[day];
            const active = !!cfg?.enabled;
            const dayLocked = intervalsLocked || !active;
            return (
              <div
                key={day}
                className={cn(
                  'rounded-lg border border-border/70 bg-muted/20 p-3.5',
                  dayLocked && 'opacity-60',
                )}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="min-w-[68px] text-sm font-medium">
                      {(t(`availabilityPage.dayShort.${day}` as any) as string) || DAY_LABELS_DEFAULT[day]}
                    </span>
                    {!active && (
                      <span className="rounded-full border border-border bg-background px-2 py-0.5 text-[10.5px] uppercase tracking-wide text-muted-foreground">
                        {t('availabilityPage.off' as any)}
                      </span>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={intervalsLocked || !active}
                    onClick={() => {
                      const next = [
                        ...(cfg?.intervals || []),
                        { from: '09:00', to: '18:00' },
                      ];
                      updateDay(day, { intervals: next });
                    }}
                    className="h-7 text-[12px]"
                  >
                    <Plus className="me-1 h-3 w-3" /> {t('availabilityPage.addInterval' as any)}
                  </Button>
                </div>
                {(cfg?.intervals?.length ?? 0) > 0 && (
                  <div className="mt-3 space-y-2">
                    {cfg.intervals.map((it, idx) => (
                      <IntervalRow
                        key={idx}
                        interval={it}
                        disabled={intervalsLocked || !active}
                        fromLabel={t('availabilityPage.from' as any) as string}
                        toLabel={t('availabilityPage.to' as any) as string}
                        removeLabel={t('availabilityPage.removeInterval' as any) as string}
                        rtl={rtl}
                        onChange={(next) => {
                          const list = cfg.intervals.slice();
                          list[idx] = next;
                          updateDay(day, { intervals: list });
                        }}
                        onRemove={() => {
                          const list = cfg.intervals.slice();
                          list.splice(idx, 1);
                          updateDay(day, { intervals: list });
                        }}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}