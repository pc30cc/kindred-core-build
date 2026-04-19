import { useTranslation } from '@/i18n';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import { useBranding, useUpdateBranding } from '@/hooks/useBranding';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { toast } from '@/hooks/use-toast';

export default function SettingsBrandingPage() {
  const { t } = useTranslation();
  const workspace = useCurrentWorkspace();
  const { data: branding, isLoading } = useBranding(workspace?.id);
  const updateBranding = useUpdateBranding(workspace?.id);

  const handleSave = (field: string, value: string) => {
    updateBranding.mutate({ [field]: value } as any, {
      onSuccess: () => toast({ title: 'Saved' }),
    });
  };

  if (isLoading) return <div className="p-8 text-center text-muted-foreground">{t('common.loading')}</div>;

  // Widget URL fields (widget_*_base_url) have moved to Super Admin → Widget Settings → Deployment & URLs.
  // They are intentionally not editable here anymore — the platform-wide settings are the single source of truth.
  const fields = [
    { key: 'platform_name', label: 'Platform Name', desc: 'The main name of your platform (shown in header, emails, etc.)' },
    { key: 'short_name', label: 'Short Name', desc: 'Abbreviated name (used in favicon, PWA, etc.)' },
    { key: 'logo_url', label: 'Logo URL', desc: 'Full URL to your logo image' },
    { key: 'favicon_url', label: 'Favicon URL', desc: 'URL to your favicon' },
    { key: 'primary_color', label: 'Primary Color', desc: 'Brand primary color (hex)', type: 'color' },
    { key: 'accent_color', label: 'Accent Color', desc: 'Brand accent color (hex)', type: 'color' },
    { key: 'support_email', label: 'Support Email', desc: 'Displayed in emails and footer' },
    { key: 'sender_name', label: 'Email Sender Name', desc: 'From name for outgoing emails' },
    { key: 'meta_title', label: 'Meta Title', desc: 'Default page title for SEO' },
    { key: 'meta_description', label: 'Meta Description', desc: 'Default meta description' },
    { key: 'social_image_url', label: 'Social Share Image', desc: 'OG / Twitter card image URL' },
    { key: 'footer_text', label: 'Footer Text', desc: 'Copyright / legal text in footer' },
    { key: 'legal_name', label: 'Legal Company Name', desc: 'For structured data and legal pages' },
    { key: 'canonical_base_url', label: 'Canonical Base URL', desc: 'Primary domain for canonical URLs (e.g. https://example.com)' },
    { key: 'panel_base_url', label: 'Panel Base URL', desc: 'Dashboard/admin panel URL' },
    { key: 'asset_base_url', label: 'Asset/CDN Base URL', desc: 'Static assets CDN URL (non-widget)' },
  ];

  return (
    <div className="space-y-6 animate-fade-in">
      <h1 className="text-2xl font-bold text-foreground">{t('settings.branding')}</h1>

      {fields.map(field => (
        <Card key={field.key}>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">{field.label}</CardTitle>
            <CardDescription className="text-xs">{field.desc}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex gap-2">
              {field.type === 'color' ? (
                <>
                  <Input
                    type="color"
                    defaultValue={(branding as any)?.[field.key] || '#3B82F6'}
                    className="w-12 h-10 p-1"
                    onBlur={e => handleSave(field.key, e.target.value)}
                  />
                  <Input
                    defaultValue={(branding as any)?.[field.key] || ''}
                    onBlur={e => handleSave(field.key, e.target.value)}
                  />
                </>
              ) : (
                <Input
                  defaultValue={(branding as any)?.[field.key] || ''}
                  onBlur={e => handleSave(field.key, e.target.value)}
                  placeholder={`Enter ${field.label.toLowerCase()}`}
                />
              )}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
