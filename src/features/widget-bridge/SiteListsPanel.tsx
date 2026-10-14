import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/features/auth/AuthContext';
import { useTranslation } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { bridgeRequest } from './api';
import { bridgeProviders, bridgeListDraft, normalizeBridgeUrls, type BridgeListKey, type BridgeSiteLists, type BridgeSiteList, type BridgeBatchDraft } from '../../../shared/widgetBridge';

export function SiteListsPanel({ workspaceId, onPrepare }: { workspaceId: string; onPrepare: (draft: BridgeBatchDraft) => void }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const qc = useQueryClient();
  const queryKey = ['widget-bridge-site-lists', user?.id, workspaceId];
  const query = useQuery({ queryKey, queryFn: () => bridgeRequest<{ lists: BridgeSiteLists }>(workspaceId, '/site-lists') });
  const [key, setKey] = useState<BridgeListKey>('goftino');
  const [drafts, setDrafts] = useState<Partial<Record<BridgeListKey, { text: string; includeShared: boolean }>>>({});
  const lists = query.data?.lists || {};
  const value = drafts[key] || { text: (lists[key]?.urls || []).join('\n'), includeShared: lists[key]?.includeShared || false };
  let urls: string[] = [];
  let valid = true;
  try { urls = normalizeBridgeUrls(value.text.split(/\r?\n/)); } catch { valid = false; }
  const entry = { urls, includeShared: key !== 'shared' && value.includeShared };
  const preview = bridgeListDraft({ ...lists, [key]: entry }, key);
  const dirty = !!drafts[key] || (entry.includeShared && !!drafts.shared);
  const save = useMutation({
    mutationFn: (input: { key: BridgeListKey; entry: BridgeSiteList }) => bridgeRequest<{ list: BridgeSiteList }>(workspaceId, `/site-lists/${input.key}`, 'PUT', input.entry),
    onSuccess: (result, input) => {
      qc.setQueryData<{ lists: BridgeSiteLists }>(queryKey, old => ({ lists: { ...old?.lists, [input.key]: result.list } }));
      setDrafts(old => { const next = { ...old }; delete next[input.key]; return next; });
    },
  });
  return <section className="space-y-4 rounded-xl border p-5">
    <h2 className="font-semibold">{t('widgetBridge.lists.title')}</h2>
    <p className="text-sm text-muted-foreground">{t('widgetBridge.lists.help')}</p>
    <Label htmlFor="bridge-list-provider">{t('widgetBridge.lists.select')}</Label>
    <select id="bridge-list-provider" className="h-10 w-full rounded-md border bg-background px-3" value={key} disabled={save.isPending}
      onChange={event => { setKey(event.target.value as BridgeListKey); save.reset(); }}>
      <option value="shared">{t('widgetBridge.lists.shared')}</option>
      {bridgeProviders.map(provider => <option key={provider} value={provider}>{provider === 'custom' ? t('widgetBridge.custom') : provider === 'webyar' ? 'WebYar / RESPOK' : provider === 'goftino' ? 'Goftino' : provider === 'crisp' ? 'Crisp' : 'Raychat'}</option>)}
    </select>
    <Label htmlFor="bridge-saved-sites">{t('widgetBridge.lists.sites')}</Label>
    <textarea id="bridge-saved-sites" dir="ltr" rows={6} maxLength={1024000} className="w-full rounded-md border bg-background p-3 text-sm"
      disabled={query.isPending || !!query.error || save.isPending} value={value.text}
      onChange={event => { save.reset(); setDrafts(old => ({ ...old, [key]: { ...value, text: event.target.value } })); }} />
    {key !== 'shared' && <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={value.includeShared} disabled={query.isPending || !!query.error || save.isPending}
        onChange={event => { save.reset(); setDrafts(old => ({ ...old, [key]: { ...value, includeShared: event.target.checked } })); }} />
      {t('widgetBridge.lists.includeShared')}
    </label>}
    <p className="text-sm">{t('widgetBridge.lists.total')}: {preview.urls.length} / 500</p>
    {preview.urls.length > 500 && <p role="alert" className="text-sm text-destructive">{t('widgetBridge.lists.limit')}</p>}
    <div className="flex flex-wrap gap-3">
      <Button disabled={!valid || urls.length > 500 || query.isPending || !!query.error || save.isPending} onClick={() => save.mutate({ key, entry })}>{t('widgetBridge.lists.save')}</Button>
      <Button variant="outline" disabled={!valid || dirty || query.isPending || !!query.error || save.isPending || !preview.urls.length || preview.urls.length > 500}
        onClick={() => onPrepare(bridgeListDraft(lists, key))}>{t('widgetBridge.lists.prepare')}</Button>
    </div>
    <p className="text-xs text-muted-foreground">{t('widgetBridge.lists.review')}</p>
    {save.isSuccess && <p role="status" className="text-sm text-success">{t('widgetBridge.lists.saved')}</p>}
    {(!valid || save.error || query.error) && <p role="alert" className="text-sm text-destructive">{t('widgetBridge.lists.error')}</p>}
  </section>;
}
