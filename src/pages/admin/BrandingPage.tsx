import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export default function AdminBrandingPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Platform Branding</h1>
      <p className="text-slate-400 text-sm">Default branding applied to all new workspaces and the public site.</p>

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="bg-slate-900 border-slate-800">
          <CardHeader><CardTitle className="text-white text-sm">Default Platform Identity</CardTitle></CardHeader>
          <CardContent className="text-slate-400 text-sm space-y-2">
            <p>• Platform Name — set via workspace_branding for the default workspace</p>
            <p>• Logo URL — configurable per workspace</p>
            <p>• Primary Color — default #3B82F6</p>
            <p>• Favicon — configurable per workspace</p>
          </CardContent>
        </Card>

        <Card className="bg-slate-900 border-slate-800">
          <CardHeader><CardTitle className="text-white text-sm">Default SEO Settings</CardTitle></CardHeader>
          <CardContent className="text-slate-400 text-sm space-y-2">
            <p>• Meta Title — set in workspace_branding.meta_title</p>
            <p>• Meta Description — set in workspace_branding.meta_description</p>
            <p>• Social Image — workspace_branding.social_image_url</p>
            <p>• Canonical URL — workspace_branding.canonical_base_url</p>
          </CardContent>
        </Card>

        <Card className="bg-slate-900 border-slate-800">
          <CardHeader><CardTitle className="text-white text-sm">Default Email Branding</CardTitle></CardHeader>
          <CardContent className="text-slate-400 text-sm space-y-2">
            <p>• Sender Name — workspace_branding.sender_name</p>
            <p>• Support Email — workspace_branding.support_email</p>
            <p>• Footer Text — workspace_branding.footer_text</p>
          </CardContent>
        </Card>

        <Card className="bg-slate-900 border-slate-800">
          <CardHeader><CardTitle className="text-white text-sm">Default Widget Settings</CardTitle></CardHeader>
          <CardContent className="text-slate-400 text-sm space-y-2">
            <p>• Welcome Message — widget_settings.welcome_message</p>
            <p>• Launcher Text — widget_settings.launcher_text</p>
            <p>• Position — widget_settings.position</p>
            <p>• Default Locale — widget_settings.locale</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
