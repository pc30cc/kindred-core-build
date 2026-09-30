/**
 * Platform support — Super Admin → Core settings → Support.
 *
 * Operators of every workspace reach the team that runs the platform from
 * Settings in the apps. That team is an ordinary workspace picked here: its
 * members answer from its own inbox, where these conversations are labelled
 * "Site user". Stored on `platform_support_settings` through
 * /api/admin/platform-support (server/routes/adminPlatformSupport.ts); the
 * contract every client follows is docs/PLATFORM_SUPPORT.md.
 */
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { AlertTriangle, Check, LifeBuoy, Loader2, Search, X } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { adminFetch } from '@/hooks/useAdmin';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';

interface SupportWorkspace {
  id: string;
  name: string | null;
  slug: string | null;
}

interface PlatformSupportSettings {
  enabled: boolean;
  workspaceId: string | null;
  updatedAt: string | null;
}

interface SettingsResponse {
  settings: PlatformSupportSettings;
  workspace: SupportWorkspace | null;
  suggestions: SupportWorkspace[];
}

const SETTINGS_KEY = ['admin', 'platform-support', 'settings'] as const;

export default function PlatformSupportCard() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [enabled, setEnabled] = useState(false);
  const [workspace, setWorkspace] = useState<SupportWorkspace | null>(null);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const { data, isLoading, isError } = useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: () => adminFetch<SettingsResponse>('/api/admin/platform-support/settings'),
    // A refetch on focus would overwrite what the admin is in the middle of editing.
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (!data) return;
    const { settings } = data;
    setEnabled(settings.enabled);
    // A workspace deleted since it was chosen: the id is still stored, the row is gone.
    setWorkspace(data.workspace ?? (settings.workspaceId ? { id: settings.workspaceId, name: null, slug: null } : null));
    setDirty(false);
  }, [data]);

  // Ask the server once typing pauses, not on every key.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const { data: found, isFetching: searching, isError: searchFailed } = useQuery({
    queryKey: ['admin', 'platform-support', 'workspaces', query],
    queryFn: async () => {
      const body = await adminFetch<{ workspaces: SupportWorkspace[] }>(
        `/api/admin/platform-support/workspaces?search=${encodeURIComponent(query)}`,
      );
      return body.workspaces ?? [];
    },
    enabled: query.length > 0,
    staleTime: 30_000,
  });

  const workspaceMissing =
    !!data?.settings.workspaceId && !data.workspace && workspace?.id === data.settings.workspaceId;
  const suggestions = data?.suggestions ?? [];

  const choose = (next: SupportWorkspace | null) => {
    setWorkspace(next);
    setSearch('');
    setQuery('');
    setDirty(true);
  };

  const workspaceName = (ws: SupportWorkspace) => ws.name || ws.slug || ws.id;

  const save = async () => {
    setSaving(true);
    try {
      const body = await adminFetch<{ success: boolean; settings: PlatformSupportSettings; warning?: string }>(
        '/api/admin/platform-support/settings',
        {
          method: 'PUT',
          body: JSON.stringify({ enabled, workspaceId: workspace?.id ?? null }),
        },
      );
      qc.setQueryData<SettingsResponse>(SETTINGS_KEY, (prev) => ({
        settings: body.settings,
        workspace: body.settings.workspaceId ? workspace : null,
        suggestions: prev?.suggestions ?? [],
      }));
      setDirty(false);
      toast({
        title: t('admin.brandingPage.settings.saved'),
        description: body.warning === 'no_workspace' ? t('admin.coreSettings.support.noWorkspace') : undefined,
      });
    } catch (e) {
      const code = e instanceof Error ? e.message : '';
      toast({
        title: t('admin.brandingPage.common.error'),
        description: code === 'workspace_not_found'
          ? t('admin.coreSettings.support.workspaceMissing')
          : code || t('admin.brandingPage.common.saveFailed'),
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <LifeBuoy className="h-5 w-5 text-primary" />
            <CardTitle className="text-base">{t('admin.coreSettings.support.title')}</CardTitle>
          </div>
          <Button size="sm" onClick={save} disabled={!dirty || saving}>
            {t('admin.brandingPage.common.save')}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t('admin.coreSettings.support.hint')}</p>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-10 w-full max-w-sm" />
            <Skeleton className="h-24 w-full max-w-md" />
          </div>
        ) : isError ? (
          <p className="text-sm text-destructive">{t('admin.coreSettings.support.loadFailed')}</p>
        ) : (
          <div className="space-y-6">
            <div className="flex items-start justify-between gap-4">
              <div className="grid gap-1">
                <Label htmlFor="platform-support-enabled">{t('admin.coreSettings.support.enabledLabel')}</Label>
                <p className="text-xs text-muted-foreground">
                  {enabled
                    ? t('admin.coreSettings.support.enabledOnHint')
                    : t('admin.coreSettings.support.enabledOffHint')}
                </p>
              </div>
              <Switch
                id="platform-support-enabled"
                checked={enabled}
                onCheckedChange={(v) => { setEnabled(v); setDirty(true); }}
              />
            </div>

            {enabled && !workspace && (
              <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-foreground">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
                <span>{t('admin.coreSettings.support.noWorkspace')}</span>
              </div>
            )}

            <div className="grid gap-2">
              <div className="grid gap-1">
                <Label htmlFor="platform-support-search">{t('admin.coreSettings.support.workspaceLabel')}</Label>
                <p className="text-xs text-muted-foreground">{t('admin.coreSettings.support.workspaceHint')}</p>
              </div>

              {workspace ? (
                <div className="flex max-w-md items-center justify-between gap-3 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium" dir="auto">{workspaceName(workspace)}</div>
                    {workspace.slug && workspace.name && (
                      <div className="truncate text-xs text-muted-foreground" dir="ltr">{workspace.slug}</div>
                    )}
                  </div>
                  <Button size="sm" variant="ghost" className="h-7 shrink-0 text-xs" onClick={() => choose(null)}>
                    <X className="me-1 h-3.5 w-3.5" />
                    {t('admin.coreSettings.support.clear')}
                  </Button>
                </div>
              ) : (
                <p className="max-w-md rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground">
                  {t('admin.coreSettings.support.workspaceNone')}
                </p>
              )}
              {workspaceMissing && (
                <p className="text-xs text-destructive">{t('admin.coreSettings.support.workspaceMissing')}</p>
              )}

              {suggestions.length > 0 && (
                <div className="grid gap-1.5">
                  <span className="text-xs font-medium text-muted-foreground">{t('admin.coreSettings.support.suggestions')}</span>
                  <div className="flex flex-wrap gap-1.5">
                    {suggestions.map((ws) => {
                      const selected = ws.id === workspace?.id;
                      return (
                        <button
                          key={ws.id}
                          type="button"
                          onClick={() => choose(ws)}
                          aria-pressed={selected}
                          className={cn(
                            'inline-flex max-w-full items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors',
                            selected ? 'border-primary bg-primary/10 text-primary' : 'border-border hover:bg-muted',
                          )}
                        >
                          {selected && <Check className="h-3 w-3 shrink-0" />}
                          <span className="truncate" dir="auto">{workspaceName(ws)}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="relative max-w-md">
                <Search className="absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="platform-support-search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t('admin.coreSettings.support.searchPlaceholder')}
                  className="ps-9"
                />
              </div>
              {query && (
                <div className="max-w-md divide-y divide-border/60 rounded-lg border">
                  {searching && !found ? (
                    <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      {t('admin.coreSettings.support.searching')}
                    </div>
                  ) : searchFailed ? (
                    <p className="px-3 py-2 text-xs text-destructive">{t('admin.coreSettings.support.searchFailed')}</p>
                  ) : !found?.length ? (
                    <p className="px-3 py-2 text-xs text-muted-foreground">{t('admin.coreSettings.support.searchEmpty')}</p>
                  ) : (
                    found.map((ws) => {
                      const selected = ws.id === workspace?.id;
                      return (
                        <button
                          key={ws.id}
                          type="button"
                          onClick={() => choose(ws)}
                          aria-pressed={selected}
                          className="flex w-full items-center justify-between gap-3 px-3 py-2 text-start transition-colors hover:bg-muted"
                        >
                          <span className="min-w-0">
                            <span className="block truncate text-sm" dir="auto">{workspaceName(ws)}</span>
                            {ws.slug && ws.name && (
                              <span className="block truncate text-xs text-muted-foreground" dir="ltr">{ws.slug}</span>
                            )}
                          </span>
                          {selected && <Check className="h-4 w-4 shrink-0 text-primary" />}
                        </button>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
