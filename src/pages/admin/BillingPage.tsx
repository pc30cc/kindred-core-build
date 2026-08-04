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
  DollarSign, CheckCircle, XCircle, Shield,
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
        <Card className="bg-card border-border"><CardContent className="py-8 text-center text-muted-foreground">
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
    { name: 'zarinpal_test', label: 'ZarinPal-Test (Sandbox)', region: 'Iran' },
    { name: 'iranpardakht_sandbox', label: 'IranPardakht-Sandbox', region: 'Iran' },
    { name: 'idpay', label: 'IDPay', region: 'Iran' },
    { name: 'idpay_test', label: 'IDPay-Test (Sandbox)', region: 'Iran' },
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
        <Card className="bg-card border-border">
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
        <Card className="bg-card border-border">
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
        <Card className="bg-card border-border">
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
        <Card className="bg-card border-border">
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
        <TabsList className="bg-muted">
          <TabsTrigger value="providers" className="data-[state=active]:bg-sidebar-accent data-[state=active]:text-foreground text-muted-foreground">Providers ({ALL_PROVIDERS.length})</TabsTrigger>
          <TabsTrigger value="plans" className="data-[state=active]:bg-sidebar-accent data-[state=active]:text-foreground text-muted-foreground">Plans</TabsTrigger>
          <TabsTrigger value="payments" className="data-[state=active]:bg-sidebar-accent data-[state=active]:text-foreground text-muted-foreground">Payments</TabsTrigger>
          <TabsTrigger value="events" className="data-[state=active]:bg-sidebar-accent data-[state=active]:text-foreground text-muted-foreground">Events</TabsTrigger>
          <TabsTrigger value="admin" className="data-[state=active]:bg-sidebar-accent data-[state=active]:text-foreground text-muted-foreground">Admin Actions</TabsTrigger>
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
                  <Card key={p.name} className="bg-card border-border">
                    <CardContent className="pt-4 pb-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <CreditCard className="w-4 h-4 text-admin-accent" />
                          <span className="font-medium text-sm text-foreground">{p.label}</span>
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleTestProvider(p.name)}
                          disabled={testingProvider === p.name}
                          className="text-muted-foreground hover:text-foreground"
                        >
                          {testingProvider === p.name ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : (
                            <span className="text-xs">Test</span>
                          )}
                        </Button>
                      </div>
                      <Badge variant="outline" className="mt-2 text-xs border-border">Backend Ready</Badge>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          ))}
        </TabsContent>

        {/* Plans Tab */}
        <TabsContent value="plans">
          <Card className="bg-card border-border">
            <Table>
              <TableHeader>
                <TableRow className="border-border">
                  <TableHead className="text-muted-foreground">Name</TableHead>
                  <TableHead className="text-muted-foreground">Slug</TableHead>
                  <TableHead className="text-muted-foreground">USD/mo</TableHead>
                  <TableHead className="text-muted-foreground">IRR/mo</TableHead>
                  <TableHead className="text-muted-foreground">TRY/mo</TableHead>
                  <TableHead className="text-muted-foreground">EUR/mo</TableHead>
                  <TableHead className="text-muted-foreground">Free</TableHead>
                  <TableHead className="text-muted-foreground">Active</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(overview?.plans || []).map((plan: any) => (
                  <TableRow key={plan.id} className="border-border hover:bg-muted/50">
                    <TableCell className="font-medium text-foreground">{plan.name}</TableCell>
                    <TableCell className="text-muted-foreground">{plan.slug}</TableCell>
                    <TableCell className="text-foreground">{formatPrice(plan.prices?.USD?.monthly || 0, 'USD')}</TableCell>
                    <TableCell className="text-foreground">{(plan.prices?.IRR?.monthly || 0).toLocaleString('fa-IR')} ریال</TableCell>
                    <TableCell className="text-foreground">{formatPrice(plan.prices?.TRY?.monthly || 0, 'TRY')}</TableCell>
                    <TableCell className="text-foreground">{formatPrice(plan.prices?.EUR?.monthly || 0, 'EUR')}</TableCell>
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
          <Card className="bg-card border-border">
            <Table>
              <TableHeader>
                <TableRow className="border-border">
                  <TableHead className="text-muted-foreground">Date</TableHead>
                  <TableHead className="text-muted-foreground">Workspace</TableHead>
                  <TableHead className="text-muted-foreground">Amount</TableHead>
                  <TableHead className="text-muted-foreground">Provider</TableHead>
                  <TableHead className="text-muted-foreground">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(overview?.recentPayments || []).length === 0 ? (
                  <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground py-8">No payments yet</TableCell></TableRow>
                ) : (
                  (overview?.recentPayments || []).map((p: any) => (
                    <TableRow key={p.id} className="border-border hover:bg-muted/50">
                      <TableCell className="text-foreground">{new Date(p.created_at).toLocaleDateString()}</TableCell>
                      <TableCell className="text-xs font-mono text-muted-foreground">{p.workspace_id?.slice(0, 8)}...</TableCell>
                      <TableCell className="text-foreground">{formatPrice(p.amount, p.currency)}</TableCell>
                      <TableCell className="text-foreground">{p.provider_name}</TableCell>
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
          <Card className="bg-card border-border">
            <Table>
              <TableHeader>
                <TableRow className="border-border">
                  <TableHead className="text-muted-foreground">Time</TableHead>
                  <TableHead className="text-muted-foreground">Event</TableHead>
                  <TableHead className="text-muted-foreground">Provider</TableHead>
                  <TableHead className="text-muted-foreground">Status</TableHead>
                  <TableHead className="text-muted-foreground">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(overview?.recentEvents || []).length === 0 ? (
                  <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground py-8">No billing events</TableCell></TableRow>
                ) : (
                  (overview?.recentEvents || []).map((e: any) => (
                    <TableRow key={e.id} className="border-border hover:bg-muted/50">
                      <TableCell className="text-xs text-muted-foreground">{new Date(e.created_at).toLocaleString()}</TableCell>
                      <TableCell><Badge variant="outline" className="text-xs border-border">{e.event_type}</Badge></TableCell>
                      <TableCell className="text-foreground">{e.provider_name}</TableCell>
                      <TableCell className="text-foreground">{e.status}</TableCell>
                      <TableCell className="text-foreground">{e.amount ? formatPrice(e.amount, e.currency || 'USD') : '—'}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>

        {/* Admin Actions Tab */}
        <TabsContent value="admin">
          <Card className="bg-card border-border">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2 text-foreground">
                <Shield className="w-4 h-4" /> Manual Plan Grant
              </CardTitle>
              <CardDescription className="text-muted-foreground">Manually assign a plan to a workspace (bypass payment).</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-3 gap-3">
                <Input
                  placeholder="Workspace ID (UUID)"
                  value={grantForm.workspaceId}
                  onChange={(e) => setGrantForm(f => ({ ...f, workspaceId: e.target.value }))}
                  className="bg-input border-border text-foreground placeholder:text-muted-foreground"
                />
                <Select value={grantForm.planId} onValueChange={(v) => setGrantForm(f => ({ ...f, planId: v }))}>
                  <SelectTrigger className="bg-input border-border text-foreground"><SelectValue placeholder="Select plan" /></SelectTrigger>
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
