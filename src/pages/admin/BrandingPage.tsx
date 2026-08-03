import React, { useState, useEffect } from 'react';
import EmailTemplatesTab from '@/components/admin/EmailTemplatesTab';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter,
} from '@/components/ui/dialog';
import { toast } from '@/hooks/use-toast';
import { Loader2, Palette, Type, Link2, Save, Eye, Mail, Plus, Pencil, Trash2, Settings2 } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import {
  usePlatformBranding,
  useUpdatePlatformBranding,
  usePlatformBrandingLocalized,
  useUpsertPlatformBrandingLocalized,
  usePlatformDomains,
  useUpdatePlatformDomains,
  type PlatformBranding,
  type PlatformBrandingLocalized,
  type PlatformDomains,
} from '@/hooks/usePlatformBranding';

// ── Reusable field row ──
function FieldRow({
  label, desc, value, onChange, type = 'text', placeholder,
}: {
  label: string; desc?: string; value: string; onChange: (v: string) => void; type?: string; placeholder?: string;
}) {
  return (
    <div className="grid gap-1.5">
      <Label className="text-sm font-medium text-foreground">{label}</Label>
      {desc && <p className="text-xs text-muted-foreground">{desc}</p>}
      <div className="flex gap-2">
        {type === 'color' ? (
          <>
            <Input type="color" value={value || '#3B82F6'} onChange={(e) => onChange(e.target.value)} className="w-12 h-10 p-1 shrink-0" />
            <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder="#3B82F6" className="font-mono" />
          </>
        ) : (
          <Input type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
        )}
      </div>
    </div>
  );
}

// ── Visual Identity Section ──
function VisualIdentitySection() {
  const { data: branding, isLoading } = usePlatformBranding();
  const update = useUpdatePlatformBranding();
  const [form, setForm] = useState<Partial<PlatformBranding>>({});
  const [dirty, setDirty] = useState(false);

  useEffect(() => { if (branding) { setForm(branding); setDirty(false); } }, [branding]);

  const set = (key: keyof PlatformBranding, val: string) => { setForm((p) => ({ ...p, [key]: val })); setDirty(true); };

  const handleSave = () => {
    const { id, created_at, updated_at, ...rest } = form as any;
    update.mutate(rest, {
      onSuccess: () => { toast({ title: 'Visual identity saved' }); setDirty(false); },
      onError: (e) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
    });
  };

  if (isLoading) return <LoadingCard />;

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2"><Palette className="h-5 w-5 text-primary" /><CardTitle className="text-foreground">Visual Identity</CardTitle></div>
          <Button size="sm" onClick={handleSave} disabled={!dirty || update.isPending}>
            {update.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Save className="h-4 w-4 mr-1" />}Save
          </Button>
        </div>
        <CardDescription>Logo, colors, and favicon for the entire platform.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-5 md:grid-cols-2">
          <FieldRow label="Logo URL" desc="Platform logo displayed in header and emails" value={form.logo_url ?? ''} onChange={(v) => set('logo_url', v)} placeholder="https://cdn.example.com/logo.svg" />
          <FieldRow label="Favicon URL" desc="Browser tab icon" value={form.favicon_url ?? ''} onChange={(v) => set('favicon_url', v)} placeholder="https://cdn.example.com/favicon.ico" />
          <FieldRow label="Primary Color" type="color" value={form.primary_color ?? '#3B82F6'} onChange={(v) => set('primary_color', v)} />
          <FieldRow label="Secondary Color" type="color" value={form.secondary_color ?? '#6366F1'} onChange={(v) => set('secondary_color', v)} />
          <FieldRow label="PWA Icon URL" desc="512x512 icon for progressive web app" value={form.pwa_icon_url ?? ''} onChange={(v) => set('pwa_icon_url', v)} placeholder="https://cdn.example.com/pwa-icon.png" />
        </div>
        {(form.logo_url || form.primary_color) && (
          <>
            <Separator />
            <div className="rounded-lg border border-border p-4">
              <p className="text-xs text-muted-foreground mb-3 flex items-center gap-1"><Eye className="h-3 w-3" /> Preview</p>
              <div className="flex items-center gap-3">
                {form.logo_url && <img src={form.logo_url} alt="Logo preview" className="h-10 max-w-[160px] object-contain rounded" onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')} />}
                <div className="flex gap-2">
                  <div className="w-8 h-8 rounded-md border border-border" style={{ backgroundColor: form.primary_color ?? '#3B82F6' }} title="Primary" />
                  <div className="w-8 h-8 rounded-md border border-border" style={{ backgroundColor: form.secondary_color ?? '#6366F1' }} title="Secondary" />
                </div>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ── Settings Section (was Localized Text) ──
const ALL_LOCALES = [
  { code: 'en', label: 'English', flag: '🇺🇸' },
  { code: 'fa', label: 'فارسی', flag: '🇮🇷' },
  { code: 'tr', label: 'Türkçe', flag: '🇹🇷' },
  { code: 'ar', label: 'العربية', flag: '🇸🇦' },
  { code: 'de', label: 'Deutsch', flag: '🇩🇪' },
  { code: 'fr', label: 'Français', flag: '🇫🇷' },
  { code: 'es', label: 'Español', flag: '🇪🇸' },
  { code: 'ru', label: 'Русский', flag: '🇷🇺' },
  { code: 'zh', label: '中文', flag: '🇨🇳' },
  { code: 'ja', label: '日本語', flag: '🇯🇵' },
  { code: 'ko', label: '한국어', flag: '🇰🇷' },
  { code: 'pt', label: 'Português', flag: '🇧🇷' },
  { code: 'it', label: 'Italiano', flag: '🇮🇹' },
  { code: 'nl', label: 'Nederlands', flag: '🇳🇱' },
  { code: 'hi', label: 'हिन्दी', flag: '🇮🇳' },
  { code: 'ku', label: 'کوردی', flag: '🏳️' },
];

const BILLING_PROVIDERS = [
  { value: 'none', label: 'No Payment Gateway' },
  { value: 'stripe', label: 'Stripe' },
  { value: 'paypal', label: 'PayPal' },
  { value: 'paddle', label: 'Paddle' },
  { value: 'zarinpal', label: 'ZarinPal' },
  { value: 'payping', label: 'PayPing' },
  { value: 'nextpay', label: 'NextPay' },
  { value: 'idpay', label: 'IDPay' },
  { value: 'sep', label: 'SEP (Saman)' },
  { value: 'zibal', label: 'Zibal' },
  { value: 'iyzico', label: 'iyzico' },
  { value: 'paytr', label: 'PayTR' },
  { value: 'craftgate', label: 'Craftgate' },
  { value: 'sipay', label: 'Sipay' },
  { value: 'paratika', label: 'Paratika' },
  { value: 'lemonsqueezy', label: 'Lemon Squeezy' },
];

const LOCALIZED_FIELDS: { key: keyof PlatformBrandingLocalized; label: string; desc?: string }[] = [
  { key: 'platform_name', label: 'Platform Name', desc: 'Main name shown in header, emails, and browser tab' },
  { key: 'meta_title', label: 'Meta Title', desc: 'Default SEO page title (also used as app title)' },
  { key: 'meta_description', label: 'Meta Description', desc: 'Default SEO description' },
  { key: 'social_share_title', label: 'Social Share Title', desc: 'OG title for social cards' },
  { key: 'social_share_description', label: 'Social Share Description' },
  { key: 'browser_title_format', label: 'Browser Title Format', desc: 'e.g. {{page}} | {{platform}}' },
  { key: 'public_site_title', label: 'Public Site Title' },
  { key: 'widget_display_name', label: 'Widget Display Name', desc: 'Chat widget header name' },
  { key: 'knowledge_base_title', label: 'Knowledge Base Title' },
  { key: 'legal_company_display_name', label: 'Legal Company Name', desc: 'For structured data and footer' },
  { key: 'footer_company_text', label: 'Footer Company Text', desc: 'Copyright / legal footer' },
  { key: 'support_label', label: 'Support Label', desc: 'Support link text' },
];

import { Switch } from '@/components/ui/switch';
import { Globe, Wrench, CreditCard, Languages, Flag } from 'lucide-react';
import { REGION_MODES, REGION_LOCALES, REGION_CURRENCY, isRegionMode, setCachedRegionMode, type RegionMode } from '@/lib/region';

const REGION_META: Record<RegionMode, { title: string; desc: string; flag: string; currency: string; languages: string }> = {
  multi: {
    title: 'Multi-Region (all languages)',
    desc: 'Every active language is selectable. Prices follow the language the user picked.',
    flag: '🌍',
    currency: 'Follows language',
    languages: 'English · فارسی · Türkçe',
  },
  iran: {
    title: 'Iran only — Persian',
    desc: 'The platform is Persian only. No language switcher anywhere, all money in Toman, Iranian gateways.',
    flag: '🇮🇷',
    currency: 'Toman (IRT)',
    languages: 'فارسی',
  },
  turkey: {
    title: 'Turkey only — Turkish',
    desc: 'The platform is Turkish only. No language switcher anywhere, all money in Turkish Lira.',
    flag: '🇹🇷',
    currency: 'Turkish Lira (TRY)',
    languages: 'Türkçe',
  },
  global: {
    title: 'Global — English only',
    desc: 'The platform is English only. No language switcher anywhere, all money in US Dollar.',
    flag: '🇺🇸',
    currency: 'US Dollar (USD)',
    languages: 'English',
  },
};

function SettingsSection() {
  const { data: rows, isLoading: brandingLoading } = usePlatformBrandingLocalized();
  const { data: settings, isLoading: settingsLoading } = useQuery({
    queryKey: ['platform_settings'],
    queryFn: async () => {
      const { data, error } = await supabase.from('platform_settings').select('*').limit(1).maybeSingle();
      if (error) throw error;
      return data;
    },
  });
  const upsert = useUpsertPlatformBrandingLocalized();
  const qc = useQueryClient();

  const [activeLocale, setActiveLocale] = useState('en');
  const [forms, setForms] = useState<Record<string, Partial<PlatformBrandingLocalized>>>({});
  const [dirtyLocales, setDirtyLocales] = useState<Set<string>>(new Set());
  const [settingsTab, setSettingsTab] = useState('general');

  // Settings form state
  const [defaultLocale, setDefaultLocale] = useState('en');
  const [activeLocales, setActiveLocales] = useState<string[]>(['en']);
  const [timezone, setTimezone] = useState('UTC');
  const [siteMode, setSiteMode] = useState('multi_language');
  const [regionMode, setRegionMode] = useState<RegionMode>('multi');
  const [maintenanceMode, setMaintenanceMode] = useState(false);
  const [maintenanceMessage, setMaintenanceMessage] = useState('');
  const [localeBillingProviders, setLocaleBillingProviders] = useState<Record<string, string>>({});
  const [settingsDirty, setSettingsDirty] = useState(false);

  useEffect(() => {
    if (settings) {
      setDefaultLocale(settings.default_locale || 'en');
      setActiveLocales(settings.active_locales || ['en']);
      setTimezone(settings.timezone || 'UTC');
      setSiteMode(settings.site_mode || 'multi_language');
      setRegionMode(isRegionMode((settings as any).region_mode) ? (settings as any).region_mode : 'multi');
      setMaintenanceMode((settings as any).maintenance_mode ?? false);
      setMaintenanceMessage((settings as any).maintenance_message ?? '');
      setLocaleBillingProviders((settings as any).locale_billing_providers ?? {});
      setSettingsDirty(false);
    }
  }, [settings]);

  useEffect(() => {
    if (rows) {
      const map: Record<string, Partial<PlatformBrandingLocalized>> = {};
      rows.forEach((r) => (map[r.locale] = r));
      setForms(map);
      setDirtyLocales(new Set());
    }
  }, [rows]);

  const setField = (locale: string, key: string, val: string) => {
    setForms((p) => ({ ...p, [locale]: { ...p[locale], [key]: val, locale } }));
    setDirtyLocales((p) => new Set(p).add(locale));
  };

  const handleSaveBranding = (locale: string) => {
    const row = forms[locale];
    if (!row) return;
    const { id, created_at, updated_at, ...rest } = row as any;
    upsert.mutate({ ...rest, locale }, {
      onSuccess: () => { toast({ title: `${locale.toUpperCase()} branding saved` }); setDirtyLocales((p) => { const n = new Set(p); n.delete(locale); return n; }); },
      onError: (e) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
    });
  };

  const handleSaveSettings = async () => {
    const { data: existing } = await supabase.from('platform_settings').select('id').limit(1).maybeSingle();
    const payload = {
      default_locale: defaultLocale,
      active_locales: activeLocales,
      timezone,
      site_mode: siteMode,
      region_mode: regionMode,
      region_currency: REGION_CURRENCY[regionMode],
      maintenance_mode: maintenanceMode,
      maintenance_message: maintenanceMessage || null,
      locale_billing_providers: localeBillingProviders,
      updated_at: new Date().toISOString(),
    };
    if (existing) {
      const { error } = await supabase.from('platform_settings').update(payload).eq('id', existing.id);
      if (error) { toast({ title: 'Error', description: error.message, variant: 'destructive' }); return; }
    } else {
      const { error } = await supabase.from('platform_settings').insert(payload);
      if (error) { toast({ title: 'Error', description: error.message, variant: 'destructive' }); return; }
    }
    qc.invalidateQueries({ queryKey: ['platform_settings'] });
    qc.invalidateQueries({ queryKey: ['platform_region_settings'] });
    setCachedRegionMode(regionMode);
    toast({ title: 'Settings saved' });
    setSettingsDirty(false);
  };

  const toggleLocale = (code: string) => {
    setActiveLocales(prev => {
      const next = prev.includes(code) ? prev.filter(l => l !== code) : [...prev, code];
      if (next.length === 0) return prev;
      return next;
    });
    setSettingsDirty(true);
  };

  const pickRegion = (mode: RegionMode) => {
    setRegionMode(mode);
    setSettingsDirty(true);
    if (mode !== 'multi') {
      const pinned = REGION_LOCALES[mode];
      setActiveLocales(pinned as string[]);
      setDefaultLocale(pinned[0]);
      setSiteMode('single_language');
    } else {
      setSiteMode('multi_language');
    }
  };

  if (brandingLoading || settingsLoading) return <LoadingCard />;

  const current = forms[activeLocale] ?? {};

  return (
    <div className="space-y-6">
      <Tabs value={settingsTab} onValueChange={setSettingsTab}>
        <TabsList>
          <TabsTrigger value="general" className="gap-1.5"><Wrench className="h-4 w-4" /> General</TabsTrigger>
          <TabsTrigger value="region" className="gap-1.5"><Flag className="h-4 w-4" /> Country / Region</TabsTrigger>
          <TabsTrigger value="languages" className="gap-1.5"><Languages className="h-4 w-4" /> Languages</TabsTrigger>
          <TabsTrigger value="billing" className="gap-1.5"><CreditCard className="h-4 w-4" /> Payment Gateways</TabsTrigger>
          <TabsTrigger value="localized" className="gap-1.5"><Globe className="h-4 w-4" /> Localized Text</TabsTrigger>
        </TabsList>

        {/* ── General Settings ── */}
        <TabsContent value="general" className="mt-4">
          <Card className="bg-card border-border">
            <CardHeader className="pb-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2"><Wrench className="h-5 w-5 text-primary" /><CardTitle>General Settings</CardTitle></div>
                <Button size="sm" onClick={handleSaveSettings} disabled={!settingsDirty}>
                  <Save className="h-4 w-4 mr-1" />Save
                </Button>
              </div>
              <CardDescription>Core platform settings: timezone, site mode, and maintenance.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="grid gap-5 md:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label>Default Language</Label>
                  <p className="text-xs text-muted-foreground">Primary language shown to visitors</p>
                  <Select value={defaultLocale} onValueChange={(v) => { setDefaultLocale(v); setSettingsDirty(true); }}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {activeLocales.map(code => {
                        const l = ALL_LOCALES.find(x => x.code === code);
                        return <SelectItem key={code} value={code}>{l?.flag} {l?.label || code}</SelectItem>;
                      })}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  <Label>Timezone</Label>
                  <Input value={timezone} onChange={e => { setTimezone(e.target.value); setSettingsDirty(true); }} placeholder="UTC" />
                </div>
                <div className="grid gap-1.5">
                  <Label>Site Mode</Label>
                  <Select value={siteMode} onValueChange={(v) => { setSiteMode(v); setSettingsDirty(true); }}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="multi_language">Multi-Language</SelectItem>
                      <SelectItem value="single_language">Single Language</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <Separator />

              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <Label className="text-sm font-medium">Maintenance Mode</Label>
                    <p className="text-xs text-muted-foreground">When enabled, visitors see a maintenance page</p>
                  </div>
                  <Switch checked={maintenanceMode} onCheckedChange={(v) => { setMaintenanceMode(v); setSettingsDirty(true); }} />
                </div>
                {maintenanceMode && (
                  <div className="grid gap-1.5">
                    <Label>Maintenance Message</Label>
                    <Textarea value={maintenanceMessage} onChange={e => { setMaintenanceMessage(e.target.value); setSettingsDirty(true); }} placeholder="We're upgrading our systems. Please check back soon." className="min-h-[80px]" />
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Languages ── */}
        <TabsContent value="languages" className="mt-4">
          {regionMode !== 'multi' && (
            <Card className="bg-muted/30 border-border mb-4">
              <CardContent className="p-4 text-sm text-muted-foreground">
                {REGION_META[regionMode].flag} Language selection is locked by the <strong className="text-foreground">Country / Region</strong> mode
                (<strong className="text-foreground">{REGION_META[regionMode].languages}</strong>). Switch to Multi-Region to edit languages.
              </CardContent>
            </Card>
          )}
          <Card className="bg-card border-border">
            <CardHeader className="pb-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2"><Languages className="h-5 w-5 text-primary" /><CardTitle>Active Languages</CardTitle></div>
                <Button size="sm" onClick={handleSaveSettings} disabled={!settingsDirty}>
                  <Save className="h-4 w-4 mr-1" />Save
                </Button>
              </div>
              <CardDescription>Select which languages are available on the platform. The default language is shown first.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
                {ALL_LOCALES.map(l => {
                  const isActive = activeLocales.includes(l.code);
                  const isDefault = defaultLocale === l.code;
                  return (
                    <button
                      key={l.code}
                      onClick={() => { if (!isDefault) toggleLocale(l.code); }}
                      className={`flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-colors text-left ${
                        isActive ? 'bg-primary/10 border-primary/30 text-foreground' : 'bg-muted/30 border-border text-muted-foreground hover:bg-muted/50'
                      } ${isDefault ? 'ring-2 ring-primary/50' : ''}`}
                    >
                      <span className="text-lg">{l.flag}</span>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate">{l.label}</div>
                        <div className="text-xs text-muted-foreground">{l.code}</div>
                      </div>
                      {isDefault && <Badge variant="default" className="text-[10px] shrink-0">Default</Badge>}
                      {isActive && !isDefault && <Badge variant="outline" className="text-[10px] shrink-0">Active</Badge>}
                    </button>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Payment Gateways per Locale ── */}
        <TabsContent value="billing" className="mt-4">
          <Card className="bg-card border-border">
            <CardHeader className="pb-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2"><CreditCard className="h-5 w-5 text-primary" /><CardTitle>Payment Gateway per Language</CardTitle></div>
                <Button size="sm" onClick={handleSaveSettings} disabled={!settingsDirty}>
                  <Save className="h-4 w-4 mr-1" />Save
                </Button>
              </div>
              <CardDescription>Assign a default payment gateway for each active language. When a user selects a language, payments route through that gateway automatically.</CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Language</TableHead>
                    <TableHead>Payment Gateway</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {activeLocales.map(code => {
                    const l = ALL_LOCALES.find(x => x.code === code);
                    return (
                      <TableRow key={code}>
                        <TableCell className="font-medium">
                          <span className="mr-2">{l?.flag}</span>{l?.label || code}
                          {code === defaultLocale && <Badge variant="outline" className="ml-2 text-[10px]">default</Badge>}
                        </TableCell>
                        <TableCell>
                          <Select
                            value={localeBillingProviders[code] || 'none'}
                            onValueChange={(v) => {
                              setLocaleBillingProviders(prev => ({ ...prev, [code]: v }));
                              setSettingsDirty(true);
                            }}
                          >
                            <SelectTrigger className="w-52"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {BILLING_PROVIDERS.map(p => (
                                <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Localized Text ── */}
        <TabsContent value="localized" className="mt-4">
          <Card className="bg-card border-border">
            <CardHeader className="pb-4">
              <div className="flex items-center gap-2"><Globe className="h-5 w-5 text-primary" /><CardTitle>Localized Branding</CardTitle></div>
              <CardDescription>Platform text & SEO for each active language.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Tabs value={activeLocale} onValueChange={setActiveLocale}>
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <TabsList className="flex-wrap">
                    {activeLocales.map((code) => {
                      const l = ALL_LOCALES.find(x => x.code === code);
                      return (
                        <TabsTrigger key={code} value={code} className="gap-1.5">
                          {l?.flag} {l?.label || code}
                          {code === defaultLocale && <Badge variant="outline" className="text-[10px] px-1 py-0">default</Badge>}
                          {dirtyLocales.has(code) && <Badge variant="secondary" className="text-[10px] px-1 py-0">unsaved</Badge>}
                        </TabsTrigger>
                      );
                    })}
                  </TabsList>
                  <Button size="sm" onClick={() => handleSaveBranding(activeLocale)} disabled={!dirtyLocales.has(activeLocale) || upsert.isPending}>
                    {upsert.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Save className="h-4 w-4 mr-1" />}
                    Save {activeLocale.toUpperCase()}
                  </Button>
                </div>
                {activeLocales.map((code) => (
                  <TabsContent key={code} value={code} className="mt-4">
                    <div className="grid gap-5 md:grid-cols-2">
                      {LOCALIZED_FIELDS.map((f) => (
                        <FieldRow key={f.key} label={f.label} desc={f.desc} value={(current as any)?.[f.key] ?? ''} onChange={(v) => setField(code, f.key, v)} placeholder={`Enter ${f.label.toLowerCase()}`} />
                      ))}
                    </div>
                  </TabsContent>
                ))}
              </Tabs>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ── Domain URLs Section ──
// NOTE: Widget URLs (loader/asset/public/api) have been moved to
// Super Admin → Widget Settings → Deployment & URLs. They are intentionally
// NOT editable here anymore — widget_platform_settings is the single source of truth.
const DOMAIN_FIELDS: { key: keyof PlatformDomains; label: string; desc?: string; placeholder: string }[] = [
  { key: 'primary_domain', label: 'Primary Domain', desc: 'Main domain of the platform', placeholder: 'example.com' },
  { key: 'canonical_base_url', label: 'Canonical Base URL', desc: 'For SEO canonical tags', placeholder: 'https://example.com' },
  { key: 'app_base_url', label: 'App / Panel URL', placeholder: 'https://app.example.com' },
  { key: 'api_base_url', label: 'API Base URL', placeholder: 'https://api.example.com' },
  { key: 'public_base_url', label: 'Public Site URL', desc: 'Marketing site / public-facing origin', placeholder: 'https://example.com' },
  { key: 'help_center_base_url', label: 'Help Center URL', placeholder: 'https://help.example.com' },
  { key: 'email_base_url', label: 'Email Base URL', desc: 'Links inside emails', placeholder: 'https://example.com' },
];

function DomainUrlsSection() {
  const { data: domains, isLoading } = usePlatformDomains();
  const update = useUpdatePlatformDomains();
  const [form, setForm] = useState<Partial<PlatformDomains>>({});
  const [dirty, setDirty] = useState(false);

  useEffect(() => { if (domains) { setForm(domains); setDirty(false); } }, [domains]);

  const set = (key: keyof PlatformDomains, val: string) => { setForm((p) => ({ ...p, [key]: val })); setDirty(true); };

  const handleSave = () => {
    const { id, created_at, updated_at, ...rest } = form as any;
    update.mutate(rest, {
      onSuccess: () => { toast({ title: 'Domain URLs saved' }); setDirty(false); },
      onError: (e) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
    });
  };

  if (isLoading) return <LoadingCard />;

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2"><Link2 className="h-5 w-5 text-primary" /><CardTitle className="text-foreground">Platform Domain URLs</CardTitle></div>
          <Button size="sm" onClick={handleSave} disabled={!dirty || update.isPending}>
            {update.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Save className="h-4 w-4 mr-1" />}Save
          </Button>
        </div>
        <CardDescription>Base URLs used across split frontend/backend widget deployments, emails, SEO, and public pages.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-5 md:grid-cols-2">
          {DOMAIN_FIELDS.map((f) => (
            <FieldRow key={f.key} label={f.label} desc={f.desc} value={(form as any)?.[f.key] ?? ''} onChange={(v) => set(f.key, v)} placeholder={f.placeholder} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Email Settings Section ──
function EmailSettingsSection() {
  const qc = useQueryClient();
  const { data: emailSettings, isLoading: settingsLoading } = useQuery({
    queryKey: ['platform-email-settings'],
    queryFn: async () => {
      const { data, error } = await supabase.from('email_settings').select('*').is('workspace_id', null).maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const [settingsForm, setSettingsForm] = useState({ sender_email: '', reply_to_email: '', email_logo_url: '', email_footer_text: '' });
  const [settingsDirty, setSettingsDirty] = useState(false);

  useEffect(() => {
    if (emailSettings) {
      setSettingsForm({
        sender_email: emailSettings.sender_email ?? '',
        reply_to_email: emailSettings.reply_to_email ?? '',
        email_logo_url: emailSettings.email_logo_url ?? '',
        email_footer_text: emailSettings.email_footer_text ?? '',
      });
      setSettingsDirty(false);
    }
  }, [emailSettings]);

  const saveSettings = useMutation({
    mutationFn: async () => {
      if (emailSettings?.id) {
        const { error } = await supabase.from('email_settings').update({ ...settingsForm, updated_at: new Date().toISOString() }).eq('id', emailSettings.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from('email_settings').insert({ ...settingsForm, workspace_id: null });
        if (error) throw error;
      }
    },
    onSuccess: () => { toast({ title: 'Email settings saved' }); setSettingsDirty(false); qc.invalidateQueries({ queryKey: ['platform-email-settings'] }); },
    onError: (e) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  // Email settings localized
  const { data: emailLocalized } = useQuery({
    queryKey: ['platform-email-settings-localized'],
    queryFn: async () => {
      const { data, error } = await supabase.from('email_settings_localized').select('*').is('workspace_id', null).order('locale');
      if (error) throw error;
      return data ?? [];
    },
  });

  const [emailLocaleForms, setEmailLocaleForms] = useState<Record<string, any>>({});
  const [emailLocaleDirty, setEmailLocaleDirty] = useState<Set<string>>(new Set());
  const [emailLocaleTab, setEmailLocaleTab] = useState('en');

  useEffect(() => {
    if (emailLocalized) {
      const map: Record<string, any> = {};
      emailLocalized.forEach(r => (map[r.locale] = r));
      setEmailLocaleForms(map);
      setEmailLocaleDirty(new Set());
    }
  }, [emailLocalized]);

  const saveEmailLocale = useMutation({
    mutationFn: async (locale: string) => {
      const row = emailLocaleForms[locale];
      const { id, created_at, updated_at, ...rest } = row || {};
      const payload = { ...rest, locale, workspace_id: null, updated_at: new Date().toISOString() };

      const { data: existing } = await supabase.from('email_settings_localized').select('id').is('workspace_id', null).eq('locale', locale).maybeSingle();
      if (existing) {
        const { error } = await supabase.from('email_settings_localized').update(payload).eq('id', existing.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from('email_settings_localized').insert(payload);
        if (error) throw error;
      }
    },
    onSuccess: () => { toast({ title: 'Email locale saved' }); qc.invalidateQueries({ queryKey: ['platform-email-settings-localized'] }); },
    onError: (e) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  if (settingsLoading) return <LoadingCard />;

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-4">
        <div className="flex items-center gap-2"><Settings2 className="h-5 w-5 text-primary" /><CardTitle className="text-foreground">Email Settings</CardTitle></div>
        <CardDescription>Global email configuration used by email providers.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Global email settings */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-foreground">Global Settings</h3>
            <Button size="sm" onClick={() => saveSettings.mutate()} disabled={!settingsDirty || saveSettings.isPending}>
              {saveSettings.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Save className="h-4 w-4 mr-1" />}Save
            </Button>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <FieldRow label="Sender Email" desc="From address for all emails" value={settingsForm.sender_email} onChange={(v) => { setSettingsForm(p => ({ ...p, sender_email: v })); setSettingsDirty(true); }} placeholder="noreply@example.com" />
            <FieldRow label="Reply-To Email" value={settingsForm.reply_to_email} onChange={(v) => { setSettingsForm(p => ({ ...p, reply_to_email: v })); setSettingsDirty(true); }} placeholder="support@example.com" />
            <FieldRow label="Email Logo URL" desc="Logo shown in email headers" value={settingsForm.email_logo_url} onChange={(v) => { setSettingsForm(p => ({ ...p, email_logo_url: v })); setSettingsDirty(true); }} placeholder="https://cdn.example.com/email-logo.png" />
            <FieldRow label="Email Footer Text" value={settingsForm.email_footer_text} onChange={(v) => { setSettingsForm(p => ({ ...p, email_footer_text: v })); setSettingsDirty(true); }} placeholder="© 2026 Your Company" />
          </div>
        </div>

        <Separator />

        {/* Localized email settings */}
        <div className="space-y-4">
          <h3 className="text-sm font-semibold text-foreground">Localized Email Text</h3>
          <Tabs value={emailLocaleTab} onValueChange={setEmailLocaleTab}>
            <div className="flex items-center justify-between">
              <TabsList>
                {ALL_LOCALES.filter(l => true).slice(0, 3).map(l => (
                  <TabsTrigger key={l.code} value={l.code} className="gap-1.5">
                    {l.label}
                    {emailLocaleDirty.has(l.code) && <Badge variant="secondary" className="text-[10px] px-1 py-0">unsaved</Badge>}
                  </TabsTrigger>
                ))}
              </TabsList>
              <Button size="sm" onClick={() => saveEmailLocale.mutate(emailLocaleTab)} disabled={!emailLocaleDirty.has(emailLocaleTab) || saveEmailLocale.isPending}>
                {saveEmailLocale.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Save className="h-4 w-4 mr-1" />}Save
              </Button>
            </div>
            {ALL_LOCALES.filter(l => true).slice(0, 3).map(l => (
              <TabsContent key={l.code} value={l.code} className="mt-4">
                <div className="grid gap-4 md:grid-cols-2">
                  <FieldRow label="Sender Name" desc="Name shown in email From field" value={emailLocaleForms[l.code]?.sender_name ?? ''} onChange={(v) => { setEmailLocaleForms(p => ({ ...p, [l.code]: { ...p[l.code], sender_name: v, locale: l.code } })); setEmailLocaleDirty(p => new Set(p).add(l.code)); }} placeholder="Your Platform" />
                  <FieldRow label="Footer Text" value={emailLocaleForms[l.code]?.footer_text ?? ''} onChange={(v) => { setEmailLocaleForms(p => ({ ...p, [l.code]: { ...p[l.code], footer_text: v, locale: l.code } })); setEmailLocaleDirty(p => new Set(p).add(l.code)); }} placeholder="All rights reserved." />
                  <FieldRow label="Support Contact Label" value={emailLocaleForms[l.code]?.support_contact_label ?? ''} onChange={(v) => { setEmailLocaleForms(p => ({ ...p, [l.code]: { ...p[l.code], support_contact_label: v, locale: l.code } })); setEmailLocaleDirty(p => new Set(p).add(l.code)); }} placeholder="Contact Support" />
                </div>
              </TabsContent>
            ))}
          </Tabs>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Loading placeholder ──
function LoadingCard() {
  return (
    <Card className="bg-card border-border">
      <CardContent className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </CardContent>
    </Card>
  );
}

// ── Main Page ──
export default function AdminBrandingPage() {
  return (
    <div className="space-y-6 max-w-4xl animate-fade-in">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Platform Branding</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Visual identity, localized text, email configuration, and domain URLs — applied globally across the platform.
        </p>
      </div>

      <Tabs defaultValue="identity">
        <TabsList className="w-full justify-start flex-wrap">
          <TabsTrigger value="identity" className="gap-1.5"><Palette className="h-4 w-4" /> Visual Identity</TabsTrigger>
          <TabsTrigger value="settings" className="gap-1.5"><Settings2 className="h-4 w-4" /> Settings</TabsTrigger>
          <TabsTrigger value="email-settings" className="gap-1.5"><Mail className="h-4 w-4" /> Email Settings</TabsTrigger>
          <TabsTrigger value="email-templates" className="gap-1.5"><Mail className="h-4 w-4" /> Email Templates</TabsTrigger>
          <TabsTrigger value="domains" className="gap-1.5"><Link2 className="h-4 w-4" /> Domain URLs</TabsTrigger>
        </TabsList>
        <TabsContent value="identity" className="mt-4"><VisualIdentitySection /></TabsContent>
        <TabsContent value="settings" className="mt-4"><SettingsSection /></TabsContent>
        <TabsContent value="email-settings" className="mt-4"><EmailSettingsSection /></TabsContent>
        <TabsContent value="email-templates" className="mt-4"><EmailTemplatesTab /></TabsContent>
        <TabsContent value="domains" className="mt-4"><DomainUrlsSection /></TabsContent>
      </Tabs>
    </div>
  );
}
