/**
 * The downgrade report (simple billing phase 4, design §9): exactly what a
 * plan locks in this workspace, as the server counted it
 * (server/services/billing/locks/report.ts). Shown in the plan picker before
 * a downgrade is confirmed, and by the lock banner for what is locked now.
 *
 * Nothing here decides what is locked. While the edition's billing locks are
 * off (`locks_enabled: false`) the data counts are a preview: the report says
 * so and leaves them out, and lists only what follows the plan either way
 * (modules and channels stopped, the monthly chat quota, storage in MB, the
 * monthly AI credit as money in the account currency).
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Download, Loader2, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n';
import { capabilityLabel } from '@/lib/capability-i18n';
import { accountBillingApi, type LockReport as LockReportData, type LockedExportJob } from '@/lib/accountBillingApi';
import { API_BASE } from '@/lib/apiBase';
import { billingDate, money } from '../shared';
import { formatMb } from '@/lib/storageUnits';
import { AI_WALLET_UNIT } from '../../../../../shared/planLimits';

/** Locked items listed by name before "and N more". */
const ITEMS_SHOWN = 5;

export default function LockReport({
  report,
  variant = 'change',
  effectiveAt = null,
  footer = null,
}: {
  report: LockReportData;
  /** 'change': what a plan change locks (picker); 'now': what the plan in force locks (banner). */
  variant?: 'change' | 'now';
  /** When the change applies: the counts are final then. */
  effectiveAt?: string | null;
  /** The acknowledgement, the export link… under the list. */
  footer?: ReactNode;
}) {
  const { t, locale } = useTranslation();
  const n = (value: number) => new Intl.NumberFormat(locale).format(value);
  const limit = (value: number | null) => (value === null || value < 0 ? t('billing.locks.report.unlimited') : n(value));
  const names = (items: Array<{ key: string; in_use: boolean }>) =>
    items
      .map((i) => {
        const name = capabilityLabel(i.key, locale, i.key);
        return i.in_use ? t('billing.locks.report.inUse', { name }) : name;
      })
      .join(locale === 'fa' ? '، ' : ', ');

  // Data locks count only while the switch is on; the rest follows the plan anyway.
  const data = report.locks_enabled;
  const lines: Array<{ key: string; node: ReactNode }> = [];
  if (data && report.kb_article.locked > 0) {
    const shown = report.kb_article.items.slice(0, ITEMS_SHOWN);
    const rest = report.kb_article.locked - shown.length;
    lines.push({
      key: 'kb',
      node: (
        <>
          {t('billing.locks.report.kb', {
            locked: n(report.kb_article.locked),
            total: n(report.kb_article.total),
            limit: limit(report.kb_article.limit),
          })}
          {shown.length > 0 && (
            <ul className="mt-1 list-disc space-y-0.5 ps-5 text-xs text-muted-foreground" aria-label={t('billing.locks.report.kbItems')}>
              {shown.map((item) => <li key={item.id}>{item.title || t('billing.locks.report.untitled')}</li>)}
              {rest > 0 && <li>{t('billing.locks.report.more', { count: n(rest) })}</li>}
            </ul>
          )}
        </>
      ),
    });
  }
  if (data && report.contact.locked > 0) {
    lines.push({
      key: 'contact',
      node: t('billing.locks.report.contacts', {
        locked: n(report.contact.locked),
        total: n(report.contact.total),
        limit: limit(report.contact.limit),
      }),
    });
  }
  if (data && report.member.locked > 0) {
    const shown = report.member.items.slice(0, ITEMS_SHOWN);
    const rest = report.member.locked - shown.length;
    lines.push({
      key: 'member',
      node: (
        <>
          {t('billing.locks.report.members', { locked: n(report.member.locked), limit: limit(report.member.limit) })}
          {/* Names reach managers only; others see the count. */}
          {shown.length > 0 && (
            <ul className="mt-1 list-disc space-y-0.5 ps-5 text-xs text-muted-foreground" aria-label={t('billing.locks.report.memberItems')}>
              {shown.map((item) => <li key={item.user_id}>{item.name || item.email || '—'}</li>)}
              {rest > 0 && <li>{t('billing.locks.report.more', { count: n(rest) })}</li>}
            </ul>
          )}
        </>
      ),
    });
  }
  if (data && report.conversation.locked > 0) {
    lines.push({
      key: 'conversation',
      node: t('billing.locks.report.conversations', {
        count: n(report.conversation.locked),
        days: n(report.conversation.retention_days ?? 0),
      }),
    });
  }
  if (report.conversation_quota.full && report.conversation_quota.limit !== null) {
    lines.push({
      key: 'quota',
      node: t('billing.locks.report.quota', {
        used: n(report.conversation_quota.used_this_month),
        limit: n(report.conversation_quota.limit),
      }),
    });
  }
  // Storage in MB.
  const storageLimitMb = typeof report.storage.limit_mb === 'number' ? report.storage.limit_mb : null;
  const storageUsedMb = typeof report.storage.used_mb === 'number' ? report.storage.used_mb : 0;
  if (report.storage.uploads_blocked && storageLimitMb !== null && storageLimitMb >= 0) {
    lines.push({
      key: 'storage',
      node: storageLimitMb === 0
        ? t('billing.locks.report.storageNone')
        : t('billing.locks.report.storage', { used: formatMb(storageUsedMb, locale), limit: formatMb(storageLimitMb, locale) }),
    });
  }
  if (report.modules_lost.length > 0) {
    lines.push({ key: 'modules', node: t('billing.locks.report.modules', { list: names(report.modules_lost) }) });
  }
  if (report.channels_lost.length > 0) {
    lines.push({
      key: 'channels',
      node: (
        <>
          {t('billing.locks.report.channels', { list: names(report.channels_lost) })}
          {/* Inbound messages stop only while billing locks are on. */}
          {report.locks_enabled && report.channels_stop_messages && (
            <span className="mt-0.5 block text-xs font-medium text-destructive">{t('billing.locks.report.channelsWarning')}</span>
          )}
        </>
      ),
    });
  }
  const credits = report.ai_credits;
  const creditsChange = credits.current !== null && credits.target !== null && credits.current !== credits.target;
  // The monthly AI credit as the billing page shows the wallet: money in the
  // account currency; without a rate, in the wallet's own unit, named.
  const aiAmount = (wallet: number, minor: number | null | undefined) =>
    credits.currency && typeof minor === 'number'
      ? money(minor, locale, credits.currency)
      : money(wallet, locale, credits.unit || AI_WALLET_UNIT);

  const dataLocked = data && (report.kb_article.locked + report.contact.locked + report.member.locked + report.conversation.locked) > 0;
  // What is deleted, and from when: only data that locks (articles, contacts, chats).
  const deletable = data && (report.kb_article.locked + report.contact.locked + report.conversation.locked) > 0;
  const retention = report.locked_data_retention_days;

  return (
    <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm" data-testid="lock-report">
      <p className="flex items-center gap-1.5 font-medium">
        <Lock className="h-4 w-4 shrink-0 text-amber-600" aria-hidden />
        {t(variant === 'now' ? 'billing.locks.report.titleNow' : 'billing.locks.report.title')}
      </p>
      {!data && <p className="text-xs text-muted-foreground" data-testid="lock-report-preview">{t('billing.locks.report.preview')}</p>}
      {lines.length === 0 && !creditsChange ? (
        <p className="text-muted-foreground" data-testid="lock-report-nothing">{t('billing.locks.report.nothing')}</p>
      ) : (
        <ul className="space-y-1.5">
          {lines.map((line) => <li key={line.key} data-testid={`lock-report-${line.key}`}>{line.node}</li>)}
          {creditsChange && (
            <li data-testid="lock-report-ai">
              {t('billing.locks.report.aiCredits', {
                current: aiAmount(credits.current ?? 0, credits.current_minor),
                target: aiAmount(credits.target ?? 0, credits.target_minor),
              })}
            </li>
          )}
        </ul>
      )}
      {dataLocked && <p className="text-xs text-muted-foreground">{t('billing.locks.report.oldestFirst')}</p>}
      {deletable && (
        <p className="text-xs text-muted-foreground" data-testid="lock-report-retention">
          {retention === null
            ? t('billing.locks.report.neverDeleted')
            : report.first_deletion_not_before
              ? t('billing.locks.report.retention', { days: n(retention), date: billingDate(report.first_deletion_not_before, locale) })
              : t('billing.locks.report.retentionNoDate', { days: n(retention) })}
        </p>
      )}
      {variant === 'change' && effectiveAt && dataLocked && (
        <p className="text-xs text-muted-foreground">{t('billing.locks.report.asOf', { date: billingDate(effectiveAt, locale) })}</p>
      )}
      {footer}
    </div>
  );
}

/**
 * Whether the signed-in user owns the workspace (GET /api/workspaces/:id/role),
 * the only one who may export locked data. False until known, and when it
 * cannot be read: the button then stays hidden (the server checks anyway).
 */
function useIsWorkspaceOwner(workspaceId: string | null | undefined): boolean {
  const [owner, setOwner] = useState(false);
  useEffect(() => {
    setOwner(false);
    if (!workspaceId) return;
    let alive = true;
    Promise.resolve()
      .then(() => fetch(`${API_BASE}/api/workspaces/${encodeURIComponent(workspaceId)}/role`, { credentials: 'include', cache: 'no-store' }))
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { role?: unknown } | null) => {
        if (alive) setOwner(body?.role === 'owner');
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [workspaceId]);
  return owner;
}

/** How often a running export is asked about, and for how long. */
const EXPORT_POLL_MS = 5000;
const EXPORT_POLL_TRIES = 120;

/**
 * "Export locked data" (design §7): the owner's ZIP of what is locked when it
 * runs, on every plan. Starts the job, follows it while it runs, then offers a
 * single-use download link. Shown to the workspace owner only (the server
 * refuses anyone else); renders nothing for anyone else.
 */
export function LockedExportButton({ workspaceId, size = 'sm' }: { workspaceId: string; size?: 'sm' | 'default' }) {
  const isOwner = useIsWorkspaceOwner(workspaceId);
  return isOwner ? <ExportControl workspaceId={workspaceId} size={size} /> : null;
}

function ExportControl({ workspaceId, size }: { workspaceId: string; size: 'sm' | 'default' }) {
  const { t, locale } = useTranslation();
  const [job, setJob] = useState<LockedExportJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const alive = useRef(true);
  const polling = useRef(0);

  const follow = useCallback(async (first: LockedExportJob | null) => {
    const mine = ++polling.current;
    let current = first;
    for (let i = 0; i < EXPORT_POLL_TRIES && current && (current.status === 'pending' || current.status === 'running'); i += 1) {
      await new Promise((r) => setTimeout(r, EXPORT_POLL_MS));
      if (!alive.current || polling.current !== mine) return;
      current = await accountBillingApi.lockedExport(workspaceId).then((r) => r.job, () => current);
      if (!alive.current || polling.current !== mine) return;
      setJob(current);
    }
  }, [workspaceId]);

  useEffect(() => {
    alive.current = true;
    setJob(null);
    setMessage(null);
    // No export yet (or the route is not there yet): just the button.
    accountBillingApi.lockedExport(workspaceId).then(
      (r) => {
        if (!alive.current) return;
        setJob(r.job);
        void follow(r.job);
      },
      () => undefined,
    );
    return () => {
      alive.current = false;
      polling.current += 1;
    };
  }, [workspaceId, follow]);

  const start = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const r = await accountBillingApi.startLockedExport(workspaceId);
      setJob(r.job);
      void follow(r.job);
    } catch (e) {
      const code = (e as { code?: string; status?: number }).code;
      const status = (e as { status?: number }).status;
      if (status === 409) {
        setMessage(t('billing.locks.export.busy'));
        const latest = await accountBillingApi.lockedExport(workspaceId).then((r) => r.job, () => null);
        if (latest) {
          setJob(latest);
          void follow(latest);
        }
      } else {
        setMessage(status === 403 || code === 'FORBIDDEN' ? t('billing.locks.export.ownerOnly') : t('billing.locks.export.failed'));
      }
    } finally {
      setBusy(false);
    }
  };

  const download = async () => {
    if (!job) return;
    setBusy(true);
    setMessage(null);
    try {
      const url = await accountBillingApi.lockedExportDownloadUrl(workspaceId, job.id);
      window.location.assign(url);
    } catch {
      setMessage(t('billing.locks.export.failed'));
    } finally {
      setBusy(false);
    }
  };

  const running = job?.status === 'pending' || job?.status === 'running';
  const ready = job?.status === 'completed' && (!job.expires_at || new Date(job.expires_at).getTime() > Date.now());
  return (
    <div className="space-y-1" data-testid="locked-export">
      {running ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          {t('billing.locks.export.running')}
        </p>
      ) : ready ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs">{t('billing.locks.export.ready')}</span>
          <Button size={size} variant="outline" onClick={() => void download()} disabled={busy}>
            <Download className="me-1.5 h-3.5 w-3.5" aria-hidden />
            {t('billing.locks.export.download')}
          </Button>
          {job?.expires_at && (
            <span className="text-xs text-muted-foreground">{t('billing.locks.export.expires', { date: billingDate(job.expires_at, locale) })}</span>
          )}
          <Button size={size} variant="ghost" onClick={() => void start()} disabled={busy}>{t('billing.locks.export.again')}</Button>
        </div>
      ) : (
        <Button size={size} variant="outline" onClick={() => void start()} disabled={busy} title={t('billing.locks.export.hint')}>
          {busy ? <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" aria-hidden /> : <Download className="me-1.5 h-3.5 w-3.5" aria-hidden />}
          {t(busy ? 'billing.locks.export.starting' : 'billing.locks.export.button')}
        </Button>
      )}
      {job?.status === 'failed' && !message && <p className="text-xs text-destructive">{t('billing.locks.export.failed')}</p>}
      {message && <p className="text-xs text-destructive" role="alert">{message}</p>}
    </div>
  );
}
