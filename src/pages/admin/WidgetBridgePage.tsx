import { useState } from 'react';
import { useWorkspaces } from '@/hooks/useWorkspace';
import { useAuth } from '@/features/auth/AuthContext';
import { useTranslation } from '@/i18n';
import { WidgetBridgeSettingsPanel } from '@/features/widget-bridge/SettingsPanel';

export default function AdminWidgetBridgePage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const workspaces = useWorkspaces();
  const [selected, setSelected] = useState('');
  const owned = (workspaces.data || []).filter(workspace => workspace.owner_id === user?.id);
  const workspace = owned.find(value => value.id === selected) || owned[0];
  return <div className="mx-auto max-w-5xl space-y-6 p-4 md:p-6">
    <div><h1 className="text-2xl font-bold">{t('widgetBridge.title')}</h1><p className="mt-1 text-sm text-muted-foreground">{t('widgetBridge.adminOnly')}</p></div>
    <label className="block space-y-2"><span className="text-sm font-medium">{t('widgetBridge.workspace')}</span>
      <select className="h-10 w-full rounded-md border bg-background px-3" value={workspace?.id || ''} onChange={event => setSelected(event.target.value)}>
        {owned.map(value => <option key={value.id} value={value.id}>{value.name}</option>)}
      </select>
    </label>
    {workspaces.isPending ? <p>{t('widgetBridge.loading')}</p> : !workspace ? <p>{t('widgetBridge.noWorkspace')}</p>
      : <WidgetBridgeSettingsPanel key={workspace.id} workspaceId={workspace.id} slug={workspace.slug} />}
  </div>;
}
