import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter,
} from '@/components/ui/dialog';
import {
  useProviderSummary,
  useRegisteredProviders,
  providerRegistry,
  PROVIDER_TYPE_KEYS,
  type ProviderTypeKey,
  type ProviderHealth,
  setGlobalDefaultProvider,
  getGlobalDefaultProvider,
} from '@/providers';
import {
  Shield, Mail, Bot, HardDrive, Radio, Search,
  Bell, Database, Flag, MessageSquare, CreditCard,
  ShieldAlert, Globe, Layers, RefreshCw, Activity,
  CheckCircle, AlertTriangle, XCircle, HelpCircle,
  Settings,
} from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

const PROVIDER_META: Record<ProviderTypeKey, { label: string; icon: typeof Shield; description: string }> = {
  auth: { label: 'Auth Provider', icon: Shield, description: 'User authentication and session management' },
  database: { label: 'Database (DAL)', icon: Layers, description: 'Data access layer for all CRUD operations' },
  realtime: { label: 'Realtime Provider', icon: Radio, description: 'WebSocket channels, presence, and live updates' },
  email: { label: 'Email Provider', icon: Mail, description: 'Transactional and notification emails' },
  ai: { label: 'AI Provider', icon: Bot, description: 'LLM completions, embeddings, and AI features' },
  storage: { label: 'Storage Provider', icon: HardDrive, description: 'File uploads, CDN, and asset management' },
  search: { label: 'Search Provider', icon: Search, description: 'Full-text and vector search' },
  notification: { label: 'Notification Provider', icon: Bell, description: 'Push notifications and in-app alerts' },
  cache: { label: 'Cache Provider', icon: Database, description: 'Key-value caching for performance' },
  feature_flag: { label: 'Feature Flags', icon: Flag, description: 'Feature toggles and gradual rollouts' },
  widget: { label: 'Widget Delivery', icon: MessageSquare, description: 'Chat widget configuration and delivery' },
  billing: { label: 'Billing Provider', icon: CreditCard, description: 'Subscriptions, plans, and payment processing' },
  captcha: { label: 'Captcha / Abuse', icon: ShieldAlert, description: 'Bot protection and abuse prevention' },
  cdn: { label: 'CDN / Assets', icon: Globe, description: 'Asset delivery and CDN management' },
};

// Available vendor options for email config
const EMAIL_VENDORS = [
  { value: 'resend', label: 'Resend', fields: ['api_key', 'from_email', 'from_name'] },
  { value: 'sendgrid', label: 'SendGrid', fields: ['api_key', 'from_email', 'from_name'] },
  { value: 'smtp', label: 'SMTP', fields: ['smtp_host', 'smtp_port', 'smtp_user', 'from_email', 'from_name'] },
];

const healthIcon = (h: ProviderHealth) => {
  switch (h) {
    case 'healthy': return <CheckCircle className="h-3.5 w-3.5 text-emerald-400" />;
    case 'degraded': return <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />;
    case 'down': return <XCircle className="h-3.5 w-3.5 text-red-400" />;
    default: return <HelpCircle className="h-3.5 w-3.5 text-muted-foreground" />;
  }
};

const healthBadge = (h: ProviderHealth) => {
  const colors: Record<ProviderHealth, string> = {
    healthy: 'bg-emerald-900/50 text-emerald-300 border-emerald-700',
    degraded: 'bg-amber-900/50 text-amber-300 border-amber-700',
    down: 'bg-red-900/50 text-red-300 border-red-700',
    unknown: 'bg-muted text-muted-foreground border-border',
  };
  return (
    <Badge variant="outline" className={`gap-1 ${colors[h]}`}>
      {healthIcon(h)}
      {h.charAt(0).toUpperCase() + h.slice(1)}
    </Badge>
  );
};

function ProviderTypeCard({ type }: { type: ProviderTypeKey }) {
  const meta = PROVIDER_META[type];
  const providers = useRegisteredProviders(type);
  const summary = useProviderSummary();
  const [healthMap, setHealthMap] = useState<Record<string, ProviderHealth>>({});
  const [checking, setChecking] = useState(false);

  const activeName = summary[type]?.active;
  const Icon = meta.icon;

  const checkAllHealth = async () => {
    setChecking(true);
    const results = await providerRegistry.checkAllHealth(type);
    setHealthMap(results);
    setChecking(false);
  };

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10">
              <Icon className="h-5 w-5 text-primary" />
            </div>
            <div>
              <CardTitle className="text-sm text-foreground">{meta.label}</CardTitle>
              <p className="text-xs text-muted-foreground mt-0.5">{meta.description}</p>
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={checkAllHealth} disabled={checking} className="h-7 w-7 p-0">
            <RefreshCw className={`h-3.5 w-3.5 ${checking ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {providers.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">No providers registered</p>
        ) : (
          providers.map((p) => (
            <div
              key={p.name}
              className={`flex items-center justify-between p-2 rounded-md border ${
                p.name === activeName ? 'border-primary/40 bg-primary/5' : 'border-border bg-muted/30'
              }`}
            >
              <div className="flex items-center gap-2">
                {p.name === activeName && (
                  <Badge className="bg-primary/20 text-primary border-primary/30 text-[10px] px-1.5">Active</Badge>
                )}
                <span className="text-sm font-medium text-foreground">{p.name}</span>
                {p.meta?.vendor && <span className="text-[10px] text-muted-foreground">({String(p.meta.vendor)})</span>}
              </div>
              <div className="flex items-center gap-2">
                {healthMap[p.name] && healthBadge(healthMap[p.name])}
                {p.name !== activeName && (
                  <Button
                    variant="outline" size="sm" className="h-6 text-xs"
                    onClick={() => providerRegistry.setActive(type, p.name)}
                  >
                    Activate
                  </Button>
                )}
              </div>
            </div>
          ))
        )}
        <div className="text-[10px] text-muted-foreground pt-1">
          {providers.length} registered · Priority: {providers.map(p => `${p.name}(${p.priority})`).join(', ')}
        </div>
      </CardContent>
    </Card>
  );
}

function EmailProviderConfigDialog() {
  const [open, setOpen] = useState(false);
  const [vendor, setVendor] = useState('resend');
  const [config, setConfig] = useState<Record<string, string>>({
    api_key: '', from_email: '', from_name: '',
    smtp_host: '', smtp_port: '587', smtp_user: '',
  });
  const qc = useQueryClient();

  // Load existing config
  const { data: existing } = useQuery({
    queryKey: ['global-email-provider'],
    queryFn: () => getGlobalDefaultProvider('email'),
  });

  const save = useMutation({
    mutationFn: async () => {
      // The provider_name in the config tells the edge function which vendor to use
      const nonEmptyConfig: Record<string, string> = {};
      for (const [k, v] of Object.entries(config)) {
        if (v.trim()) nonEmptyConfig[k] = v.trim();
      }
      const result = await setGlobalDefaultProvider('email', vendor, nonEmptyConfig);
      if (result.error) throw result.error;
    },
    onSuccess: () => {
      toast({ title: 'Email provider saved', description: `Global default set to ${vendor}` });
      qc.invalidateQueries({ queryKey: ['global-email-provider'] });
      setOpen(false);
    },
    onError: (err) => {
      toast({ title: 'Save failed', description: err.message, variant: 'destructive' });
    },
  });

  const vendorInfo = EMAIL_VENDORS.find(v => v.value === vendor);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Settings className="h-4 w-4 me-2" />
          Configure Email Provider
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Global Email Provider Config</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          {existing && (
            <div className="p-3 bg-muted/50 rounded-md text-sm">
              Current: <Badge variant="outline">{existing.provider_name}</Badge>
              {existing.config?.from_email && (
                <span className="ml-2 text-muted-foreground">({String(existing.config.from_email)})</span>
              )}
            </div>
          )}

          <div className="space-y-2">
            <Label>Email Vendor</Label>
            <Select value={vendor} onValueChange={setVendor}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {EMAIL_VENDORS.map(v => (
                  <SelectItem key={v.value} value={v.value}>{v.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {vendorInfo?.fields.map(field => (
            <div key={field} className="space-y-2">
              <Label>{field.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}</Label>
              <Input
                type={field.includes('key') || field.includes('pass') ? 'password' : 'text'}
                placeholder={field === 'from_email' ? 'noreply@yourdomain.com' : field === 'from_name' ? 'Your Platform' : ''}
                value={config[field] || ''}
                onChange={e => setConfig(p => ({ ...p, [field]: e.target.value }))}
              />
              {field === 'api_key' && (
                <p className="text-xs text-muted-foreground">
                  ⚠️ For production, store API keys as Edge Function secrets (RESEND_API_KEY / SENDGRID_API_KEY) instead of here.
                </p>
              )}
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? 'Saving...' : 'Save & Activate'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function AdminProvidersPage() {
  const summary = useProviderSummary();
  const configured = Object.values(summary).filter(s => s.registered.length > 0).length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Provider Control Center</h1>
          <p className="text-muted-foreground text-sm mt-1">
            {configured}/{PROVIDER_TYPE_KEYS.length} provider types configured.
            Manage global providers for the entire platform.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <EmailProviderConfigDialog />
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">Live Registry</span>
          </div>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {PROVIDER_TYPE_KEYS.map((type) => (
          <ProviderTypeCard key={type} type={type} />
        ))}
      </div>
    </div>
  );
}
