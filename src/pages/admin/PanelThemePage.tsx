/**
 * Super Admin → Panel theme ("تعویض قالب").
 *
 * One click switches the look of every workspace panel for every user
 * (platform_branding.workspace_panel_theme, PUT /api/admin/management/panel-theme).
 * No theme is removed: Classic is the panel's own design and stays one click
 * away. "Preview in my panel" wears a theme in this tab only
 * (src/themes/usePanelTheme.ts) before activating it for everyone.
 * Themes come from src/themes/registry.ts; a new one appears here by itself.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Brush, Check, Eye, Info, Loader2, Moon, Sun } from 'lucide-react';
import { useTranslation, type TranslationKey } from '@/i18n';
import { adminFetch } from '@/hooks/useAdmin';
import { toast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { PLATFORM_PUBLIC_CONFIG_QUERY_KEY } from '@/lib/platformPublicConfig';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { panelThemes, type PanelThemeInfo } from '@/themes/registry';
import { ThemePreview } from '@/themes/ThemePreview';
import { endPanelThemePreview, startPanelThemePreview } from '@/themes/usePanelTheme';
import { resolvePanelTheme, type PanelThemeId } from '../../../shared/panelThemes';

const BRANDING_QUERY_KEY = ['platform_branding'] as const;

type Mode = 'light' | 'dark';

export default function PanelThemePage() {
  const { t } = useTranslation();
  const tk = (key: string, params?: Record<string, string>) => t(key as TranslationKey, params);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [mode, setMode] = useState<Mode>('light');

  const { data: active, isLoading } = useQuery({
    queryKey: BRANDING_QUERY_KEY,
    queryFn: async () =>
      (await adminFetch<{ branding: Record<string, unknown> | null }>('/api/admin/management/platform-branding')).branding,
    select: (branding) => resolvePanelTheme(branding?.workspace_panel_theme),
  });

  const activate = useMutation({
    mutationFn: (theme: PanelThemeId) =>
      adminFetch<{ theme: PanelThemeId }>('/api/admin/management/panel-theme', {
        method: 'PUT',
        body: JSON.stringify({ theme }),
      }),
    onSuccess: ({ theme }) => {
      // Show the new theme as active at once; the refetch below confirms it.
      qc.setQueryData<Record<string, unknown> | null>(BRANDING_QUERY_KEY, (branding) =>
        branding ? { ...branding, workspace_panel_theme: theme } : branding,
      );
      endPanelThemePreview();
      toast({
        title: tk('admin.panelThemes.activated', { name: tk(`admin.panelThemes.themes.${theme}.name`) }),
        description: tk('admin.panelThemes.activatedHint'),
      });
      return Promise.all([
        qc.invalidateQueries({ queryKey: BRANDING_QUERY_KEY }),
        qc.invalidateQueries({ queryKey: PLATFORM_PUBLIC_CONFIG_QUERY_KEY }),
      ]);
    },
    onError: (err: Error) => {
      toast({ title: tk('admin.panelThemes.failed'), description: err.message, variant: 'destructive' });
    },
  });

  const preview = (theme: PanelThemeId) => {
    startPanelThemePreview(theme);
    navigate('/app');
  };

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Brush className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h1 className="text-xl font-bold">{tk('admin.panelThemes.title')}</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{tk('admin.panelThemes.subtitle')}</p>
            {active && (
              <p className="mt-2 text-sm font-medium text-foreground">
                {tk('admin.panelThemes.current', { name: tk(`admin.panelThemes.themes.${active}.name`) })}
              </p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 self-start sm:self-auto">
          <span className="text-xs text-muted-foreground">{tk('admin.panelThemes.previewMode')}</span>
          <div role="radiogroup" className="inline-flex rounded-lg border border-border bg-muted/40 p-0.5">
            {(['light', 'dark'] as const).map((m) => {
              const Icon = m === 'light' ? Sun : Moon;
              return (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={mode === m}
                  onClick={() => setMode(m)}
                  className={cn(
                    'inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-medium transition-colors',
                    mode === m ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {tk(`admin.panelThemes.${m}`)}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {panelThemes.map((theme) => (
          <ThemeCard
            key={theme.id}
            theme={theme}
            mode={mode}
            loading={isLoading}
            active={active === theme.id}
            switching={activate.isPending && activate.variables === theme.id}
            busy={activate.isPending}
            onActivate={() => activate.mutate(theme.id)}
            onPreview={() => preview(theme.id)}
          />
        ))}
      </div>

      <Card className="p-5">
        <div className="flex items-start gap-3">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 space-y-2">
            <h2 className="text-sm font-semibold">{tk('admin.panelThemes.howTitle')}</h2>
            <ul className="space-y-1.5 text-sm text-muted-foreground">
              {(['how1', 'how2', 'how3', 'how4'] as const).map((key) => (
                <li key={key} className="flex gap-2">
                  <span aria-hidden className="mt-2 h-1 w-1 shrink-0 rounded-full bg-muted-foreground/60" />
                  <span>{tk(`admin.panelThemes.${key}`)}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Card>
    </div>
  );
}

function ThemeCard({
  theme,
  mode,
  loading,
  active,
  switching,
  busy,
  onActivate,
  onPreview,
}: {
  theme: PanelThemeInfo;
  mode: Mode;
  loading: boolean;
  active: boolean;
  switching: boolean;
  busy: boolean;
  onActivate: () => void;
  onPreview: () => void;
}) {
  const { t } = useTranslation();
  const tk = (key: string) => t(key as TranslationKey);
  const base = `admin.panelThemes.themes.${theme.id}`;
  const swatches = theme[mode];

  return (
    <Card
      className={cn(
        'flex flex-col overflow-hidden transition-shadow',
        active && 'border-primary/50 ring-1 ring-primary/30',
      )}
    >
      <div className="bg-muted/30 p-3 sm:p-4">
        <ThemePreview theme={theme} mode={mode} />
      </div>

      <div className="flex flex-1 flex-col gap-4 p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold leading-tight">{tk(`${base}.name`)}</h2>
              <code dir="ltr" className="rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                {theme.id}
              </code>
            </div>
            <p className="mt-1.5 text-sm text-muted-foreground">{tk(`${base}.description`)}</p>
          </div>
          {active && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-success/15 px-2.5 py-1 text-xs font-semibold text-success">
              <Check className="h-3.5 w-3.5" />
              {tk('admin.panelThemes.active')}
            </span>
          )}
        </div>

        <ul className="space-y-1.5 text-sm">
          {(['trait1', 'trait2', 'trait3'] as const).map((key) => (
            <li key={key} className="flex items-start gap-2">
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <span>{tk(`${base}.${key}`)}</span>
            </li>
          ))}
        </ul>

        <div className="flex items-center gap-1.5" aria-hidden>
          {[swatches.surface, swatches.ink, swatches.primary, ...swatches.accents.slice(1)].map((color, i) => (
            <span
              key={i}
              className="h-6 w-6 rounded-full ring-1 ring-inset ring-black/10 dark:ring-white/15"
              style={{ background: color }}
            />
          ))}
        </div>

        <div className="mt-auto flex flex-wrap gap-2 pt-1">
          {loading ? (
            <Skeleton className="h-10 w-40 rounded-md" />
          ) : (
            <Button onClick={onActivate} disabled={active || busy} className="min-w-40">
              {switching ? <Loader2 className="h-4 w-4 animate-spin" /> : active ? <Check className="h-4 w-4" /> : null}
              {active ? tk('admin.panelThemes.inUse') : tk('admin.panelThemes.activate')}
            </Button>
          )}
          {!active && (
            <Button variant="outline" onClick={onPreview}>
              <Eye className="h-4 w-4" />
              {tk('admin.panelThemes.previewAction')}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}
