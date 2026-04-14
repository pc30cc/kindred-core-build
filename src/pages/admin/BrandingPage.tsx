import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import { toast } from '@/hooks/use-toast';
import { Loader2, Palette, Globe, Type, Link2, Image, Save, Eye } from 'lucide-react';
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
  label,
  desc,
  value,
  onChange,
  type = 'text',
  placeholder,
}: {
  label: string;
  desc?: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
}) {
  return (
    <div className="grid gap-1.5">
      <Label className="text-sm font-medium text-foreground">{label}</Label>
      {desc && <p className="text-xs text-muted-foreground">{desc}</p>}
      <div className="flex gap-2">
        {type === 'color' ? (
          <>
            <Input
              type="color"
              value={value || '#3B82F6'}
              onChange={(e) => onChange(e.target.value)}
              className="w-12 h-10 p-1 shrink-0"
            />
            <Input
              value={value}
              onChange={(e) => onChange(e.target.value)}
              placeholder="#3B82F6"
              className="font-mono"
            />
          </>
        ) : (
          <Input
            type={type}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
          />
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

  useEffect(() => {
    if (branding) {
      setForm(branding);
      setDirty(false);
    }
  }, [branding]);

  const set = (key: keyof PlatformBranding, val: string) => {
    setForm((p) => ({ ...p, [key]: val }));
    setDirty(true);
  };

  const handleSave = () => {
    const { id, created_at, updated_at, ...rest } = form as any;
    update.mutate(rest, {
      onSuccess: () => {
        toast({ title: 'Visual identity saved' });
        setDirty(false);
      },
      onError: (e) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
    });
  };

  if (isLoading) return <LoadingCard />;

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Palette className="h-5 w-5 text-primary" />
            <CardTitle className="text-foreground">Visual Identity</CardTitle>
          </div>
          <Button size="sm" onClick={handleSave} disabled={!dirty || update.isPending}>
            {update.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Save className="h-4 w-4 mr-1" />}
            Save
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

        {/* Preview */}
        {(form.logo_url || form.primary_color) && (
          <>
            <Separator />
            <div className="rounded-lg border border-border p-4">
              <p className="text-xs text-muted-foreground mb-3 flex items-center gap-1"><Eye className="h-3 w-3" /> Preview</p>
              <div className="flex items-center gap-3">
                {form.logo_url && (
                  <img src={form.logo_url} alt="Logo preview" className="h-10 max-w-[160px] object-contain rounded" onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')} />
                )}
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

// ── Localized Branding Section ──
const LOCALES = [
  { code: 'en', label: 'English' },
  { code: 'fa', label: 'فارسی' },
  { code: 'tr', label: 'Türkçe' },
];

const LOCALIZED_FIELDS: { key: keyof PlatformBrandingLocalized; label: string; desc?: string }[] = [
  { key: 'platform_name', label: 'Platform Name', desc: 'Main name shown in header and emails' },
  { key: 'meta_title', label: 'Meta Title', desc: 'Default SEO page title' },
  { key: 'meta_description', label: 'Meta Description', desc: 'Default SEO description' },
  { key: 'social_share_title', label: 'Social Share Title', desc: 'OG title for social cards' },
  { key: 'social_share_description', label: 'Social Share Description' },
  { key: 'browser_title_format', label: 'Browser Title Format', desc: 'e.g. {{page}} | {{platform}}' },
  { key: 'public_site_title', label: 'Public Site Title', desc: 'Landing/public page heading' },
  { key: 'widget_display_name', label: 'Widget Display Name', desc: 'Chat widget header name' },
  { key: 'knowledge_base_title', label: 'Knowledge Base Title' },
  { key: 'legal_company_display_name', label: 'Legal Company Name', desc: 'For structured data and footer' },
  { key: 'footer_company_text', label: 'Footer Company Text', desc: 'Copyright / legal footer' },
  { key: 'support_label', label: 'Support Label', desc: 'Support link text' },
];

function LocalizedBrandingSection() {
  const { data: rows, isLoading } = usePlatformBrandingLocalized();
  const upsert = useUpsertPlatformBrandingLocalized();
  const [activeLocale, setActiveLocale] = useState('en');
  const [forms, setForms] = useState<Record<string, Partial<PlatformBrandingLocalized>>>({});
  const [dirtyLocales, setDirtyLocales] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (rows) {
      const map: Record<string, Partial<PlatformBrandingLocalized>> = {};
      rows.forEach((r) => (map[r.locale] = r));
      setForms(map);
      setDirtyLocales(new Set());
    }
  }, [rows]);

  const setField = (locale: string, key: string, val: string) => {
    setForms((p) => ({
      ...p,
      [locale]: { ...p[locale], [key]: val, locale },
    }));
    setDirtyLocales((p) => new Set(p).add(locale));
  };

  const handleSave = (locale: string) => {
    const row = forms[locale];
    if (!row) return;
    const { id, created_at, updated_at, ...rest } = row as any;
    upsert.mutate(
      { ...rest, locale },
      {
        onSuccess: () => {
          toast({ title: `${locale.toUpperCase()} branding saved` });
          setDirtyLocales((p) => {
            const n = new Set(p);
            n.delete(locale);
            return n;
          });
        },
        onError: (e) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
      }
    );
  };

  if (isLoading) return <LoadingCard />;

  const current = forms[activeLocale] ?? {};

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-4">
        <div className="flex items-center gap-2">
          <Type className="h-5 w-5 text-primary" />
          <CardTitle className="text-foreground">Localized Branding</CardTitle>
        </div>
        <CardDescription>Platform text & SEO for each language.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Tabs value={activeLocale} onValueChange={setActiveLocale}>
          <div className="flex items-center justify-between">
            <TabsList>
              {LOCALES.map((l) => (
                <TabsTrigger key={l.code} value={l.code} className="gap-1.5">
                  {l.label}
                  {dirtyLocales.has(l.code) && <Badge variant="secondary" className="text-[10px] px-1 py-0">unsaved</Badge>}
                </TabsTrigger>
              ))}
            </TabsList>
            <Button size="sm" onClick={() => handleSave(activeLocale)} disabled={!dirtyLocales.has(activeLocale) || upsert.isPending}>
              {upsert.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Save className="h-4 w-4 mr-1" />}
              Save {activeLocale.toUpperCase()}
            </Button>
          </div>

          {LOCALES.map((l) => (
            <TabsContent key={l.code} value={l.code} className="mt-4">
              <div className="grid gap-5 md:grid-cols-2">
                {LOCALIZED_FIELDS.map((f) => (
                  <FieldRow
                    key={f.key}
                    label={f.label}
                    desc={f.desc}
                    value={(current as any)?.[f.key] ?? ''}
                    onChange={(v) => setField(l.code, f.key, v)}
                    placeholder={`Enter ${f.label.toLowerCase()}`}
                  />
                ))}
              </div>
            </TabsContent>
          ))}
        </Tabs>
      </CardContent>
    </Card>
  );
}

// ── Domain URLs Section ──
const DOMAIN_FIELDS: { key: keyof PlatformDomains; label: string; desc?: string; placeholder: string }[] = [
  { key: 'primary_domain', label: 'Primary Domain', desc: 'Main domain of the platform', placeholder: 'example.com' },
  { key: 'canonical_base_url', label: 'Canonical Base URL', desc: 'For SEO canonical tags', placeholder: 'https://example.com' },
  { key: 'app_base_url', label: 'App / Panel URL', placeholder: 'https://app.example.com' },
  { key: 'api_base_url', label: 'API Base URL', placeholder: 'https://api.example.com' },
  { key: 'widget_base_url', label: 'Widget Base URL', desc: 'Widget CDN/loader', placeholder: 'https://widget.example.com' },
  { key: 'asset_base_url', label: 'Asset / CDN URL', placeholder: 'https://cdn.example.com' },
  { key: 'public_base_url', label: 'Public Site URL', placeholder: 'https://example.com' },
  { key: 'help_center_base_url', label: 'Help Center URL', placeholder: 'https://help.example.com' },
  { key: 'email_base_url', label: 'Email Base URL', desc: 'Links inside emails', placeholder: 'https://example.com' },
];

function DomainUrlsSection() {
  const { data: domains, isLoading } = usePlatformDomains();
  const update = useUpdatePlatformDomains();
  const [form, setForm] = useState<Partial<PlatformDomains>>({});
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (domains) {
      setForm(domains);
      setDirty(false);
    }
  }, [domains]);

  const set = (key: keyof PlatformDomains, val: string) => {
    setForm((p) => ({ ...p, [key]: val }));
    setDirty(true);
  };

  const handleSave = () => {
    const { id, created_at, updated_at, ...rest } = form as any;
    update.mutate(rest, {
      onSuccess: () => {
        toast({ title: 'Domain URLs saved' });
        setDirty(false);
      },
      onError: (e) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
    });
  };

  if (isLoading) return <LoadingCard />;

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Link2 className="h-5 w-5 text-primary" />
            <CardTitle className="text-foreground">Platform Domain URLs</CardTitle>
          </div>
          <Button size="sm" onClick={handleSave} disabled={!dirty || update.isPending}>
            {update.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Save className="h-4 w-4 mr-1" />}
            Save
          </Button>
        </div>
        <CardDescription>Base URLs used across emails, widgets, SEO, and public pages.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-5 md:grid-cols-2">
          {DOMAIN_FIELDS.map((f) => (
            <FieldRow
              key={f.key}
              label={f.label}
              desc={f.desc}
              value={(form as any)?.[f.key] ?? ''}
              onChange={(v) => set(f.key, v)}
              placeholder={f.placeholder}
            />
          ))}
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
          Default visual identity, localized text, and domain URLs applied to all new workspaces and the public site.
        </p>
      </div>

      <Tabs defaultValue="identity">
        <TabsList className="w-full justify-start">
          <TabsTrigger value="identity" className="gap-1.5"><Palette className="h-4 w-4" /> Visual Identity</TabsTrigger>
          <TabsTrigger value="localized" className="gap-1.5"><Type className="h-4 w-4" /> Localized Text</TabsTrigger>
          <TabsTrigger value="domains" className="gap-1.5"><Link2 className="h-4 w-4" /> Domain URLs</TabsTrigger>
        </TabsList>
        <TabsContent value="identity" className="mt-4"><VisualIdentitySection /></TabsContent>
        <TabsContent value="localized" className="mt-4"><LocalizedBrandingSection /></TabsContent>
        <TabsContent value="domains" className="mt-4"><DomainUrlsSection /></TabsContent>
      </Tabs>
    </div>
  );
}
