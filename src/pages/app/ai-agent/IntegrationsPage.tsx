import { useState, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { aiAgentApi, type ToolRecord, type ToolServerRecord } from '@/lib/ai-agent-api';
import { useTranslation, type TranslationKey } from '@/i18n';
import { AiPageHeader } from '@/components/ai-agent/AiPageHeader';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/components/ui/use-toast';
import { Plug, ShieldAlert, Loader2, Trash2, Beaker, Lock } from 'lucide-react';

type Translate = ReturnType<typeof useTranslation>['t'];
type ToolPatch = Partial<ToolRecord> & { confirm_high_risk?: boolean };
type NewToolInput = Partial<ToolRecord> & { name: string; tool_type: ToolRecord['tool_type'] };

// The codes the server sends, shown as words; a code not listed here shows as it is.
const TYPE: Record<string, TranslationKey> = {
  internal: 'aiAgent.integrations.type.internal',
  mcp: 'aiAgent.integrations.type.mcp',
  webhook: 'aiAgent.integrations.type.webhook',
  crm: 'aiAgent.integrations.type.crm',
  ticket: 'aiAgent.integrations.type.ticket',
};
const RISK: Record<string, TranslationKey> = {
  medium: 'aiAgent.integrations.risk.medium',
  high: 'aiAgent.integrations.risk.high',
};
const STATUS: Record<string, TranslationKey> = {
  enabled: 'aiAgent.integrations.status.enabled',
  disabled: 'aiAgent.integrations.status.disabled',
  error: 'aiAgent.integrations.status.error',
};
const AUTH: Record<string, TranslationKey> = {
  bearer: 'aiAgent.integrations.authType.bearer',
  basic: 'aiAgent.integrations.authType.basic',
  api_key: 'aiAgent.integrations.authType.api_key',
  oauth: 'aiAgent.integrations.authType.oauth',
};
const LAST_ERROR: Record<string, TranslationKey> = {
  validation_failed: 'aiAgent.integrations.lastError.validation_failed',
};
const ERROR: Record<string, TranslationKey> = {
  owner_or_admin_required: 'aiAgent.integrations.error.owner_or_admin_required',
  high_risk_confirmation_required: 'aiAgent.integrations.error.high_risk_confirmation_required',
  invalid_params: 'aiAgent.integrations.error.invalid_params',
  not_found: 'aiAgent.integrations.error.not_found',
  network_error: 'aiAgent.integrations.error.network_error',
};
// The built-in tools' descriptions (server/services/ai-agent/overview.ts
// DEFAULT_INTERNAL_TOOLS), shown in the panel's language while a tool keeps
// the description it was added with.
const INTERNAL_TOOL: Record<string, TranslationKey> = {
  search_kb: 'aiAgent.integrations.internalTool.search_kb',
  handoff_to_operator: 'aiAgent.integrations.internalTool.handoff_to_operator',
  create_ticket: 'aiAgent.integrations.internalTool.create_ticket',
  get_business_hours: 'aiAgent.integrations.internalTool.get_business_hours',
  get_pricing_info: 'aiAgent.integrations.internalTool.get_pricing_info',
  add_internal_note: 'aiAgent.integrations.internalTool.add_internal_note',
  mark_priority: 'aiAgent.integrations.internalTool.mark_priority',
  assign_team: 'aiAgent.integrations.internalTool.assign_team',
};

function keyFor(map: Record<string, TranslationKey>, code: string | null | undefined): TranslationKey | undefined {
  return code && Object.prototype.hasOwnProperty.call(map, code) ? map[code] : undefined;
}

function codeLabel(t: Translate, map: Record<string, TranslationKey>, code: string): string {
  const key = keyFor(map, code);
  return key ? t(key) : code;
}

/** A refused request's message (the server's code), in words when it is a known one. */
function errorText(t: Translate, e: unknown): string | undefined {
  const message = (e as { message?: string } | null)?.message;
  return message ? codeLabel(t, ERROR, message) : message;
}

/** A translated sentence whose {{name}} spot holds an element (a code, a button's name). */
function withSlot(text: string, name: string, slot: ReactNode): ReactNode {
  const marker = `{{${name}}}`;
  const at = text.indexOf(marker);
  if (at < 0) return <>{text} {slot}</>;
  return <>{text.slice(0, at)}{slot}{text.slice(at + marker.length)}</>;
}

export default function IntegrationsPage() {
  const { workspace } = useActiveWorkspace();
  const wsId = workspace?.id;
  const qc = useQueryClient();
  const { toast } = useToast();
  const { t } = useTranslation();

  const tools = useQuery({ queryKey: ['ai-tools', wsId], queryFn: () => aiAgentApi.listTools(wsId!), enabled: !!wsId });
  const servers = useQuery({ queryKey: ['ai-tool-servers', wsId], queryFn: () => aiAgentApi.listToolServers(wsId!), enabled: !!wsId });

  const refreshAll = () => {
    qc.invalidateQueries({ queryKey: ['ai-tools', wsId] });
    qc.invalidateQueries({ queryKey: ['ai-tool-servers', wsId] });
  };

  const updateTool = useMutation({
    mutationFn: (vars: { id: string; patch: ToolPatch }) => aiAgentApi.updateTool(vars.id, vars.patch),
    onSuccess: () => { refreshAll(); toast({ title: t('aiAgent.integrations.toast.toolUpdated') }); },
    onError: (e) => toast({ title: t('aiAgent.integrations.toast.updateFailed'), description: errorText(t, e), variant: 'destructive' }),
  });
  const deleteTool = useMutation({
    mutationFn: (id: string) => aiAgentApi.deleteTool(id),
    onSuccess: () => { refreshAll(); toast({ title: t('aiAgent.integrations.toast.toolRemoved') }); },
  });
  const createTool = useMutation({
    mutationFn: (input: NewToolInput) => aiAgentApi.createTool({ workspaceId: wsId!, ...input }),
    onSuccess: () => { refreshAll(); toast({ title: t('aiAgent.integrations.toast.toolAdded') }); },
    onError: (e) => toast({ title: t('aiAgent.integrations.toast.failed'), description: errorText(t, e), variant: 'destructive' }),
  });

  const seedInternal = async () => {
    const list = tools.data?.defaultInternalTools || [];
    const existing = new Set((tools.data?.items || []).filter((tool) => tool.tool_type === 'internal').map((tool) => tool.name));
    let added = 0;
    for (const d of list) {
      if (existing.has(d.name)) continue;
      try {
        await aiAgentApi.createTool({ workspaceId: wsId!, name: d.name, description: d.description, tool_type: 'internal', risk_level: d.risk_level, enabled: false });
        added++;
      } catch { /* keep going */ }
    }
    refreshAll();
    toast({ title: t('aiAgent.integrations.internal.seeded', { count: added }) });
  };

  const defaultDescriptions = new Map((tools.data?.defaultInternalTools || []).map((d) => [d.name, d.description]));
  const internalTools = (tools.data?.items || []).filter((tool) => tool.tool_type === 'internal');
  const mcpServers = (servers.data?.items || []).filter((s) => s.server_type === 'mcp');
  const webhookTools = (tools.data?.items || []).filter((tool) => tool.tool_type === 'webhook');

  return (
    <div className="space-y-6">
      <AiPageHeader icon={Plug} accent="emerald" title={t('aiAgent.integrations.title')} subtitle={t('aiAgent.integrations.subtitle')} />

      <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm flex items-start gap-2.5">
        <ShieldAlert className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
        <div>
          <p className="font-medium">{t('aiAgent.integrations.notice.title')}</p>
          <p className="text-muted-foreground text-xs mt-0.5">
            {t('aiAgent.integrations.notice.body')}
          </p>
        </div>
      </div>

      {/* Internal tools */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-base">{t('aiAgent.integrations.internal.title')}</CardTitle>
            <CardDescription>{t('aiAgent.integrations.internal.desc')}</CardDescription>
          </div>
          {internalTools.length === 0 && (
            <Button size="sm" onClick={seedInternal} disabled={!wsId}>{t('aiAgent.integrations.internal.addDefaults')}</Button>
          )}
        </CardHeader>
        <CardContent>
          {tools.isLoading ? (
            <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          ) : internalTools.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {withSlot(t('aiAgent.integrations.internal.empty'), 'action', <em className="rtl:not-italic">{t('aiAgent.integrations.internal.addDefaults')}</em>)}
            </p>
          ) : (
            <div className="divide-y">
              {internalTools.map((tool) => (
                <ToolRow key={tool.id} tool={tool} defaultDescription={defaultDescriptions.get(tool.name)} onToggle={(enabled, confirm_high_risk) => updateTool.mutate({ id: tool.id, patch: { enabled, confirm_high_risk } })} onDelete={() => deleteTool.mutate(tool.id)} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* MCP servers */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('aiAgent.integrations.mcp.title')}</CardTitle>
          <CardDescription>{t('aiAgent.integrations.mcp.desc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <NewServerForm onCreate={(input) => aiAgentApi.createToolServer({ workspaceId: wsId!, server_type: 'mcp', ...input }).then(() => refreshAll())} />
          {servers.isLoading ? (
            <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          ) : mcpServers.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('aiAgent.integrations.mcp.empty')}</p>
          ) : (
            <div className="divide-y">
              {mcpServers.map((s) => <ServerRow key={s.id} server={s} onChange={refreshAll} />)}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Webhook tools */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('aiAgent.integrations.webhook.title')}</CardTitle>
          <CardDescription>{t('aiAgent.integrations.webhook.desc')}</CardDescription>
        </CardHeader>
        <CardContent>
          <NewWebhookToolForm onCreate={(input) => createTool.mutate(input)} />
          {webhookTools.length > 0 && (
            <div className="divide-y mt-4">
              {webhookTools.map((tool) => (
                <ToolRow key={tool.id} tool={tool} onToggle={(enabled, confirm_high_risk) => updateTool.mutate({ id: tool.id, patch: { enabled, confirm_high_risk } })} onDelete={() => deleteTool.mutate(tool.id)} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Security */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><Lock className="h-4 w-4" /> {t('aiAgent.integrations.security.title')}</CardTitle>
          <CardDescription>{t('aiAgent.integrations.security.desc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>• {t('aiAgent.integrations.security.credentials')}</p>
          <p>• {t('aiAgent.integrations.security.highRisk')}</p>
          <p>• {withSlot(t('aiAgent.integrations.security.runtime'), 'flag', <code dir="ltr" className="px-1 py-0.5 rounded bg-muted text-xs">AI_AGENT_MCP_TEST_ENABLED=1</code>)}</p>
          <p>• {t('aiAgent.integrations.security.roles')}</p>
        </CardContent>
      </Card>
    </div>
  );
}

function ToolRow({ tool, defaultDescription, onToggle, onDelete }: { tool: ToolRecord; defaultDescription?: string; onToggle: (enabled: boolean, confirmHighRisk?: boolean) => void; onDelete: () => void }) {
  const { t } = useTranslation();
  // A built-in tool still carrying the description it was added with reads it in the panel's language.
  const builtIn = tool.tool_type === 'internal' && defaultDescription !== undefined && tool.description === defaultDescription
    ? keyFor(INTERNAL_TOOL, tool.name)
    : undefined;
  const description = builtIn ? t(builtIn) : tool.description;
  const handleToggle = (next: boolean) => {
    if (next && tool.risk_level === 'high') {
      const ok = window.confirm(t('aiAgent.integrations.tool.confirmHighRisk', { name: tool.name }));
      if (!ok) return;
      onToggle(true, true);
    } else {
      onToggle(next);
    }
  };
  return (
    <div className="py-3 flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium truncate">{tool.name}</p>
          <Badge variant="outline" className="text-[10px]">{codeLabel(t, TYPE, tool.tool_type)}</Badge>
          {tool.risk_level !== 'low' && (
            <Badge variant={tool.risk_level === 'high' ? 'destructive' : 'secondary'} className="text-[10px]">{codeLabel(t, RISK, tool.risk_level)}</Badge>
          )}
        </div>
        {description && <p className="text-xs text-muted-foreground mt-0.5 truncate">{description}</p>}
      </div>
      <Switch checked={tool.enabled} onCheckedChange={handleToggle} aria-label={t('aiAgent.integrations.tool.enable', { name: tool.name })} />
      <Button variant="ghost" size="icon" onClick={onDelete} aria-label={t('aiAgent.integrations.tool.remove', { name: tool.name })} title={t('aiAgent.integrations.tool.remove', { name: tool.name })}><Trash2 className="h-4 w-4 text-muted-foreground" /></Button>
    </div>
  );
}

function NewServerForm({ onCreate }: { onCreate: (input: { name: string; endpoint_url: string; auth_type: ToolServerRecord['auth_type'] }) => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [auth, setAuth] = useState<'none' | 'bearer' | 'api_key'>('none');
  return (
    <div className="grid grid-cols-1 sm:grid-cols-[1fr_2fr_140px_auto] gap-2 items-end">
      <div>
        <Label className="text-xs">{t('aiAgent.integrations.form.name')}</Label>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('aiAgent.integrations.form.namePlaceholder')} />
      </div>
      <div>
        <Label className="text-xs">{t('aiAgent.integrations.form.endpoint')}</Label>
        <Input dir="ltr" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com" />
      </div>
      <div>
        <Label className="text-xs">{t('aiAgent.integrations.form.auth')}</Label>
        <Select value={auth} onValueChange={(v) => setAuth(v as typeof auth)}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="none">{t('aiAgent.integrations.form.authNone')}</SelectItem>
            <SelectItem value="bearer">{t('aiAgent.integrations.form.authBearer')}</SelectItem>
            <SelectItem value="api_key">{t('aiAgent.integrations.form.authApiKey')}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <Button disabled={!name || !url} onClick={() => { onCreate({ name, endpoint_url: url, auth_type: auth }); setName(''); setUrl(''); setAuth('none'); }}>{t('aiAgent.integrations.form.add')}</Button>
    </div>
  );
}

function ServerRow({ server, onChange }: { server: ToolServerRecord; onChange: () => void }) {
  const { toast } = useToast();
  const { t } = useTranslation();
  const [testing, setTesting] = useState(false);
  const test = async () => {
    setTesting(true);
    try {
      const r = await aiAgentApi.testToolServer(server.id);
      toast({
        title: r.ok ? t('aiAgent.integrations.server.testPassed') : t('aiAgent.integrations.server.testFailed'),
        // The server's note while tools cannot run, in the panel's language.
        description: r.runtimeExecutionEnabled ? r.message : t('aiAgent.integrations.server.runtimeOff'),
        variant: r.ok ? 'default' : 'destructive',
      });
      onChange();
    } catch (e) {
      toast({ title: t('aiAgent.integrations.server.testError'), description: errorText(t, e), variant: 'destructive' });
    } finally { setTesting(false); }
  };
  const remove = async () => {
    if (!window.confirm(t('aiAgent.integrations.server.confirmRemove', { name: server.name }))) return;
    await aiAgentApi.deleteToolServer(server.id);
    onChange();
  };
  return (
    <div className="py-3 flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium truncate">{server.name}</p>
          <Badge variant="outline" className="text-[10px]">{codeLabel(t, TYPE, server.server_type)}</Badge>
          <Badge variant={server.status === 'enabled' ? 'default' : server.status === 'error' ? 'destructive' : 'secondary'} className="text-[10px]">{codeLabel(t, STATUS, server.status)}</Badge>
          {server.auth_type !== 'none' && <Badge variant="outline" className="text-[10px]">{codeLabel(t, AUTH, server.auth_type)}</Badge>}
        </div>
        {server.endpoint_url && <p className="text-xs text-muted-foreground mt-0.5 truncate"><bdi>{server.endpoint_url}</bdi></p>}
        {server.last_error && <p className="text-xs text-destructive mt-0.5">{codeLabel(t, LAST_ERROR, server.last_error)}</p>}
      </div>
      <Button variant="outline" size="sm" onClick={test} disabled={testing} aria-label={t('aiAgent.integrations.server.test', { name: server.name })} title={t('aiAgent.integrations.server.test', { name: server.name })}>
        {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Beaker className="h-3.5 w-3.5" />}
      </Button>
      <Button variant="ghost" size="icon" onClick={remove} aria-label={t('aiAgent.integrations.server.remove', { name: server.name })} title={t('aiAgent.integrations.server.remove', { name: server.name })}><Trash2 className="h-4 w-4 text-muted-foreground" /></Button>
    </div>
  );
}

function NewWebhookToolForm({ onCreate }: { onCreate: (input: NewToolInput) => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [risk, setRisk] = useState<'low' | 'medium' | 'high'>('low');
  return (
    <div className="grid grid-cols-1 sm:grid-cols-[1fr_2fr_120px_auto] gap-2 items-end">
      <div>
        <Label className="text-xs">{t('aiAgent.integrations.form.toolName')}</Label>
        <Input dir="ltr" value={name} onChange={(e) => setName(e.target.value)} placeholder="notify_slack" />
      </div>
      <div>
        <Label className="text-xs">{t('aiAgent.integrations.form.webhookUrl')}</Label>
        <Input dir="ltr" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://hooks.example.com/..." />
      </div>
      <div>
        <Label className="text-xs">{t('aiAgent.integrations.form.risk')}</Label>
        <Select value={risk} onValueChange={(v) => setRisk(v as typeof risk)}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="low">{t('aiAgent.integrations.form.riskLow')}</SelectItem>
            <SelectItem value="medium">{t('aiAgent.integrations.form.riskMedium')}</SelectItem>
            <SelectItem value="high">{t('aiAgent.integrations.form.riskHigh')}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <Button disabled={!name || !url} onClick={() => { onCreate({ name, tool_type: 'webhook', config_json: { url }, risk_level: risk, enabled: false }); setName(''); setUrl(''); setRisk('low'); }}>{t('aiAgent.integrations.form.add')}</Button>
    </div>
  );
}
