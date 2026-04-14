/**
 * Admin Platform Settings Page
 * Covers: General, Branding, Domains & URLs, Localization, Email, SEO
 * All data flows through /api/config/* endpoints on the self-hosted backend.
 */

import { useState, useEffect } from 'react';
import { useTranslation } from '@/i18n';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import {
  fetchPlatformSettings,
  updatePlatformSettings,
  fetchPlatformBranding,
  updatePlatformBranding,
  fetchPlatformBrandingLocalized,
  updatePlatformBrandingLocalized,
  fetchPlatformDomains,
  updatePlatformDomains,
  fetchPlatformEmailSettings,
  updatePlatformEmailSettings,
} from '@/lib/config-api';

const LOCALE_OPTIONS = [
  { value: 'en', label: 'English' },
  { value: 'fa', label: 'فارسی (Persian)' },
  { value: 'tr', label: 'Türkçe (Turkish)' },
];

export default function PlatformSettingsPage() {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState('general');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Platform Configuration</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Central runtime configuration — all identity, URLs, localization, and email settings.
        </p>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="flex-wrap">
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="branding">Branding</TabsTrigger>
          <TabsTrigger value="localized">Localized Identity</TabsTrigger>
          <TabsTrigger value="domains">Domains & URLs</TabsTrigger>
          <TabsTrigger value="email">Email</TabsTrigger>
          <TabsTrigger value="seo">SEO & Social</TabsTrigger>
        </TabsList>

        <TabsContent value="general"><GeneralTab /></TabsContent>
        <TabsContent value="branding"><BrandingTab /></TabsContent>
        <TabsContent value="localized"><LocalizedIdentityTab /></TabsContent>
        <TabsContent value="domains"><DomainsTab /></TabsContent>
        <TabsContent value="email"><EmailTab /></TabsContent>
        <TabsContent value="seo"><SeoTab /></TabsContent>
      </Tabs>
    </div>
  );
}

// ─── General Tab ────────────────────────────────────────────

function GeneralTab() {
  const [settings, setSettings] = useState<any>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchPlatformSettings().then(r => setSettings(r.settings)).catch(() => {});
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      await updatePlatformSettings(settings);
      toast.success('Settings saved');
    } catch (e: any) { toast.error(e.message); }
    setSaving(false);
  };

  if (!settings) return <p className="text-muted-foreground p-4">Loading...</p>;

  return (
    <Card>
      <CardHeader>
        <CardTitle>General Settings</CardTitle>
        <CardDescription>Site mode, language defaults, and timezone.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label>Site Mode</Label>
            <Select value={settings.site_mode} onValueChange={v => setSettings({ ...settings, site_mode: v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="single_language">Single Language</SelectItem>
                <SelectItem value="multi_language">Multi Language</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Default Locale</Label>
            <Select value={settings.default_locale} onValueChange={v => setSettings({ ...settings, default_locale: v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {LOCALE_OPTIONS.map(l => <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Panel Default Locale</Label>
            <Select value={settings.panel_default_locale} onValueChange={v => setSettings({ ...settings, panel_default_locale: v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {LOCALE_OPTIONS.map(l => <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Widget Default Locale</Label>
            <Select value={settings.widget_default_locale} onValueChange={v => setSettings({ ...settings, widget_default_locale: v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {LOCALE_OPTIONS.map(l => <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Fallback Locale</Label>
            <Select value={settings.fallback_locale} onValueChange={v => setSettings({ ...settings, fallback_locale: v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {LOCALE_OPTIONS.map(l => <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Timezone</Label>
            <Input value={settings.timezone || ''} onChange={e => setSettings({ ...settings, timezone: e.target.value })} placeholder="UTC" />
          </div>
        </div>

        <div className="space-y-2">
          <Label>Active Locales</Label>
          <div className="flex gap-2">
            {LOCALE_OPTIONS.map(l => {
              const active = settings.active_locales?.includes(l.value);
              return (
                <Badge
                  key={l.value}
                  variant={active ? 'default' : 'outline'}
                  className="cursor-pointer"
                  onClick={() => {
                    const locales = active
                      ? settings.active_locales.filter((x: string) => x !== l.value)
                      : [...(settings.active_locales || []), l.value];
                    setSettings({ ...settings, active_locales: locales });
                  }}
                >
                  {l.label}
                </Badge>
              );
            })}
          </div>
        </div>

        <Button onClick={save} disabled={saving}>{saving ? 'Saving...' : 'Save Settings'}</Button>
      </CardContent>
    </Card>
  );
}

// ─── Branding Tab ───────────────────────────────────────────

function BrandingTab() {
  const [branding, setBranding] = useState<any>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchPlatformBranding().then(r => setBranding(r.branding)).catch(() => {});
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      await updatePlatformBranding(branding);
      toast.success('Branding saved');
    } catch (e: any) { toast.error(e.message); }
    setSaving(false);
  };

  if (!branding) return <p className="text-muted-foreground p-4">Loading...</p>;

  const fields = [
    { key: 'logo_url', label: 'Logo URL', placeholder: 'https://...' },
    { key: 'favicon_url', label: 'Favicon URL', placeholder: 'https://...' },
    { key: 'pwa_icon_url', label: 'PWA Icon URL', placeholder: 'https://...' },
    { key: 'primary_color', label: 'Primary Color', placeholder: '#3B82F6' },
    { key: 'secondary_color', label: 'Secondary Color', placeholder: '#1E40AF' },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Visual Branding</CardTitle>
        <CardDescription>Non-localized visual assets and colors (shared across all languages).</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {fields.map(f => (
            <div key={f.key} className="space-y-2">
              <Label>{f.label}</Label>
              <Input
                value={branding[f.key] || ''}
                onChange={e => setBranding({ ...branding, [f.key]: e.target.value || null })}
                placeholder={f.placeholder}
              />
            </div>
          ))}
        </div>
        <Button onClick={save} disabled={saving}>{saving ? 'Saving...' : 'Save Branding'}</Button>
      </CardContent>
    </Card>
  );
}

// ─── Localized Identity Tab ─────────────────────────────────

function LocalizedIdentityTab() {
  const [items, setItems] = useState<any[]>([]);
  const [activeLocale, setActiveLocale] = useState('en');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchPlatformBrandingLocalized().then(r => setItems(r.items)).catch(() => {});
  }, []);

  const current = items.find(i => i.locale === activeLocale) || { locale: activeLocale };

  const updateField = (key: string, value: string) => {
    const updated = { ...current, [key]: value || null };
    setItems(prev => {
      const idx = prev.findIndex(i => i.locale === activeLocale);
      if (idx >= 0) {
        const copy = [...prev];
        copy[idx] = updated;
        return copy;
      }
      return [...prev, updated];
    });
  };

  const save = async () => {
    setSaving(true);
    try {
      await updatePlatformBrandingLocalized(activeLocale, current);
      toast.success(`${activeLocale} identity saved`);
    } catch (e: any) { toast.error(e.message); }
    setSaving(false);
  };

  const fields = [
    { key: 'platform_name', label: 'Platform Name' },
    { key: 'public_site_title', label: 'Public Site Title' },
    { key: 'browser_title_format', label: 'Browser Title Format', placeholder: '{{page}} — {{platform}}' },
    { key: 'meta_title', label: 'Meta Title' },
    { key: 'meta_description', label: 'Meta Description' },
    { key: 'footer_company_text', label: 'Footer Company Text' },
    { key: 'support_label', label: 'Support Label' },
    { key: 'legal_company_display_name', label: 'Legal/Company Display Name' },
    { key: 'social_share_title', label: 'Social Share Title' },
    { key: 'social_share_description', label: 'Social Share Description' },
    { key: 'knowledge_base_title', label: 'Knowledge Base Title' },
    { key: 'widget_display_name', label: 'Widget Display Name' },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Localized Identity</CardTitle>
        <CardDescription>Per-language text identity (different name/title/footer per locale).</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-2">
          {LOCALE_OPTIONS.map(l => (
            <Badge
              key={l.value}
              variant={activeLocale === l.value ? 'default' : 'outline'}
              className="cursor-pointer"
              onClick={() => setActiveLocale(l.value)}
            >
              {l.label}
            </Badge>
          ))}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {fields.map(f => (
            <div key={f.key} className="space-y-2">
              <Label>{f.label}</Label>
              <Input
                value={current[f.key] || ''}
                onChange={e => updateField(f.key, e.target.value)}
                placeholder={f.placeholder || ''}
                dir={activeLocale === 'fa' ? 'rtl' : 'ltr'}
              />
            </div>
          ))}
        </div>

        <Button onClick={save} disabled={saving}>{saving ? 'Saving...' : `Save ${activeLocale.toUpperCase()} Identity`}</Button>
      </CardContent>
    </Card>
  );
}

// ─── Domains Tab ────────────────────────────────────────────

function DomainsTab() {
  const [domains, setDomains] = useState<any>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchPlatformDomains().then(r => setDomains(r.domains)).catch(() => {});
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      await updatePlatformDomains(domains);
      toast.success('Domains saved');
    } catch (e: any) { toast.error(e.message); }
    setSaving(false);
  };

  if (!domains) return <p className="text-muted-foreground p-4">Loading...</p>;

  const fields = [
    { key: 'primary_domain', label: 'Primary Domain', placeholder: 'example.com', desc: 'Main deployment domain' },
    { key: 'canonical_base_url', label: 'Canonical Base URL', placeholder: 'https://example.com', desc: 'Used in SEO canonical links' },
    { key: 'public_base_url', label: 'Public Base URL', placeholder: 'https://example.com', desc: 'Public-facing site URL' },
    { key: 'app_base_url', label: 'App Base URL', placeholder: 'https://app.example.com', desc: 'Dashboard/panel URL' },
    { key: 'api_base_url', label: 'API Base URL', placeholder: '', desc: 'Leave empty for same-origin (/api)' },
    { key: 'widget_base_url', label: 'Widget Base URL', placeholder: '', desc: 'Widget JS/CSS hosting' },
    { key: 'asset_base_url', label: 'Asset Base URL', placeholder: '', desc: 'CDN for static assets' },
    { key: 'help_center_base_url', label: 'Help Center Base URL', placeholder: '', desc: 'Knowledge base root' },
    { key: 'email_base_url', label: 'Email Base URL', placeholder: '', desc: 'Base URL for email links' },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Domains & URLs</CardTitle>
        <CardDescription>
          Runtime URL resolution. Empty fields default to current origin (same-origin deployment).
          Changing these will affect auth links, email links, widget bootstrap, and SEO.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-4">
          {fields.map(f => (
            <div key={f.key} className="space-y-1">
              <Label>{f.label}</Label>
              <Input
                value={domains[f.key] || ''}
                onChange={e => setDomains({ ...domains, [f.key]: e.target.value || null })}
                placeholder={f.placeholder}
              />
              <p className="text-xs text-muted-foreground">{f.desc}</p>
            </div>
          ))}
        </div>
        <Button onClick={save} disabled={saving}>{saving ? 'Saving...' : 'Save Domains'}</Button>
      </CardContent>
    </Card>
  );
}

// ─── Email Tab ──────────────────────────────────────────────

function EmailTab() {
  const [settings, setSettings] = useState<any>(null);
  const [localized, setLocalized] = useState<any[]>([]);
  const [activeLocale, setActiveLocale] = useState('en');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchPlatformEmailSettings().then(r => {
      setSettings(r.settings);
      setLocalized(r.localized || []);
    }).catch(() => {});
  }, []);

  const currentLoc = localized.find(l => l.locale === activeLocale) || { locale: activeLocale };

  const updateLoc = (key: string, value: string) => {
    const updated = { ...currentLoc, [key]: value || null };
    setLocalized(prev => {
      const idx = prev.findIndex(l => l.locale === activeLocale);
      if (idx >= 0) { const c = [...prev]; c[idx] = updated; return c; }
      return [...prev, updated];
    });
  };

  const save = async () => {
    setSaving(true);
    try {
      await updatePlatformEmailSettings({ settings, localized });
      toast.success('Email settings saved');
    } catch (e: any) { toast.error(e.message); }
    setSaving(false);
  };

  if (!settings) return <p className="text-muted-foreground p-4">Loading...</p>;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Email Identity</CardTitle>
        <CardDescription>Sender address, reply-to, and locale-aware sender names.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label>Sender Email</Label>
            <Input value={settings.sender_email || ''} onChange={e => setSettings({ ...settings, sender_email: e.target.value })} />
          </div>
          <div className="space-y-2">
            <Label>Reply-To Email</Label>
            <Input value={settings.reply_to_email || ''} onChange={e => setSettings({ ...settings, reply_to_email: e.target.value || null })} />
          </div>
          <div className="space-y-2">
            <Label>Email Logo URL</Label>
            <Input value={settings.email_logo_url || ''} onChange={e => setSettings({ ...settings, email_logo_url: e.target.value || null })} />
          </div>
          <div className="space-y-2">
            <Label>Email Footer Text (default)</Label>
            <Input value={settings.email_footer_text || ''} onChange={e => setSettings({ ...settings, email_footer_text: e.target.value || null })} />
          </div>
        </div>

        <div>
          <h3 className="font-medium mb-2">Locale-Specific Sender Identity</h3>
          <div className="flex gap-2 mb-4">
            {LOCALE_OPTIONS.map(l => (
              <Badge
                key={l.value}
                variant={activeLocale === l.value ? 'default' : 'outline'}
                className="cursor-pointer"
                onClick={() => setActiveLocale(l.value)}
              >
                {l.label}
              </Badge>
            ))}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label>Sender Name ({activeLocale})</Label>
              <Input
                value={currentLoc.sender_name || ''}
                onChange={e => updateLoc('sender_name', e.target.value)}
                dir={activeLocale === 'fa' ? 'rtl' : 'ltr'}
              />
            </div>
            <div className="space-y-2">
              <Label>Footer Text ({activeLocale})</Label>
              <Input
                value={currentLoc.footer_text || ''}
                onChange={e => updateLoc('footer_text', e.target.value)}
                dir={activeLocale === 'fa' ? 'rtl' : 'ltr'}
              />
            </div>
            <div className="space-y-2">
              <Label>Support Label ({activeLocale})</Label>
              <Input
                value={currentLoc.support_contact_label || ''}
                onChange={e => updateLoc('support_contact_label', e.target.value)}
                dir={activeLocale === 'fa' ? 'rtl' : 'ltr'}
              />
            </div>
          </div>
        </div>

        <Button onClick={save} disabled={saving}>{saving ? 'Saving...' : 'Save Email Settings'}</Button>
      </CardContent>
    </Card>
  );
}

// ─── SEO Tab ────────────────────────────────────────────────

function SeoTab() {
  const [items, setItems] = useState<any[]>([]);
  const [activeLocale, setActiveLocale] = useState('en');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchPlatformBrandingLocalized().then(r => setItems(r.items)).catch(() => {});
  }, []);

  const current = items.find(i => i.locale === activeLocale) || { locale: activeLocale };

  const updateField = (key: string, value: string) => {
    const updated = { ...current, [key]: value || null };
    setItems(prev => {
      const idx = prev.findIndex(i => i.locale === activeLocale);
      if (idx >= 0) { const c = [...prev]; c[idx] = updated; return c; }
      return [...prev, updated];
    });
  };

  const save = async () => {
    setSaving(true);
    try {
      await updatePlatformBrandingLocalized(activeLocale, current);
      toast.success(`SEO for ${activeLocale} saved`);
    } catch (e: any) { toast.error(e.message); }
    setSaving(false);
  };

  const fields = [
    { key: 'meta_title', label: 'Meta Title', desc: 'Browser tab title & search engine title' },
    { key: 'meta_description', label: 'Meta Description', desc: 'Search engine description (< 160 chars)' },
    { key: 'social_share_title', label: 'Social Share Title (OG)', desc: 'Title for social media sharing' },
    { key: 'social_share_description', label: 'Social Share Description (OG)', desc: 'Description for social media' },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>SEO & Social</CardTitle>
        <CardDescription>Per-locale SEO metadata and social sharing text.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-2 mb-2">
          {LOCALE_OPTIONS.map(l => (
            <Badge
              key={l.value}
              variant={activeLocale === l.value ? 'default' : 'outline'}
              className="cursor-pointer"
              onClick={() => setActiveLocale(l.value)}
            >
              {l.label}
            </Badge>
          ))}
        </div>

        <div className="grid grid-cols-1 gap-4">
          {fields.map(f => (
            <div key={f.key} className="space-y-1">
              <Label>{f.label}</Label>
              <Input
                value={current[f.key] || ''}
                onChange={e => updateField(f.key, e.target.value)}
                dir={activeLocale === 'fa' ? 'rtl' : 'ltr'}
              />
              <p className="text-xs text-muted-foreground">{f.desc}</p>
            </div>
          ))}
        </div>

        <Button onClick={save} disabled={saving}>{saving ? 'Saving...' : `Save SEO (${activeLocale.toUpperCase()})`}</Button>
      </CardContent>
    </Card>
  );
}
