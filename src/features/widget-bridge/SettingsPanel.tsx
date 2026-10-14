import { useEffect, useState } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation, type TranslationKey } from '@/i18n';
import { useAuth } from '@/features/auth/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { AlertCircle, Loader2, Trash2, ExternalLink, Settings2 } from 'lucide-react';
import { useBridgeSettings } from './hooks';
import { bridgeRequest, type BridgeContact, type BridgeSettings, type BridgeProvider, type BridgeSelectors } from './api';

export function BridgeErrorNotice({ error }: { error: unknown }) {
  const { t } = useTranslation();
  const code = error instanceof Error ? error.message : 'bridge_unavailable';
  const known = ['bridge_unavailable','bridge_database_must_be_separate','bridge_workspace_forbidden',
    'invalid_contact','save_settings_or_duplicate_site','bridge_disabled_or_queue_full','public_https_required','invalid_settings'];
  const key = known.includes(code) ? code : 'bridge_unavailable';
  return <p role="alert" className="flex items-start gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />{t(`widgetBridge.errors.${key}` as TranslationKey)}
  </p>;
}

const selectorFields: Array<keyof BridgeSelectors> = ['frame','root','launcher','start','name','email','phone','formSubmit','composer','send','inbound','outbound','messageIdAttribute'];

export function WidgetBridgeSettingsPanel({ workspaceId, slug }: { workspaceId: string; slug: string }) {
  const { t, dir } = useTranslation();
  const { user } = useAuth();
  const qc = useQueryClient();
  const settings = useBridgeSettings(workspaceId);
  const [form, setForm] = useState<BridgeSettings>({ enabled: false, identity: { name: '', email: '', phone: '' } });
  const [dirty, setDirty] = useState(false);
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [provider, setProvider] = useState<BridgeProvider>('auto');
  const [selectors, setSelectors] = useState<BridgeSelectors>({});
  const [advanced, setAdvanced] = useState(false);
  useEffect(() => {
    if (settings.data && !dirty) setForm({
      enabled: settings.data.settings.enabled,
      identity: { name: '', email: '', phone: '', ...settings.data.settings.identity },
    });
  }, [settings.data, dirty]);
  const contacts = useQuery({
    queryKey: ['widget-bridge-contacts', user?.id, workspaceId],
    queryFn: () => bridgeRequest<{ contacts: BridgeContact[] }>(workspaceId, '/contacts'),
    enabled: !!settings.data, retry: false, refetchInterval: 10000,
  });
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['widget-bridge-settings'] });
    void qc.invalidateQueries({ queryKey: ['widget-bridge-contacts'] });
  };
  const save = useMutation({
    mutationFn: () => bridgeRequest(workspaceId, '/settings', 'PUT', form),
    onSuccess: () => { setDirty(false); invalidate(); },
  });
  const create = useMutation({
    mutationFn: () => bridgeRequest(workspaceId, '/contacts', 'POST', {
      url, ...(name.trim() ? { name: name.trim() } : {}), provider, selectors, enabled: true,
    }),
    onSuccess: () => { setUrl(''); setName(''); setSelectors({}); invalidate(); },
  });
  const change = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => bridgeRequest(workspaceId, `/contacts/${id}`, 'PATCH', { enabled }),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => bridgeRequest(workspaceId, `/contacts/${id}`, 'DELETE'),
    onSuccess: invalidate,
  });
  const purge = useMutation({
    mutationFn: () => bridgeRequest(workspaceId, '/settings', 'DELETE'),
    onSuccess: () => { setDirty(false); invalidate(); },
  });
  if (settings.isPending) return <p className="p-4"><Loader2 className="h-5 w-5 animate-spin" /></p>;
  if (settings.error) return <BridgeErrorNotice error={settings.error} />;
  return <div className="space-y-6" dir={dir}>
    <div className="rounded-xl border p-5">
      <p className="mb-4 text-sm text-muted-foreground">{t('widgetBridge.description')}</p>
      <div className="flex items-center gap-3">
        <Switch id="bridge-enabled" checked={form.enabled} onCheckedChange={enabled => { setDirty(true); setForm({ ...form, enabled }); }} />
        <Label htmlFor="bridge-enabled">{t('widgetBridge.enabled')}</Label>
      </div>
      <div className="mt-5 grid gap-4 sm:grid-cols-3">
        {(['name','email','phone'] as const).map(field => <div key={field} className="space-y-2">
          <Label htmlFor={`bridge-identity-${field}`}>{t(`widgetBridge.identity.${field}`)}</Label>
          <Input id={`bridge-identity-${field}`} type={field === 'email' ? 'email' : 'text'}
            value={form.identity[field]} maxLength={field === 'name' ? 200 : field === 'email' ? 254 : 40}
            onChange={event => { setDirty(true); setForm({ ...form, identity: { ...form.identity, [field]: event.target.value } }); }} />
        </div>)}
      </div>
      <p className="mt-3 text-xs text-muted-foreground">{t('widgetBridge.settingsChangeNotice')}</p>
      <Button className="mt-4" disabled={save.isPending || !form.identity.name.trim()} onClick={() => save.mutate()}>{t('widgetBridge.save')}</Button>
      {save.isSuccess && !dirty && <p role="status" className="mt-2 text-sm text-success">{t('widgetBridge.saved')}</p>}
      {save.error && <BridgeErrorNotice error={save.error} />}
    </div>
    <form className="space-y-4 rounded-xl border p-5" onSubmit={event => { event.preventDefault(); create.mutate(); }}>
      <h2 className="font-semibold">{t('widgetBridge.addSite')}</h2>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2"><Label htmlFor="bridge-url">{t('widgetBridge.siteUrl')}</Label>
          <Input id="bridge-url" dir="ltr" type="url" placeholder="https://example.com" required value={url} maxLength={2048} onChange={event => setUrl(event.target.value)} /></div>
        <div className="space-y-2"><Label htmlFor="bridge-site-name">{t('widgetBridge.siteName')}</Label>
          <Input id="bridge-site-name" value={name} maxLength={200} onChange={event => setName(event.target.value)} placeholder={t('widgetBridge.domainDefault')} /></div>
      </div>
      <div className="space-y-2"><Label htmlFor="bridge-provider">{t('widgetBridge.provider')}</Label>
        <select id="bridge-provider" className="h-10 w-full rounded-md border bg-background px-3" value={provider}
          onChange={event => { const value = event.target.value as BridgeProvider; setProvider(value); setAdvanced(value === 'custom'); }}>
          <option value="auto">{t('widgetBridge.auto')}</option><option value="webyar">WebYar / RESPOK</option>
          <option value="crisp">Crisp</option><option value="raychat">Raychat</option><option value="custom">{t('widgetBridge.custom')}</option>
        </select>
        <p className="text-xs text-muted-foreground">{t('widgetBridge.supported')}</p>
      </div>
      <Button type="button" variant="ghost" onClick={() => setAdvanced(!advanced)}><Settings2 className="me-2 h-4 w-4" />{t('widgetBridge.advanced')}</Button>
      {advanced && <div className="grid gap-3 rounded-lg bg-muted/30 p-4 sm:grid-cols-2">
        <p className="text-xs text-muted-foreground sm:col-span-2">{t('widgetBridge.selectorsHelp')}</p>
        {selectorFields.map(field => <div key={field} className="space-y-1">
          <Label htmlFor={`bridge-selector-${field}`}>{t(`widgetBridge.selectors.${field}`)}</Label>
          <Input id={`bridge-selector-${field}`} dir="ltr" value={selectors[field] || ''} maxLength={300}
            onChange={event => setSelectors(current => { const next = { ...current }; if (event.target.value) next[field] = event.target.value; else delete next[field]; return next; })} />
        </div>)}
      </div>}
      <Button type="submit" disabled={create.isPending || !settings.data || !settings.data.settings.identity.name}>{t('widgetBridge.addSite')}</Button>
      {create.error && <BridgeErrorNotice error={create.error} />}
    </form>
    <div className="rounded-xl border p-5">
      <div className="mb-4 flex items-center justify-between gap-3"><h2 className="font-semibold">{t('widgetBridge.sites')}</h2>
        <Button variant="outline" asChild><Link to={`/${slug}/inbox/widget-bridge`}>{t('widgetBridge.openInbox')}<ExternalLink className="ms-2 h-4 w-4" /></Link></Button>
      </div>
      {contacts.error && <BridgeErrorNotice error={contacts.error} />}
      {!contacts.data?.contacts.length && <p className="text-sm text-muted-foreground">{t('widgetBridge.empty')}</p>}
      {contacts.data?.contacts.map(contact => <div key={contact.id} className="flex flex-wrap items-center gap-3 border-t py-3">
        <div className="min-w-0 flex-1"><p className="truncate font-medium">{contact.name}</p><p dir="ltr" className="truncate text-xs text-muted-foreground">{contact.url}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t(`widgetBridge.status.${contact.status}` as TranslationKey)}</p></div>
        <Switch aria-label={t('widgetBridge.toggleSite')} disabled={change.isPending || contact.deleting} checked={contact.enabled}
          onCheckedChange={enabled => change.mutate({ id: contact.id, enabled })} />
        <Button variant="ghost" size="icon" disabled={remove.isPending || contact.deleting} aria-label={t('widgetBridge.deleteSite')}
          onClick={() => { if (window.confirm(t('widgetBridge.deleteConfirm'))) remove.mutate(contact.id); }}><Trash2 className="h-4 w-4 text-destructive" /></Button>
      </div>)}
      {(change.error || remove.error) && <BridgeErrorNotice error={change.error || remove.error} />}
      <p className="mt-3 text-xs text-muted-foreground">{t('widgetBridge.isolation')}</p>
      <Button variant="destructive" className="mt-4" disabled={purge.isPending}
        onClick={() => { if (window.confirm(t('widgetBridge.purgeConfirm'))) purge.mutate(); }}>{t('widgetBridge.purge')}</Button>
      {purge.error && <BridgeErrorNotice error={purge.error} />}
    </div>
  </div>;
}
