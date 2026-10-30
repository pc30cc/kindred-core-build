import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { toast } from '@/lib/toast';
import { AlertTriangle, Copy, Info, Mail, Monitor, Moon, Save, Send, Smartphone, Sun, Trash2 } from 'lucide-react';
import { useTranslation, type TranslationKey } from '@/i18n';
import {
  EmailTemplatesApiError,
  createPlatformEmailTemplate,
  deletePlatformEmailTemplate,
  fetchEmailTemplateCatalog,
  fetchPlatformEmailTemplates,
  previewEmailTemplate,
  sendEmailTemplateTest,
  updatePlatformEmailTemplate,
  type EmailTemplateCatalog,
  type EmailTemplateCatalogItem,
  type EmailTemplatePreview,
  type PlatformEmailTemplate,
} from '@/features/emailTemplates/emailTemplatesApi';

/**
 * Super Admin → Branding → Email templates.
 *
 * Every template the platform keeps is listed, from the server's catalog
 * (server/services/email/templateCatalog.ts): the mails it sends, by group,
 * then the ones nothing sends any more, and any other row the table holds.
 * Each language's row can be read, and the languages the platform offers
 * edited; a language this edition never sends says so instead of hiding.
 *
 * The preview is the server's own render (the email core's fill, layout and
 * brand, with sample values), drawn in an iframe with an empty sandbox: no
 * script runs in it and it shares nothing with this page. That also means
 * the page cannot read the mail's height (the frame has an opaque origin),
 * so the frame has a tall fixed height of its own, scrolls, and can be
 * dragged taller.
 */

const LOCALES = ['fa', 'en', 'tr'] as const;
const CATEGORIES = ['auth', 'transactional', 'notification', 'billing'] as const;
/** The preview waits this long after the last keystroke. */
const PREVIEW_DELAY_MS = 400;
const PREVIEW_WIDTH = { desktop: 600, mobile: 375 } as const;
const PREVIEW_HEIGHT = 720;
const PROBLEM_CODES = new Set([
  'event_handler', 'hidden_element', 'background_url', 'too_many_images', 'image_without_size_or_alt',
  'foreign_link', 'foreign_image', 'script_link', 'bad_link', 'too_large',
]);

interface Form {
  subject: string;
  html: string;
  text: string;
  active: boolean;
}

function formOf(row: PlatformEmailTemplate | undefined): Form {
  return row
    ? { subject: row.subject, html: row.html_body, text: row.text_body || '', active: row.is_active ?? true }
    : { subject: '', html: '', text: '', active: true };
}

/** A row in the list: a catalog template, or a slug the table holds that the catalog does not know. */
interface Listed {
  slug: string;
  item: EmailTemplateCatalogItem | null;
}

interface Props {
  /** Told whenever the edits become unsaved or saved, so the page can ask before leaving the tab. */
  onDirtyChange?: (dirty: boolean) => void;
}

export default function EmailTemplatesTab({ onDirtyChange }: Props) {
  const { t, locale: uiLocale } = useTranslation();

  const [catalog, setCatalog] = useState<EmailTemplateCatalog | null>(null);
  const [templates, setTemplates] = useState<PlatformEmailTemplate[]>([]);
  const [selectedSlug, setSelectedSlug] = useState('email_verify');
  const [selectedLocale, setSelectedLocale] = useState<string>('');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [form, setForm] = useState<Form>(formOf(undefined));
  const [saved, setSaved] = useState<Form>(formOf(undefined));
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  /** The server's last render, and the template and language it is of. */
  const [rendered, setRendered] = useState<{ of: string; mail: EmailTemplatePreview } | null>(null);
  const [previewState, setPreviewState] = useState<'idle' | 'loading' | 'failed'>('idle');
  const [previewView, setPreviewView] = useState<'email' | 'text'>('email');
  const [previewWidth, setPreviewWidth] = useState<keyof typeof PREVIEW_WIDTH>('desktop');
  const [scheme, setScheme] = useState<'light' | 'dark'>('light');
  const previewSeq = useRef(0);

  const offered = catalog?.locales.offered ?? [];
  const fallback = catalog?.locales.fallback ?? 'en';
  const item = catalog?.templates.find((i) => i.slug === selectedSlug) ?? null;
  const isSent = item?.status === 'sent';
  const row = templates.find((r) => r.slug === selectedSlug && r.locale === selectedLocale);
  const editable = offered.includes(selectedLocale);
  const dirty = form.subject !== saved.subject || form.html !== saved.html || form.text !== saved.text || form.active !== saved.active;
  // Only the selected template's render is shown: the previous one's, kept
  // while the new one loads or after it failed, would put a different mail
  // under this one's editor.
  const preview = rendered?.of === `${selectedSlug}:${selectedLocale}` ? rendered.mail : null;

  useEffect(() => {
    void (async () => {
      try {
        const [nextCatalog, rows] = await Promise.all([fetchEmailTemplateCatalog(), fetchPlatformEmailTemplates()]);
        setCatalog(nextCatalog);
        setTemplates(rows.templates || []);
        setSelectedLocale((current) => current || nextCatalog.locales.offered[0] || 'en');
      } catch (err) {
        toast.error(t('admin.brandingPage.emailTemplates.toasts.loadFailed' as TranslationKey));
        console.error(err);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function reloadTemplates() {
    try {
      const rows = await fetchPlatformEmailTemplates();
      setTemplates(rows.templates || []);
    } catch (err) {
      toast.error(t('admin.brandingPage.emailTemplates.toasts.loadFailed' as TranslationKey));
      console.error(err);
    }
  }

  // The form is the selected row as saved, whenever the selection or the rows change.
  useEffect(() => {
    const next = formOf(templates.find((r) => r.slug === selectedSlug && r.locale === selectedLocale));
    setForm(next);
    setSaved(next);
  }, [selectedSlug, selectedLocale, templates]);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  // Closing or reloading the page with unsaved edits: the browser asks.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  // The preview follows the editor: the text as it stands, rendered by the server.
  useEffect(() => {
    if (!catalog || !selectedLocale) return;
    if (!form.html.trim()) {
      previewSeq.current += 1;
      setRendered(null);
      setPreviewState('idle');
      return;
    }
    const seq = ++previewSeq.current;
    const controller = new AbortController();
    setPreviewState('loading');
    const timer = setTimeout(() => {
      previewEmailTemplate(
        { slug: selectedSlug, locale: selectedLocale, subject: form.subject, html_body: form.html, text_body: form.text || null, scheme },
        controller.signal,
      )
        .then((next) => {
          if (seq !== previewSeq.current) return;
          setRendered({ of: `${selectedSlug}:${selectedLocale}`, mail: next });
          setPreviewState('idle');
        })
        .catch(() => {
          if (seq !== previewSeq.current || controller.signal.aborted) return;
          // An older text's render is not this text's: it goes with the failure.
          setRendered(null);
          setPreviewState('failed');
        });
    }, PREVIEW_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [catalog, selectedSlug, selectedLocale, form.subject, form.html, form.text, scheme]);

  /** A step that would drop the edits asks first. */
  function guarded(step: () => void) {
    if (dirty && !window.confirm(t('admin.brandingPage.emailTemplates.unsaved.confirm' as TranslationKey))) return;
    step();
  }

  const inUse = (err: unknown) => err instanceof EmailTemplatesApiError && err.code === 'template_in_use';

  async function handleSave() {
    if (!form.subject.trim() || !form.html.trim()) {
      toast.error(t('admin.brandingPage.emailTemplates.toasts.required' as TranslationKey));
      return;
    }
    setSaving(true);
    // A sent mail's template is always on (the server refuses it off).
    const body = { subject: form.subject, html_body: form.html, text_body: form.text || null, is_active: isSent ? true : form.active };
    try {
      if (row) {
        await updatePlatformEmailTemplate(row.id, body);
        toast.success(t('admin.brandingPage.emailTemplates.toasts.updated' as TranslationKey));
      } else {
        await createPlatformEmailTemplate({ slug: selectedSlug, locale: selectedLocale, ...body });
        toast.success(t('admin.brandingPage.emailTemplates.toasts.created' as TranslationKey));
      }
      await reloadTemplates();
    } catch (err) {
      toast.error(inUse(err)
        ? t('admin.brandingPage.emailTemplates.toasts.inUse' as TranslationKey)
        : t((row ? 'admin.brandingPage.emailTemplates.toasts.updateFailed' : 'admin.brandingPage.emailTemplates.toasts.createFailed') as TranslationKey));
    }
    setSaving(false);
  }

  async function handleDelete() {
    if (!row || isSent) return;
    try {
      await deletePlatformEmailTemplate(row.id);
      toast.success(t('admin.brandingPage.emailTemplates.toasts.deleted' as TranslationKey));
      await reloadTemplates();
    } catch (err) {
      toast.error(inUse(err)
        ? t('admin.brandingPage.emailTemplates.toasts.inUse' as TranslationKey)
        : t('admin.brandingPage.emailTemplates.toasts.deleteFailed' as TranslationKey));
    }
  }

  /** The text as it stands, to the next language the platform offers that has no row yet (the edits here are left). */
  async function duplicateToNextLocale() {
    const existing = templates.filter((r) => r.slug === selectedSlug).map((r) => r.locale);
    const next = LOCALES.find((code) => offered.includes(code) && !existing.includes(code));
    if (!next) {
      toast.info(t('admin.brandingPage.emailTemplates.toasts.allLocales' as TranslationKey));
      return;
    }
    try {
      await createPlatformEmailTemplate({
        slug: selectedSlug, locale: next, subject: form.subject, html_body: form.html, text_body: form.text || null,
        is_active: isSent ? true : form.active,
      });
      toast.success(t('admin.brandingPage.emailTemplates.toasts.duplicated' as TranslationKey, { locale: t(`admin.brandingPage.languages.${next}` as TranslationKey) }));
      await reloadTemplates();
      setSelectedLocale(next);
    } catch {
      toast.error(t('admin.brandingPage.emailTemplates.toasts.duplicateFailed' as TranslationKey));
    }
  }

  async function handleTest() {
    setTesting(true);
    try {
      const result = await sendEmailTemplateTest({
        slug: selectedSlug, locale: selectedLocale, subject: form.subject, html_body: form.html, text_body: form.text || null,
      });
      toast.success(t('admin.brandingPage.emailTemplates.test.sent' as TranslationKey, { email: result.sent_to }));
    } catch (err) {
      const code = err instanceof EmailTemplatesApiError ? err.code : 'unknown';
      if (code === 'test_limit_reached') toast.error(t('admin.brandingPage.emailTemplates.test.limit' as TranslationKey));
      else if (code === 'verified_email_required') toast.error(t('admin.brandingPage.emailTemplates.test.noAddress' as TranslationKey));
      else toast.error(t('admin.brandingPage.emailTemplates.test.failed' as TranslationKey, { code }));
    }
    setTesting(false);
  }

  const languageName = (code: string) => t(`admin.brandingPage.languages.${code}` as TranslationKey);
  const nameOf = (entry: Listed) => (entry.item ? t(`admin.brandingPage.emailTemplates.slugs.${entry.slug}` as TranslationKey) : entry.slug);
  const problemText = (code: string) => {
    const [base, element] = code.split(':');
    if (base === 'forbidden_element' && element) return t('admin.brandingPage.emailTemplates.problems.forbidden_element' as TranslationKey, { element });
    if (PROBLEM_CODES.has(base)) return t(`admin.brandingPage.emailTemplates.problems.${base}` as TranslationKey);
    return t('admin.brandingPage.emailTemplates.problems.unknown' as TranslationKey, { code });
  };

  const shown = (entry: Listed) => categoryFilter === 'all' || entry.item?.category === categoryFilter;
  const known = new Set((catalog?.templates ?? []).map((i) => i.slug));
  const listed: Listed[] = [
    ...(catalog?.templates ?? []).map((i) => ({ slug: i.slug, item: i })),
    // A row of a slug the catalog does not know is listed too: every row stays viewable.
    ...[...new Set(templates.map((r) => r.slug))].filter((slug) => !known.has(slug)).sort().map((slug) => ({ slug, item: null })),
  ].filter(shown);
  const sentList = listed.filter((l) => l.item?.status === 'sent');
  const legacyList = listed.filter((l) => l.item?.status !== 'sent');

  const notices: string[] = [];
  if (catalog) {
    if (!item) notices.push(t('admin.brandingPage.emailTemplates.notices.unknown' as TranslationKey));
    else if (item.status === 'legacy') notices.push(t('admin.brandingPage.emailTemplates.notices.legacy' as TranslationKey));
    else if (!item.sentInEdition) notices.push(t('admin.brandingPage.emailTemplates.notices.notSentInEdition' as TranslationKey));
    if (!offered.includes(selectedLocale)) {
      notices.push(selectedLocale === fallback && offered.length
        ? t('admin.brandingPage.emailTemplates.notices.fallback' as TranslationKey, {
            languages: offered.map(languageName).join(uiLocale === 'fa' ? '، ' : ', '),
            primary: languageName(offered[0]),
          })
        : t('admin.brandingPage.emailTemplates.notices.neverSent' as TranslationKey));
      notices.push(t('admin.brandingPage.emailTemplates.notices.readOnly' as TranslationKey));
    }
    if (!row) notices.push(t('admin.brandingPage.emailTemplates.notices.missing' as TranslationKey));
    else if (isSent && row.is_active === false) notices.push(t('admin.brandingPage.emailTemplates.notices.inactive' as TranslationKey));
  }

  const variables = item?.variables ?? [];
  const dir = selectedLocale === 'fa' ? 'rtl' : 'ltr';

  const listButton = (entry: Listed) => {
    const isSelected = entry.slug === selectedSlug;
    const locales = templates.filter((r) => r.slug === entry.slug).map((r) => r.locale);
    return (
      <button
        key={entry.slug}
        type="button"
        data-testid={`email-template-${entry.slug}`}
        aria-current={isSelected ? 'true' : undefined}
        onClick={() => { if (!isSelected) guarded(() => setSelectedSlug(entry.slug)); }}
        className={`w-full text-start px-3 py-2.5 rounded-lg transition-colors flex items-center justify-between gap-2 ${isSelected ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
      >
        <div className="min-w-0">
          <div className="text-sm font-medium truncate">{nameOf(entry)}</div>
          <div className={`text-xs truncate ${isSelected ? 'text-primary-foreground/70' : 'text-muted-foreground'}`} dir="ltr">{entry.slug}</div>
          {entry.item?.status === 'sent' && !entry.item.sentInEdition && (
            <div className={`text-[11px] ${isSelected ? 'text-primary-foreground/80' : 'text-amber-600 dark:text-amber-400'}`}>
              {t('admin.brandingPage.emailTemplates.groups.notSentHere' as TranslationKey)}
            </div>
          )}
        </div>
        <div className="flex gap-1 shrink-0" data-testid={`email-template-${entry.slug}-locales`}>
          {LOCALES.filter((code) => locales.includes(code)).map((code) => (
            <Badge key={code} variant={isSelected ? 'secondary' : 'outline'} className="text-[10px] px-1">{code}</Badge>
          ))}
        </div>
      </button>
    );
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {catalog && (
        <p className="lg:col-span-3 rounded-lg border bg-muted/40 px-3 py-2 text-sm text-muted-foreground" data-testid="email-templates-edition">
          {t(`admin.brandingPage.emailTemplates.edition.${catalog.edition}` as TranslationKey)}
        </p>
      )}
      <div className="space-y-4">
        <Select value={categoryFilter} onValueChange={setCategoryFilter}>
          <SelectTrigger className="w-full"><SelectValue placeholder={t('admin.brandingPage.emailTemplates.filterCategory' as TranslationKey)} /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('admin.brandingPage.emailTemplates.allCategories' as TranslationKey)}</SelectItem>
            {CATEGORIES.map((c) => (<SelectItem key={c} value={c}>{t(`admin.brandingPage.emailTemplates.categories.${c}` as TranslationKey)}</SelectItem>))}
          </SelectContent>
        </Select>
        <div className="space-y-1" data-testid="email-templates-sent">{sentList.map(listButton)}</div>
        {legacyList.length > 0 && (
          <div className="space-y-1" data-testid="email-templates-legacy">
            <p className="px-3 pt-2 text-xs font-medium text-muted-foreground">{t('admin.brandingPage.emailTemplates.groups.legacy' as TranslationKey)}</p>
            {legacyList.map(listButton)}
          </div>
        )}
      </div>

      <div className="lg:col-span-2 space-y-4">
        <Card>
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <CardTitle className="text-lg flex items-center gap-2">
                  <Mail className="h-5 w-5" />
                  {nameOf({ slug: selectedSlug, item })}
                  {dirty && <Badge variant="outline" className="text-[10px]" data-testid="email-template-dirty">{t('admin.brandingPage.emailTemplates.unsaved.badge' as TranslationKey)}</Badge>}
                </CardTitle>
                <CardDescription dir="ltr" className="text-start">{selectedSlug}</CardDescription>
                {item && <p className="mt-1 text-sm text-muted-foreground">{t(item.descriptionKey as TranslationKey)}</p>}
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-1" role="group" aria-label={t('admin.brandingPage.emailTemplates.locales.label' as TranslationKey)}>
                  {LOCALES.map((code) => {
                    const has = templates.some((r) => r.slug === selectedSlug && r.locale === code);
                    return (
                      <Button
                        key={code}
                        type="button"
                        size="sm"
                        variant={code === selectedLocale ? 'default' : 'outline'}
                        className={`h-7 text-xs ${has ? '' : 'opacity-60'}`}
                        data-testid={`email-template-locale-${code}`}
                        title={has ? undefined : t('admin.brandingPage.emailTemplates.locales.noRow' as TranslationKey)}
                        onClick={() => { if (code !== selectedLocale) guarded(() => setSelectedLocale(code)); }}
                      >
                        {languageName(code)}
                      </Button>
                    );
                  })}
                </div>
                {!isSent && (
                  <div className="flex items-center gap-2">
                    <Label className="text-sm">{t('admin.brandingPage.common.active' as TranslationKey)}</Label>
                    <Switch checked={form.active} disabled={!editable} onCheckedChange={(active) => setForm((f) => ({ ...f, active }))} />
                  </div>
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {isSent && <p className="text-xs text-muted-foreground">{t('admin.brandingPage.emailTemplates.notices.alwaysOn' as TranslationKey)}</p>}
            {notices.length > 0 && (
              <div className="space-y-1.5 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3" role="status" data-testid="email-template-notices">
                {notices.map((text) => (
                  <p key={text} className="flex items-start gap-2 text-sm"><Info className="h-4 w-4 mt-0.5 shrink-0" />{text}</p>
                ))}
              </div>
            )}
            <div>
              <Label className="text-xs text-muted-foreground">{t('admin.brandingPage.emailTemplates.availableVariables' as TranslationKey)}</Label>
              <div className="flex flex-wrap gap-1.5 mt-1" dir="ltr" data-testid="email-template-variables">
                {variables.map((v) => (
                  <Badge key={v} variant="outline" className="text-xs cursor-pointer hover:bg-accent"
                    onClick={() => navigator.clipboard.writeText(v).then(() => toast.info(t('admin.brandingPage.emailTemplates.toasts.copied' as TranslationKey, { variable: v })))}>{v}</Badge>
                ))}
              </div>
            </div>
            <div>
              <Label>{t('admin.brandingPage.emailTemplates.subject' as TranslationKey)}</Label>
              <Input value={form.subject} readOnly={!editable} dir={dir} onChange={(e) => setForm((f) => ({ ...f, subject: e.target.value }))} placeholder={t('admin.brandingPage.emailTemplates.subjectPlaceholder' as TranslationKey)} />
            </div>
            <div>
              <Label>{t('admin.brandingPage.emailTemplates.htmlBody' as TranslationKey)}</Label>
              <Textarea value={form.html} readOnly={!editable} onChange={(e) => setForm((f) => ({ ...f, html: e.target.value }))} placeholder="<h1>…</h1><p>…</p>" className="mt-1 min-h-[260px] font-mono text-xs" dir="ltr" data-testid="email-template-html" />
            </div>
            <div>
              <Label>{t('admin.brandingPage.emailTemplates.plainTextBody' as TranslationKey)}</Label>
              <Textarea value={form.text} readOnly={!editable} onChange={(e) => setForm((f) => ({ ...f, text: e.target.value }))} placeholder={t('admin.brandingPage.emailTemplates.plainTextPlaceholder' as TranslationKey)} className="mt-1 min-h-[80px] font-mono text-xs" dir={dir} />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
              <div className="flex flex-wrap gap-2">
                {row && !isSent && editable && (<Button variant="destructive" size="sm" onClick={handleDelete}><Trash2 className="h-4 w-4 me-1" /> {t('admin.brandingPage.emailTemplates.delete' as TranslationKey)}</Button>)}
                {editable && (<Button variant="outline" size="sm" onClick={() => guarded(() => void duplicateToNextLocale())}><Copy className="h-4 w-4 me-1" /> {t('admin.brandingPage.emailTemplates.duplicate' as TranslationKey)}</Button>)}
                <Button variant="outline" size="sm" onClick={handleTest} disabled={testing || !form.subject.trim() || !form.html.trim()} title={t('admin.brandingPage.emailTemplates.test.hint' as TranslationKey)} data-testid="email-template-test">
                  <Send className="h-4 w-4 me-1" />
                  {testing ? t('admin.brandingPage.emailTemplates.test.sending' as TranslationKey) : t('admin.brandingPage.emailTemplates.test.send' as TranslationKey)}
                </Button>
              </div>
              {editable && (
                <Button onClick={handleSave} disabled={saving} data-testid="email-template-save">
                  <Save className="h-4 w-4 me-1" />{row ? t('admin.brandingPage.emailTemplates.update' as TranslationKey) : t('admin.brandingPage.emailTemplates.create' as TranslationKey)}
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <CardTitle className="text-base">{t('admin.brandingPage.emailTemplates.preview' as TranslationKey)}</CardTitle>
              <div className="flex flex-wrap gap-2">
                <div className="flex gap-1">
                  <Button size="sm" variant={previewView === 'email' ? 'default' : 'outline'} className="h-7 text-xs" onClick={() => setPreviewView('email')}>
                    <Mail className="h-3 w-3 me-1" />{t('admin.brandingPage.emailTemplates.previewPanel.email' as TranslationKey)}
                  </Button>
                  <Button size="sm" variant={previewView === 'text' ? 'default' : 'outline'} className="h-7 text-xs" onClick={() => setPreviewView('text')} data-testid="email-template-preview-text">
                    {t('admin.brandingPage.emailTemplates.previewPanel.text' as TranslationKey)}
                  </Button>
                </div>
                <div className="flex gap-1">
                  <Button size="sm" variant={previewWidth === 'desktop' ? 'default' : 'outline'} className="h-7 text-xs" onClick={() => setPreviewWidth('desktop')}>
                    <Monitor className="h-3 w-3 me-1" />{t('admin.brandingPage.emailTemplates.previewPanel.desktop' as TranslationKey)}
                  </Button>
                  <Button size="sm" variant={previewWidth === 'mobile' ? 'default' : 'outline'} className="h-7 text-xs" onClick={() => setPreviewWidth('mobile')} data-testid="email-template-preview-mobile">
                    <Smartphone className="h-3 w-3 me-1" />{t('admin.brandingPage.emailTemplates.previewPanel.mobile' as TranslationKey)}
                  </Button>
                </div>
                <div className="flex gap-1">
                  <Button size="sm" variant={scheme === 'light' ? 'default' : 'outline'} className="h-7 text-xs" onClick={() => setScheme('light')}>
                    <Sun className="h-3 w-3 me-1" />{t('admin.brandingPage.emailTemplates.previewPanel.light' as TranslationKey)}
                  </Button>
                  <Button size="sm" variant={scheme === 'dark' ? 'default' : 'outline'} className="h-7 text-xs" onClick={() => setScheme('dark')} data-testid="email-template-preview-dark">
                    <Moon className="h-3 w-3 me-1" />{t('admin.brandingPage.emailTemplates.previewPanel.dark' as TranslationKey)}
                  </Button>
                </div>
              </div>
            </div>
            <CardDescription>{t('admin.brandingPage.emailTemplates.previewPanel.sampleNote' as TranslationKey)}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {preview && preview.problems.length > 0 && (
              <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm" role="alert" data-testid="email-template-problems">
                <p className="flex items-center gap-2 font-medium"><AlertTriangle className="h-4 w-4" />{t('admin.brandingPage.emailTemplates.problems.title' as TranslationKey)}</p>
                <p className="mt-1 text-muted-foreground">{t('admin.brandingPage.emailTemplates.problems.hint' as TranslationKey)}</p>
                <ul className="mt-1 list-disc ps-5">
                  {preview.problems.map((code) => <li key={code}>{problemText(code)}</li>)}
                </ul>
              </div>
            )}
            {previewState === 'loading' && <p className="text-xs text-muted-foreground">{t('admin.brandingPage.emailTemplates.previewPanel.loading' as TranslationKey)}</p>}
            {previewState === 'failed' && <p className="text-sm text-destructive">{t('admin.brandingPage.emailTemplates.previewPanel.failed' as TranslationKey)}</p>}
            {!form.html.trim() ? (
              <p className="text-sm text-muted-foreground">{t('admin.brandingPage.emailTemplates.previewPanel.empty' as TranslationKey)}</p>
            ) : preview ? (
              <>
                <p className="text-sm" dir={dir}>
                  <span className="text-muted-foreground">{t('admin.brandingPage.emailTemplates.subject' as TranslationKey)}: </span>
                  <span data-testid="email-template-preview-subject">{preview.subject}</span>
                </p>
                {previewView === 'email' ? (
                  <div
                    className="mx-auto max-w-full resize-y overflow-hidden rounded-lg border"
                    style={{ width: PREVIEW_WIDTH[previewWidth], height: PREVIEW_HEIGHT }}
                    data-testid="email-template-preview-frame"
                  >
                    {/*
                      An empty sandbox, and it must stay empty: no scripts, no
                      same-origin access to this page's cookies or storage, no
                      navigation of the page, no forms, no popups. The mail is
                      the server's render of a Super Admin's HTML.
                    */}
                    <iframe srcDoc={preview.html} sandbox="" className="block h-full w-full border-0" title={t('admin.brandingPage.emailTemplates.previewTitle' as TranslationKey)} />
                  </div>
                ) : (
                  <pre className="max-h-[720px] overflow-auto whitespace-pre-wrap rounded-lg border bg-muted/30 p-4 text-sm" dir={dir} data-testid="email-template-preview-plain">{preview.text}</pre>
                )}
              </>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
