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
import { useTranslation } from '@/i18n';
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
}

function IntervalRow({ interval, disabled, onChange, onRemove }: IntervalRowProps) {
  return (
    <div className="flex items-center gap-2">
      <Input
        type="time"
        value={interval.from}
        disabled={disabled}
        onChange={(e) => onChange({ ...interval, from: e.target.value })}
        className="w-32"
      />
      <span className="text-xs text-muted-foreground">→</span>
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

export default function AvailabilityPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['availability'],
    queryFn: fetchAvailability,
  });

  const [prefs, setPrefs] = useState<AvailabilityPrefs | null>(null);
  useEffect(() => {
    if (data?.prefs) setPrefs(data.prefs);
  }, [data?.prefs]);

  const [savingKey, setSavingKey] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: updateAvailability,
    onSuccess: (resp: AvailabilityResponse) => {
      qc.setQueryData(['availability'], resp);
      setPrefs(resp.prefs);
      setSavingKey(null);
    },
    onError: (err: Error) => {
      setSavingKey(null);
      toast({
        title: 'Failed to save',
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
        {(error as Error)?.message || 'Failed to load availability'}
      </Card>
    );
  }

  const status = data?.status;
  const scheduleLocked = prefs.force_offline;
  const intervalsLocked = scheduleLocked || !prefs.schedule_enabled;

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Availability
          </h1>
          <p className="mt-1 text-[13.5px] text-muted-foreground">
            Set your operator presence schedule. Visitors see you as available
            during the time windows you define below.
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
                You are currently seen as:{' '}
                <span
                  className={cn(
                    'font-semibold',
                    status.state === 'online'
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : 'text-amber-600 dark:text-amber-400',
                  )}
                >
                  {status.state === 'online' ? 'Online' : 'Offline'}
                </span>
              </div>
              <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
                Set yourself available on schedule by configuring days and times
                (in your timezone). Visitors will see you as away outside scheduled
                hours, but they can still send you messages.{' '}
                <span className="font-medium text-foreground">
                  If you are a member of a workspace with multiple operators, the
                  chatbox will be seen as online if at least one operator is
                  available, and away if all operators are unavailable.
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
            label="Force offline (invisible mode)"
            description="When enabled, you will appear offline to visitors regardless of your schedule."
            checked={prefs.force_offline}
            onChange={(v) => update('force_offline', v)}
          />
          <ToggleRow
            label="Set me available when using the app"
            description="Automatically mark you as online while the app is open in your browser."
            checked={prefs.available_when_using_app}
            disabled={prefs.force_offline}
            onChange={(v) => update('available_when_using_app', v)}
          />
          <ToggleRow
            label="Enable availability schedule"
            description="Use the weekly schedule below to define when you are available."
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
          title="Days"
          hint={`${DAY_KEYS.filter((d) => prefs.weekly_schedule[d]?.enabled).length}/7`}
        />
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {DAY_KEYS.map((day) => (
            <DayChip
              key={day}
              day={day}
              label={DAY_LABELS_DEFAULT[day]}
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
          title="Timezone"
          hint={`Currently ${formatTzOffset(prefs.timezone)}`}
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
                  {tz} ({formatTzOffset(tz)})
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
          title="Hours"
          hint="Time intervals during which you are available, per day."
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
                    <span className="w-12 text-sm font-medium">
                      {DAY_LABELS_DEFAULT[day]}
                    </span>
                    {!active && (
                      <span className="rounded-full border border-border bg-background px-2 py-0.5 text-[10.5px] uppercase tracking-wide text-muted-foreground">
                        Off
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
                    <Plus className="me-1 h-3 w-3" /> Add an interval
                  </Button>
                </div>
                {(cfg?.intervals?.length ?? 0) > 0 && (
                  <div className="mt-3 space-y-2">
                    {cfg.intervals.map((it, idx) => (
                      <IntervalRow
                        key={idx}
                        interval={it}
                        disabled={intervalsLocked || !active}
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