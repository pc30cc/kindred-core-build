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

// ── Localized Branding Section ──
const LOCALES = [
  { code: 'en', label: 'English' },
  { code: 'fa', label: 'فارسی' },
  { code: 'tr', label: 'Türkçe' },
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

function LocalizedBrandingSection() {
  const { data: rows, isLoading } = usePlatformBrandingLocalized();
  const { data: settings } = useQuery({
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

  const handleSave = (locale: string) => {
    const row = forms[locale];
    if (!row) return;
    const { id, created_at, updated_at, ...rest } = row as any;
    upsert.mutate({ ...rest, locale }, {
      onSuccess: () => { toast({ title: `${locale.toUpperCase()} branding saved` }); setDirtyLocales((p) => { const n = new Set(p); n.delete(locale); return n; }); },
      onError: (e) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
    });
  };

  const handleSetDefaultLocale = async (locale: string) => {
    const { data: existing } = await supabase.from('platform_settings').select('id').limit(1).maybeSingle();
    if (existing) {
      await supabase.from('platform_settings').update({ default_locale: locale, updated_at: new Date().toISOString() }).eq('id', existing.id);
    } else {
      await supabase.from('platform_settings').insert({ default_locale: locale });
    }
    qc.invalidateQueries({ queryKey: ['platform_settings'] });
    toast({ title: `Default language set to ${locale.toUpperCase()}` });
  };

  if (isLoading) return <LoadingCard />;

  const current = forms[activeLocale] ?? {};
  const defaultLocale = settings?.default_locale || 'en';

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-4">
        <div className="flex items-center gap-2"><Type className="h-5 w-5 text-primary" /><CardTitle className="text-foreground">Localized Branding</CardTitle></div>
        <CardDescription>Platform text & SEO for each language.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Default locale selector */}
        <div className="flex items-center gap-3 p-3 rounded-lg border border-border bg-muted/30">
          <Label className="text-sm font-medium whitespace-nowrap">Default Language:</Label>
          <Select value={defaultLocale} onValueChange={handleSetDefaultLocale}>
            <SelectTrigger className="w-40 h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              {LOCALES.map(l => (
                <SelectItem key={l.code} value={l.code}>{l.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Tabs value={activeLocale} onValueChange={setActiveLocale}>
          <div className="flex items-center justify-between">
            <TabsList>
              {LOCALES.map((l) => (
                <TabsTrigger key={l.code} value={l.code} className="gap-1.5">
                  {l.label}
                  {l.code === defaultLocale && <Badge variant="outline" className="text-[10px] px-1 py-0">default</Badge>}
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
                  <FieldRow key={f.key} label={f.label} desc={f.desc} value={(current as any)?.[f.key] ?? ''} onChange={(v) => setField(l.code, f.key, v)} placeholder={`Enter ${f.label.toLowerCase()}`} />
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
        <CardDescription>Base URLs used across emails, widgets, SEO, and public pages.</CardDescription>
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
                {LOCALES.map(l => (
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
            {LOCALES.map(l => (
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
          <TabsTrigger value="localized" className="gap-1.5"><Type className="h-4 w-4" /> Localized Text</TabsTrigger>
          <TabsTrigger value="email-settings" className="gap-1.5"><Settings2 className="h-4 w-4" /> Email Settings</TabsTrigger>
          <TabsTrigger value="email-templates" className="gap-1.5"><Mail className="h-4 w-4" /> Email Templates</TabsTrigger>
          <TabsTrigger value="domains" className="gap-1.5"><Link2 className="h-4 w-4" /> Domain URLs</TabsTrigger>
        </TabsList>
        <TabsContent value="identity" className="mt-4"><VisualIdentitySection /></TabsContent>
        <TabsContent value="localized" className="mt-4"><LocalizedBrandingSection /></TabsContent>
        <TabsContent value="email-settings" className="mt-4"><EmailSettingsSection /></TabsContent>
        <TabsContent value="email-templates" className="mt-4"><EmailTemplatesTab /></TabsContent>
        <TabsContent value="domains" className="mt-4"><DomainUrlsSection /></TabsContent>
      </Tabs>
    </div>
  );
}
