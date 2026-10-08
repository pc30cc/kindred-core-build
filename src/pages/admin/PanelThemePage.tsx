/**
 * Super Admin → Panel theme ("تعویض قالب").
 *
 * One click switches the look of every workspace panel for every user
 * (platform_branding.workspace_panel_theme, PUT /api/admin/management/panel-theme).
 * No theme is removed: Classic is the panel's own design and stays one click
 * away. A theme may have options, chosen here for everyone too
 * (workspace_panel_theme_options): Art's layout (top menu or side menu) and
 * colour scheme. "Preview in my panel" wears a theme, with the options picked
 * on its card, in this tab only (src/themes/usePanelTheme.ts) before
 * activating it for everyone. Themes come from src/themes/registry.ts; a new
 * one appears here by itself.
 */
import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as RadioGroupPrimitive from '@radix-ui/react-radio-group';
import { AlertTriangle, Brush, Check, Eye, Info, Loader2, Moon, RotateCcw, Sun } from 'lucide-react';
import { useTranslation, type TranslationKey } from '@/i18n';
import { adminFetch } from '@/hooks/useAdmin';
import { API_BASE } from '@/lib/api';
import { toast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { PLATFORM_PUBLIC_CONFIG_QUERY_KEY } from '@/lib/platformPublicConfig';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { panelThemeLabel, panelThemes, previewSwatches, type ArtPreviewOptions, type PanelThemeInfo } from '@/themes/registry';
import { ArtLayoutSketch, ThemePreview } from '@/themes/ThemePreview';
import { ART_PALETTE_SWATCHES } from '@/themes/art/palettes';
import { endPanelThemePreview, startPanelThemePreview } from '@/themes/usePanelTheme';
import {
  ART_LAYOUTS,
  ART_PALETTES,
  resolvePanelTheme,
  resolvePanelThemeOptions,
  resolvePanelThemeSelection,
  type ArtLayout,
  type ArtPalette,
  type PanelThemeId,
} from '../../../shared/panelThemes';

const BRANDING_QUERY_KEY = ['platform_branding'] as const;
const OPTIONS_COLUMN = 'workspace_panel_theme_options';

type Mode = 'light' | 'dark';
type Branding = Record<string, unknown> | null;
type Activation = { theme: PanelThemeId; options?: Record<string, string> };
type Activated = { theme: PanelThemeId; options?: Record<string, string> };

/** A failed save, with the server's `code` when it gave one. */
class PanelThemeSaveError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

/**
 * PUT /api/admin/management/panel-theme. As adminFetch, but keeps the
 * answer's `code` (`migration_required`), so the page can explain it in the
 * Super Admin's language. The answer must carry every option that was sent:
 * a server from before options (the frontend can go live minutes before the
 * backend) ignores them and answers with the theme alone, and that is no
 * save.
 */
async function savePanelTheme({ theme, options }: Activation): Promise<Activated> {
  const res = await fetch(`${API_BASE}/api/admin/management/panel-theme`, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options ? { theme, options } : { theme }),
  });
  const body = (await res.json().catch(() => ({}))) as Partial<Activated> & { error?: string; code?: string };
  if (!res.ok) throw new PanelThemeSaveError(body.error || `Request failed: ${res.status}`, body.code);
  const saved = asObject(body.options);
  if (options && !Object.entries(options).every(([key, value]) => saved[key] === value)) {
    throw new PanelThemeSaveError('The server did not save the options.', 'options_not_saved');
  }
  return { theme: body.theme ?? theme, options: body.options };
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

const sameArt = (a: ArtPreviewOptions, b: ArtPreviewOptions) => a.layout === b.layout && a.palette === b.palette;

export default function PanelThemePage() {
  const { t } = useTranslation();
  const tk = (key: string, params?: Record<string, string>) => t(key as TranslationKey, params);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [mode, setMode] = useState<Mode>('light');

  const { data: branding, isLoading } = useQuery({
    queryKey: BRANDING_QUERY_KEY,
    queryFn: async () =>
      (await adminFetch<{ branding: Branding }>('/api/admin/management/platform-branding')).branding,
  });
  const active = isLoading ? undefined : resolvePanelTheme(branding?.workspace_panel_theme);
  const storedOptions = asObject(branding?.[OPTIONS_COLUMN]);
  // A branding row without the column: migration 254 is not applied yet, so
  // options can be previewed but not saved (the server answers 409).
  const optionsSaveable = !branding || OPTIONS_COLUMN in branding;

  // Art's options as stored, and the Super Admin's unsaved choice over them.
  const storedArt: ArtPreviewOptions = resolvePanelThemeOptions('art', storedOptions);
  const [artDraft, setArtDraft] = useState<ArtPreviewOptions | null>(null);
  const art = artDraft ?? storedArt;
  const artDirty = !sameArt(art, storedArt);

  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: BRANDING_QUERY_KEY }),
      qc.invalidateQueries({ queryKey: PLATFORM_PUBLIC_CONFIG_QUERY_KEY }),
    ]);

  const activate = useMutation({
    mutationFn: savePanelTheme,
    onSuccess: ({ theme, options }, variables) => {
      const wasActive = active === theme;
      // Show the new choice at once; the refetch below confirms it.
      qc.setQueryData<Branding>(BRANDING_QUERY_KEY, (current) =>
        current
          ? {
              ...current,
              workspace_panel_theme: theme,
              ...(variables.options && options
                ? { [OPTIONS_COLUMN]: { ...asObject(current[OPTIONS_COLUMN]), [theme]: options } }
                : {}),
            }
          : current,
      );
      // The draft is now what is stored. (A theme-only switch keeps it: it
      // could not be saved, migration 254 missing.)
      if (variables.options) setArtDraft(null);
      endPanelThemePreview();
      const name = panelThemeLabel(t, resolvePanelThemeSelection(theme, { [theme]: options ?? variables.options ?? {} }));
      toast({
        title: wasActive && variables.options ? tk('admin.panelThemes.options.saved', { name }) : tk('admin.panelThemes.activated', { name }),
        description: tk('admin.panelThemes.activatedHint'),
      });
      return refresh();
    },
    onError: (err: Error) => {
      const code = err instanceof PanelThemeSaveError ? err.code : undefined;
      const description =
        code === 'migration_required'
          ? tk('admin.panelThemes.options.needsMigration')
          : code === 'options_not_saved'
            ? tk('admin.panelThemes.options.notSaved')
            : err.message;
      toast({ title: tk('admin.panelThemes.failed'), description, variant: 'destructive' });
      // An older server switched the theme while dropping the options: show
      // what is stored now.
      if (code === 'options_not_saved') void refresh();
    },
  });

  // Options are sent only when they change what is stored, and only where
  // they can be kept, so switching themes keeps working on a database from
  // before migration 254 (the draft can still be previewed there).
  const activation = (theme: PanelThemeId): Activation =>
    theme === 'art' && artDirty && optionsSaveable ? { theme, options: { ...art } } : { theme };

  const preview = (theme: PanelThemeId) => {
    startPanelThemePreview(theme, theme === 'art' ? { ...art } : undefined);
    navigate('/app');
  };

  const activeLabel =
    active && panelThemeLabel(t, resolvePanelThemeSelection(active, active === 'art' ? { art: storedArt } : storedOptions));

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
            {activeLabel && (
              <p className="mt-2 text-sm font-medium text-foreground">{tk('admin.panelThemes.current', { name: activeLabel })}</p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 self-start sm:self-auto">
          <span id="panel-theme-mode" className="text-xs text-muted-foreground">
            {tk('admin.panelThemes.previewMode')}
          </span>
          <div role="radiogroup" aria-labelledby="panel-theme-mode" className="inline-flex rounded-lg border border-border bg-muted/40 p-0.5">
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
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
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

      <div className="grid items-start gap-6 lg:grid-cols-2">
        {panelThemes.map((theme) => {
          const isActive = active === theme.id;
          const isArt = theme.id === 'art';
          const pending = activate.isPending && activate.variables?.theme === theme.id;
          return (
            <ThemeCard
              key={theme.id}
              theme={theme}
              mode={mode}
              art={isArt ? art : undefined}
              loading={isLoading}
              active={isActive}
              // Art's options can be saved while Art is the active theme.
              changed={isArt && isActive && artDirty && optionsSaveable}
              dirty={isArt && artDirty}
              switching={pending}
              busy={activate.isPending}
              onActivate={() => activate.mutate(activation(theme.id))}
              onPreview={() => preview(theme.id)}
            >
              {isArt && (
                <ArtOptions
                  value={art}
                  mode={mode}
                  theme={theme}
                  saveable={optionsSaveable}
                  dirty={artDirty}
                  busy={activate.isPending}
                  onChange={(next) => setArtDraft(sameArt(next, storedArt) ? null : next)}
                  onReset={() => setArtDraft(null)}
                />
              )}
            </ThemeCard>
          );
        })}
      </div>

      <Card className="p-5">
        <div className="flex items-start gap-3">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 space-y-2">
            <h2 className="text-sm font-semibold">{tk('admin.panelThemes.howTitle')}</h2>
            <ul className="space-y-1.5 text-sm text-muted-foreground">
              {(['how1', 'how2', 'how3', 'how5', 'how4'] as const).map((key) => (
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
  art,
  loading,
  active,
  changed,
  dirty,
  switching,
  busy,
  onActivate,
  onPreview,
  children,
}: {
  theme: PanelThemeInfo;
  mode: Mode;
  /** Art's options as picked on the card (drawn by the preview). */
  art?: ArtPreviewOptions;
  loading: boolean;
  active: boolean;
  /** The active theme's options were changed here and can be saved. */
  changed: boolean;
  /** The options picked here differ from what is stored (worth a preview). */
  dirty: boolean;
  switching: boolean;
  busy: boolean;
  onActivate: () => void;
  onPreview: () => void;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const tk = (key: string) => t(key as TranslationKey);
  const base = `admin.panelThemes.themes.${theme.id}`;
  const swatches = previewSwatches(theme, mode, art?.palette);

  return (
    <Card
      data-theme-card={theme.id}
      className={cn('flex flex-col overflow-hidden transition-shadow', active && 'border-primary/50 ring-1 ring-primary/30')}
    >
      <div className="bg-muted/30 p-3 sm:p-4">
        <ThemePreview theme={theme} mode={mode} art={art} />
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

        {children ?? (
          <div className="flex items-center gap-1.5" aria-hidden>
            {[swatches.surface, swatches.ink, swatches.primary, ...swatches.accents.slice(1)].map((color, i) => (
              <span
                key={i}
                className="h-6 w-6 rounded-full ring-1 ring-inset ring-black/10 dark:ring-white/15"
                style={{ background: color }}
              />
            ))}
          </div>
        )}

        <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
          {loading ? (
            <Skeleton className="h-10 w-40 rounded-md" />
          ) : changed ? (
            <Button onClick={onActivate} disabled={busy} className="min-w-40">
              {switching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              {tk('admin.panelThemes.options.save')}
            </Button>
          ) : (
            <Button onClick={onActivate} disabled={active || busy} className="min-w-40">
              {switching ? <Loader2 className="h-4 w-4 animate-spin" /> : active ? <Check className="h-4 w-4" /> : null}
              {active ? tk('admin.panelThemes.inUse') : tk('admin.panelThemes.activate')}
            </Button>
          )}
          {(!active || dirty) && (
            <Button variant="outline" onClick={onPreview} disabled={busy}>
              <Eye className="h-4 w-4" />
              {tk('admin.panelThemes.previewAction')}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

/**
 * Art's options on its card: the layout, as two sketches, and the colour
 * scheme, as named swatches. Both are radio groups (arrow keys move the
 * choice, in the page's direction).
 */
function ArtOptions({
  value,
  mode,
  theme,
  saveable,
  dirty,
  busy,
  onChange,
  onReset,
}: {
  value: ArtPreviewOptions;
  mode: Mode;
  theme: PanelThemeInfo;
  saveable: boolean;
  /** Differs from what is stored. */
  dirty: boolean;
  busy: boolean;
  onChange: (next: ArtPreviewOptions) => void;
  /** Back to what is stored. */
  onReset: () => void;
}) {
  const { t } = useTranslation();
  const tk = (key: string) => t(key as TranslationKey);
  const swatches = previewSwatches(theme, mode, value.palette);

  return (
    <section
      aria-labelledby="art-options-title"
      data-art-options
      className="rounded-xl border border-border bg-muted/25 p-4"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 id="art-options-title" className="text-sm font-semibold">
          {tk('admin.panelThemes.options.title')}
        </h3>
        {dirty && (
          <div className="flex items-center gap-1">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-warning/15 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:text-amber-300">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
              {tk('admin.panelThemes.options.unsaved')}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onReset}
              disabled={busy}
              className="h-7 gap-1 px-2 text-xs text-muted-foreground"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              {tk('admin.panelThemes.options.reset')}
            </Button>
          </div>
        )}
      </div>

      <div className="mt-3 space-y-4">
        <div className="space-y-2">
          <div id="art-layout-label" className="text-xs font-medium text-muted-foreground">
            {tk('admin.panelThemes.options.layout')}
          </div>
          <RadioGroupPrimitive.Root
            aria-labelledby="art-layout-label"
            value={value.layout}
            onValueChange={(layout) => onChange({ ...value, layout: layout as ArtLayout })}
            className="grid grid-cols-2 gap-3"
          >
            {ART_LAYOUTS.map((layout) => {
              const selected = value.layout === layout;
              return (
                <RadioGroupPrimitive.Item
                  key={layout}
                  value={layout}
                  data-art-layout={layout}
                  className={cn(
                    'group relative flex flex-col gap-2 rounded-xl border bg-background p-2.5 text-start transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                    selected ? 'border-primary ring-1 ring-primary' : 'border-border hover:border-foreground/25',
                  )}
                >
                  <ArtLayoutSketch layout={layout} swatches={swatches} />
                  <span className="flex items-start gap-2 px-0.5">
                    <span
                      aria-hidden
                      className={cn(
                        'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors',
                        selected ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/40',
                      )}
                    >
                      {selected && <Check className="h-3 w-3" strokeWidth={3} />}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-medium leading-5">{tk(`admin.panelThemes.layouts.${layout}.name`)}</span>
                      <span className="mt-0.5 hidden text-xs leading-snug text-muted-foreground sm:block">
                        {tk(`admin.panelThemes.layouts.${layout}.description`)}
                      </span>
                    </span>
                  </span>
                </RadioGroupPrimitive.Item>
              );
            })}
          </RadioGroupPrimitive.Root>
        </div>

        <div className="space-y-2">
          <div id="art-palette-label" className="text-xs font-medium text-muted-foreground">
            {tk('admin.panelThemes.options.palette')}
          </div>
          <RadioGroupPrimitive.Root
            aria-labelledby="art-palette-label"
            value={value.palette}
            onValueChange={(palette) => onChange({ ...value, palette: palette as ArtPalette })}
            className="grid grid-cols-4 gap-1.5 sm:grid-cols-7"
          >
            {ART_PALETTES.map((palette) => (
              <PaletteChip key={palette} palette={palette} mode={mode} selected={value.palette === palette} label={tk(`admin.panelThemes.palettes.${palette}`)} />
            ))}
          </RadioGroupPrimitive.Root>
        </div>

        {!saveable && (
          <p className="flex items-start gap-2 rounded-lg bg-warning/10 px-3 py-2 text-xs leading-relaxed text-amber-800 dark:text-amber-300">
            <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
            <span>{tk('admin.panelThemes.options.needsMigration')}</span>
          </p>
        )}
      </div>
    </section>
  );
}

/**
 * One colour scheme: its main colour on its paper, ringed by its chart
 * series, and its name under it. A scheme whose swatches are missing shows a
 * neutral outline.
 */
function PaletteChip({ palette, mode, selected, label }: { palette: ArtPalette; mode: Mode; selected: boolean; label: string }) {
  const swatch = ART_PALETTE_SWATCHES[palette]?.[mode] ?? null;
  const [s1, s2, s3, s4] = swatch?.series ?? [];
  return (
    <RadioGroupPrimitive.Item
      value={palette}
      data-art-palette={palette}
      className={cn(
        'group flex min-w-0 flex-col items-center justify-start gap-1.5 rounded-xl border bg-background px-0.5 pb-2 pt-2.5 transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        selected ? 'border-primary ring-1 ring-primary' : 'border-transparent hover:border-border',
      )}
    >
      <span
        aria-hidden
        className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-full p-[3px]', !swatch && 'border border-dashed border-muted-foreground/40')}
        style={swatch ? { background: `conic-gradient(${s1} 0 25%, ${s2} 0 50%, ${s3} 0 75%, ${s4} 0)` } : undefined}
      >
        <span
          className="flex h-full w-full items-center justify-center rounded-full p-[3px]"
          style={swatch ? { background: swatch.canvas } : undefined}
        >
          <span
            className={cn('flex h-full w-full items-center justify-center rounded-full', !swatch && 'bg-muted')}
            style={swatch ? { background: swatch.primary } : undefined}
          >
            {selected && (
              <Check className={cn('h-3.5 w-3.5', !swatch && 'text-primary')} strokeWidth={3} style={swatch ? { color: swatch.primaryInk } : undefined} />
            )}
          </span>
        </span>
      </span>
      <span className={cn('w-full break-words text-center text-xs leading-4', selected ? 'font-semibold text-foreground' : 'font-medium text-muted-foreground group-hover:text-foreground')}>
        {label}
      </span>
    </RadioGroupPrimitive.Item>
  );
}
