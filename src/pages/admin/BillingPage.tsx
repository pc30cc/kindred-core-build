import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { billingAdminOverview, billingAdminGrant, billingTest, API_BASE } from '@/lib/api';
import {
  CreditCard, Users, TrendingUp, AlertCircle, Loader2, Activity,
  DollarSign, CheckCircle, XCircle, Shield, Search,
} from 'lucide-react';
import { toast } from 'sonner';

function formatPrice(amount: number, currency: string): string {
  if (currency === 'IRR') return `${amount.toLocaleString('fa-IR')} ریال`;
  if (currency === 'TRY') return `₺${(amount / 100).toFixed(2)}`;
  return `$${(amount / 100).toFixed(2)}`;
}

export default function AdminBillingPage() {
  const [overview, setOverview] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [grantForm, setGrantForm] = useState({ workspaceId: '', planId: '', status: 'active' });
  const [testingProvider, setTestingProvider] = useState<string | null>(null);

  useEffect(() => {
    if (!API_BASE) return;
    loadOverview();
  }, []);

  async function loadOverview() {
    setLoading(true);
    try {
      const data = await billingAdminOverview();
      setOverview(data);
    } catch (e) {
      console.error('Failed to load billing overview:', e);
    } finally {
      setLoading(false);
    }
  }

  async function handleGrant() {
    if (!grantForm.workspaceId || !grantForm.planId) return;
    try {
      await billingAdminGrant(grantForm);
      toast.success('Plan granted successfully');
      loadOverview();
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  async function handleTestProvider(provider: string) {
    setTestingProvider(provider);
    try {
      const result = await billingTest(provider, {});
      if (result.success) {
        toast.success(`${provider}: Connected (${result.latencyMs}ms)`);
      } else {
        toast.error(`${provider}: ${result.error || 'Failed'}`);
      }
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setTestingProvider(null);
    }
  }

  if (!API_BASE) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold text-foreground">Billing Management</h1>
        <Card><CardContent className="py-8 text-center text-muted-foreground">
          <AlertCircle className="w-8 h-8 mx-auto mb-2" />
          <p>Billing requires the self-hosted backend. Set VITE_API_BASE_URL.</p>
        </CardContent></Card>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const ALL_PROVIDERS = [
    { name: 'stripe', label: 'Stripe', region: 'International' },
    { name: 'paddle', label: 'Paddle', region: 'International' },
    { name: 'lemon_squeezy', label: 'Lemon Squeezy', region: 'International' },
    { name: 'paypal', label: 'PayPal', region: 'International' },
    { name: 'zarinpal', label: 'ZarinPal', region: 'Iran' },
    { name: 'idpay', label: 'IDPay', region: 'Iran' },
    { name: 'nextpay', label: 'NextPay', region: 'Iran' },
    { name: 'payping', label: 'PayPing', region: 'Iran' },
    { name: 'zibal', label: 'Zibal', region: 'Iran' },
    { name: 'sep_shaparak', label: 'SEP Shaparak', region: 'Iran' },
    { name: 'iyzico', label: 'iyzico', region: 'Turkey' },
    { name: 'paytr', label: 'PayTR', region: 'Turkey' },
    { name: 'sipay', label: 'Sipay', region: 'Turkey' },
    { name: 'paratika', label: 'Paratika', region: 'Turkey' },
    { name: 'craftgate', label: 'Craftgate', region: 'Turkey' },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-foreground">Billing Management</h1>
      <p className="text-muted-foreground text-sm">Platform-wide billing overview, plan management, and provider status.</p>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-primary/10"><Users className="w-5 h-5 text-primary" /></div>
              <div>
                <p className="text-2xl font-bold text-foreground">{overview?.totalSubscriptions || 0}</p>
                <p className="text-xs text-muted-foreground">Total Subscriptions</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-green-500/10"><TrendingUp className="w-5 h-5 text-green-500" /></div>
              <div>
                <p className="text-2xl font-bold text-foreground">{overview?.activeSubscriptions || 0}</p>
                <p className="text-xs text-muted-foreground">Active</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-blue-500/10"><DollarSign className="w-5 h-5 text-blue-500" /></div>
              <div>
                <p className="text-2xl font-bold text-foreground">{overview?.recentPayments?.length || 0}</p>
                <p className="text-xs text-muted-foreground">Recent Payments</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-yellow-500/10"><Activity className="w-5 h-5 text-yellow-500" /></div>
              <div>
                <p className="text-2xl font-bold text-foreground">{overview?.recentEvents?.length || 0}</p>
                <p className="text-xs text-muted-foreground">Billing Events</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="providers">
        <TabsList>
          <TabsTrigger value="providers">Providers ({ALL_PROVIDERS.length})</TabsTrigger>
          <TabsTrigger value="plans">Plans</TabsTrigger>
          <TabsTrigger value="payments">Payments</TabsTrigger>
          <TabsTrigger value="events">Events</TabsTrigger>
          <TabsTrigger value="admin">Admin Actions</TabsTrigger>
        </TabsList>

        {/* Providers Tab */}
        <TabsContent value="providers" className="space-y-4">
          {['International', 'Iran', 'Turkey'].map(region => (
            <div key={region}>
              <h3 className="text-sm font-semibold text-muted-foreground mb-2">
                {region === 'Iran' ? '🇮🇷 Iran (IRR/Toman)' : region === 'Turkey' ? '🇹🇷 Turkey (TRY)' : '🌍 International (USD/EUR)'}
              </h3>
              <div className="grid md:grid-cols-3 gap-3">
                {ALL_PROVIDERS.filter(p => p.region === region).map(p => (
                  <Card key={p.name} className="border-border">
                    <CardContent className="pt-4 pb-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <CreditCard className="w-4 h-4 text-primary" />
                          <span className="font-medium text-sm text-foreground">{p.label}</span>
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleTestProvider(p.name)}
                          disabled={testingProvider === p.name}
                        >
                          {testingProvider === p.name ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : (
                            <span className="text-xs">Test</span>
                          )}
                        </Button>
                      </div>
                      <Badge variant="outline" className="mt-2 text-xs">Backend Ready</Badge>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          ))}
        </TabsContent>

        {/* Plans Tab */}
        <TabsContent value="plans">
          <Card>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Slug</TableHead>
                  <TableHead>USD/mo</TableHead>
                  <TableHead>IRR/mo</TableHead>
                  <TableHead>TRY/mo</TableHead>
                  <TableHead>EUR/mo</TableHead>
                  <TableHead>Free</TableHead>
                  <TableHead>Active</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(overview?.plans || []).map((plan: any) => (
                  <TableRow key={plan.id}>
                    <TableCell className="font-medium text-foreground">{plan.name}</TableCell>
                    <TableCell className="text-muted-foreground">{plan.slug}</TableCell>
                    <TableCell>{formatPrice(plan.prices?.USD?.monthly || 0, 'USD')}</TableCell>
                    <TableCell>{(plan.prices?.IRR?.monthly || 0).toLocaleString('fa-IR')} ریال</TableCell>
                    <TableCell>{formatPrice(plan.prices?.TRY?.monthly || 0, 'TRY')}</TableCell>
                    <TableCell>{formatPrice(plan.prices?.EUR?.monthly || 0, 'EUR')}</TableCell>
                    <TableCell>{plan.is_free ? <CheckCircle className="w-4 h-4 text-green-500" /> : <XCircle className="w-4 h-4 text-muted-foreground" />}</TableCell>
                    <TableCell>{plan.is_active ? <CheckCircle className="w-4 h-4 text-green-500" /> : <XCircle className="w-4 h-4 text-red-500" />}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>

        {/* Payments Tab */}
        <TabsContent value="payments">
          <Card>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Workspace</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(overview?.recentPayments || []).length === 0 ? (
                  <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground py-8">No payments yet</TableCell></TableRow>
                ) : (
                  (overview?.recentPayments || []).map((p: any) => (
                    <TableRow key={p.id}>
                      <TableCell>{new Date(p.created_at).toLocaleDateString()}</TableCell>
                      <TableCell className="text-xs font-mono text-muted-foreground">{p.workspace_id?.slice(0, 8)}...</TableCell>
                      <TableCell>{formatPrice(p.amount, p.currency)}</TableCell>
                      <TableCell>{p.provider_name}</TableCell>
                      <TableCell><Badge variant={p.status === 'succeeded' ? 'default' : 'destructive'} className="text-xs">{p.status}</Badge></TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>

        {/* Events Tab */}
        <TabsContent value="events">
          <Card>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Event</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(overview?.recentEvents || []).length === 0 ? (
                  <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground py-8">No billing events</TableCell></TableRow>
                ) : (
                  (overview?.recentEvents || []).map((e: any) => (
                    <TableRow key={e.id}>
                      <TableCell className="text-xs">{new Date(e.created_at).toLocaleString()}</TableCell>
                      <TableCell><Badge variant="outline" className="text-xs">{e.event_type}</Badge></TableCell>
                      <TableCell>{e.provider_name}</TableCell>
                      <TableCell>{e.status}</TableCell>
                      <TableCell>{e.amount ? formatPrice(e.amount, e.currency || 'USD') : '—'}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>

        {/* Admin Actions Tab */}
        <TabsContent value="admin">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Shield className="w-4 h-4" /> Manual Plan Grant
              </CardTitle>
              <CardDescription>Manually assign a plan to a workspace (bypass payment).</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-3 gap-3">
                <Input
                  placeholder="Workspace ID (UUID)"
                  value={grantForm.workspaceId}
                  onChange={(e) => setGrantForm(f => ({ ...f, workspaceId: e.target.value }))}
                />
                <Select value={grantForm.planId} onValueChange={(v) => setGrantForm(f => ({ ...f, planId: v }))}>
                  <SelectTrigger><SelectValue placeholder="Select plan" /></SelectTrigger>
                  <SelectContent>
                    {(overview?.plans || []).map((p: any) => (
                      <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button onClick={handleGrant} disabled={!grantForm.workspaceId || !grantForm.planId}>
                  Grant Plan
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
