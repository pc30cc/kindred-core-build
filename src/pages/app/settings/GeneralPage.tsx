import { useTranslation } from '@/i18n';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import { supabase } from '@/lib/supabase';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from '@/hooks/use-toast';

export default function SettingsGeneralPage() {
  const { t } = useTranslation();
  const workspace = useCurrentWorkspace();
  const qc = useQueryClient();

  const update = useMutation({
    mutationFn: async (updates: Record<string, unknown>) => {
      const { error } = await supabase
        .from('workspaces')
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq('id', workspace!.id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workspaces'] });
      toast({ title: 'Saved' });
    },
  });

  if (!workspace) return <div className="p-8 text-center text-muted-foreground">{t('common.loading')}</div>;

  return (
    <div className="space-y-6 animate-fade-in max-w-3xl">
      <h1 className="text-2xl font-bold text-foreground">{t('settings.general')}</h1>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Workspace Name</CardTitle>
          <CardDescription>The internal name of your workspace</CardDescription>
        </CardHeader>
        <CardContent>
          <Input
            defaultValue={workspace.name}
            onBlur={e => e.target.value !== workspace.name && update.mutate({ name: e.target.value })}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Workspace Slug</CardTitle>
          <CardDescription>URL-friendly identifier (used in API endpoints)</CardDescription>
        </CardHeader>
        <CardContent>
          <Input
            defaultValue={workspace.slug}
            onBlur={e => e.target.value !== workspace.slug && update.mutate({ slug: e.target.value })}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('settings.defaultLocale')}</CardTitle>
          <CardDescription>Default language for the workspace</CardDescription>
        </CardHeader>
        <CardContent>
          <Select
            value={workspace.default_locale}
            onValueChange={v => update.mutate({ default_locale: v })}
          >
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="en">English</SelectItem>
              <SelectItem value="fa">فارسی</SelectItem>
              <SelectItem value="tr">Türkçe</SelectItem>
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('settings.panelLocale')}</CardTitle>
          <CardDescription>Language for the admin dashboard</CardDescription>
        </CardHeader>
        <CardContent>
          <Select
            value={workspace.panel_locale}
            onValueChange={v => update.mutate({ panel_locale: v })}
          >
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="en">English</SelectItem>
              <SelectItem value="fa">فارسی</SelectItem>
              <SelectItem value="tr">Türkçe</SelectItem>
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('settings.widgetLocale')}</CardTitle>
          <CardDescription>Default language for the embeddable widget</CardDescription>
        </CardHeader>
        <CardContent>
          <Select
            value={workspace.widget_locale}
            onValueChange={v => update.mutate({ widget_locale: v })}
          >
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="en">English</SelectItem>
              <SelectItem value="fa">فارسی</SelectItem>
              <SelectItem value="tr">Türkçe</SelectItem>
            </SelectContent>
          </Select>
        </CardContent>
      </Card>
    </div>
  );
}
