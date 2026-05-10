import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { useCallCenterSettings, useUpdateCallCenterSettings } from '@/hooks/useCallCenter';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useState, useEffect } from 'react';
import { toast } from '@/hooks/use-toast';
import { Copy, AlertCircle } from 'lucide-react';

export default function InstallPage() {
  const { workspace } = useActiveWorkspace();
  const { data } = useCallCenterSettings(workspace?.id);
  const update = useUpdateCallCenterSettings(workspace?.id);
  const apiBase = (import.meta.env.VITE_API_BASE_URL as string) || window.location.origin;
  const wid = workspace?.id || '';
  const snippet = `<script async src="${apiBase}/call-widget/l.js" workspace-id="${wid}"></script>`;
  const [domains, setDomains] = useState('');

  useEffect(() => {
    if (data?.settings?.allowed_domains) setDomains(data.settings.allowed_domains.join('\n'));
  }, [data?.settings?.allowed_domains]);

  function copy(text: string) {
    navigator.clipboard.writeText(text);
    toast({ title: 'Copied to clipboard' });
  }

  async function saveDomains() {
    const list = domains.split('\n').map((s) => s.trim()).filter(Boolean);
    await update.mutateAsync({ allowed_domains: list });
    toast({ title: 'Allowed domains saved' });
  }

  async function testBootstrap() {
    try {
      const r = await fetch(`${apiBase}/api/call-widget/bootstrap?workspaceId=${wid}`);
      const j = await r.json();
      toast({ title: `Bootstrap: ${j.status || r.status}`, description: JSON.stringify(j).slice(0, 200) });
    } catch (e: any) {
      toast({ title: 'Bootstrap failed', description: e.message, variant: 'destructive' });
    }
  }

  const platformDisabled = data?.platform && !data.platform.call_center_enabled;
  const wsDisabled = data?.settings && !data.settings.enabled;

  return (
    <div className="space-y-6 max-w-3xl">
      {(platformDisabled || wsDisabled) && (
        <Card className="p-4 border-warning/50 bg-warning/5 flex gap-2 items-start">
          <AlertCircle className="h-5 w-5 text-warning shrink-0" />
          <div className="text-sm">
            {platformDisabled ? 'Call Center is disabled by the platform.' : 'Call Center is disabled for this workspace.'}
          </div>
        </Card>
      )}
      <Card className="p-5 space-y-3">
        <h2 className="font-semibold">Embed snippet</h2>
        <p className="text-sm text-muted-foreground">Paste this on every page where you want the call widget to appear.</p>
        <pre className="bg-muted p-3 rounded text-xs overflow-x-auto">{snippet}</pre>
        <Button size="sm" onClick={() => copy(snippet)}><Copy className="h-3.5 w-3.5 me-1" />Copy</Button>
      </Card>
      <Card className="p-5 space-y-2">
        <h2 className="font-semibold">Public key</h2>
        <p className="text-sm text-muted-foreground">Use this if you prefer not to expose your workspace ID.</p>
        <code className="block bg-muted p-2 rounded text-xs break-all">{data?.settings?.public_key || '—'}</code>
      </Card>
      <Card className="p-5 space-y-3">
        <h2 className="font-semibold">Allowed domains</h2>
        <p className="text-xs text-muted-foreground">One per line. Use *.example.com for subdomains. Required.</p>
        <textarea
          className="w-full min-h-[120px] rounded border border-input bg-background p-2 text-sm font-mono"
          value={domains}
          onChange={(e) => setDomains(e.target.value)}
          placeholder={"example.com\n*.example.com"}
        />
        <div className="flex gap-2">
          <Button onClick={saveDomains} disabled={update.isPending}>Save</Button>
          <Button variant="outline" onClick={testBootstrap}>Test bootstrap</Button>
        </div>
      </Card>
    </div>
  );
}
