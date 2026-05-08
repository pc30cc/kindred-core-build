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
import { Separator } from '@/components/ui/separator';
import { useAdminPlans, useCreatePlan, useUpdatePlan, useDeletePlan, useAdminSubscriptions, useAssignPlan, useRevokePlan } from '@/hooks/usePlans';
import { useAdminWorkspaces } from '@/hooks/useAdmin';
import { supabase } from '@/lib/supabase';
import {
  Plus, Edit2, Trash2, Shield, CreditCard, Users, Loader2,
  CheckCircle2, XCircle, Crown, Globe, Languages,
  MessageSquare, BookOpen, Bot, Eye, Mail, Zap, BarChart3,
  Radio, Palette, Code2, Phone, HelpCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { useQuery } from '@tanstack/react-query';

// ─── Feature definitions with icons & labels ───
const FEATURE_DEFS = [
  { key: 'chat', label: 'Chat', icon: MessageSquare },
  { key: 'knowledge_base', label: 'Knowledge Base', icon: BookOpen },
  { key: 'ai_assistant', label: 'AI Assistant', icon: Bot },
  { key: 'visitor_tracking', label: 'Visitor Tracking', icon: Eye },
  { key: 'email_campaigns', label: 'Email Campaigns', icon: Mail },
  { key: 'automation', label: 'Automation', icon: Zap },
  { key: 'analytics', label: 'Analytics', icon: BarChart3 },
  { key: 'omnichannel', label: 'Omnichannel', icon: Radio },
  { key: 'custom_branding', label: 'Custom Branding', icon: Palette },
  { key: 'api_access', label: 'API Access', icon: Code2 },
  { key: 'voice_video', label: 'Voice & Video', icon: Phone },
  { key: 'help_center', label: 'Help Center', icon: HelpCircle },
  { key: 'ai_operator_assist', label: 'AI Operator Assist', icon: Bot },
];

const DEFAULT_LIMITS = [
  { key: 'agents', label: 'Max Agents', default: 1 },
  { key: 'contacts', label: 'Max Contacts', default: 100 },
  { key: 'ai_credits', label: 'AI Credits/mo', default: 0 },
  { key: 'conversations', label: 'Max Conversations/mo', default: 100 },
  { key: 'kb_articles', label: 'KB Articles', default: 10 },
  { key: 'file_storage_mb', label: 'Storage (MB)', default: 100 },
  { key: 'ai_operator_suggestions', label: 'AI Operator Suggestions/mo', default: 0 },
];

const CURRENCIES = ['USD', 'EUR', 'TRY', 'IRR'];

const LOCALE_LABELS: Record<string, string> = {
  en: '🇬🇧 English', tr: '🇹🇷 Türkçe', fa: '🇮🇷 فارسی',
  de: '🇩🇪 Deutsch', fr: '🇫🇷 Français', ar: '🇸🇦 العربية',
};

interface LocalizedPlan { name: string; description: string; }

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
  localized: Record<string, LocalizedPlan>;
}

function usePlatformLocales() {
  return useQuery({
    queryKey: ['platform-settings-locales'],
    queryFn: async () => {
      const { data } = await supabase
        .from('platform_settings')
        .select('active_locales')
        .limit(1)
        .maybeSingle();
      return { locales: (data?.active_locales || ['en']) as string[] };
    },
  });
}

function emptyPlan(locales: string[]): PlanFormData {
  return {
    name: '', slug: '', description: '',
    is_free: false, is_active: true, sort_order: 0, trial_days: 0,
    default_currency: 'USD',
    prices: Object.fromEntries(CURRENCIES.map(c => [c, { monthly: 0, yearly: 0 }])),
    entitlements: Object.fromEntries(FEATURE_DEFS.map(f => [f.key, false])),
    limits: Object.fromEntries(DEFAULT_LIMITS.map(l => [l.key, l.default])),
    provider_price_ids: {},
    localized: Object.fromEntries(locales.map(l => [l, { name: '', description: '' }])),
  };
}

function planToForm(plan: any, locales: string[]): PlanFormData {
  const existingLocalized = (plan.localized || {}) as Record<string, LocalizedPlan>;
  return {
    name: plan.name || '', slug: plan.slug || '', description: plan.description || '',
    is_free: plan.is_free || false, is_active: plan.is_active !== false,
    sort_order: plan.sort_order || 0, trial_days: plan.trial_days || 0,
    default_currency: plan.default_currency || 'USD',
    prices: { ...Object.fromEntries(CURRENCIES.map(c => [c, { monthly: 0, yearly: 0 }])), ...(plan.prices || {}) },
    entitlements: { ...Object.fromEntries(FEATURE_DEFS.map(f => [f.key, false])), ...(plan.entitlements || {}) },
    limits: { ...Object.fromEntries(DEFAULT_LIMITS.map(l => [l.key, l.default])), ...(plan.limits || {}) },
    provider_price_ids: plan.provider_price_ids || {},
    localized: Object.fromEntries(locales.map(l => [l, existingLocalized[l] || { name: '', description: '' }])),
  };
}

// ─── Plan Form Dialog ───
function PlanFormDialog({ plan, onClose, locales }: { plan?: any; onClose: () => void; locales: string[] }) {
  const [form, setForm] = useState<PlanFormData>(plan ? planToForm(plan, locales) : emptyPlan(locales));
  const [activeSection, setActiveSection] = useState('general');
  const createPlan = useCreatePlan();
  const updatePlan = useUpdatePlan();
  const isEdit = !!plan?.id;
  const isPending = createPlan.isPending || updatePlan.isPending;

  async function handleSubmit() {
    if (!form.name || !form.slug) { toast.error('Name and slug are required'); return; }
    try {
      if (isEdit) {
        await updatePlan.mutateAsync({ planId: plan.id, ...form });
        toast.success('Plan updated');
      } else {
        await createPlan.mutateAsync(form);
        toast.success('Plan created');
      }
      onClose();
    } catch (e: any) { toast.error(e.message); }
  }

  function updateLocalized(locale: string, field: string, value: string) {
    setForm(f => ({ ...f, localized: { ...f.localized, [locale]: { ...f.localized[locale], [field]: value } } }));
  }

  const sections = [
    { id: 'general', label: 'General' },
    { id: 'features', label: 'Features' },
    { id: 'limits', label: 'Limits' },
    { id: 'pricing', label: 'Pricing' },
    { id: 'locales', label: 'Translations' },
  ];

  return (
    <div className="flex flex-col max-h-[75vh]">
      {/* Section nav */}
      <div className="flex gap-1 border-b border-border pb-2 mb-4 overflow-x-auto">
        {sections.map(s => (
          <Button
            key={s.id}
            variant={activeSection === s.id ? 'default' : 'ghost'}
            size="sm"
            className="text-xs shrink-0"
            onClick={() => setActiveSection(s.id)}
          >
            {s.label}
          </Button>
        ))}
      </div>

      <div className="overflow-y-auto flex-1 pr-1 space-y-4">
        {/* General */}
        {activeSection === 'general' && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Plan Name</Label>
                <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Pro" />
              </div>
              <div>
                <Label>Slug</Label>
                <Input value={form.slug} onChange={e => setForm(f => ({ ...f, slug: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') }))} placeholder="pro" disabled={isEdit} />
              </div>
            </div>
            <div>
              <Label>Description</Label>
              <Textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} rows={2} placeholder="Best for growing teams" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Sort Order</Label>
                <Input type="number" value={form.sort_order} onChange={e => setForm(f => ({ ...f, sort_order: parseInt(e.target.value) || 0 }))} />
              </div>
              <div>
                <Label>Trial Days</Label>
                <Input type="number" value={form.trial_days} onChange={e => setForm(f => ({ ...f, trial_days: parseInt(e.target.value) || 0 }))} />
              </div>
            </div>
            <Separator />
            <div className="flex gap-6">
              <div className="flex items-center gap-2">
                <Switch checked={form.is_free} onCheckedChange={v => setForm(f => ({ ...f, is_free: v }))} />
                <Label>Free Plan</Label>
              </div>
              <div className="flex items-center gap-2">
                <Switch checked={form.is_active} onCheckedChange={v => setForm(f => ({ ...f, is_active: v }))} />
                <Label>Active</Label>
              </div>
            </div>
          </div>
        )}

        {/* Features */}
        {activeSection === 'features' && (
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground mb-3">Toggle which features are included in this plan.</p>
            <div className="grid grid-cols-1 gap-0.5">
              {FEATURE_DEFS.map(feat => {
                const Icon = feat.icon;
                const enabled = form.entitlements[feat.key] || false;
                return (
                  <div
                    key={feat.key}
                    className={`flex items-center justify-between px-3 py-2.5 rounded-lg border transition-colors cursor-pointer ${enabled ? 'border-primary/30 bg-primary/5' : 'border-transparent bg-muted/30 hover:bg-muted/50'}`}
                    onClick={() => setForm(f => ({ ...f, entitlements: { ...f.entitlements, [feat.key]: !enabled } }))}
                  >
                    <div className="flex items-center gap-3">
                      <Icon className={`w-4 h-4 ${enabled ? 'text-primary' : 'text-muted-foreground'}`} />
                      <span className={`text-sm font-medium ${enabled ? 'text-foreground' : 'text-muted-foreground'}`}>{feat.label}</span>
                    </div>
                    <Switch checked={enabled} onCheckedChange={v => setForm(f => ({ ...f, entitlements: { ...f.entitlements, [feat.key]: v } }))} />
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Limits */}
        {activeSection === 'limits' && (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">Set numeric limits. Use <code className="bg-muted px-1 rounded">-1</code> for unlimited.</p>
            <div className="grid grid-cols-2 gap-3">
              {DEFAULT_LIMITS.map(lim => (
                <div key={lim.key} className="space-y-1">
                  <Label className="text-xs">{lim.label}</Label>
                  <Input
                    type="number"
                    value={form.limits[lim.key] ?? lim.default}
                    onChange={e => setForm(f => ({ ...f, limits: { ...f.limits, [lim.key]: parseInt(e.target.value) || 0 } }))}
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Pricing */}
        {activeSection === 'pricing' && (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">Set pricing per currency. Payment gateway is auto-selected based on locale provider settings.</p>
            <div className="grid grid-cols-2 gap-3">
              {CURRENCIES.map(cur => (
                <Card key={cur} className="bg-muted/20 border-border">
                  <CardContent className="pt-3 pb-3 space-y-2">
                    <p className="text-xs font-bold text-foreground">{cur}</p>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <Label className="text-[11px]">Monthly</Label>
                        <Input type="number" value={form.prices[cur]?.monthly || 0}
                          onChange={e => setForm(f => ({ ...f, prices: { ...f.prices, [cur]: { ...f.prices[cur], monthly: parseInt(e.target.value) || 0 } } }))} />
                      </div>
                      <div>
                        <Label className="text-[11px]">Yearly</Label>
                        <Input type="number" value={form.prices[cur]?.yearly || 0}
                          onChange={e => setForm(f => ({ ...f, prices: { ...f.prices, [cur]: { ...f.prices[cur], yearly: parseInt(e.target.value) || 0 } } }))} />
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        )}

        {/* Translations */}
        {activeSection === 'locales' && (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">Localized plan names and descriptions per language.</p>
            {locales.map(loc => (
              <Card key={loc} className="bg-muted/20 border-border">
                <CardContent className="pt-3 pb-3 space-y-2">
                  <p className="text-xs font-bold text-foreground">{LOCALE_LABELS[loc] || loc.toUpperCase()}</p>
                  <div className="grid grid-cols-1 gap-2">
                    <div>
                      <Label className="text-[11px]">Plan Name</Label>
                      <Input
                        value={form.localized[loc]?.name || ''}
                        onChange={e => updateLocalized(loc, 'name', e.target.value)}
                        placeholder={`Plan name in ${loc}`}
                        dir={loc === 'fa' || loc === 'ar' ? 'rtl' : 'ltr'}
                      />
                    </div>
                    <div>
                      <Label className="text-[11px]">Description</Label>
                      <Textarea
                        value={form.localized[loc]?.description || ''}
                        onChange={e => updateLocalized(loc, 'description', e.target.value)}
                        placeholder={`Description in ${loc}`}
                        rows={2}
                        dir={loc === 'fa' || loc === 'ar' ? 'rtl' : 'ltr'}
                      />
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Submit */}
      <div className="pt-4 border-t border-border mt-4">
        <Button onClick={handleSubmit} disabled={isPending} className="w-full">
          {isPending && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
          {isEdit ? 'Update Plan' : 'Create Plan'}
        </Button>
      </div>
    </div>
  );
}

// ─── Feature chip for plan cards ───
function FeatureChip({ featureKey, enabled }: { featureKey: string; enabled: boolean }) {
  const def = FEATURE_DEFS.find(f => f.key === featureKey);
  if (!def) return null;
  const Icon = def.icon;
  return (
    <div className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium transition-colors ${enabled ? 'bg-primary/10 text-primary border border-primary/20' : 'bg-muted/50 text-muted-foreground border border-transparent'}`}>
      <Icon className="w-3 h-3" />
      {def.label}
      {enabled ? <CheckCircle2 className="w-3 h-3 ml-0.5" /> : <XCircle className="w-3 h-3 ml-0.5 opacity-40" />}
    </div>
  );
}

// ─── Main Page ───
export default function AdminPlansPage() {
  const { data: plans, isLoading } = useAdminPlans();
  const { data: subscriptions } = useAdminSubscriptions();
  const { data: workspaces } = useAdminWorkspaces();
  const { data: platformConfig } = usePlatformLocales();
  const deletePlan = useDeletePlan();
  const assignPlan = useAssignPlan();
  const revokePlan = useRevokePlan();

  const locales = platformConfig?.locales || ['en'];

  const [editPlan, setEditPlan] = useState<any>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [assignForm, setAssignForm] = useState({ workspaceId: '', planId: '' });

  if (isLoading) {
    return <div className="flex items-center justify-center py-20"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>;
  }

  async function handleDelete(planId: string) {
    if (!confirm('Deactivate this plan?')) return;
    try { await deletePlan.mutateAsync(planId); toast.success('Plan deactivated'); } catch (e: any) { toast.error(e.message); }
  }

  async function handleAssign() {
    if (!assignForm.workspaceId || !assignForm.planId) return;
    try {
      await assignPlan.mutateAsync({ workspaceId: assignForm.workspaceId, planId: assignForm.planId });
      toast.success('Plan assigned');
      setAssignForm({ workspaceId: '', planId: '' });
    } catch (e: any) { toast.error(e.message); }
  }

  async function handleRevoke(wsId: string) {
    if (!confirm('Revoke this workspace subscription?')) return;
    try { await revokePlan.mutateAsync(wsId); toast.success('Revoked'); } catch (e: any) { toast.error(e.message); }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Plan Management</h1>
          <p className="text-muted-foreground text-sm">Manage subscription plans, features, and pricing. Payment gateways are auto-selected per locale from Provider settings.</p>
        </div>
        <Dialog open={showCreate} onOpenChange={setShowCreate}>
          <DialogTrigger asChild>
            <Button><Plus className="w-4 h-4 mr-2" /> Create Plan</Button>
          </DialogTrigger>
          <DialogContent className="max-w-2xl">
            <DialogHeader><DialogTitle>Create New Plan</DialogTitle></DialogHeader>
            <PlanFormDialog onClose={() => setShowCreate(false)} locales={locales} />
          </DialogContent>
        </Dialog>
      </div>

      <Tabs defaultValue="plans">
        <TabsList className="bg-muted">
          <TabsTrigger value="plans" className="data-[state=active]:bg-sidebar-accent data-[state=active]:text-foreground text-muted-foreground">
            <CreditCard className="w-3.5 h-3.5 mr-1.5" /> Plans ({plans?.length || 0})
          </TabsTrigger>
          <TabsTrigger value="subscriptions" className="data-[state=active]:bg-sidebar-accent data-[state=active]:text-foreground text-muted-foreground">
            <Users className="w-3.5 h-3.5 mr-1.5" /> Subscriptions ({subscriptions?.length || 0})
          </TabsTrigger>
          <TabsTrigger value="assign" className="data-[state=active]:bg-sidebar-accent data-[state=active]:text-foreground text-muted-foreground">
            <Shield className="w-3.5 h-3.5 mr-1.5" /> Assign Plan
          </TabsTrigger>
        </TabsList>

        {/* ─── Plans Tab ─── */}
        <TabsContent value="plans" className="space-y-4">
          {(!plans || plans.length === 0) ? (
            <Card className="bg-card border-border">
              <CardContent className="py-16 text-center text-muted-foreground">
                <CreditCard className="w-10 h-10 mx-auto mb-3 opacity-30" />
                <p className="text-lg font-medium">No plans yet</p>
                <p className="text-sm">Click "Create Plan" to get started.</p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-4">
              {(plans || []).map((plan: any) => {
                const localized = (plan.localized || {}) as Record<string, LocalizedPlan>;
                const entitlements = (plan.entitlements || {}) as Record<string, boolean>;
                const limits = (plan.limits || {}) as Record<string, number>;
                const enabledCount = Object.values(entitlements).filter(Boolean).length;

                return (
                  <Card key={plan.id} className={`bg-card border-border transition-opacity ${!plan.is_active ? 'opacity-50' : ''}`}>
                    <CardHeader className="pb-2">
                      <div className="flex items-start justify-between">
                        <div className="flex items-center gap-3">
                          <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${plan.is_free ? 'bg-muted' : 'bg-primary/10'}`}>
                            <Crown className={`w-5 h-5 ${plan.is_free ? 'text-muted-foreground' : 'text-primary'}`} />
                          </div>
                          <div>
                            <div className="flex items-center gap-2">
                              <CardTitle className="text-lg">{plan.name}</CardTitle>
                              <Badge variant="outline" className="text-[10px] font-mono">{plan.slug}</Badge>
                              {plan.is_free && <Badge variant="secondary" className="text-[10px]">Free</Badge>}
                              {plan.trial_days > 0 && <Badge variant="outline" className="text-[10px]">{plan.trial_days}d trial</Badge>}
                            </div>
                            <CardDescription className="text-xs mt-0.5">{plan.description || 'No description'}</CardDescription>
                          </div>
                        </div>
                        <div className="flex items-center gap-1">
                          <Badge variant={plan.is_active ? 'default' : 'destructive'} className="text-[10px]">
                            {plan.is_active ? 'Active' : 'Inactive'}
                          </Badge>
                          <Dialog open={editPlan?.id === plan.id} onOpenChange={v => !v && setEditPlan(null)}>
                            <DialogTrigger asChild>
                              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setEditPlan(plan)}>
                                <Edit2 className="w-3.5 h-3.5" />
                              </Button>
                            </DialogTrigger>
                            <DialogContent className="max-w-2xl">
                              <DialogHeader><DialogTitle>Edit: {plan.name}</DialogTitle></DialogHeader>
                              <PlanFormDialog plan={plan} onClose={() => setEditPlan(null)} locales={locales} />
                            </DialogContent>
                          </Dialog>
                          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => handleDelete(plan.id)} disabled={deletePlan.isPending}>
                            <Trash2 className="w-3.5 h-3.5 text-destructive" />
                          </Button>
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {/* Locales */}
                      {Object.keys(localized).some(l => localized[l]?.name) && (
                        <div className="flex flex-wrap gap-1.5">
                          {Object.entries(localized).map(([loc, data]) => data.name ? (
                            <Badge key={loc} variant="outline" className="text-[11px] gap-1 font-normal">
                              <Globe className="w-3 h-3" />
                              {LOCALE_LABELS[loc]?.split(' ')[0] || loc} {data.name}
                            </Badge>
                          ) : null)}
                        </div>
                      )}

                      {/* Pricing summary */}
                      {!plan.is_free && (
                        <div className="flex flex-wrap gap-3">
                          {CURRENCIES.map(cur => {
                            const p = plan.prices?.[cur];
                            if (!p?.monthly && !p?.yearly) return null;
                            return (
                              <div key={cur} className="bg-muted/40 rounded-lg px-3 py-1.5 text-sm">
                                <span className="font-bold text-foreground">{cur}</span>
                                <span className="text-muted-foreground ml-1.5">{p.monthly?.toLocaleString()}/mo</span>
                                {p.yearly > 0 && <span className="text-muted-foreground"> · {p.yearly?.toLocaleString()}/yr</span>}
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {/* Feature entitlements */}
                      <div>
                        <p className="text-[11px] text-muted-foreground mb-1.5 font-medium">
                          Features ({enabledCount}/{FEATURE_DEFS.length})
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {FEATURE_DEFS.map(feat => (
                            <FeatureChip key={feat.key} featureKey={feat.key} enabled={entitlements[feat.key] || false} />
                          ))}
                        </div>
                      </div>

                      {/* Limits */}
                      <div className="flex flex-wrap gap-1.5">
                        {DEFAULT_LIMITS.map(lim => {
                          const val = limits[lim.key];
                          if (val === undefined) return null;
                          return (
                            <Badge key={lim.key} variant="secondary" className="text-[11px] font-normal">
                              {lim.label}: {val === -1 ? '∞' : val?.toLocaleString()}
                            </Badge>
                          );
                        })}
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </TabsContent>

        {/* ─── Subscriptions Tab ─── */}
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
                      <Button variant="ghost" size="sm" onClick={() => handleRevoke(sub.workspace_id)} className="text-destructive text-xs">
                        Revoke
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>

        {/* ─── Assign Tab ─── */}
        <TabsContent value="assign">
          <Card className="bg-card border-border">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2"><Shield className="w-4 h-4" /> Assign Plan to Workspace</CardTitle>
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
