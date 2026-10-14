import { useEffect, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation, type TranslationKey } from '@/i18n';
import { useAuth } from '@/features/auth/AuthContext';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { bridgeRequest } from './api';
import type { BridgeBatch, BridgeBatchItem } from '../../../shared/widgetBridge';

export function BatchPanel({ workspaceId, enabled, followup }: { workspaceId: string; enabled: boolean; followup?: { urls: string[] } | null }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const qc = useQueryClient();
  const [sites, setSites] = useState('');
  const [body, setBody] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const requestId = useRef<string | null>(null);
  useEffect(() => { if (followup) { setSites(followup.urls.join('\n')); requestId.current = null; } }, [followup]);
  const urls = [...new Set(sites.split(/\r?\n/).map(url => url.trim()).filter(Boolean).map(url => {
    const value = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    try { const parsed = new URL(value); parsed.hash = ''; return parsed.toString(); } catch { return value; }
  }))];
  const queryKey = ['widget-bridge-batches', user?.id, workspaceId];
  const batches = useQuery({ queryKey, queryFn: () => bridgeRequest<{ batches: BridgeBatch[] }>(workspaceId, '/batches'), refetchInterval: 5000 });
  const items = useQuery({ queryKey: [...queryKey, selected], enabled: !!selected,
    queryFn: () => bridgeRequest<{ items: BridgeBatchItem[] }>(workspaceId, `/batches/${selected}`), refetchInterval: 5000 });
  const invalidate = () => { void qc.invalidateQueries({ queryKey }); void qc.invalidateQueries({ queryKey: ['widget-bridge-contacts'] }); };
  const start = useMutation({ mutationFn: () => {
    requestId.current ||= crypto.randomUUID();
    return bridgeRequest<{ batch: { id: string } }>(workspaceId, '/batches', 'POST', { urls, body, clientBatchId: requestId.current });
  }, onSuccess: result => { setSelected(result.batch.id); setSites(''); requestId.current = null; invalidate(); } });
  const stop = useMutation({ mutationFn: (id: string) => bridgeRequest(workspaceId, `/batches/${id}`, 'DELETE'), onSuccess: invalidate });
  const resume = useMutation({ mutationFn: (batch: BridgeBatch) => bridgeRequest(workspaceId, `/batches/${batch.id}/continue`, 'POST', { reviewVersion: batch.review_version }), onSuccess: invalidate });
  const active = batches.data?.batches.some(batch => batch.status === 'running' || batch.status === 'paused');
  const error = start.error || stop.error || resume.error || batches.error || items.error;
  return <section className="space-y-4 rounded-xl border p-5">
    <h2 className="font-semibold">{t('widgetBridge.batch.title')}</h2>
    <p className="text-sm text-muted-foreground">{t('widgetBridge.batch.description')}</p>
    <div className="space-y-2"><Label htmlFor="bridge-batch-sites">{t('widgetBridge.batch.sites')}</Label>
      <textarea id="bridge-batch-sites" dir="ltr" rows={7} maxLength={1024000} className="w-full rounded-md border bg-background p-3 text-sm"
        value={sites} disabled={start.isPending} onChange={event => { setSites(event.target.value); requestId.current = null; }} />
      <p className="text-xs text-muted-foreground">{t('widgetBridge.batch.count')}: {urls.length} / 500</p>
    </div>
    <div className="space-y-2"><Label htmlFor="bridge-batch-body">{t('widgetBridge.batch.message')}</Label>
      <textarea id="bridge-batch-body" rows={4} maxLength={2000} className="w-full rounded-md border bg-background p-3 text-sm"
        value={body} disabled={start.isPending} onChange={event => { setBody(event.target.value); requestId.current = null; }} />
    </div>
    <Button disabled={!enabled || active || start.isPending || !urls.length || urls.length>500 || !body.trim()}
      onClick={() => start.mutate()}>{t('widgetBridge.batch.start')}</Button>
    {active && <p className="text-sm text-muted-foreground">{t('widgetBridge.batch.activeNotice')}</p>}
    {error && <p role="alert" className="text-sm text-destructive">{t('widgetBridge.batch.error')}</p>}
    <div className="space-y-3">
      {batches.data?.batches.map(batch => <div key={batch.id} className="rounded-lg border p-3">
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="ghost" className="max-w-full truncate" onClick={() => setSelected(batch.id)}>{batch.body.slice(0,60)}</Button>
          <span className="text-sm">{t(`widgetBridge.batch.${batch.status}`)}</span>
          {batch.status==='paused' && <Button disabled={resume.isPending || !enabled} onClick={() => resume.mutate(batch)}>{t('widgetBridge.pacing.continue')}</Button>}
          {(batch.status==='running' || batch.status==='paused') && <Button variant="destructive" disabled={stop.isPending} onClick={() => stop.mutate(batch.id)}>{t('widgetBridge.batch.stop')}</Button>}
        </div>
        <p className="text-xs text-muted-foreground">{t('widgetBridge.pacing.roundSize')}: {batch.round_size} · {t('widgetBridge.pacing.interval')}: {batch.interval_seconds}</p>
        {batch.status==='paused' && <p className="my-2 text-sm">{t('widgetBridge.pacing.review')}</p>}
        <p className="text-xs text-muted-foreground">{t('widgetBridge.batch.count')}: {batch.total} · {t('widgetBridge.delivery.sent')}: {batch.sent} · {t('widgetBridge.delivery.queued')}: {batch.pending} · {t('widgetBridge.delivery.failed')}: {batch.failed} · {t('widgetBridge.delivery.uncertain')}: {batch.uncertain} · {t('widgetBridge.batch.skipped')}: {batch.skipped}</p>
      </div>)}
    </div>
    {selected && <div className="max-h-80 overflow-auto rounded-lg border">
      {items.data?.items.map(item => <div key={item.position} className="flex flex-wrap justify-between gap-2 border-b p-3 text-xs">
        <span dir="ltr">{item.position}. {item.url}</span>
        <span>{t((item.delivery==='skipped' ? 'widgetBridge.batch.skipped' : `widgetBridge.delivery.${item.delivery}`) as TranslationKey)}</span>
        {item.error && <span>{t('widgetBridge.batch.review')}</span>}
      </div>)}
    </div>}
  </section>;
}
