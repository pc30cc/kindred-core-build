import { useState, useEffect } from 'react';
import { API_BASE } from '@/lib/api';
import { usePlatformRegion } from '@/hooks/usePlatformRegion';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { toast } from '@/lib/toast';
import { Save, Trash2, Eye, Code, Mail, Shield, Bell, CreditCard, Copy } from 'lucide-react';
import { useTranslation } from '@/i18n';

async function adminFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed: ${res.status}`);
  return body as T;
}

interface DbTemplate {
  id: string;
  workspace_id: string | null;
  slug: string;
  locale: string;
  subject: string;
  html_body: string;
  text_body: string | null;
  is_active: boolean | null;
}

const CATEGORIES = [
  { key: 'auth', icon: Shield, slugs: ['email_verify', 'password_reset', 'magic_link', 'welcome'] },
  { key: 'transactional', icon: CreditCard, slugs: ['invite_member', 'invite_otp', 'payment_success', 'payment_failed', 'subscription_renewed', 'subscription_cancelled'] },
  { key: 'notification', icon: Bell, slugs: ['new_conversation', 'task_assigned', 'account_expiry', 'system_alert'] },
  { key: 'billing', icon: Receipt, slugs: ['invoice_issued', 'invoice_reminder', 'invoice_due', 'invoice_past_due', 'wallet_autopay_insufficient', 'payment_received', 'subscription_restored', 'subscription_free_fallback'] },
] as const;

// Every billing notification renders with the same server-provided context.
const BILLING_VARIABLES = ['{brand}', '{year}', '{invoice_number}', '{amount}', '{due_at}', '{grace_ends_at}', '{plan_name}', '{action_url}'];

const SLUG_VARIABLES: Record<string, string[]> = {
  email_verify: ['{name}', '{brand}', '{action_url}', '{expiry_time}'],
  password_reset: ['{name}', '{brand}', '{action_url}', '{expiry_time}'],
  magic_link: ['{name}', '{brand}', '{action_url}', '{expiry_time}'],
  welcome: ['{name}', '{brand}', '{action_url}'],
  invite_member: ['{name}', '{brand}', '{inviter}', '{workspace}', '{role}', '{action_url}'],
  invite_otp: ['{code}', '{expiry_minutes}', '{brand}', '{year}'],
  payment_success: ['{name}', '{brand}', '{amount}', '{currency}', '{plan}', '{invoice_url}'],
  payment_failed: ['{name}', '{brand}', '{amount}', '{currency}', '{reason}', '{action_url}'],
  subscription_renewed: ['{name}', '{brand}', '{plan}', '{next_date}', '{amount}'],
  subscription_cancelled: ['{name}', '{brand}', '{plan}', '{end_date}'],
  new_conversation: ['{name}', '{brand}', '{visitor}', '{message}', '{action_url}'],
  task_assigned: ['{name}', '{brand}', '{task}', '{assigner}', '{action_url}'],
  account_expiry: ['{name}', '{brand}', '{days_left}', '{plan}', '{action_url}'],
  system_alert: ['{brand}', '{title}', '{message}', '{severity}'],
  invoice_issued: BILLING_VARIABLES,
  invoice_reminder: BILLING_VARIABLES,
  invoice_due: BILLING_VARIABLES,
  invoice_past_due: BILLING_VARIABLES,
  wallet_autopay_insufficient: BILLING_VARIABLES,
  payment_received: BILLING_VARIABLES,
  subscription_restored: BILLING_VARIABLES,
  subscription_free_fallback: BILLING_VARIABLES,
};

const LOCALES = [
  { code: 'en', labelKey: 'en' },
  { code: 'fa', labelKey: 'fa' },
  { code: 'tr', labelKey: 'tr' },
];

export default function EmailTemplatesTab() {
  const { t } = useTranslation();
  // The platform's active region/language mode decides which languages a
  // transactional email can be sent in — a single-language platform never
  // sends (or needs) templates in a language no account can be set to.
  const { allowedLocales, canSwitchLanguage } = usePlatformRegion();
  const activeLocales = allowedLocales.length ? allowedLocales : LOCALES.map(l => l.code);

  const [templates, setTemplates] = useState<DbTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [selectedSlug, setSelectedSlug] = useState('email_verify');
  const [selectedLocale, setSelectedLocale] = useState(activeLocales[0] || 'en');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [viewMode, setViewMode] = useState<'code' | 'preview'>('code');

  const [editSubject, setEditSubject] = useState('');
  const [editHtml, setEditHtml] = useState('');
  const [editText, setEditText] = useState('');
  const [editActive, setEditActive] = useState(true);
  const [editId, setEditId] = useState<string | null>(null);

  useEffect(() => { fetchTemplates(); }, []);
  useEffect(() => { loadTemplateForEdit(); }, [selectedSlug, selectedLocale, templates]);
  useEffect(() => {
    if (activeLocales.length && !activeLocales.includes(selectedLocale)) {
      setSelectedLocale(activeLocales[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeLocales.join(',')]);

  async function fetchTemplates() {
    setLoading(true);
    try {
      const { templates } = await adminFetch<{ templates: DbTemplate[] }>('/api/admin/management/email-templates');
      setTemplates(templates || []);
    } catch (err: any) {
      toast.error(t('admin.brandingPage.emailTemplates.toasts.loadFailed' as any));
      console.error(err);
    }
    setLoading(false);
  }

  function loadTemplateForEdit() {
    const tpl = templates.find(t => t.slug === selectedSlug && t.locale === selectedLocale);
    if (tpl) {
      setEditId(tpl.id);
      setEditSubject(tpl.subject);
      setEditHtml(tpl.html_body);
      setEditText(tpl.text_body || '');
      setEditActive(tpl.is_active ?? true);
    } else {
      setEditId(null); setEditSubject(''); setEditHtml(''); setEditText(''); setEditActive(true);
    }
  }

  async function handleSave() {
    if (!editSubject.trim() || !editHtml.trim()) { toast.error(t('admin.brandingPage.emailTemplates.toasts.required' as any)); return; }
    setSaving(true);
    try {
      if (editId) {
        await adminFetch(`/api/admin/management/email-templates/${editId}`, {
          method: 'PUT',
          body: JSON.stringify({ subject: editSubject, html_body: editHtml, text_body: editText || null, is_active: editActive }),
        });
        toast.success(t('admin.brandingPage.emailTemplates.toasts.updated' as any));
      } else {
        await adminFetch('/api/admin/management/email-templates', {
          method: 'POST',
          body: JSON.stringify({
            slug: selectedSlug, locale: selectedLocale, subject: editSubject,
            html_body: editHtml, text_body: editText || null, is_active: editActive,
          }),
        });
        toast.success(t('admin.brandingPage.emailTemplates.toasts.created' as any));
      }
      await fetchTemplates();
    } catch {
      toast.error(t((editId ? 'admin.brandingPage.emailTemplates.toasts.updateFailed' : 'admin.brandingPage.emailTemplates.toasts.createFailed') as any));
    }
    setSaving(false);
  }

  async function handleDelete() {
    if (!editId) return;
    try {
      await adminFetch(`/api/admin/management/email-templates/${editId}`, { method: 'DELETE' });
      toast.success(t('admin.brandingPage.emailTemplates.toasts.deleted' as any));
      await fetchTemplates();
    } catch {
      toast.error(t('admin.brandingPage.emailTemplates.toasts.deleteFailed' as any));
    }
  }

  async function handleDuplicate() {
    const existingLocales = templates.filter(t => t.slug === selectedSlug).map(t => t.locale);
    const nextLocale = LOCALES.find(l => activeLocales.includes(l.code) && !existingLocales.includes(l.code));
    if (!nextLocale) { toast.info(t('admin.brandingPage.emailTemplates.toasts.allLocales' as any)); return; }
    try {
      await adminFetch('/api/admin/management/email-templates', {
        method: 'POST',
        body: JSON.stringify({
          slug: selectedSlug, locale: nextLocale.code, subject: editSubject,
          html_body: editHtml, text_body: editText || null, is_active: editActive,
        }),
      });
      toast.success(t('admin.brandingPage.emailTemplates.toasts.duplicated' as any, { locale: t(`admin.brandingPage.languages.${nextLocale.labelKey}` as any) }));
      setSelectedLocale(nextLocale.code);
      await fetchTemplates();
    } catch {
      toast.error(t('admin.brandingPage.emailTemplates.toasts.duplicateFailed' as any));
    }
  }

  const filteredSlugs = categoryFilter === 'all'
    ? CATEGORIES.flatMap(c => c.slugs)
    : CATEGORIES.find(c => c.key === categoryFilter)?.slugs || [];

  const getTemplateStatus = (slug: string) => {
    const localesWithTemplate = templates.filter(t => t.slug === slug).map(t => t.locale);
    return { count: localesWithTemplate.length, locales: localesWithTemplate };
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div className="space-y-4">
        <Select value={categoryFilter} onValueChange={setCategoryFilter}>
          <SelectTrigger className="w-full"><SelectValue placeholder={t('admin.brandingPage.emailTemplates.filterCategory' as any)} /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('admin.brandingPage.emailTemplates.allCategories' as any)}</SelectItem>
            {CATEGORIES.map(c => (<SelectItem key={c.key} value={c.key}>{t(`admin.brandingPage.emailTemplates.categories.${c.key}` as any)}</SelectItem>))}
          </SelectContent>
        </Select>
        <div className="space-y-1">
          {filteredSlugs.map(slug => {
            const status = getTemplateStatus(slug);
            const isSelected = slug === selectedSlug;
            return (
              <button key={slug} onClick={() => setSelectedSlug(slug)}
                className={`w-full text-left px-3 py-2.5 rounded-lg transition-colors flex items-center justify-between ${isSelected ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}>
                <div>
                  <div className="text-sm font-medium">{t(`admin.brandingPage.emailTemplates.slugs.${slug}` as any)}</div>
                  <div className={`text-xs ${isSelected ? 'text-primary-foreground/70' : 'text-muted-foreground'}`}>{slug}</div>
                </div>
                <div className="flex gap-1">
                  {status.locales.map(l => (
                    <Badge key={l} variant={isSelected ? 'secondary' : 'outline'} className="text-[10px] px-1">{l}</Badge>
                  ))}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="lg:col-span-2 space-y-4">
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-lg flex items-center gap-2"><Mail className="h-5 w-5" />{t(`admin.brandingPage.emailTemplates.slugs.${selectedSlug}` as any)}</CardTitle>
                <CardDescription>{selectedSlug}</CardDescription>
              </div>
              <div className="flex items-center gap-2">
                {canSwitchLanguage && (
                <Select value={selectedLocale} onValueChange={setSelectedLocale}>
                  <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {LOCALES.filter(l => activeLocales.includes(l.code)).map(l => (
                      <SelectItem key={l.code} value={l.code}>{t(`admin.brandingPage.languages.${l.labelKey}` as any)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                )}
                <div className="flex items-center gap-2">
                  <Label className="text-sm">{t('admin.brandingPage.common.active' as any)}</Label>
                  <Switch checked={editActive} onCheckedChange={setEditActive} />
                </div>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label className="text-xs text-muted-foreground">{t('admin.brandingPage.emailTemplates.availableVariables' as any)}</Label>
              <div className="flex flex-wrap gap-1.5 mt-1">
                {(SLUG_VARIABLES[selectedSlug] || []).map(v => (
                  <Badge key={v} variant="outline" className="text-xs cursor-pointer hover:bg-accent"
                    onClick={() => navigator.clipboard.writeText(v).then(() => toast.info(t('admin.brandingPage.emailTemplates.toasts.copied' as any, { variable: v })))}>{v}</Badge>
                ))}
              </div>
            </div>
            <div><Label>{t('admin.brandingPage.emailTemplates.subject' as any)}</Label><Input value={editSubject} onChange={e => setEditSubject(e.target.value)} placeholder={t('admin.brandingPage.emailTemplates.subjectPlaceholder' as any)} /></div>
            <div>
              <div className="flex items-center justify-between mb-2">
                <Label>{t('admin.brandingPage.emailTemplates.htmlBody' as any)}</Label>
                <div className="flex gap-1">
                  <Button size="sm" variant={viewMode === 'code' ? 'default' : 'outline'} onClick={() => setViewMode('code')} className="h-7 text-xs"><Code className="h-3 w-3 me-1" /> {t('admin.brandingPage.emailTemplates.source' as any)}</Button>
                  <Button size="sm" variant={viewMode === 'preview' ? 'default' : 'outline'} onClick={() => setViewMode('preview')} className="h-7 text-xs"><Eye className="h-3 w-3 me-1" /> {t('admin.brandingPage.emailTemplates.preview' as any)}</Button>
                </div>
              </div>
              {viewMode === 'code' ? (
                <Textarea value={editHtml} onChange={e => setEditHtml(e.target.value)} placeholder="<html>...</html>" className="min-h-[300px] font-mono text-xs" dir="ltr" />
              ) : (
                <div className="border rounded-lg p-4 min-h-[300px] bg-white">
                  <iframe srcDoc={editHtml} className="w-full min-h-[280px] border-0" sandbox="" title={t('admin.brandingPage.emailTemplates.previewTitle' as any)} />
                </div>
              )}
            </div>
            <div><Label>{t('admin.brandingPage.emailTemplates.plainTextBody' as any)}</Label><Textarea value={editText} onChange={e => setEditText(e.target.value)} placeholder={t('admin.brandingPage.emailTemplates.plainTextPlaceholder' as any)} className="min-h-[80px] font-mono text-xs" dir="ltr" /></div>
            <div className="flex items-center justify-between pt-2">
              <div className="flex gap-2">
                {editId && (<Button variant="destructive" size="sm" onClick={handleDelete}><Trash2 className="h-4 w-4 me-1" /> {t('admin.brandingPage.emailTemplates.delete' as any)}</Button>)}
                <Button variant="outline" size="sm" onClick={handleDuplicate}><Copy className="h-4 w-4 me-1" /> {t('admin.brandingPage.emailTemplates.duplicate' as any)}</Button>
              </div>
              <Button onClick={handleSave} disabled={saving}><Save className="h-4 w-4 me-1" />{editId ? t('admin.brandingPage.emailTemplates.update' as any) : t('admin.brandingPage.emailTemplates.create' as any)}</Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
