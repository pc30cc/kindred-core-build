/**
 * Super Admin — platform audit trail.
 *
 * The previous version dumped raw UUIDs and unfiltered rows. This surface is
 * the change trail an operator actually investigates with: filters (free text,
 * action, entity, date range), server-side pagination, resolved actor identity
 * and workspace name, and an expandable before/after diff per row.
 */
import { Fragment, useMemo, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useAdminAuditLogs, type AdminAuditLogRow } from '@/hooks/useAdmin';
import { formatDateTime } from '@/lib/date';
import { useTranslation } from '@/i18n';
import { ChevronDown, ChevronLeft, ChevronRight, RotateCcw, Search, FileText } from 'lucide-react';
import { SkeletonTable } from '@/components/common/Skeletons';

const PAGE_SIZE = 25;
const ALL = '__all__';

/** create/update/delete/other → semantic badge tone. Never a raw enum. */
function actionTone(action: string): string {
  const a = action.toLowerCase();
  if (/(create|insert|add|grant|bootstrap|invite)/.test(a)) return 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20';
  if (/(delete|remove|purge|revoke|block|reset)/.test(a)) return 'bg-destructive/10 text-destructive border-destructive/20';
  if (/(update|change|edit|set|assign|restore)/.test(a)) return 'bg-blue-500/10 text-blue-600 border-blue-500/20';
  return 'bg-muted text-muted-foreground border-border';
}

function humanize(value: string | null | undefined): string {
  if (!value) return '—';
  return value.replace(/[._]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function DiffBlock({ label, value }: { label: string; value: any }) {
  if (value === null || value === undefined) return null;
  return (
    <div className="min-w-0 flex-1">
      <p className="text-xs font-medium text-muted-foreground mb-1">{label}</p>
      <pre className="text-xs bg-muted/50 rounded-md p-3 overflow-x-auto max-h-56 text-foreground/90" dir="ltr">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

export default function AdminAuditLogsPage() {
  const { t } = useTranslation();
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [action, setAction] = useState('');
  const [entityType, setEntityType] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  const { data, isLoading, isFetching } = useAdminAuditLogs({
    limit: PAGE_SIZE, offset: page * PAGE_SIZE, search, action, entityType, from, to,
  });

  const logs = data?.logs ?? [];
  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const hasFilters = !!(search || action || entityType || from || to);

  const summary = useMemo(() => {
    const byAction = new Map<string, number>();
    for (const l of logs) byAction.set(l.action, (byAction.get(l.action) || 0) + 1);
    return [...byAction.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  }, [logs]);

  const applySearch = () => { setSearch(searchInput.trim()); setPage(0); };
  const reset = () => {
    setSearch(''); setSearchInput(''); setAction(''); setEntityType(''); setFrom(''); setTo(''); setPage(0);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-foreground">{t('admin.audit.title' as never)}</h2>
          <p className="text-muted-foreground text-sm mt-1">{t('admin.audit.subtitle' as never)}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {summary.map(([a, n]) => (
            <Badge key={a} variant="outline" className={`text-xs ${actionTone(a)}`}>
              {humanize(a)} · {n}
            </Badge>
          ))}
        </div>
      </div>

      {/* Filters */}
      <Card className="bg-card border-border">
        <CardContent className="p-4 grid gap-3 md:grid-cols-2 xl:grid-cols-6">
          <div className="relative xl:col-span-2">
            <Search className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && applySearch()}
              onBlur={applySearch}
              placeholder={t('admin.audit.searchPlaceholder' as never)}
              className="ps-9"
            />
          </div>

          <Select value={action || ALL} onValueChange={(v) => { setAction(v === ALL ? '' : v); setPage(0); }}>
            <SelectTrigger><SelectValue placeholder={t('admin.audit.filters.action' as never)} /></SelectTrigger>
            <SelectContent className="max-h-72">
              <SelectItem value={ALL}>{t('admin.audit.filters.allActions' as never)}</SelectItem>
              {(data?.facets.actions ?? []).map((a) => (
                <SelectItem key={a} value={a}>{humanize(a)}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={entityType || ALL} onValueChange={(v) => { setEntityType(v === ALL ? '' : v); setPage(0); }}>
            <SelectTrigger><SelectValue placeholder={t('admin.audit.filters.entity' as never)} /></SelectTrigger>
            <SelectContent className="max-h-72">
              <SelectItem value={ALL}>{t('admin.audit.filters.allEntities' as never)}</SelectItem>
              {(data?.facets.entityTypes ?? []).map((e) => (
                <SelectItem key={e} value={e}>{humanize(e)}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(0); }} aria-label={t('admin.audit.filters.from' as never)} />
          <div className="flex gap-2">
            <Input type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(0); }} aria-label={t('admin.audit.filters.to' as never)} />
            <Button variant="outline" size="icon" onClick={reset} disabled={!hasFilters} title={t('admin.audit.filters.reset' as never)}>
              <RotateCcw className="w-4 h-4" />
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Table */}
      <Card className="bg-card border-border">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4"><SkeletonTable rows={8} columns={6} /></div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="border-border">
                  <TableHead className="text-muted-foreground w-[170px]">{t('admin.common.time' as never)}</TableHead>
                  <TableHead className="text-muted-foreground">{t('admin.common.action' as never)}</TableHead>
                  <TableHead className="text-muted-foreground">{t('admin.audit.entity' as never)}</TableHead>
                  <TableHead className="text-muted-foreground">{t('admin.common.user' as never)}</TableHead>
                  <TableHead className="text-muted-foreground">{t('admin.audit.columns.workspace' as never)}</TableHead>
                  <TableHead className="text-muted-foreground w-[120px]">{t('admin.audit.columns.ip' as never)}</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-muted-foreground py-10">
                      <FileText className="w-6 h-6 mx-auto mb-2 opacity-60" />
                      {t('admin.audit.empty' as never)}
                    </TableCell>
                  </TableRow>
                )}
                {logs.map((l: AdminAuditLogRow) => {
                  const open = expanded === l.id;
                  const hasDiff = !!(l.old_value || l.new_value);
                  return (
                    <Fragment key={l.id}>
                      <TableRow
                        className="border-border hover:bg-muted/50 cursor-pointer"
                        onClick={() => setExpanded(open ? null : l.id)}
                      >
                        <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                          {formatDateTime(l.created_at, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={`text-xs ${actionTone(l.action)}`}>{humanize(l.action)}</Badge>
                        </TableCell>
                        <TableCell className="text-sm text-foreground/90">
                          {humanize(l.entity_type)}
                          {l.entity_id && <span className="ms-1 text-[11px] font-mono text-muted-foreground" dir="ltr">{l.entity_id.slice(0, 8)}</span>}
                        </TableCell>
                        <TableCell className="text-sm">
                          {l.actor_email ? (
                            <span className="text-foreground" dir="ltr">{l.actor_email}</span>
                          ) : (
                            <span className="text-muted-foreground text-xs font-mono" dir="ltr">{l.user_id?.slice(0, 8) ?? '—'}</span>
                          )}
                          {l.actor_name && <span className="block text-[11px] text-muted-foreground">{l.actor_name}</span>}
                        </TableCell>
                        <TableCell className="text-sm text-foreground/80">
                          {l.workspace_name || (l.workspace_id ? <span className="font-mono text-xs text-muted-foreground" dir="ltr">{l.workspace_id.slice(0, 8)}</span> : '—')}
                        </TableCell>
                        <TableCell className="text-xs font-mono text-muted-foreground" dir="ltr">{l.ip_address || '—'}</TableCell>
                        <TableCell>
                          {hasDiff && <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`} />}
                        </TableCell>
                      </TableRow>
                      {open && hasDiff && (
                        <TableRow className="border-border bg-muted/20 hover:bg-muted/20">
                          <TableCell colSpan={7}>
                            <div className="flex flex-col md:flex-row gap-4 py-2">
                              <DiffBlock label={t('admin.audit.before' as never)} value={l.old_value} />
                              <DiffBlock label={t('admin.audit.after' as never)} value={l.new_value} />
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Pagination */}
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">
          {t('admin.audit.resultCount' as never, { count: total })}{isFetching ? ' …' : ''}
        </span>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
            <ChevronRight className="w-4 h-4 rtl:block hidden" /><ChevronLeft className="w-4 h-4 rtl:hidden" />
          </Button>
          <span className="text-muted-foreground">{t('admin.audit.pageOf' as never, { current: page + 1, total: pageCount })}</span>
          <Button variant="outline" size="sm" disabled={page + 1 >= pageCount} onClick={() => setPage((p) => p + 1)}>
            <ChevronLeft className="w-4 h-4 rtl:block hidden" /><ChevronRight className="w-4 h-4 rtl:hidden" />
          </Button>
        </div>
      </div>
    </div>
  );
}
