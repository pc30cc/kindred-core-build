import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useAdminProviderConfigs } from '@/hooks/useAdmin';
import {
  Shield, Mail, Bot, HardDrive, Radio, Search,
  Bell, Database, Flag, MessageSquare, CreditCard,
  ShieldAlert, Globe,
} from 'lucide-react';

const PROVIDER_TYPES = [
  { type: 'auth', label: 'Auth Provider', icon: Shield },
  { type: 'email', label: 'Email Provider', icon: Mail },
  { type: 'ai', label: 'AI Provider', icon: Bot },
  { type: 'storage', label: 'Storage Provider', icon: HardDrive },
  { type: 'realtime', label: 'Realtime Provider', icon: Radio },
  { type: 'search', label: 'Search Provider', icon: Search },
  { type: 'notification', label: 'Notification Provider', icon: Bell },
  { type: 'cache', label: 'Cache Provider', icon: Database },
  { type: 'feature_flag', label: 'Feature Flag Provider', icon: Flag },
  { type: 'widget', label: 'Widget Delivery', icon: MessageSquare },
  { type: 'billing', label: 'Billing Provider', icon: CreditCard },
  { type: 'captcha', label: 'Captcha / Abuse Protection', icon: ShieldAlert },
  { type: 'cdn', label: 'CDN / Asset Provider', icon: Globe },
];

export default function AdminProvidersPage() {
  const { data: configs } = useAdminProviderConfigs();

  const getConfigsForType = (type: string) =>
    configs?.filter(c => c.provider_type === type) ?? [];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Provider Control Center</h1>
      <p className="text-slate-400 text-sm">Configure global providers for the entire platform. Workspace-level overrides are managed per workspace.</p>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {PROVIDER_TYPES.map(pt => {
          const providerConfigs = getConfigsForType(pt.type);
          const activeConfig = providerConfigs.find(c => c.is_active);

          return (
            <Card key={pt.type} className="bg-slate-900 border-slate-800">
              <CardHeader className="flex flex-row items-center gap-3 pb-2">
                <pt.icon className="h-5 w-5 text-slate-400" />
                <CardTitle className="text-sm text-white">{pt.label}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {activeConfig ? (
                  <>
                    <div className="flex items-center gap-2">
                      <Badge className="bg-green-900 text-green-300">Active</Badge>
                      <span className="text-sm text-slate-300">{activeConfig.provider_name}</span>
                    </div>
                  </>
                ) : (
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="border-slate-600 text-slate-500">Not Configured</Badge>
                  </div>
                )}
                <p className="text-xs text-slate-500">
                  {providerConfigs.length} config{providerConfigs.length !== 1 ? 's' : ''} registered
                </p>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
