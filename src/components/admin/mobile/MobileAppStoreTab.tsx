/**
 * The App Store submission checklist.
 *
 * Every requirement Apple applies to this app, grouped, with a live verdict:
 *   pass    — verified from the saved settings or from the project on disk
 *   fail    — a value is missing or wrong; the fix text says exactly which
 *   manual  — only a human can confirm it (screenshots uploaded, tested on a
 *             real device); acknowledging it records who confirmed and when
 *
 * The verdicts come from the server so the same rules apply to a CI check as
 * to this screen; the prose is local so every requirement reads in the
 * operator's own language.
 */
import { useState } from 'react';
import {
  AlertTriangle, CheckCircle2, ChevronDown, CircleDashed, Filter, XCircle,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useTranslation, type TranslationKey } from '@/i18n';
import { cn } from '@/lib/utils';
import {
  useAcknowledgeRequirement,
  type CheckGroup, type MobileAppSettings, type ReadinessCheck, type ReadinessSummary,
} from '@/hooks/useMobileApp';

const GROUP_ORDER: CheckGroup[] = [
  'identity', 'build', 'privacy', 'account', 'review', 'store', 'push', 'compliance', 'technical',
];

type FilterMode = 'all' | 'todo' | 'blockers';

export function MobileAppStoreTab({
  checks,
  summary,
  settings,
}: {
  checks: ReadinessCheck[];
  summary: ReadinessSummary;
  settings: MobileAppSettings;
}) {
  const { t } = useTranslation();
  const acknowledge = useAcknowledgeRequirement();
  const [filter, setFilter] = useState<FilterMode>('all');

  const visible = checks.filter((check) => {
    if (filter === 'todo') return check.status !== 'pass';
    if (filter === 'blockers') return check.severity === 'blocker' && check.status !== 'pass';
    return true;
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="text-base">{t('admin.mobileApp.appStore.title')}</CardTitle>
              <p className="mt-1 text-xs text-muted-foreground">
                {t('admin.mobileApp.appStore.subtitle')}
              </p>
            </div>
            <div className="flex items-center gap-1 rounded-xl border border-border/70 p-1">
              <Filter className="mx-1.5 h-3.5 w-3.5 text-muted-foreground" />
              {(['all', 'todo', 'blockers'] as FilterMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setFilter(mode)}
                  className={cn(
                    'rounded-lg px-2.5 py-1 text-xs font-medium transition-colors',
                    filter === mode
                      ? 'bg-primary/10 text-primary'
                      : 'text-muted-foreground hover:bg-muted',
                  )}
                >
                  {t(`admin.mobileApp.appStore.filter.${mode}` as TranslationKey)}
                </button>
              ))}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <p
            className={cn(
              'rounded-xl p-3 text-sm',
              summary.submittable
                ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                : 'bg-destructive/10 text-destructive',
            )}
          >
            {summary.submittable
              ? t('admin.mobileApp.appStore.readyMessage')
              : t('admin.mobileApp.appStore.blockedMessage', { count: summary.blockers })}
          </p>
        </CardContent>
      </Card>

      {GROUP_ORDER.map((group) => {
        const groupChecks = visible.filter((check) => check.group === group);
        if (!groupChecks.length) return null;
        const open = groupChecks.filter((check) => check.status !== 'pass').length;
        return (
          <Card key={group}>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <CardTitle className="text-base">
                    {t(`admin.mobileApp.groups.${group}.title` as TranslationKey)}
                  </CardTitle>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t(`admin.mobileApp.groups.${group}.description` as TranslationKey)}
                  </p>
                </div>
                {open > 0 && (
                  <Badge variant="secondary">
                    {t('admin.mobileApp.appStore.openCount', { count: open })}
                  </Badge>
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-1.5">
              {groupChecks.map((check) => (
                <CheckRow
                  key={check.id}
                  check={check}
                  acknowledged={Boolean(settings.checklist?.[check.id]?.done)}
                  onAcknowledge={(done) => acknowledge.mutate({ key: check.id, done })}
                  pending={acknowledge.isPending}
                />
              ))}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

function CheckRow({
  check,
  acknowledged,
  onAcknowledge,
  pending,
}: {
  check: ReadinessCheck;
  acknowledged: boolean;
  onAcknowledge: (done: boolean) => void;
  pending: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  const Icon =
    check.status === 'pass' ? CheckCircle2 : check.status === 'fail' ? XCircle : CircleDashed;
  const tone =
    check.status === 'pass'
      ? 'text-emerald-600'
      : check.status === 'fail'
        ? 'text-destructive'
        : 'text-amber-600';

  // A manual requirement can be acknowledged; a failing one is a real
  // configuration gap and must be fixed, not ticked off.
  const acknowledgeable = check.status === 'manual' || acknowledged;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="rounded-xl border border-border/70">
        <CollapsibleTrigger className="flex w-full items-start gap-3 p-3 text-start">
          <Icon className={cn('mt-0.5 h-[18px] w-[18px] shrink-0', tone)} />
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">
                {t(`admin.mobileApp.checks.${check.id}.title` as TranslationKey)}
              </span>
              {check.severity === 'blocker' && check.status !== 'pass' && (
                <Badge variant="destructive" className="gap-1 px-1.5 py-0 text-[10px]">
                  <AlertTriangle className="h-2.5 w-2.5" />
                  {t('admin.mobileApp.appStore.blocker')}
                </Badge>
              )}
              {check.guideline && (
                <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                  {check.guideline}
                </span>
              )}
            </span>
            <span className="mt-0.5 block truncate text-xs text-muted-foreground">
              {t(`admin.mobileApp.checks.${check.id}.requirement` as TranslationKey)}
            </span>
          </span>
          <ChevronDown
            className={cn(
              'mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform',
              open && 'rotate-180',
            )}
          />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="space-y-3 border-t border-border/70 p-3 text-sm">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('admin.mobileApp.appStore.requirementLabel')}
              </p>
              <p className="mt-1">{t(`admin.mobileApp.checks.${check.id}.requirement` as TranslationKey)}</p>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('admin.mobileApp.appStore.fixLabel')}
              </p>
              <p className="mt-1 whitespace-pre-line text-muted-foreground">
                {t(`admin.mobileApp.checks.${check.id}.fix` as TranslationKey)}
              </p>
            </div>
            {check.evidence && (
              <p dir="ltr" className="rounded-lg bg-muted/60 px-2 py-1 font-mono text-[11.5px]">
                {check.evidence}
              </p>
            )}
            {acknowledgeable && (
              <Button
                size="sm"
                variant={acknowledged ? 'outline' : 'default'}
                disabled={pending}
                onClick={() => onAcknowledge(!acknowledged)}
              >
                {acknowledged
                  ? t('admin.mobileApp.appStore.unacknowledge')
                  : t('admin.mobileApp.appStore.acknowledge')}
              </Button>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
