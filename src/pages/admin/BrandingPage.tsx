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
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter,
} from '@/components/ui/dialog';
import { toast } from '@/hooks/use-toast';
import { Loader2, Palette, Type, Link2, Save, Eye, Mail, Plus, Pencil, Trash2, Settings2, Smartphone } from 'lucide-react';
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
import { UI_ACCENT_SWATCH, UI_FONT_SIZE_PX, type UiAccent, type UiFontSize } from '@/lib/ui-preferences';

/**
 * What the three admin endpoints on this page answer with. These were `any`
 * at every call site, which is also why `(settings as any).region_mode` had to
 * be written four times. Declaring the rows once turns each of those into an
 * ordinary property read.
 *
 * Only the fields this page actually uses are listed — the endpoints return
 * whole rows, and an index signature keeps that honest without pretending to
 * enumerate columns this screen never touches.
 */
interface PlatformSettingsRow {
  region_mode?: string | null;
  maintenance_mode?: boolean | null;
  maintenance_message?: string | null;
  locale_billing_providers?: Record<string, string> | null;
  [key: string]: unknown;
}

interface EmailSettingsRow {
  sender_email?: string | null;
  reply_to_email?: string | null;
  email_logo_url?: string | null;
  email_footer_text?: string | null;
  [key: string]: unknown;
}

/** One row of `email_settings_localized`, keyed by locale. */
interface EmailSettingsLocalizedRow {
  locale: string;
  sender_name?: string | null;
  footer_text?: string | null;
  support_contact_label?: string | null;
  [key: string]: unknown;
}

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

  const set = (key: keyof PlatformBranding, val: string | boolean) => { setForm((p) => ({ ...p, [key]: val })); setDirty(true); };

  const handleSave = () => {
    const { id, created_at, updated_at, ...rest } = form;
    update.mutate(rest, {
      onSuccess: () => { toast({ title: t('admin.brandingPage.identity.saved') }); setDirty(false); },
      onError: (e) => toast({ title: t('admin.brandingPage.common.error'), description: e.message, variant: 'destructive' }),
    });
  };

  if (isLoading) return <LoadingCard />;

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2"><Palette className="h-5 w-5 text-primary" /><CardTitle className="text-foreground">{t('admin.brandingPage.identity.title')}</CardTitle></div>
          <Button size="sm" onClick={handleSave} disabled={!dirty || update.isPending}>
            {update.isPending ? <Loader2 className="h-4 w-4 animate-spin me-1" /> : <Save className="h-4 w-4 me-1" />}{t('admin.brandingPage.common.save')}
          </Button>
        </div>
        <CardDescription>{t('admin.brandingPage.identity.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-5 md:grid-cols-2">
          <FieldRow label={t('admin.brandingPage.identity.logoUrl')} desc={t('admin.brandingPage.identity.logoHint')} value={form.logo_url ?? ''} onChange={(v) => set('logo_url', v)} placeholder="https://cdn.example.com/logo.svg" />
          <FieldRow label={t('admin.brandingPage.identity.faviconUrl')} desc={t('admin.brandingPage.identity.faviconHint')} value={form.favicon_url ?? ''} onChange={(v) => set('favicon_url', v)} placeholder="https://cdn.example.com/favicon.ico" />
          <FieldRow label={t('admin.brandingPage.identity.primaryColor')} type="color" value={form.primary_color ?? '#3B82F6'} onChange={(v) => set('primary_color', v)} />
          <FieldRow label={t('admin.brandingPage.identity.secondaryColor')} type="color" value={form.secondary_color ?? '#6366F1'} onChange={(v) => set('secondary_color', v)} />
          <FieldRow label={t('admin.brandingPage.identity.pwaIconUrl')} desc={t('admin.brandingPage.identity.pwaIconHint')} value={form.pwa_icon_url ?? ''} onChange={(v) => set('pwa_icon_url', v)} placeholder="https://cdn.example.com/pwa-icon.png" />
        </div>

        <Separator />
        <div className="space-y-4">
          <div className="flex items-center gap-2"><Smartphone className="h-4 w-4 text-primary" /><p className="text-sm font-semibold text-foreground">{t('admin.brandingPage.identity.pwaSectionTitle')}</p></div>
          <p className="text-xs text-muted-foreground -mt-2">{t('admin.brandingPage.identity.pwaSectionDesc')}</p>
          <div className="flex items-center justify-between rounded-lg border border-border p-3">
            <div>
              <p className="text-sm font-medium text-foreground">{t('admin.brandingPage.identity.pwaEnabled')}</p>
              <p className="text-xs text-muted-foreground">{t('admin.brandingPage.identity.pwaEnabledDesc')}</p>
            </div>
            <Switch checked={form.pwa_enabled !== false} onCheckedChange={(v) => set('pwa_enabled', v)} />
          </div>
          <div className="grid gap-5 md:grid-cols-2">
            <FieldRow label={t('admin.brandingPage.identity.pwaShortName')} desc={t('admin.brandingPage.identity.pwaShortNameHint')} value={form.pwa_short_name ?? ''} onChange={(v) => set('pwa_short_name', v)} placeholder={t('admin.brandingPage.identity.pwaShortNamePlaceholder')} />
            <FieldRow label={t('admin.brandingPage.identity.pwaBackgroundColor')} type="color" value={form.pwa_background_color ?? '#ffffff'} onChange={(v) => set('pwa_background_color', v)} />
          </div>
        </div>

        {(form.logo_url || form.primary_color) && (
          <>
            <Separator />
            <div className="rounded-lg border border-border p-4">
              <p className="text-xs text-muted-foreground mb-3 flex items-center gap-1"><Eye className="h-3 w-3" /> {t('admin.brandingPage.identity.preview')}</p>
              <div className="flex items-center gap-3">
                {form.logo_url && <img src={form.logo_url} alt={t('admin.brandingPage.identity.logoPreview')} className="h-10 max-w-[160px] object-contain rounded" onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')} />}
                <div className="flex gap-2">
                  <div className="w-8 h-8 rounded-md border border-border" style={{ backgroundColor: form.primary_color ?? '#3B82F6' }} title={t('admin.brandingPage.identity.primaryColor')} />
                  <div className="w-8 h-8 rounded-md border border-border" style={{ backgroundColor: form.secondary_color ?? '#6366F1' }} title={t('admin.brandingPage.identity.secondaryColor')} />
                </div>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ── Platform default UI preferences (font size / accent / chroma / skin) ──
function UiDefaultsSection() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: branding, isLoading } = usePlatformBranding();
  const update = useUpdatePlatformBranding();
  const [form, setForm] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!branding) return;
    const row = branding as unknown as Record<string, string | null>;
    setForm({
      default_ui_font_size: row.default_ui_font_size || 'md',
      default_ui_accent: row.default_ui_accent || 'blue',
      default_ui_chroma: row.default_ui_chroma || 'color',
      default_ui_skin: row.default_ui_skin || 'cloud',
    });
    setDirty(false);
  }, [branding]);

  const set = (key: string, val: string) => { setForm((p) => ({ ...p, [key]: val })); setDirty(true); };

  const handleSave = () => {
    update.mutate(form, {
      onSuccess: () => {
        toast({ title: t('admin.brandingPage.uiDefaults.saved') });
        setDirty(false);
        qc.invalidateQueries({ queryKey: ['platform_ui_defaults'] });
      },
      onError: (e: Error) => toast({ title: t('admin.brandingPage.common.error'), description: e.message, variant: 'destructive' }),
    });
  };

  if (isLoading) return <LoadingCard />;

  const fontSizes: UiFontSize[] = ['xs', 'sm', 'md', 'lg', 'xl'];

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2"><Type className="h-5 w-5 text-primary" /><CardTitle className="text-foreground">{t('admin.brandingPage.uiDefaults.title')}</CardTitle></div>
          <Button size="sm" onClick={handleSave} disabled={!dirty || update.isPending}>
            {update.isPending ? <Loader2 className="h-4 w-4 animate-spin me-1" /> : <Save className="h-4 w-4 me-1" />}{t('admin.brandingPage.common.save')}
          </Button>
        </div>
        <CardDescription>{t('admin.brandingPage.uiDefaults.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Font size */}
        <div className="space-y-2">
          <Label className="text-sm font-medium text-foreground">{t('interface.fontSize')}</Label>
          <div className="flex flex-wrap gap-2">
            {fontSizes.map((size) => (
              <button
                key={size}
                type="button"
                onClick={() => set('default_ui_font_size', size)}
                className={`rounded-xl border px-4 py-2 transition-all ${
                  form.default_ui_font_size === size
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border bg-background text-muted-foreground hover:border-primary/40'
                }`}
                style={{ fontSize: `${UI_FONT_SIZE_PX[size]}px` }}
              >
                {t(`interface.fontSize_${size}`)}
              </button>
            ))}
          </div>
        </div>

        {/* Accent */}
        <div className="space-y-2">
          <Label className="text-sm font-medium text-foreground">{t('interface.accent')}</Label>
          <div className="flex flex-wrap gap-2">
            {(Object.keys(UI_ACCENT_SWATCH) as UiAccent[]).map((accent) => (
              <button
                key={accent}
                type="button"
                aria-label={t(`interface.accent_${accent}`)}
                onClick={() => set('default_ui_accent', accent)}
                className={`h-9 w-9 rounded-full border-2 transition-transform ${
                  form.default_ui_accent === accent ? 'border-foreground scale-110' : 'border-transparent hover:scale-105'
                }`}
                style={{ backgroundColor: UI_ACCENT_SWATCH[accent] }}
              />
            ))}
          </div>
        </div>

        <div className="grid gap-5 md:grid-cols-2">
          <div className="grid gap-1.5">
            <Label className="text-sm font-medium text-foreground">{t('interface.chroma')}</Label>
            <Select value={form.default_ui_chroma ?? 'color'} onValueChange={(v) => set('default_ui_chroma', v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="color">{t('interface.chroma_color')}</SelectItem>
                <SelectItem value="mono">{t('interface.chroma_mono')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label className="text-sm font-medium text-foreground">{t('interface.skin')}</Label>
            <Select value={form.default_ui_skin ?? 'cloud'} onValueChange={(v) => set('default_ui_skin', v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="cloud">{t('interface.skin_cloud')}</SelectItem>
                <SelectItem value="linen">{t('interface.skin_linen')}</SelectItem>
                <SelectItem value="graphite">{t('interface.skin_graphite')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <p className="text-xs text-muted-foreground">{t('admin.brandingPage.uiDefaults.note')}</p>
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
  { value: 'internal_test', label: 'Internal Test Gateway (Simulator)' },
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
      const body = await adminFetch<{ settings: PlatformSettingsRow }>('/api/admin/management/platform-settings');
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
  // Signup verification (method/gate) now lives in Super Admin →
  // Verification & OTP (SignupDeliveryCard) — never written from here, so
  // saving general settings can't overwrite it with a stale value.
  const [settingsDirty, setSettingsDirty] = useState(false);


  useEffect(() => {
    if (settings) {
      setDefaultLocale(settings.default_locale || 'en');
      setActiveLocales(settings.active_locales || ['en']);
      setTimezone(settings.timezone || 'UTC');
      setSiteMode(settings.site_mode || 'multi_language');
      setRegionMode(isRegionMode(settings.region_mode) ? (settings.region_mode as RegionMode) : 'multi');
      setMaintenanceMode(settings.maintenance_mode ?? false);
      setMaintenanceMessage(settings.maintenance_message ?? '');
      setLocaleBillingProviders(settings.locale_billing_providers ?? {});
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
    const { id, created_at, updated_at, ...rest } = row;
    upsert.mutate({ ...rest, locale }, {
      onSuccess: () => { toast({ title: t('admin.brandingPage.settings.localized.saved', { locale: locale.toUpperCase() }) }); setDirtyLocales((p) => { const n = new Set(p); n.delete(locale); return n; }); },
      onError: (e) => toast({ title: t('admin.brandingPage.common.error'), description: e.message, variant: 'destructive' }),
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
      toast({ title: t('admin.brandingPage.common.error'), description: e instanceof Error ? e.message : t('admin.brandingPage.common.saveFailed'), variant: 'destructive' });
      return;
    }
    qc.invalidateQueries({ queryKey: ['platform_settings'] });
    qc.invalidateQueries({ queryKey: ['platform_region_settings'] });
    setCachedRegionMode(regionMode);
    toast({ title: t('admin.brandingPage.settings.saved') });
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
  const localeLabel = (code: string) => t(`admin.brandingPage.languages.${code}`);
  const regionTitle = (mode: RegionMode) => t(`admin.brandingPage.settings.region.modes.${mode}.title`);
  const regionDescription = (mode: RegionMode) => t(`admin.brandingPage.settings.region.modes.${mode}.description`);
  const regionCurrency = (mode: RegionMode) => t(`admin.brandingPage.settings.region.modes.${mode}.currency`);

  return (
    <div className="space-y-6">
      <Tabs value={settingsTab} onValueChange={setSettingsTab}>
        <TabsList className="h-auto w-full justify-start overflow-x-auto">
          <TabsTrigger value="general" className="gap-1.5"><Wrench className="h-4 w-4" /> {t('admin.brandingPage.settings.tabs.general')}</TabsTrigger>
          <TabsTrigger value="region" className="gap-1.5"><Flag className="h-4 w-4" /> {t('admin.brandingPage.settings.tabs.region')}</TabsTrigger>
          <TabsTrigger value="languages" className="gap-1.5"><Languages className="h-4 w-4" /> {t('admin.brandingPage.settings.tabs.languages')}</TabsTrigger>
          <TabsTrigger value="billing" className="gap-1.5"><CreditCard className="h-4 w-4" /> {t('admin.brandingPage.settings.tabs.billing')}</TabsTrigger>
          <TabsTrigger value="localized" className="gap-1.5"><Globe className="h-4 w-4" /> {t('admin.brandingPage.settings.tabs.localized')}</TabsTrigger>
        </TabsList>

        {/* ── General Settings ── */}
        <TabsContent value="general" className="mt-4">
          <Card className="bg-card border-border">
            <CardHeader className="pb-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2"><Wrench className="h-5 w-5 text-primary" /><CardTitle>{t('admin.brandingPage.settings.general.title')}</CardTitle></div>
                <Button size="sm" onClick={handleSaveSettings} disabled={!settingsDirty}>
                  <Save className="h-4 w-4 me-1" />{t('admin.brandingPage.common.save')}
                </Button>
              </div>
              <CardDescription>{t('admin.brandingPage.settings.general.description')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="grid gap-5 md:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label>{t('admin.brandingPage.settings.general.defaultLanguage')}</Label>
                  <p className="text-xs text-muted-foreground">{t('admin.brandingPage.settings.general.defaultLanguageHint')}</p>
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
                  <Label>{t('admin.brandingPage.settings.general.timezone')}</Label>
                  <Input value={timezone} onChange={e => { setTimezone(e.target.value); setSettingsDirty(true); }} placeholder="UTC" />
                </div>
                <div className="grid gap-1.5">
                  <Label>{t('admin.brandingPage.settings.general.siteMode')}</Label>
                  <Select value={siteMode} onValueChange={(v) => { setSiteMode(v); setSettingsDirty(true); }}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="multi_language">{t('admin.brandingPage.settings.general.multiLanguage')}</SelectItem>
                      <SelectItem value="single_language">{t('admin.brandingPage.settings.general.singleLanguage')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <Separator />



              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <Label className="text-sm font-medium">{t('admin.brandingPage.settings.general.maintenanceMode')}</Label>
                    <p className="text-xs text-muted-foreground">{t('admin.brandingPage.settings.general.maintenanceModeHint')}</p>
                  </div>
                  <Switch checked={maintenanceMode} onCheckedChange={(v) => { setMaintenanceMode(v); setSettingsDirty(true); }} />
                </div>
                {maintenanceMode && (
                  <div className="grid gap-1.5">
                    <Label>{t('admin.brandingPage.settings.general.maintenanceMessage')}</Label>
                    <Textarea value={maintenanceMessage} onChange={e => { setMaintenanceMessage(e.target.value); setSettingsDirty(true); }} placeholder={t('admin.brandingPage.settings.general.maintenancePlaceholder')} className="min-h-[80px]" />
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
                <div className="flex items-center gap-2"><Flag className="h-5 w-5 text-primary" /><CardTitle>{t('admin.brandingPage.settings.region.title')}</CardTitle></div>
                <Button size="sm" onClick={handleSaveSettings} disabled={!settingsDirty}>
                  <Save className="h-4 w-4 me-1" />{t('admin.brandingPage.common.save')}
                </Button>
              </div>
              <CardDescription>{t('admin.brandingPage.settings.region.description')}</CardDescription>
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
                        {selected && <Badge className="ms-auto text-[10px]">{t('admin.brandingPage.common.active')}</Badge>}
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
                {t('admin.brandingPage.settings.region.currentMode')} <strong className="text-foreground">{regionTitle(regionMode)}</strong>
                {' · '}{t('admin.brandingPage.settings.region.languages')}{' '}
                <strong className="text-foreground">{REGION_META[regionMode].languages}</strong>{' · '}
                {t('admin.brandingPage.settings.region.currency')}{' '}
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
                {REGION_META[regionMode].flag} {t('admin.brandingPage.settings.languages.locked', { languages: REGION_META[regionMode].languages })}
              </CardContent>
            </Card>
          )}
          <Card className="bg-card border-border">
            <CardHeader className="pb-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2"><Languages className="h-5 w-5 text-primary" /><CardTitle>{t('admin.brandingPage.settings.languages.title')}</CardTitle></div>
                <Button size="sm" onClick={handleSaveSettings} disabled={!settingsDirty}>
                  <Save className="h-4 w-4 me-1" />{t('admin.brandingPage.common.save')}
                </Button>
              </div>
              <CardDescription>{t('admin.brandingPage.settings.languages.description')}</CardDescription>
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
                      {isDefault && <Badge variant="default" className="text-[10px] shrink-0">{t('admin.brandingPage.common.default')}</Badge>}
                      {isActive && !isDefault && <Badge variant="outline" className="text-[10px] shrink-0">{t('admin.brandingPage.common.active')}</Badge>}
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
                <div className="flex items-center gap-2"><CreditCard className="h-5 w-5 text-primary" /><CardTitle>{t('admin.brandingPage.settings.billing.title')}</CardTitle></div>
                <Button size="sm" onClick={handleSaveSettings} disabled={!settingsDirty}>
                  <Save className="h-4 w-4 me-1" />{t('admin.brandingPage.common.save')}
                </Button>
              </div>
              <CardDescription>{t('admin.brandingPage.settings.billing.description')}</CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('admin.brandingPage.settings.billing.language')}</TableHead>
                    <TableHead>{t('admin.brandingPage.settings.billing.gateway')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {activeLocales.map(code => {
                    const l = ALL_LOCALES.find(x => x.code === code);
                    return (
                      <TableRow key={code}>
                        <TableCell className="font-medium">
                          <span className="me-2">{l?.flag}</span>{l ? localeLabel(l.code) : code}
                          {code === defaultLocale && <Badge variant="outline" className="ms-2 text-[10px]">{t('admin.brandingPage.common.default')}</Badge>}
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
                                <SelectItem key={p.value} value={p.value}>{p.value === 'none' ? t('admin.brandingPage.settings.billing.none') : p.label}</SelectItem>
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
              <div className="flex items-center gap-2"><Globe className="h-5 w-5 text-primary" /><CardTitle>{t('admin.brandingPage.settings.localized.title')}</CardTitle></div>
              <CardDescription>{t('admin.brandingPage.settings.localized.description')}</CardDescription>
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
                          {code === defaultLocale && <Badge variant="outline" className="text-[10px] px-1 py-0">{t('admin.brandingPage.common.default')}</Badge>}
                          {dirtyLocales.has(code) && <Badge variant="secondary" className="text-[10px] px-1 py-0">{t('admin.brandingPage.common.unsaved')}</Badge>}
                        </TabsTrigger>
                      );
                    })}
                  </TabsList>
                  <Button size="sm" onClick={() => handleSaveBranding(activeLocale)} disabled={!dirtyLocales.has(activeLocale) || upsert.isPending}>
                    {upsert.isPending ? <Loader2 className="h-4 w-4 animate-spin me-1" /> : <Save className="h-4 w-4 me-1" />}
                    {t('admin.brandingPage.settings.localized.saveLocale', { locale: activeLocale.toUpperCase() })}
                  </Button>
                </div>
                {activeLocales.map((code) => (
                  <TabsContent key={code} value={code} className="mt-4">
                    <div className="grid gap-5 md:grid-cols-2">
                      {LOCALIZED_FIELDS.map((f) => {
                        const label = t(`admin.brandingPage.settings.localized.fields.${f.key}.label`);
                        return <FieldRow key={f.key} label={label} desc={f.hasDescription ? t(`admin.brandingPage.settings.localized.fields.${f.key}.hint`) : undefined} value={(current as Record<string, unknown> | undefined)?.[f.key] as string ?? ''} onChange={(v) => setField(code, f.key, v)} placeholder={t('admin.brandingPage.settings.localized.placeholder', { field: label })} />;
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
    const { id, created_at, updated_at, ...rest } = form;
    update.mutate(rest, {
      onSuccess: () => { toast({ title: t('admin.brandingPage.domains.saved') }); setDirty(false); },
      onError: (e) => toast({ title: t('admin.brandingPage.common.error'), description: e.message, variant: 'destructive' }),
    });
  };

  if (isLoading) return <LoadingCard />;

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2"><Link2 className="h-5 w-5 text-primary" /><CardTitle className="text-foreground">{t('admin.brandingPage.domains.title')}</CardTitle></div>
          <Button size="sm" onClick={handleSave} disabled={!dirty || update.isPending}>
            {update.isPending ? <Loader2 className="h-4 w-4 animate-spin me-1" /> : <Save className="h-4 w-4 me-1" />}{t('admin.brandingPage.common.save')}
          </Button>
        </div>
        <CardDescription>{t('admin.brandingPage.domains.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-5 md:grid-cols-2">
          {DOMAIN_FIELDS.map((f) => (
            <FieldRow key={f.key} label={t(`admin.brandingPage.domains.fields.${f.key}.label`)} desc={t(`admin.brandingPage.domains.fields.${f.key}.hint`)} value={(form as Record<string, unknown>)?.[f.key] as string ?? ''} onChange={(v) => set(f.key, v)} placeholder={f.placeholder} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Email Settings Section ──
/**
 * Super Admin → Branding → Email settings.
 *
 * ONE field, and that is the whole section. It used to carry seven, and six
 * of them were read by nothing:
 *
 *   sender_email, sender_name  — a second place to answer "who is this from".
 *     The From header is built entirely from the platform email provider's
 *     `from_email` / `from_name` (Super Admin → Providers → Email); see
 *     `resolveFromAddress` in server/services/email/index.ts, the only code
 *     that decides a sender.
 *   email_logo_url, email_footer_text, footer_text, support_contact_label —
 *     email branding that no template can express. Of the 84 stored templates
 *     (28 slugs) not one references a logo or footer placeholder, and not one
 *     contains an <img> tag; `{brand}` is the only branding hook, and it comes
 *     from platform_branding_localized. The code-side wrapper in
 *     server/services/verification/templates.ts has no slot for either.
 *
 * A setting an admin can change that the runtime never reads is worse than no
 * setting: it looks like it worked. The columns stay for rollback, but nothing
 * writes them any more.
 */
function EmailSettingsSection() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: emailSettings, isLoading: settingsLoading } = useQuery({
    queryKey: ['platform-email-settings'],
    queryFn: async () => {
      const body = await adminFetch<{ settings: EmailSettingsRow }>('/api/admin/management/email-settings');
      return body.settings;
    },
  });

  const [replyTo, setReplyTo] = useState('');
  const [settingsDirty, setSettingsDirty] = useState(false);

  useEffect(() => {
    if (emailSettings) {
      setReplyTo(emailSettings.reply_to_email ?? '');
      setSettingsDirty(false);
    }
  }, [emailSettings]);

  const saveSettings = useMutation({
    mutationFn: async () => {
      await adminFetch('/api/admin/management/email-settings', {
        method: 'PUT',
        body: JSON.stringify({ reply_to_email: replyTo }),
      });
    },
    onSuccess: () => {
      toast({ title: t('admin.brandingPage.emailSettings.saved') });
      setSettingsDirty(false);
      qc.invalidateQueries({ queryKey: ['platform-email-settings'] });
    },
    onError: (e: Error) => toast({ title: t('admin.brandingPage.common.error'), description: e.message, variant: 'destructive' }),
  });

  if (settingsLoading) return <LoadingCard />;

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-4">
        <div className="flex items-center gap-2"><Settings2 className="h-5 w-5 text-primary" /><CardTitle className="text-foreground text-base">{t('admin.brandingPage.emailSettings.title')}</CardTitle></div>
        <CardDescription>{t('admin.brandingPage.emailSettings.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-foreground">{t('admin.brandingPage.emailSettings.globalTitle')}</h3>
          <Button size="sm" onClick={() => saveSettings.mutate()} disabled={!settingsDirty || saveSettings.isPending}>
            {saveSettings.isPending ? <Loader2 className="h-4 w-4 animate-spin me-1" /> : <Save className="h-4 w-4 me-1" />}{t('admin.brandingPage.common.save')}
          </Button>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <FieldRow
            label={t('admin.brandingPage.emailSettings.replyToEmail')}
            desc={t('admin.brandingPage.emailSettings.replyToEmailHint')}
            value={replyTo}
            onChange={(v) => { setReplyTo(v); setSettingsDirty(true); }}
            placeholder="support@example.com"
          />
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
        <h1 className="text-2xl font-bold text-foreground">{t('admin.brandingPage.title')}</h1>
        <p className="text-muted-foreground text-sm mt-1">
          {t('admin.brandingPage.subtitle')}
        </p>
      </div>

      <Tabs defaultValue="identity">
        <TabsList className="w-full justify-start flex-wrap">
          <TabsTrigger value="identity" className="gap-1.5"><Palette className="h-4 w-4" /> {t('admin.brandingPage.tabs.identity')}</TabsTrigger>
          <TabsTrigger value="settings" className="gap-1.5"><Settings2 className="h-4 w-4" /> {t('admin.brandingPage.tabs.settings')}</TabsTrigger>
          <TabsTrigger value="email-settings" className="gap-1.5"><Mail className="h-4 w-4" /> {t('admin.brandingPage.tabs.emailSettings')}</TabsTrigger>
          <TabsTrigger value="email-templates" className="gap-1.5"><Mail className="h-4 w-4" /> {t('admin.brandingPage.tabs.emailTemplates')}</TabsTrigger>
          <TabsTrigger value="ui-defaults" className="gap-1.5"><Type className="h-4 w-4" /> {t('admin.brandingPage.tabs.uiDefaults')}</TabsTrigger>
          <TabsTrigger value="domains" className="gap-1.5"><Link2 className="h-4 w-4" /> {t('admin.brandingPage.tabs.domains')}</TabsTrigger>
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
