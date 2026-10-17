/**
 * Super Admin → Widget settings → Widget templates.
 *
 * The chat widget template catalog of the running edition
 * (GET / PUT /api/admin/widget-catalog; shared/chatTemplateCatalog.ts): for
 * each template the edition ships, whether workspaces may pick it, its
 * display name per dashboard language (a label only: never in an id, a file
 * or the widget), its place in the list, its option defaults, and which one
 * is the default. Usage counts show who a change affects; disabling a
 * template in use, or moving the default while workspaces follow it, asks
 * first. One save for the whole catalog; it reaches every widget on its next
 * page load. Before migration 275 the page shows the built-in defaults, read
 * only.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowDown, ArrowUp, Eye, LayoutTemplate, Loader2, RotateCcw, Users } from 'lucide-react';
import { useTranslation, type TranslationKey } from '@/i18n';
import { cn } from '@/lib/utils';
import { toast } from '@/hooks/use-toast';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  useAdminWidgetCatalog,
  useSaveAdminWidgetCatalog,
  WidgetCatalogError,
  type AdminWidgetCatalog,
} from '@/hooks/useWidgetCatalog';
import { templateDescription, templateDisplayName } from '@/lib/widgetTemplateNames';
import { TemplateSketch } from '@/components/app/widget/TemplateSketch';
import { TemplateOptionsFields } from '@/components/app/widget/TemplateOptionsFields';
import { WidgetLivePreview, type PreviewView } from '@/components/app/widget/WidgetLivePreview';
import { widgetCatalogEn, widgetCatalogFa, widgetCatalogTr } from '@/i18n/widgetCatalog';
import {
  CHAT_TEMPLATE_LOCALES,
  CHAT_TEMPLATE_NAME_MAX,
  chatTemplateOptionDefaults,
  chatTemplateOptionKeys,
  readTemplateOptions,
  type ChatTemplateLocale,
  type ChatTemplateOptions,
} from '../../../../shared/chatTemplateCatalog';

/** The default names in every language, for the name fields' placeholders. */
const DEFAULT_NAMES: Record<ChatTemplateLocale, Record<string, string>> = {
  fa: widgetCatalogFa.names,
  en: widgetCatalogEn.names,
  tr: widgetCatalogTr.names,
};

interface DraftTemplate {
  id: string;
  enabled: boolean;
  name: Record<ChatTemplateLocale, string>;
  options: ChatTemplateOptions;
}

interface Draft {
  defaultId: string;
  /** In display order. */
  templates: DraftTemplate[];
}

function sameDraft(a: Draft, b: Draft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function draftOf(data: AdminWidgetCatalog): Draft {
  return {
    defaultId: data.defaultId,
    templates: [...data.templates]
      .sort((a, b) => a.order - b.order)
      .map((tpl) => ({
        id: tpl.id,
        enabled: tpl.enabled,
        name: { fa: tpl.name.fa ?? '', en: tpl.name.en ?? '', tr: tpl.name.tr ?? '' },
        options: tpl.options,
      })),
  };
}

const PREVIEW_VIEWS: PreviewView[] = ['home', 'list', 'chat', 'kb'];

export function WidgetCatalogSection() {
  const { t, locale } = useTranslation();
  const tk = (key: string, params?: Record<string, string | number>) => t(key as TranslationKey, params);
  const uiLocale: ChatTemplateLocale = (CHAT_TEMPLATE_LOCALES as readonly string[]).includes(locale) ? (locale as ChatTemplateLocale) : 'en';
  const { data, isLoading, error, refetch, isFetching } = useAdminWidgetCatalog();
  const save = useSaveAdminWidgetCatalog();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirming, setConfirming] = useState<Array<{ title: string; body: string }> | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewView, setPreviewView] = useState<PreviewView>('home');
  // Stable, so the preview frame is not rebuilt on every render of the page.
  const previewSettings = useMemo(() => ({ locale: uiLocale, widget_language: uiLocale }), [uiLocale]);

  // The catalog the form was last filled from. A new answer (the window
  // regaining focus refetches; usage counts or another admin's save change
  // it) refills the form only while it holds no unsaved edit.
  const seeded = useRef<Draft | null>(null);
  useEffect(() => {
    if (!data) return;
    const next = draftOf(data);
    const before = seeded.current;
    seeded.current = next;
    setDraft((current) => (!current || !before || sameDraft(current, before) ? next : current));
  }, [data]);

  const saved = useMemo(() => (data ? draftOf(data) : null), [data]);
  const dirty = !!draft && !!saved && !sameDraft(draft, saved);
  // What the preview's template reads: the drafted option defaults, cleaned
  // as the server cleans them (a topic row still being typed is left out).
  const previewOptions = useMemo(() => {
    const tpl = preview && draft ? draft.templates.find((x) => x.id === preview) : null;
    if (!tpl) return {};
    const keys = chatTemplateOptionKeys(tpl.id);
    return { ...chatTemplateOptionDefaults(tpl.id), ...readTemplateOptions(tpl.options, keys) } as Record<string, unknown>;
  }, [preview, draft]);

  if (isLoading || (!draft && !error)) {
    return (
      <Card>
        <CardContent className="space-y-3 p-6">
          <p className="text-sm text-muted-foreground">{t('widgetCatalog.admin.loading')}</p>
          <Skeleton className="h-40 w-full rounded-xl" />
        </CardContent>
      </Card>
    );
  }
  if (error || !data || !draft) {
    return (
      <Card>
        <CardContent className="space-y-3 p-6">
          <p className="text-sm font-medium text-destructive">{t('widgetCatalog.admin.loadFailed')}</p>
          {error instanceof Error && <p className="break-all text-xs text-muted-foreground">{error.message}</p>}
          <Button size="sm" variant="outline" onClick={() => refetch()} disabled={isFetching}>
            {t('widgetCatalog.admin.retry')}
          </Button>
        </CardContent>
      </Card>
    );
  }

  const readOnly = !data.ready;
  const nameOf = (tpl: DraftTemplate) => templateDisplayName(t, tpl.id, tpl.name[uiLocale]);
  const usage = (id: string) => data.templates.find((tpl) => tpl.id === id)?.chosenBy ?? null;
  const enabledCount = draft.templates.filter((tpl) => tpl.enabled).length;
  const update = (id: string, patch: Partial<DraftTemplate>) =>
    setDraft({ ...draft, templates: draft.templates.map((tpl) => (tpl.id === id ? { ...tpl, ...patch } : tpl)) });
  const move = (index: number, by: -1 | 1) => {
    const next = [...draft.templates];
    const [item] = next.splice(index, 1);
    next.splice(index + by, 0, item);
    setDraft({ ...draft, templates: next });
  };

  /** Who the draft's change affects, as confirmations (none: save at once). */
  const confirmations = (): Array<{ title: string; body: string }> => {
    if (!saved) return [];
    const out: Array<{ title: string; body: string }> = [];
    const defaultName = nameOf(draft.templates.find((tpl) => tpl.id === draft.defaultId) ?? draft.templates[0]);
    for (const tpl of draft.templates) {
      const before = saved.templates.find((s) => s.id === tpl.id);
      const count = usage(tpl.id) ?? 0;
      if (before?.enabled && !tpl.enabled && count > 0) {
        out.push({
          title: t('widgetCatalog.admin.confirmDisableTitle'),
          body: t('widgetCatalog.admin.confirmDisable', { count, name: nameOf(tpl), default: defaultName }),
        });
      }
    }
    // Who moves with the default: the workspaces that never chose, and those
    // whose choice was and stays disabled (a choice disabled by this save is
    // asked about above). Workspaces whose plan does not let them choose wear
    // the default too; they are not counted, the text names them.
    const following = (data.followingDefault ?? 0) + draft.templates
      .filter((tpl) => !tpl.enabled && !saved.templates.find((s) => s.id === tpl.id)?.enabled)
      .reduce((sum, tpl) => sum + (usage(tpl.id) ?? 0), 0);
    if (draft.defaultId !== saved.defaultId && following > 0) {
      out.push({
        title: t('widgetCatalog.admin.confirmDefaultTitle'),
        body: t('widgetCatalog.admin.confirmDefault', { count: following, name: defaultName }),
      });
    }
    return out;
  };

  const doSave = () => {
    setConfirming(null);
    save.mutate(
      {
        defaultId: draft.defaultId,
        templates: draft.templates.map((tpl, order) => ({
          id: tpl.id,
          enabled: tpl.enabled,
          order,
          name: { fa: tpl.name.fa || null, en: tpl.name.en || null, tr: tpl.name.tr || null },
          options: tpl.options,
        })),
      },
      {
        onSuccess: (result) => {
          // The form shows what was stored (names cleaned, the server's order).
          const next = draftOf(result);
          seeded.current = next;
          setDraft(next);
          toast({ title: t('widgetCatalog.admin.saved'), description: t('widgetCatalog.admin.savedHint') });
        },
        onError: (err) => {
          const code = err instanceof WidgetCatalogError ? err.code : undefined;
          const known = code && Object.prototype.hasOwnProperty.call(widgetCatalogEn.admin.errors, code);
          toast({
            title: known ? tk(`widgetCatalog.admin.errors.${code}`, { max: CHAT_TEMPLATE_NAME_MAX }) : t('widgetCatalog.admin.errors.generic'),
            description: known ? undefined : err instanceof Error ? err.message : undefined,
            variant: 'destructive',
          });
        },
      },
    );
  };

  const onSave = () => {
    const asks = confirmations();
    if (asks.length) setConfirming(asks);
    else doSave();
  };

  const previewed = preview ? draft.templates.find((tpl) => tpl.id === preview) ?? null : null;

  return (
    <div className="space-y-4" data-widget-catalog>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <LayoutTemplate className="h-4 w-4 text-primary" />{t('widgetCatalog.admin.title')}
          </CardTitle>
          <CardDescription>{t('widgetCatalog.admin.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {readOnly && (
            <p className="flex items-start gap-2 rounded-lg bg-warning/10 px-3 py-2 text-xs leading-relaxed text-amber-800 dark:text-amber-300">
              <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
              <span>{t('widgetCatalog.admin.migrationNote')}</span>
            </p>
          )}
          {enabledCount < 2 && <p className="text-xs text-muted-foreground">{t('widgetCatalog.admin.singleNote')}</p>}
          {data.followingDefault !== null && (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Users className="h-3.5 w-3.5" />{t('widgetCatalog.admin.followingDefault', { count: data.followingDefault })}
            </p>
          )}
        </CardContent>
      </Card>

      {draft.templates.map((tpl, index) => {
        const isDefault = tpl.id === draft.defaultId;
        const count = usage(tpl.id);
        return (
          <Card key={tpl.id} data-catalog-template={tpl.id} className={cn(!tpl.enabled && 'opacity-80')}>
            <CardContent className="grid gap-5 p-5 md:grid-cols-[150px_minmax(0,1fr)]">
              <div className="space-y-2">
                <TemplateSketch id={tpl.id} className={cn(!tpl.enabled && 'grayscale')} />
                <Button type="button" variant="outline" size="sm" className="w-full" onClick={() => { setPreview(tpl.id); setPreviewView('home'); }}>
                  <Eye className="me-1 h-3.5 w-3.5" />{t('widgetCatalog.admin.preview')}
                </Button>
              </div>
              <div className="min-w-0 space-y-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    {/* A div: Badge renders a <div>, which a <p> may not hold. */}
                    <div className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                      {nameOf(tpl)}
                      {/* The id is technical: Latin digits in every locale. */}
                      <span className="font-mono text-[11px] font-normal text-muted-foreground" dir="ltr" data-latin-digits>{tpl.id}</span>
                      {isDefault && <Badge variant="secondary" className="text-[10px]">{t('widgetCatalog.admin.default')}</Badge>}
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">{templateDescription(t, tpl.id)}</p>
                    {count !== null && (
                      <p className="mt-1 text-[11px] text-muted-foreground">{t('widgetCatalog.admin.chosenBy', { count })}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <Button type="button" variant="ghost" size="icon" className="h-8 w-8" disabled={readOnly || index === 0}
                      aria-label={t('widgetCatalog.admin.moveUp')} onClick={() => move(index, -1)}>
                      <ArrowUp className="h-4 w-4" />
                    </Button>
                    <Button type="button" variant="ghost" size="icon" className="h-8 w-8" disabled={readOnly || index === draft.templates.length - 1}
                      aria-label={t('widgetCatalog.admin.moveDown')} onClick={() => move(index, 1)}>
                      <ArrowDown className="h-4 w-4" />
                    </Button>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
                  <label className="flex items-center gap-2 text-sm">
                    <Switch
                      checked={tpl.enabled}
                      // The default stays enabled: pick another default first.
                      disabled={readOnly || isDefault}
                      onCheckedChange={(enabled) => update(tpl.id, { enabled })}
                    />
                    {t('widgetCatalog.admin.enabled')}
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="widget-catalog-default"
                      className="h-4 w-4 accent-primary"
                      checked={isDefault}
                      disabled={readOnly || !tpl.enabled}
                      onChange={() => setDraft({ ...draft, defaultId: tpl.id })}
                    />
                    {t('widgetCatalog.admin.makeDefault')}
                  </label>
                </div>

                <div className="grid gap-3 sm:grid-cols-3">
                  {CHAT_TEMPLATE_LOCALES.map((lang) => (
                    <div key={lang} className="space-y-1">
                      <Label htmlFor={`catalog-${tpl.id}-${lang}`} className="text-xs">
                        {t('widgetCatalog.admin.displayNameIn', { language: tk(`widgetCatalog.languages.${lang}`) })}
                      </Label>
                      <Input
                        id={`catalog-${tpl.id}-${lang}`}
                        dir="auto"
                        lang={lang}
                        maxLength={CHAT_TEMPLATE_NAME_MAX}
                        value={tpl.name[lang]}
                        disabled={readOnly}
                        placeholder={DEFAULT_NAMES[lang][tpl.id] ?? tpl.id}
                        onChange={(e) => update(tpl.id, { name: { ...tpl.name, [lang]: e.target.value } })}
                      />
                    </div>
                  ))}
                </div>

                {Object.keys(tpl.options).length > 0 && (
                  <div className="space-y-2 rounded-lg border border-border/70 p-3">
                    <p className="text-xs font-medium">{t('widgetCatalog.admin.optionDefaults')}</p>
                    <p className="text-[11px] text-muted-foreground">{t('widgetCatalog.admin.optionDefaultsHint')}</p>
                    <TemplateOptionsFields
                      templateId={tpl.id}
                      value={tpl.options}
                      onChange={(options) => update(tpl.id, { options })}
                      disabled={readOnly}
                      idPrefix={`catalog-${tpl.id}`}
                    />
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        );
      })}

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button type="button" variant="ghost" disabled={!dirty || save.isPending} onClick={() => saved && setDraft(saved)}>
          <RotateCcw className="me-1 h-3.5 w-3.5" />{t('widgetCatalog.admin.reset')}
        </Button>
        <Button type="button" disabled={readOnly || !dirty || save.isPending} onClick={onSave}>
          {save.isPending && <Loader2 className="me-1 h-3.5 w-3.5 animate-spin" />}
          {save.isPending ? t('widgetCatalog.admin.saving') : t('widgetCatalog.admin.save')}
        </Button>
      </div>

      <AlertDialog open={!!confirming} onOpenChange={(open) => { if (!open) setConfirming(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirming?.[0]?.title}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                {(confirming ?? []).map((c, i) => <p key={i}>{c.body}</p>)}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('widgetCatalog.admin.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={doSave}>{t('widgetCatalog.admin.confirm')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={!!previewed} onOpenChange={(open) => { if (!open) setPreview(null); }}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{previewed ? t('widgetCatalog.admin.previewTitle', { name: nameOf(previewed) }) : ''}</DialogTitle>
          </DialogHeader>
          {previewed && (
            <div className="space-y-2">
              <div className="flex items-center gap-1 rounded-lg border border-border bg-secondary/40 p-1">
                {PREVIEW_VIEWS.map((v) => (
                  <Button key={v} size="sm" variant={previewView === v ? 'default' : 'ghost'} className="h-7 flex-1 px-2 text-[11px]" onClick={() => setPreviewView(v)}>
                    {tk(`widgetPage.preview.view.${v}`)}
                  </Button>
                ))}
              </div>
              <div style={{ height: 720 }}>
                <WidgetLivePreview
                  settings={previewSettings}
                  workspaceName={t('widgetPage.preview.brandFallback')}
                  platformName={t('widgetPage.preview.brandFallback')}
                  view={previewView}
                  onViewChange={setPreviewView}
                  templateId={previewed.id}
                  templateOptions={previewOptions}
                />
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
