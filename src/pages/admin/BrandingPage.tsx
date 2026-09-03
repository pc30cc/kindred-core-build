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
import { adminFetch } from '@/hooks/useAdmin';
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
import { useTranslation } from '@/i18n';

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
  const { t } = useTranslation();
  const { data: branding, isLoading } = usePlatformBranding();
  const update = useUpdatePlatformBranding();
  const [form, setForm] = useState<Partial<PlatformBranding>>({});
  const [dirty, setDirty] = useState(false);

  useEffect(() => { if (branding) { setForm(branding); setDirty(false); } }, [branding]);

  const set = (key: keyof PlatformBranding, val: string) => { setForm((p) => ({ ...p, [key]: val })); setDirty(true); };

  const handleSave = () => {
    const { id, created_at, updated_at, ...rest } = form as any;
    update.mutate(rest, {
      onSuccess: () => { toast({ title: t('admin.brandingPage.identity.saved' as any) }); setDirty(false); },
      onError: (e) => toast({ title: t('admin.brandingPage.common.error' as any), description: e.message, variant: 'destructive' }),
    });
  };

  if (isLoading) return <LoadingCard />;

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2"><Palette className="h-5 w-5 text-primary" /><CardTitle className="text-foreground">{t('admin.brandingPage.identity.title' as any)}</CardTitle></div>
          <Button size="sm" onClick={handleSave} disabled={!dirty || update.isPending}>
            {update.isPending ? <Loader2 className="h-4 w-4 animate-spin me-1" /> : <Save className="h-4 w-4 me-1" />}{t('admin.brandingPage.common.save' as any)}
          </Button>
        </div>
        <CardDescription>{t('admin.brandingPage.identity.description' as any)}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-5 md:grid-cols-2">
          <FieldRow label={t('admin.brandingPage.identity.logoUrl' as any)} desc={t('admin.brandingPage.identity.logoHint' as any)} value={form.logo_url ?? ''} onChange={(v) => set('logo_url', v)} placeholder="https://cdn.example.com/logo.svg" />
          <FieldRow label={t('admin.brandingPage.identity.faviconUrl' as any)} desc={t('admin.brandingPage.identity.faviconHint' as any)} value={form.favicon_url ?? ''} onChange={(v) => set('favicon_url', v)} placeholder="https://cdn.example.com/favicon.ico" />
          <FieldRow label={t('admin.brandingPage.identity.primaryColor' as any)} type="color" value={form.primary_color ?? '#3B82F6'} onChange={(v) => set('primary_color', v)} />
          <FieldRow label={t('admin.brandingPage.identity.secondaryColor' as any)} type="color" value={form.secondary_color ?? '#6366F1'} onChange={(v) => set('secondary_color', v)} />
          <FieldRow label={t('admin.brandingPage.identity.pwaIconUrl' as any)} desc={t('admin.brandingPage.identity.pwaIconHint' as any)} value={form.pwa_icon_url ?? ''} onChange={(v) => set('pwa_icon_url', v)} placeholder="https://cdn.example.com/pwa-icon.png" />
        </div>
        {(form.logo_url || form.primary_color) && (
          <>
            <Separator />
            <div className="rounded-lg border border-border p-4">
              <p className="text-xs text-muted-foreground mb-3 flex items-center gap-1"><Eye className="h-3 w-3" /> {t('admin.brandingPage.identity.preview' as any)}</p>
              <div className="flex items-center gap-3">
                {form.logo_url && <img src={form.logo_url} alt={t('admin.brandingPage.identity.logoPreview' as any)} className="h-10 max-w-[160px] object-contain rounded" onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')} />}
                <div className="flex gap-2">
                  <div className="w-8 h-8 rounded-md border border-border" style={{ backgroundColor: form.primary_color ?? '#3B82F6' }} title={t('admin.brandingPage.identity.primaryColor' as any)} />
                  <div className="w-8 h-8 rounded-md border border-border" style={{ backgroundColor: form.secondary_color ?? '#6366F1' }} title={t('admin.brandingPage.identity.secondaryColor' as any)} />
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
  { code: 'en', labelKey: 'en', flag: '🇺🇸' },
  { code: 'fa', labelKey: 'fa', flag: '🇮🇷' },
  { code: 'tr', labelKey: 'tr', flag: '🇹🇷' },
  { code: 'ar', labelKey: 'ar', flag: '🇸🇦' },
  { code: 'de', labelKey: 'de', flag: '🇩🇪' },
  { code: 'fr', labelKey: 'fr', flag: '🇫🇷' },
  { code: 'es', labelKey: 'es', flag: '🇪🇸' },
  { code: 'ru', labelKey: 'ru', flag: '🇷🇺' },
  { code: 'zh', labelKey: 'zh', flag: '🇨🇳' },
  { code: 'ja', labelKey: 'ja', flag: '🇯🇵' },
  { code: 'ko', labelKey: 'ko', flag: '🇰🇷' },
  { code: 'pt', labelKey: 'pt', flag: '🇧🇷' },
  { code: 'it', labelKey: 'it', flag: '🇮🇹' },
  { code: 'nl', labelKey: 'nl', flag: '🇳🇱' },
  { code: 'hi', labelKey: 'hi', flag: '🇮🇳' },
  { code: 'ku', labelKey: 'ku', flag: '🏳️' },
];

const BILLING_PROVIDERS = [
  { value: 'none', label: '' },
  { value: 'stripe', label: 'Stripe' },
  { value: 'paypal', label: 'PayPal' },
  { value: 'paddle', label: 'Paddle' },
  { value: 'zarinpal', label: 'ZarinPal' },
  { value: 'zarinpal_test', label: 'ZarinPal-Test (Sandbox)' },
  { value: 'iranpardakht_sandbox', label: 'IranPardakht-Sandbox' },
  { value: 'payping', label: 'PayPing' },
  { value: 'nextpay', label: 'NextPay' },
  { value: 'idpay', label: 'IDPay' },
  { value: 'idpay_test', label: 'IDPay-Test (Sandbox)' },
  { value: 'sep', label: 'SEP (Saman)' },
  { value: 'zibal', label: 'Zibal' },
  { value: 'iyzico', label: 'iyzico' },
  { value: 'paytr', label: 'PayTR' },
  { value: 'craftgate', label: 'Craftgate' },
  { value: 'sipay', label: 'Sipay' },
  { value: 'paratika', label: 'Paratika' },
  { value: 'lemonsqueezy', label: 'Lemon Squeezy' },
];

const LOCALIZED_FIELDS: { key: keyof PlatformBrandingLocalized; hasDescription?: boolean }[] = [
  { key: 'platform_name', hasDescription: true },
  { key: 'meta_title', hasDescription: true },
  { key: 'meta_description', hasDescription: true },
  { key: 'social_share_title', hasDescription: true },
  { key: 'social_share_description' },
  { key: 'browser_title_format', hasDescription: true },
  { key: 'public_site_title' },
  { key: 'widget_display_name', hasDescription: true },
  { key: 'knowledge_base_title' },
  { key: 'legal_company_display_name', hasDescription: true },
  { key: 'footer_company_text', hasDescription: true },
  { key: 'support_label', hasDescription: true },
];

import { Switch } from '@/components/ui/switch';
import { Globe, Wrench, CreditCard, Languages, Flag } from 'lucide-react';
import { REGION_MODES, REGION_LOCALES, REGION_CURRENCY, isRegionMode, setCachedRegionMode, type RegionMode } from '@/lib/region';

const REGION_META: Record<RegionMode, { flag: string; languages: string }> = {
  multi: {
    flag: '🌍',
    languages: 'English · فارسی · Türkçe',
  },
  iran: {
    flag: '🇮🇷',
    languages: 'فارسی',
  },
  turkey: {
    flag: '🇹🇷',
    languages: 'Türkçe',
  },
  global: {
    flag: '🇺🇸',
    languages: 'English',
  },
};

function SettingsSection() {
  const { t } = useTranslation();
  const { data: rows, isLoading: brandingLoading } = usePlatformBrandingLocalized();
  const { data: settings, isLoading: settingsLoading } = useQuery({
    queryKey: ['platform_settings'],
    queryFn: async () => {
      const body = await adminFetch<{ settings: any }>('/api/admin/management/platform-settings');
      return body.settings;
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
      onSuccess: () => { toast({ title: t('admin.brandingPage.settings.localized.saved' as any, { locale: locale.toUpperCase() }) }); setDirtyLocales((p) => { const n = new Set(p); n.delete(locale); return n; }); },
      onError: (e) => toast({ title: t('admin.brandingPage.common.error' as any), description: e.message, variant: 'destructive' }),
    });
  };

  const handleSaveSettings = async () => {
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
    };
    try {
      await adminFetch('/api/admin/management/platform-settings', {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
    } catch (e) {
      toast({ title: t('admin.brandingPage.common.error' as any), description: e instanceof Error ? e.message : t('admin.brandingPage.common.saveFailed' as any), variant: 'destructive' });
      return;
    }
    qc.invalidateQueries({ queryKey: ['platform_settings'] });
    qc.invalidateQueries({ queryKey: ['platform_region_settings'] });
    setCachedRegionMode(regionMode);
    toast({ title: t('admin.brandingPage.settings.saved' as any) });
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
  const localeLabel = (code: string) => t(`admin.brandingPage.languages.${code}` as any);
  const regionTitle = (mode: RegionMode) => t(`admin.brandingPage.settings.region.modes.${mode}.title` as any);
  const regionDescription = (mode: RegionMode) => t(`admin.brandingPage.settings.region.modes.${mode}.description` as any);
  const regionCurrency = (mode: RegionMode) => t(`admin.brandingPage.settings.region.modes.${mode}.currency` as any);

  return (
    <div className="space-y-6">
      <Tabs value={settingsTab} onValueChange={setSettingsTab}>
        <TabsList className="h-auto w-full justify-start overflow-x-auto">
          <TabsTrigger value="general" className="gap-1.5"><Wrench className="h-4 w-4" /> {t('admin.brandingPage.settings.tabs.general' as any)}</TabsTrigger>
          <TabsTrigger value="region" className="gap-1.5"><Flag className="h-4 w-4" /> {t('admin.brandingPage.settings.tabs.region' as any)}</TabsTrigger>
          <TabsTrigger value="languages" className="gap-1.5"><Languages className="h-4 w-4" /> {t('admin.brandingPage.settings.tabs.languages' as any)}</TabsTrigger>
          <TabsTrigger value="billing" className="gap-1.5"><CreditCard className="h-4 w-4" /> {t('admin.brandingPage.settings.tabs.billing' as any)}</TabsTrigger>
          <TabsTrigger value="localized" className="gap-1.5"><Globe className="h-4 w-4" /> {t('admin.brandingPage.settings.tabs.localized' as any)}</TabsTrigger>
        </TabsList>

        {/* ── General Settings ── */}
        <TabsContent value="general" className="mt-4">
          <Card className="bg-card border-border">
            <CardHeader className="pb-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2"><Wrench className="h-5 w-5 text-primary" /><CardTitle>{t('admin.brandingPage.settings.general.title' as any)}</CardTitle></div>
                <Button size="sm" onClick={handleSaveSettings} disabled={!settingsDirty}>
                  <Save className="h-4 w-4 me-1" />{t('admin.brandingPage.common.save' as any)}
                </Button>
              </div>
              <CardDescription>{t('admin.brandingPage.settings.general.description' as any)}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="grid gap-5 md:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label>{t('admin.brandingPage.settings.general.defaultLanguage' as any)}</Label>
                  <p className="text-xs text-muted-foreground">{t('admin.brandingPage.settings.general.defaultLanguageHint' as any)}</p>
                  <Select value={defaultLocale} onValueChange={(v) => { setDefaultLocale(v); setSettingsDirty(true); }}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {activeLocales.map(code => {
                        const l = ALL_LOCALES.find(x => x.code === code);
                        return <SelectItem key={code} value={code}>{l?.flag} {l ? localeLabel(l.code) : code}</SelectItem>;
                      })}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  <Label>{t('admin.brandingPage.settings.general.timezone' as any)}</Label>
                  <Input value={timezone} onChange={e => { setTimezone(e.target.value); setSettingsDirty(true); }} placeholder="UTC" />
                </div>
                <div className="grid gap-1.5">
                  <Label>{t('admin.brandingPage.settings.general.siteMode' as any)}</Label>
                  <Select value={siteMode} onValueChange={(v) => { setSiteMode(v); setSettingsDirty(true); }}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="multi_language">{t('admin.brandingPage.settings.general.multiLanguage' as any)}</SelectItem>
                      <SelectItem value="single_language">{t('admin.brandingPage.settings.general.singleLanguage' as any)}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <Separator />

              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <Label className="text-sm font-medium">{t('admin.brandingPage.settings.general.maintenanceMode' as any)}</Label>
                    <p className="text-xs text-muted-foreground">{t('admin.brandingPage.settings.general.maintenanceModeHint' as any)}</p>
                  </div>
                  <Switch checked={maintenanceMode} onCheckedChange={(v) => { setMaintenanceMode(v); setSettingsDirty(true); }} />
                </div>
                {maintenanceMode && (
                  <div className="grid gap-1.5">
                    <Label>{t('admin.brandingPage.settings.general.maintenanceMessage' as any)}</Label>
                    <Textarea value={maintenanceMessage} onChange={e => { setMaintenanceMessage(e.target.value); setSettingsDirty(true); }} placeholder={t('admin.brandingPage.settings.general.maintenancePlaceholder' as any)} className="min-h-[80px]" />
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Country / Region ── */}
        <TabsContent value="region" className="mt-4">
          <Card className="bg-card border-border">
            <CardHeader className="pb-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2"><Flag className="h-5 w-5 text-primary" /><CardTitle>{t('admin.brandingPage.settings.region.title' as any)}</CardTitle></div>
                <Button size="sm" onClick={handleSaveSettings} disabled={!settingsDirty}>
                  <Save className="h-4 w-4 me-1" />{t('admin.brandingPage.common.save' as any)}
                </Button>
              </div>
              <CardDescription>{t('admin.brandingPage.settings.region.description' as any)}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                {REGION_MODES.map((mode) => {
                  const meta = REGION_META[mode];
                  const selected = regionMode === mode;
                  return (
                    <button
                      key={mode}
                      onClick={() => pickRegion(mode)}
                      className={`text-left rounded-xl border p-4 transition-colors ${
                        selected ? 'border-primary/50 bg-primary/10 ring-2 ring-primary/30' : 'border-border bg-muted/20 hover:bg-muted/40'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-xl">{meta.flag}</span>
                        <span className="text-sm font-semibold text-foreground">{regionTitle(mode)}</span>
                        {selected && <Badge className="ms-auto text-[10px]">{t('admin.brandingPage.common.active' as any)}</Badge>}
                      </div>
                      <p className="text-xs text-muted-foreground mt-2">{regionDescription(mode)}</p>
                      <div className="flex flex-wrap gap-2 mt-3">
                        <Badge variant="outline" className="text-[10px]">{meta.languages}</Badge>
                        <Badge variant="secondary" className="text-[10px]">{regionCurrency(mode)}</Badge>
                      </div>
                    </button>
                  );
                })}
              </div>
              <Separator />
              <p className="text-xs text-muted-foreground">
                {t('admin.brandingPage.settings.region.currentMode' as any)} <strong className="text-foreground">{regionTitle(regionMode)}</strong>
                {' · '}{t('admin.brandingPage.settings.region.languages' as any)}{' '}
                <strong className="text-foreground">{REGION_META[regionMode].languages}</strong>{' · '}
                {t('admin.brandingPage.settings.region.currency' as any)}{' '}
                <strong className="text-foreground">{regionCurrency(regionMode)}</strong>
              </p>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Languages ── */}
        <TabsContent value="languages" className="mt-4">
          {regionMode !== 'multi' && (
            <Card className="bg-muted/30 border-border mb-4">
              <CardContent className="p-4 text-sm text-muted-foreground">
                {REGION_META[regionMode].flag} {t('admin.brandingPage.settings.languages.locked' as any, { languages: REGION_META[regionMode].languages })}
              </CardContent>
            </Card>
          )}
          <Card className="bg-card border-border">
            <CardHeader className="pb-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2"><Languages className="h-5 w-5 text-primary" /><CardTitle>{t('admin.brandingPage.settings.languages.title' as any)}</CardTitle></div>
                <Button size="sm" onClick={handleSaveSettings} disabled={!settingsDirty}>
                  <Save className="h-4 w-4 me-1" />{t('admin.brandingPage.common.save' as any)}
                </Button>
              </div>
              <CardDescription>{t('admin.brandingPage.settings.languages.description' as any)}</CardDescription>
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
                        <div className="text-sm font-medium truncate">{localeLabel(l.code)}</div>
                        <div className="text-xs text-muted-foreground">{l.code}</div>
                      </div>
                      {isDefault && <Badge variant="default" className="text-[10px] shrink-0">{t('admin.brandingPage.common.default' as any)}</Badge>}
                      {isActive && !isDefault && <Badge variant="outline" className="text-[10px] shrink-0">{t('admin.brandingPage.common.active' as any)}</Badge>}
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
                <div className="flex items-center gap-2"><CreditCard className="h-5 w-5 text-primary" /><CardTitle>{t('admin.brandingPage.settings.billing.title' as any)}</CardTitle></div>
                <Button size="sm" onClick={handleSaveSettings} disabled={!settingsDirty}>
                  <Save className="h-4 w-4 me-1" />{t('admin.brandingPage.common.save' as any)}
                </Button>
              </div>
              <CardDescription>{t('admin.brandingPage.settings.billing.description' as any)}</CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('admin.brandingPage.settings.billing.language' as any)}</TableHead>
                    <TableHead>{t('admin.brandingPage.settings.billing.gateway' as any)}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {activeLocales.map(code => {
                    const l = ALL_LOCALES.find(x => x.code === code);
                    return (
                      <TableRow key={code}>
                        <TableCell className="font-medium">
                          <span className="me-2">{l?.flag}</span>{l ? localeLabel(l.code) : code}
                          {code === defaultLocale && <Badge variant="outline" className="ms-2 text-[10px]">{t('admin.brandingPage.common.default' as any)}</Badge>}
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
                                <SelectItem key={p.value} value={p.value}>{p.value === 'none' ? t('admin.brandingPage.settings.billing.none' as any) : p.label}</SelectItem>
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
              <div className="flex items-center gap-2"><Globe className="h-5 w-5 text-primary" /><CardTitle>{t('admin.brandingPage.settings.localized.title' as any)}</CardTitle></div>
              <CardDescription>{t('admin.brandingPage.settings.localized.description' as any)}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Tabs value={activeLocale} onValueChange={setActiveLocale}>
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <TabsList className="flex-wrap">
                    {activeLocales.map((code) => {
                      const l = ALL_LOCALES.find(x => x.code === code);
                      return (
                        <TabsTrigger key={code} value={code} className="gap-1.5">
                          {l?.flag} {l ? localeLabel(l.code) : code}
                          {code === defaultLocale && <Badge variant="outline" className="text-[10px] px-1 py-0">{t('admin.brandingPage.common.default' as any)}</Badge>}
                          {dirtyLocales.has(code) && <Badge variant="secondary" className="text-[10px] px-1 py-0">{t('admin.brandingPage.common.unsaved' as any)}</Badge>}
                        </TabsTrigger>
                      );
                    })}
                  </TabsList>
                  <Button size="sm" onClick={() => handleSaveBranding(activeLocale)} disabled={!dirtyLocales.has(activeLocale) || upsert.isPending}>
                    {upsert.isPending ? <Loader2 className="h-4 w-4 animate-spin me-1" /> : <Save className="h-4 w-4 me-1" />}
                    {t('admin.brandingPage.settings.localized.saveLocale' as any, { locale: activeLocale.toUpperCase() })}
                  </Button>
                </div>
                {activeLocales.map((code) => (
                  <TabsContent key={code} value={code} className="mt-4">
                    <div className="grid gap-5 md:grid-cols-2">
                      {LOCALIZED_FIELDS.map((f) => {
                        const label = t(`admin.brandingPage.settings.localized.fields.${f.key}.label` as any);
                        return <FieldRow key={f.key} label={label} desc={f.hasDescription ? t(`admin.brandingPage.settings.localized.fields.${f.key}.hint` as any) : undefined} value={(current as any)?.[f.key] ?? ''} onChange={(v) => setField(code, f.key, v)} placeholder={t('admin.brandingPage.settings.localized.placeholder' as any, { field: label })} />;
                      })}
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
const DOMAIN_FIELDS: { key: keyof PlatformDomains; placeholder: string }[] = [
  { key: 'primary_domain', placeholder: 'example.com' },
  { key: 'canonical_base_url', placeholder: 'https://example.com' },
  { key: 'app_base_url', placeholder: 'https://app.example.com' },
  { key: 'api_base_url', placeholder: 'https://api.example.com' },
  { key: 'public_base_url', placeholder: 'https://example.com' },
  { key: 'help_center_base_url', placeholder: 'https://help.example.com' },
  { key: 'email_base_url', placeholder: 'https://example.com' },
];

function DomainUrlsSection() {
  const { t } = useTranslation();
  const { data: domains, isLoading } = usePlatformDomains();
  const update = useUpdatePlatformDomains();
  const [form, setForm] = useState<Partial<PlatformDomains>>({});
  const [dirty, setDirty] = useState(false);

  useEffect(() => { if (domains) { setForm(domains); setDirty(false); } }, [domains]);

  const set = (key: keyof PlatformDomains, val: string) => { setForm((p) => ({ ...p, [key]: val })); setDirty(true); };

  const handleSave = () => {
    const { id, created_at, updated_at, ...rest } = form as any;
    update.mutate(rest, {
      onSuccess: () => { toast({ title: t('admin.brandingPage.domains.saved' as any) }); setDirty(false); },
      onError: (e) => toast({ title: t('admin.brandingPage.common.error' as any), description: e.message, variant: 'destructive' }),
    });
  };

  if (isLoading) return <LoadingCard />;

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2"><Link2 className="h-5 w-5 text-primary" /><CardTitle className="text-foreground">{t('admin.brandingPage.domains.title' as any)}</CardTitle></div>
          <Button size="sm" onClick={handleSave} disabled={!dirty || update.isPending}>
            {update.isPending ? <Loader2 className="h-4 w-4 animate-spin me-1" /> : <Save className="h-4 w-4 me-1" />}{t('admin.brandingPage.common.save' as any)}
          </Button>
        </div>
        <CardDescription>{t('admin.brandingPage.domains.description' as any)}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-5 md:grid-cols-2">
          {DOMAIN_FIELDS.map((f) => (
            <FieldRow key={f.key} label={t(`admin.brandingPage.domains.fields.${f.key}.label` as any)} desc={t(`admin.brandingPage.domains.fields.${f.key}.hint` as any)} value={(form as any)?.[f.key] ?? ''} onChange={(v) => set(f.key, v)} placeholder={f.placeholder} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Email Settings Section ──
function EmailSettingsSection() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: emailSettings, isLoading: settingsLoading } = useQuery({
    queryKey: ['platform-email-settings'],
    queryFn: async () => {
      const body = await adminFetch<{ settings: any }>('/api/admin/management/email-settings');
      return body.settings;
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
      await adminFetch('/api/admin/management/email-settings', {
        method: 'PUT',
        body: JSON.stringify(settingsForm),
      });
    },
    onSuccess: () => { toast({ title: t('admin.brandingPage.emailSettings.saved' as any) }); setSettingsDirty(false); qc.invalidateQueries({ queryKey: ['platform-email-settings'] }); },
    onError: (e) => toast({ title: t('admin.brandingPage.common.error' as any), description: e.message, variant: 'destructive' }),
  });

  // Email settings localized
  const { data: emailLocalized } = useQuery({
    queryKey: ['platform-email-settings-localized'],
    queryFn: async () => {
      const body = await adminFetch<{ rows: any[] }>('/api/admin/management/email-settings-localized');
      return body.rows ?? [];
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
      const { id, created_at, updated_at, workspace_id, ...rest } = row || {};
      await adminFetch('/api/admin/management/email-settings-localized', {
        method: 'PUT',
        body: JSON.stringify({ ...rest, locale }),
      });
    },
    onSuccess: (_data, locale) => { toast({ title: t('admin.brandingPage.emailSettings.localizedSaved' as any, { locale: locale.toUpperCase() }) }); setEmailLocaleDirty((current) => { const next = new Set(current); next.delete(locale); return next; }); qc.invalidateQueries({ queryKey: ['platform-email-settings-localized'] }); },
    onError: (e) => toast({ title: t('admin.brandingPage.common.error' as any), description: e.message, variant: 'destructive' }),
  });

  if (settingsLoading) return <LoadingCard />;

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-4">
        <div className="flex items-center gap-2"><Settings2 className="h-5 w-5 text-primary" /><CardTitle className="text-foreground">{t('admin.brandingPage.emailSettings.title' as any)}</CardTitle></div>
        <CardDescription>{t('admin.brandingPage.emailSettings.description' as any)}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Global email settings */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-foreground">{t('admin.brandingPage.emailSettings.globalTitle' as any)}</h3>
            <Button size="sm" onClick={() => saveSettings.mutate()} disabled={!settingsDirty || saveSettings.isPending}>
              {saveSettings.isPending ? <Loader2 className="h-4 w-4 animate-spin me-1" /> : <Save className="h-4 w-4 me-1" />}{t('admin.brandingPage.common.save' as any)}
            </Button>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <FieldRow label={t('admin.brandingPage.emailSettings.senderEmail' as any)} desc={t('admin.brandingPage.emailSettings.senderEmailHint' as any)} value={settingsForm.sender_email} onChange={(v) => { setSettingsForm(p => ({ ...p, sender_email: v })); setSettingsDirty(true); }} placeholder="noreply@example.com" />
            <FieldRow label={t('admin.brandingPage.emailSettings.replyToEmail' as any)} value={settingsForm.reply_to_email} onChange={(v) => { setSettingsForm(p => ({ ...p, reply_to_email: v })); setSettingsDirty(true); }} placeholder="support@example.com" />
            <FieldRow label={t('admin.brandingPage.emailSettings.logoUrl' as any)} desc={t('admin.brandingPage.emailSettings.logoUrlHint' as any)} value={settingsForm.email_logo_url} onChange={(v) => { setSettingsForm(p => ({ ...p, email_logo_url: v })); setSettingsDirty(true); }} placeholder="https://cdn.example.com/email-logo.png" />
            <FieldRow label={t('admin.brandingPage.emailSettings.footerText' as any)} value={settingsForm.email_footer_text} onChange={(v) => { setSettingsForm(p => ({ ...p, email_footer_text: v })); setSettingsDirty(true); }} placeholder={t('admin.brandingPage.emailSettings.footerPlaceholder' as any)} />
          </div>
        </div>

        <Separator />

        {/* Localized email settings */}
        <div className="space-y-4">
          <h3 className="text-sm font-semibold text-foreground">{t('admin.brandingPage.emailSettings.localizedTitle' as any)}</h3>
          <Tabs value={emailLocaleTab} onValueChange={setEmailLocaleTab}>
            <div className="flex items-center justify-between">
              <TabsList>
                {ALL_LOCALES.filter(l => true).slice(0, 3).map(l => (
                  <TabsTrigger key={l.code} value={l.code} className="gap-1.5">
                    {t(`admin.brandingPage.languages.${l.labelKey}` as any)}
                    {emailLocaleDirty.has(l.code) && <Badge variant="secondary" className="text-[10px] px-1 py-0">{t('admin.brandingPage.common.unsaved' as any)}</Badge>}
                  </TabsTrigger>
                ))}
              </TabsList>
              <Button size="sm" onClick={() => saveEmailLocale.mutate(emailLocaleTab)} disabled={!emailLocaleDirty.has(emailLocaleTab) || saveEmailLocale.isPending}>
                {saveEmailLocale.isPending ? <Loader2 className="h-4 w-4 animate-spin me-1" /> : <Save className="h-4 w-4 me-1" />}{t('admin.brandingPage.common.save' as any)}
              </Button>
            </div>
            {ALL_LOCALES.filter(l => true).slice(0, 3).map(l => (
              <TabsContent key={l.code} value={l.code} className="mt-4">
                <div className="grid gap-4 md:grid-cols-2">
                  <FieldRow label={t('admin.brandingPage.emailSettings.senderName' as any)} desc={t('admin.brandingPage.emailSettings.senderNameHint' as any)} value={emailLocaleForms[l.code]?.sender_name ?? ''} onChange={(v) => { setEmailLocaleForms(p => ({ ...p, [l.code]: { ...p[l.code], sender_name: v, locale: l.code } })); setEmailLocaleDirty(p => new Set(p).add(l.code)); }} placeholder={t('admin.brandingPage.emailSettings.senderNamePlaceholder' as any)} />
                  <FieldRow label={t('admin.brandingPage.emailSettings.localizedFooter' as any)} value={emailLocaleForms[l.code]?.footer_text ?? ''} onChange={(v) => { setEmailLocaleForms(p => ({ ...p, [l.code]: { ...p[l.code], footer_text: v, locale: l.code } })); setEmailLocaleDirty(p => new Set(p).add(l.code)); }} placeholder={t('admin.brandingPage.emailSettings.localizedFooterPlaceholder' as any)} />
                  <FieldRow label={t('admin.brandingPage.emailSettings.supportLabel' as any)} value={emailLocaleForms[l.code]?.support_contact_label ?? ''} onChange={(v) => { setEmailLocaleForms(p => ({ ...p, [l.code]: { ...p[l.code], support_contact_label: v, locale: l.code } })); setEmailLocaleDirty(p => new Set(p).add(l.code)); }} placeholder={t('admin.brandingPage.emailSettings.supportPlaceholder' as any)} />
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
  const { t } = useTranslation();
  return (
    <div className="space-y-6 max-w-4xl animate-fade-in">
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t('admin.brandingPage.title' as any)}</h1>
        <p className="text-muted-foreground text-sm mt-1">
          {t('admin.brandingPage.subtitle' as any)}
        </p>
      </div>

      <Tabs defaultValue="identity">
        <TabsList className="w-full justify-start flex-wrap">
          <TabsTrigger value="identity" className="gap-1.5"><Palette className="h-4 w-4" /> {t('admin.brandingPage.tabs.identity' as any)}</TabsTrigger>
          <TabsTrigger value="settings" className="gap-1.5"><Settings2 className="h-4 w-4" /> {t('admin.brandingPage.tabs.settings' as any)}</TabsTrigger>
          <TabsTrigger value="email-settings" className="gap-1.5"><Mail className="h-4 w-4" /> {t('admin.brandingPage.tabs.emailSettings' as any)}</TabsTrigger>
          <TabsTrigger value="email-templates" className="gap-1.5"><Mail className="h-4 w-4" /> {t('admin.brandingPage.tabs.emailTemplates' as any)}</TabsTrigger>
          <TabsTrigger value="ui-defaults" className="gap-1.5"><Type className="h-4 w-4" /> {t('admin.brandingPage.tabs.uiDefaults' as any)}</TabsTrigger>
          <TabsTrigger value="domains" className="gap-1.5"><Link2 className="h-4 w-4" /> {t('admin.brandingPage.tabs.domains' as any)}</TabsTrigger>
        </TabsList>
        <TabsContent value="identity" className="mt-4"><VisualIdentitySection /></TabsContent>
        <TabsContent value="ui-defaults" className="mt-4"><UiDefaultsSection /></TabsContent>

        <TabsContent value="settings" className="mt-4"><SettingsSection /></TabsContent>
        <TabsContent value="email-settings" className="mt-4"><EmailSettingsSection /></TabsContent>
        <TabsContent value="email-templates" className="mt-4"><EmailTemplatesTab /></TabsContent>
        <TabsContent value="domains" className="mt-4"><DomainUrlsSection /></TabsContent>
      </Tabs>
    </div>
  );
}
