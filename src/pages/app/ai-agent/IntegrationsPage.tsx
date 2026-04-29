import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { aiAgentApi, type ToolRecord, type ToolServerRecord } from '@/lib/ai-agent-api';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/components/ui/use-toast';
import { Plug, ShieldAlert, Loader2, Trash2, Beaker, Lock } from 'lucide-react';

export default function IntegrationsPage() {
  const { workspace } = useActiveWorkspace();
  const wsId = workspace?.id;
  const qc = useQueryClient();
  const { toast } = useToast();

  const tools = useQuery({ queryKey: ['ai-tools', wsId], queryFn: () => aiAgentApi.listTools(wsId!), enabled: !!wsId });
  const servers = useQuery({ queryKey: ['ai-tool-servers', wsId], queryFn: () => aiAgentApi.listToolServers(wsId!), enabled: !!wsId });

  const refreshAll = () => {
    qc.invalidateQueries({ queryKey: ['ai-tools', wsId] });
    qc.invalidateQueries({ queryKey: ['ai-tool-servers', wsId] });
  };

  const updateTool = useMutation({
    mutationFn: (vars: { id: string; patch: any }) => aiAgentApi.updateTool(vars.id, vars.patch),
    onSuccess: () => { refreshAll(); toast({ title: 'Tool updated' }); },
    onError: (e: any) => toast({ title: 'Update failed', description: e?.message, variant: 'destructive' }),
  });
  const deleteTool = useMutation({
    mutationFn: (id: string) => aiAgentApi.deleteTool(id),
    onSuccess: () => { refreshAll(); toast({ title: 'Tool removed' }); },
  });
  const createTool = useMutation({
    mutationFn: (input: any) => aiAgentApi.createTool({ workspaceId: wsId!, ...input }),
    onSuccess: () => { refreshAll(); toast({ title: 'Tool added' }); },
    onError: (e: any) => toast({ title: 'Failed', description: e?.message, variant: 'destructive' }),
  });

  const seedInternal = async () => {
    const list = tools.data?.defaultInternalTools || [];
    const existing = new Set((tools.data?.items || []).filter((t) => t.tool_type === 'internal').map((t) => t.name));
    let added = 0;
    for (const t of list) {
      if (existing.has(t.name)) continue;
      try {
        await aiAgentApi.createTool({ workspaceId: wsId!, name: t.name, description: t.description, tool_type: 'internal', risk_level: t.risk_level, enabled: false });
        added++;
      } catch { /* keep going */ }
    }
    refreshAll();
    toast({ title: `Added ${added} internal tools` });
  };

  const internalTools = (tools.data?.items || []).filter((t) => t.tool_type === 'internal');
  const mcpServers = (servers.data?.items || []).filter((s) => s.server_type === 'mcp');
  const webhookTools = (tools.data?.items || []).filter((t) => t.tool_type === 'webhook');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2.5">
          <Plug className="h-5 w-5 text-primary" /> Integrations & MCP
        </h1>
        <p className="text-sm text-muted-foreground mt-1.5 max-w-2xl">
          Configure internal tools, MCP servers, and webhook integrations. Runtime execution is intentionally disabled in this pass — configurations are saved safely for review.
        </p>
      </div>

      <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm flex items-start gap-2.5">
        <ShieldAlert className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
        <div>
          <p className="font-medium">Tool execution is disabled</p>
          <p className="text-muted-foreground text-xs mt-0.5">
            The agent will not call MCP servers, webhooks, or external tools yet. You can configure and enable tools, but they will not run until the platform admin enables MCP/tool runtime.
          </p>
        </div>
      </div>

      {/* Internal tools */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-base">Internal tools</CardTitle>
            <CardDescription>Built-in actions the agent can be allowed to use.</CardDescription>
          </div>
          {internalTools.length === 0 && (
            <Button size="sm" onClick={seedInternal} disabled={!wsId}>Add defaults</Button>
          )}
        </CardHeader>
        <CardContent>
          {tools.isLoading ? (
            <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          ) : internalTools.length === 0 ? (
            <p className="text-sm text-muted-foreground">No internal tools yet. Click <em>Add defaults</em> to seed them.</p>
          ) : (
            <div className="divide-y">
              {internalTools.map((t) => (
                <ToolRow key={t.id} tool={t} onToggle={(enabled, confirm_high_risk) => updateTool.mutate({ id: t.id, patch: { enabled, confirm_high_risk } })} onDelete={() => deleteTool.mutate(t.id)} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* MCP servers */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">MCP servers</CardTitle>
          <CardDescription>Register external Model Context Protocol servers. Validation only — no execution.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <NewServerForm onCreate={(input) => aiAgentApi.createToolServer({ workspaceId: wsId!, server_type: 'mcp', ...input }).then(() => refreshAll())} />
          {servers.isLoading ? (
            <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          ) : mcpServers.length === 0 ? (
            <p className="text-sm text-muted-foreground">No MCP servers configured.</p>
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
          <CardTitle className="text-base">Webhook tools</CardTitle>
          <CardDescription>HTTP webhook actions. Saved as configuration only.</CardDescription>
        </CardHeader>
        <CardContent>
          <NewWebhookToolForm onCreate={(input) => createTool.mutate(input)} />
          {webhookTools.length > 0 && (
            <div className="divide-y mt-4">
              {webhookTools.map((t) => (
                <ToolRow key={t.id} tool={t} onToggle={(enabled, confirm_high_risk) => updateTool.mutate({ id: t.id, patch: { enabled, confirm_high_risk } })} onDelete={() => deleteTool.mutate(t.id)} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Security */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><Lock className="h-4 w-4" /> Security & permissions</CardTitle>
          <CardDescription>How tool credentials and execution are guarded.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>• API keys and auth credentials are stored server-side only. They are never returned to the browser.</p>
          <p>• High-risk tools cannot be enabled without explicit confirmation.</p>
          <p>• MCP runtime execution is disabled until the platform admin sets <code className="px-1 py-0.5 rounded bg-muted text-xs">AI_AGENT_MCP_TEST_ENABLED=1</code>.</p>
          <p>• Only owners and admins can create, edit, or delete tools and servers.</p>
        </CardContent>
      </Card>
    </div>
  );
}

function ToolRow({ tool, onToggle, onDelete }: { tool: ToolRecord; onToggle: (enabled: boolean, confirmHighRisk?: boolean) => void; onDelete: () => void }) {
  const handleToggle = (next: boolean) => {
    if (next && tool.risk_level === 'high') {
      const ok = window.confirm(`"${tool.name}" is a high-risk tool. Enabling it gives the agent permission to perform potentially destructive actions. Continue?`);
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
          <Badge variant="outline" className="text-[10px]">{tool.tool_type}</Badge>
          {tool.risk_level !== 'low' && (
            <Badge variant={tool.risk_level === 'high' ? 'destructive' : 'secondary'} className="text-[10px]">{tool.risk_level} risk</Badge>
          )}
        </div>
        {tool.description && <p className="text-xs text-muted-foreground mt-0.5 truncate">{tool.description}</p>}
      </div>
      <Switch checked={tool.enabled} onCheckedChange={handleToggle} />
      <Button variant="ghost" size="icon" onClick={onDelete}><Trash2 className="h-4 w-4 text-muted-foreground" /></Button>
    </div>
  );
}

function NewServerForm({ onCreate }: { onCreate: (input: { name: string; endpoint_url: string; auth_type: any }) => void }) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [auth, setAuth] = useState<'none' | 'bearer' | 'api_key'>('none');
  return (
    <div className="grid grid-cols-1 sm:grid-cols-[1fr_2fr_140px_auto] gap-2 items-end">
      <div>
        <Label className="text-xs">Name</Label>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="My MCP server" />
      </div>
      <div>
        <Label className="text-xs">Endpoint URL</Label>
        <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com" />
      </div>
      <div>
        <Label className="text-xs">Auth</Label>
        <Select value={auth} onValueChange={(v: any) => setAuth(v)}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="none">None</SelectItem>
            <SelectItem value="bearer">Bearer</SelectItem>
            <SelectItem value="api_key">API key</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <Button disabled={!name || !url} onClick={() => { onCreate({ name, endpoint_url: url, auth_type: auth }); setName(''); setUrl(''); setAuth('none'); }}>Add</Button>
    </div>
  );
}

function ServerRow({ server, onChange }: { server: ToolServerRecord; onChange: () => void }) {
  const { toast } = useToast();
  const [testing, setTesting] = useState(false);
  const test = async () => {
    setTesting(true);
    try {
      const r = await aiAgentApi.testToolServer(server.id);
      toast({
        title: r.ok ? 'Validation passed' : 'Validation failed',
        description: r.message,
        variant: r.ok ? 'default' : 'destructive',
      });
      onChange();
    } catch (e: any) {
      toast({ title: 'Test failed', description: e?.message, variant: 'destructive' });
    } finally { setTesting(false); }
  };
  const remove = async () => {
    if (!window.confirm(`Remove server "${server.name}"?`)) return;
    await aiAgentApi.deleteToolServer(server.id);
    onChange();
  };
  return (
    <div className="py-3 flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium truncate">{server.name}</p>
          <Badge variant="outline" className="text-[10px]">{server.server_type}</Badge>
          <Badge variant={server.status === 'enabled' ? 'default' : server.status === 'error' ? 'destructive' : 'secondary'} className="text-[10px]">{server.status}</Badge>
          {server.auth_type !== 'none' && <Badge variant="outline" className="text-[10px]">{server.auth_type}</Badge>}
        </div>
        {server.endpoint_url && <p className="text-xs text-muted-foreground mt-0.5 truncate">{server.endpoint_url}</p>}
        {server.last_error && <p className="text-xs text-destructive mt-0.5">{server.last_error}</p>}
      </div>
      <Button variant="outline" size="sm" onClick={test} disabled={testing}>
        {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Beaker className="h-3.5 w-3.5" />}
      </Button>
      <Button variant="ghost" size="icon" onClick={remove}><Trash2 className="h-4 w-4 text-muted-foreground" /></Button>
    </div>
  );
}

function NewWebhookToolForm({ onCreate }: { onCreate: (input: any) => void }) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [risk, setRisk] = useState<'low' | 'medium' | 'high'>('low');
  return (
    <div className="grid grid-cols-1 sm:grid-cols-[1fr_2fr_120px_auto] gap-2 items-end">
      <div>
        <Label className="text-xs">Tool name</Label>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="notify_slack" />
      </div>
      <div>
        <Label className="text-xs">Webhook URL</Label>
        <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://hooks.example.com/..." />
      </div>
      <div>
        <Label className="text-xs">Risk</Label>
        <Select value={risk} onValueChange={(v: any) => setRisk(v)}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="low">Low</SelectItem>
            <SelectItem value="medium">Medium</SelectItem>
            <SelectItem value="high">High</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <Button disabled={!name || !url} onClick={() => { onCreate({ name, tool_type: 'webhook', config_json: { url }, risk_level: risk, enabled: false }); setName(''); setUrl(''); setRisk('low'); }}>Add</Button>
    </div>
  );
}