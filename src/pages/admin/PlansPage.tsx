import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAdminPlans, useCreatePlan, useUpdatePlan, useDeletePlan, useAdminSubscriptions, useAssignPlan, useRevokePlan } from '@/hooks/usePlans';
import { useAdminWorkspaces } from '@/hooks/useAdmin';
import { Plus, Edit2, Trash2, Shield, CreditCard, Users, Loader2, CheckCircle, XCircle, Crown } from 'lucide-react';
import { toast } from 'sonner';

const DEFAULT_FEATURES = [
  'chat', 'knowledge_base', 'ai_assistant', 'visitor_tracking',
  'email_campaigns', 'automation', 'analytics', 'omnichannel',
  'custom_branding', 'api_access', 'voice_video', 'help_center',
];

const DEFAULT_LIMITS = [
  { key: 'agents', label: 'Max Agents', default: 1 },
  { key: 'contacts', label: 'Max Contacts', default: 100 },
  { key: 'ai_credits', label: 'AI Credits/mo', default: 0 },
  { key: 'conversations', label: 'Max Conversations/mo', default: 100 },
  { key: 'kb_articles', label: 'KB Articles', default: 10 },
  { key: 'file_storage_mb', label: 'Storage (MB)', default: 100 },
];

const CURRENCIES = ['USD', 'EUR', 'TRY', 'IRR'];

interface PlanFormData {
  name: string;
  slug: string;
  description: string;
  is_free: boolean;
  is_active: boolean;
  sort_order: number;
  trial_days: number;
  default_currency: string;
  prices: Record<string, { monthly: number; yearly: number }>;
  entitlements: Record<string, boolean>;
  limits: Record<string, number>;
  provider_price_ids: Record<string, any>;
}

function emptyPlan(): PlanFormData {
  return {
    name: '',
    slug: '',
    description: '',
    is_free: false,
    is_active: true,
    sort_order: 0,
    trial_days: 0,
    default_currency: 'USD',
    prices: { USD: { monthly: 0, yearly: 0 }, EUR: { monthly: 0, yearly: 0 }, TRY: { monthly: 0, yearly: 0 }, IRR: { monthly: 0, yearly: 0 } },
    entitlements: Object.fromEntries(DEFAULT_FEATURES.map(f => [f, false])),
    limits: Object.fromEntries(DEFAULT_LIMITS.map(l => [l.key, l.default])),
    provider_price_ids: {},
  };
}

function planToForm(plan: any): PlanFormData {
  return {
    name: plan.name || '',
    slug: plan.slug || '',
    description: plan.description || '',
    is_free: plan.is_free || false,
    is_active: plan.is_active !== false,
    sort_order: plan.sort_order || 0,
    trial_days: plan.trial_days || 0,
    default_currency: plan.default_currency || 'USD',
    prices: {
      USD: plan.prices?.USD || { monthly: 0, yearly: 0 },
      EUR: plan.prices?.EUR || { monthly: 0, yearly: 0 },
      TRY: plan.prices?.TRY || { monthly: 0, yearly: 0 },
      IRR: plan.prices?.IRR || { monthly: 0, yearly: 0 },
    },
    entitlements: { ...Object.fromEntries(DEFAULT_FEATURES.map(f => [f, false])), ...(plan.entitlements || {}) },
    limits: { ...Object.fromEntries(DEFAULT_LIMITS.map(l => [l.key, l.default])), ...(plan.limits || {}) },
    provider_price_ids: plan.provider_price_ids || {},
  };
}

function PlanFormDialog({ plan, onClose }: { plan?: any; onClose: () => void }) {
  const [form, setForm] = useState<PlanFormData>(plan ? planToForm(plan) : emptyPlan());
  const createPlan = useCreatePlan();
  const updatePlan = useUpdatePlan();
  const isEdit = !!plan?.id;

  async function handleSubmit() {
    if (!form.name || !form.slug) {
      toast.error('Name and slug are required');
      return;
    }
    try {
      if (isEdit) {
        await updatePlan.mutateAsync({ planId: plan.id, ...form });
        toast.success('Plan updated');
      } else {
        await createPlan.mutateAsync(form);
        toast.success('Plan created');
      }
      onClose();
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  const isPending = createPlan.isPending || updatePlan.isPending;

  return (
    <div className="space-y-6 max-h-[70vh] overflow-y-auto pr-2">
      {/* Basic Info */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label>Name</Label>
          <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Pro" />
        </div>
        <div>
          <Label>Slug</Label>
          <Input value={form.slug} onChange={e => setForm(f => ({ ...f, slug: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') }))} placeholder="pro" disabled={isEdit} />
        </div>
        <div className="col-span-2">
          <Label>Description</Label>
          <Textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="Best for growing teams" rows={2} />
        </div>
        <div>
          <Label>Sort Order</Label>
          <Input type="number" value={form.sort_order} onChange={e => setForm(f => ({ ...f, sort_order: parseInt(e.target.value) || 0 }))} />
        </div>
        <div>
          <Label>Trial Days</Label>
          <Input type="number" value={form.trial_days} onChange={e => setForm(f => ({ ...f, trial_days: parseInt(e.target.value) || 0 }))} />
        </div>
        <div className="flex items-center gap-3">
          <Switch checked={form.is_free} onCheckedChange={v => setForm(f => ({ ...f, is_free: v }))} />
          <Label>Free Plan</Label>
        </div>
        <div className="flex items-center gap-3">
          <Switch checked={form.is_active} onCheckedChange={v => setForm(f => ({ ...f, is_active: v }))} />
          <Label>Active</Label>
        </div>
      </div>

      {/* Pricing */}
      <div>
        <h3 className="text-sm font-semibold text-foreground mb-2">Pricing</h3>
        <div className="grid grid-cols-2 gap-3">
          {CURRENCIES.map(cur => (
            <Card key={cur} className="bg-muted/30">
              <CardContent className="pt-3 pb-3 space-y-2">
                <p className="text-xs font-semibold text-muted-foreground">{cur}</p>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label className="text-xs">Monthly</Label>
                    <Input
                      type="number"
                      value={form.prices[cur]?.monthly || 0}
                      onChange={e => setForm(f => ({
                        ...f,
                        prices: { ...f.prices, [cur]: { ...f.prices[cur], monthly: parseInt(e.target.value) || 0 } },
                      }))}
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Yearly</Label>
                    <Input
                      type="number"
                      value={form.prices[cur]?.yearly || 0}
                      onChange={e => setForm(f => ({
                        ...f,
                        prices: { ...f.prices, [cur]: { ...f.prices[cur], yearly: parseInt(e.target.value) || 0 } },
                      }))}
                    />
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      {/* Feature Entitlements */}
      <div>
        <h3 className="text-sm font-semibold text-foreground mb-2">Feature Entitlements</h3>
        <div className="grid grid-cols-2 gap-2">
          {DEFAULT_FEATURES.map(feat => (
            <div key={feat} className="flex items-center gap-2 py-1">
              <Switch
                checked={form.entitlements[feat] || false}
                onCheckedChange={v => setForm(f => ({
                  ...f,
                  entitlements: { ...f.entitlements, [feat]: v },
                }))}
              />
              <span className="text-sm text-foreground">{feat.replace(/_/g, ' ')}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Limits */}
      <div>
        <h3 className="text-sm font-semibold text-foreground mb-2">Limits <span className="text-muted-foreground text-xs">(-1 = unlimited)</span></h3>
        <div className="grid grid-cols-2 gap-3">
          {DEFAULT_LIMITS.map(lim => (
            <div key={lim.key}>
              <Label className="text-xs">{lim.label}</Label>
              <Input
                type="number"
                value={form.limits[lim.key] ?? lim.default}
                onChange={e => setForm(f => ({
                  ...f,
                  limits: { ...f.limits, [lim.key]: parseInt(e.target.value) || 0 },
                }))}
              />
            </div>
          ))}
        </div>
      </div>

      <Button onClick={handleSubmit} disabled={isPending} className="w-full">
        {isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
        {isEdit ? 'Update Plan' : 'Create Plan'}
      </Button>
    </div>
  );
}

export default function AdminPlansPage() {
  const { data: plans, isLoading } = useAdminPlans();
  const { data: subscriptions } = useAdminSubscriptions();
  const { data: workspaces } = useAdminWorkspaces();
  const deletePlan = useDeletePlan();
  const assignPlan = useAssignPlan();
  const revokePlan = useRevokePlan();

  const [editPlan, setEditPlan] = useState<any>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [assignForm, setAssignForm] = useState({ workspaceId: '', planId: '' });

  if (isLoading) {
    return <div className="flex items-center justify-center py-20"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>;
  }

  async function handleDelete(planId: string) {
    if (!confirm('Deactivate this plan? Existing subscribers will not be affected.')) return;
    try {
      await deletePlan.mutateAsync(planId);
      toast.success('Plan deactivated');
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  async function handleAssign() {
    if (!assignForm.workspaceId || !assignForm.planId) return;
    try {
      await assignPlan.mutateAsync({ workspaceId: assignForm.workspaceId, planId: assignForm.planId });
      toast.success('Plan assigned');
      setAssignForm({ workspaceId: '', planId: '' });
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  async function handleRevoke(wsId: string) {
    if (!confirm('Revoke this workspace subscription?')) return;
    try {
      await revokePlan.mutateAsync(wsId);
      toast.success('Subscription revoked');
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Plan Management</h1>
          <p className="text-muted-foreground text-sm">Create, edit, and manage subscription plans. Assign plans to workspaces.</p>
        </div>
        <Dialog open={showCreate} onOpenChange={setShowCreate}>
          <DialogTrigger asChild>
            <Button><Plus className="w-4 h-4 mr-2" /> Create Plan</Button>
          </DialogTrigger>
          <DialogContent className="max-w-2xl">
            <DialogHeader><DialogTitle>Create Plan</DialogTitle></DialogHeader>
            <PlanFormDialog onClose={() => setShowCreate(false)} />
          </DialogContent>
        </Dialog>
      </div>

      <Tabs defaultValue="plans">
        <TabsList className="bg-muted">
          <TabsTrigger value="plans" className="data-[state=active]:bg-sidebar-accent data-[state=active]:text-foreground text-muted-foreground">
            Plans ({plans?.length || 0})
          </TabsTrigger>
          <TabsTrigger value="subscriptions" className="data-[state=active]:bg-sidebar-accent data-[state=active]:text-foreground text-muted-foreground">
            Subscriptions ({subscriptions?.length || 0})
          </TabsTrigger>
          <TabsTrigger value="assign" className="data-[state=active]:bg-sidebar-accent data-[state=active]:text-foreground text-muted-foreground">
            Assign Plan
          </TabsTrigger>
        </TabsList>

        {/* Plans Tab */}
        <TabsContent value="plans" className="space-y-4">
          <div className="grid gap-4">
            {(plans || []).map((plan: any) => (
              <Card key={plan.id} className={`bg-card border-border ${!plan.is_active ? 'opacity-50' : ''}`}>
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <Crown className="w-5 h-5 text-primary" />
                      <div>
                        <CardTitle className="text-base">{plan.name}</CardTitle>
                        <CardDescription>{plan.slug} {plan.is_free && <Badge variant="secondary" className="ml-2">Free</Badge>}</CardDescription>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant={plan.is_active ? 'default' : 'destructive'}>
                        {plan.is_active ? 'Active' : 'Inactive'}
                      </Badge>
                      <Dialog open={editPlan?.id === plan.id} onOpenChange={v => !v && setEditPlan(null)}>
                        <DialogTrigger asChild>
                          <Button variant="ghost" size="sm" onClick={() => setEditPlan(plan)}>
                            <Edit2 className="w-4 h-4" />
                          </Button>
                        </DialogTrigger>
                        <DialogContent className="max-w-2xl">
                          <DialogHeader><DialogTitle>Edit Plan: {plan.name}</DialogTitle></DialogHeader>
                          <PlanFormDialog plan={plan} onClose={() => setEditPlan(null)} />
                        </DialogContent>
                      </Dialog>
                      <Button variant="ghost" size="sm" onClick={() => handleDelete(plan.id)} disabled={deletePlan.isPending}>
                        <Trash2 className="w-4 h-4 text-destructive" />
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    {/* Pricing summary */}
                    {CURRENCIES.map(cur => {
                      const p = plan.prices?.[cur];
                      if (!p?.monthly && !p?.yearly) return null;
                      return (
                        <div key={cur} className="text-sm">
                          <span className="text-muted-foreground">{cur}:</span>{' '}
                          <span className="text-foreground font-medium">{p.monthly}/mo</span>
                          {p.yearly ? <span className="text-muted-foreground"> · {p.yearly}/yr</span> : null}
                        </div>
                      );
                    })}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1">
                    {Object.entries(plan.entitlements || {}).map(([k, v]) => (
                      <Badge key={k} variant={v ? 'default' : 'outline'} className="text-xs">
                        {v ? <CheckCircle className="w-3 h-3 mr-1" /> : <XCircle className="w-3 h-3 mr-1" />}
                        {k.replace(/_/g, ' ')}
                      </Badge>
                    ))}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {Object.entries(plan.limits || {}).map(([k, v]) => (
                      <Badge key={k} variant="secondary" className="text-xs">
                        {k.replace(/_/g, ' ')}: {(v as number) === -1 ? '∞' : String(v)}
                      </Badge>
                    ))}
                  </div>
                </CardContent>
              </Card>
            ))}
            {(!plans || plans.length === 0) && (
              <Card className="bg-card border-border">
                <CardContent className="py-12 text-center text-muted-foreground">
                  <CreditCard className="w-8 h-8 mx-auto mb-2 opacity-40" />
                  <p>No plans created yet. Click "Create Plan" to get started.</p>
                </CardContent>
              </Card>
            )}
          </div>
        </TabsContent>

        {/* Subscriptions Tab */}
        <TabsContent value="subscriptions">
          <Card className="bg-card border-border">
            <Table>
              <TableHeader>
                <TableRow className="border-border">
                  <TableHead className="text-muted-foreground">Workspace</TableHead>
                  <TableHead className="text-muted-foreground">Plan</TableHead>
                  <TableHead className="text-muted-foreground">Status</TableHead>
                  <TableHead className="text-muted-foreground">Provider</TableHead>
                  <TableHead className="text-muted-foreground">Period End</TableHead>
                  <TableHead className="text-muted-foreground">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(!subscriptions || subscriptions.length === 0) ? (
                  <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">No subscriptions</TableCell></TableRow>
                ) : subscriptions.map((sub: any) => (
                  <TableRow key={sub.id} className="border-border hover:bg-muted/50">
                    <TableCell className="font-mono text-xs text-foreground">{sub.workspace_id?.slice(0, 8)}...</TableCell>
                    <TableCell className="text-foreground">{sub.billing_plans?.name || sub.plan_id?.slice(0, 8)}</TableCell>
                    <TableCell>
                      <Badge variant={sub.status === 'active' ? 'default' : sub.status === 'trialing' ? 'secondary' : 'destructive'}>
                        {sub.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{sub.provider_name}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {sub.current_period_end ? new Date(sub.current_period_end).toLocaleDateString() : '—'}
                    </TableCell>
                    <TableCell>
                      <Button variant="ghost" size="sm" onClick={() => handleRevoke(sub.workspace_id)} className="text-destructive">
                        Revoke
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>

        {/* Assign Tab */}
        <TabsContent value="assign">
          <Card className="bg-card border-border">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Shield className="w-4 h-4" /> Assign Plan to Workspace
              </CardTitle>
              <CardDescription>Manually assign a plan (bypasses payment).</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <Label>Workspace</Label>
                  <Select value={assignForm.workspaceId} onValueChange={v => setAssignForm(f => ({ ...f, workspaceId: v }))}>
                    <SelectTrigger><SelectValue placeholder="Select workspace" /></SelectTrigger>
                    <SelectContent>
                      {(workspaces || []).map((w: any) => (
                        <SelectItem key={w.id} value={w.id}>{w.name} ({w.slug})</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Plan</Label>
                  <Select value={assignForm.planId} onValueChange={v => setAssignForm(f => ({ ...f, planId: v }))}>
                    <SelectTrigger><SelectValue placeholder="Select plan" /></SelectTrigger>
                    <SelectContent>
                      {(plans || []).filter((p: any) => p.is_active).map((p: any) => (
                        <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-end">
                  <Button onClick={handleAssign} disabled={!assignForm.workspaceId || !assignForm.planId || assignPlan.isPending}>
                    {assignPlan.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Users className="w-4 h-4 mr-2" />}
                    Assign
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
