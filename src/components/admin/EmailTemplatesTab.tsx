import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
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
  { key: 'auth', label: 'Authentication', icon: Shield, slugs: ['email_verify', 'password_reset', 'magic_link', 'welcome'] },
  { key: 'transactional', label: 'Transactional', icon: CreditCard, slugs: ['invite_member', 'payment_success', 'payment_failed', 'subscription_renewed', 'subscription_cancelled'] },
  { key: 'notification', label: 'Notification', icon: Bell, slugs: ['new_conversation', 'task_assigned', 'account_expiry', 'system_alert'] },
] as const;

const SLUG_LABELS: Record<string, string> = {
  email_verify: 'Email Verification',
  password_reset: 'Password Reset',
  magic_link: 'Magic Link Login',
  welcome: 'Welcome Email',
  invite_member: 'Team Invite',
  payment_success: 'Payment Success',
  payment_failed: 'Payment Failed',
  subscription_renewed: 'Subscription Renewed',
  subscription_cancelled: 'Subscription Cancelled',
  new_conversation: 'New Conversation',
  task_assigned: 'Task Assigned',
  account_expiry: 'Account Expiry Warning',
  system_alert: 'System Alert',
};

const SLUG_VARIABLES: Record<string, string[]> = {
  email_verify: ['{name}', '{brand}', '{action_url}', '{expiry_time}'],
  password_reset: ['{name}', '{brand}', '{action_url}', '{expiry_time}'],
  magic_link: ['{name}', '{brand}', '{action_url}', '{expiry_time}'],
  welcome: ['{name}', '{brand}', '{action_url}'],
  invite_member: ['{name}', '{brand}', '{inviter}', '{workspace}', '{role}', '{action_url}'],
  payment_success: ['{name}', '{brand}', '{amount}', '{currency}', '{plan}', '{invoice_url}'],
  payment_failed: ['{name}', '{brand}', '{amount}', '{currency}', '{reason}', '{action_url}'],
  subscription_renewed: ['{name}', '{brand}', '{plan}', '{next_date}', '{amount}'],
  subscription_cancelled: ['{name}', '{brand}', '{plan}', '{end_date}'],
  new_conversation: ['{name}', '{brand}', '{visitor}', '{message}', '{action_url}'],
  task_assigned: ['{name}', '{brand}', '{task}', '{assigner}', '{action_url}'],
  account_expiry: ['{name}', '{brand}', '{days_left}', '{plan}', '{action_url}'],
  system_alert: ['{brand}', '{title}', '{message}', '{severity}'],
};

const LOCALES = [
  { code: 'en', label: 'English' },
  { code: 'fa', label: 'فارسی' },
  { code: 'tr', label: 'Türkçe' },
];

export default function EmailTemplatesTab() {
  const [templates, setTemplates] = useState<DbTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [selectedSlug, setSelectedSlug] = useState('email_verify');
  const [selectedLocale, setSelectedLocale] = useState('en');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [viewMode, setViewMode] = useState<'code' | 'preview'>('code');

  const [editSubject, setEditSubject] = useState('');
  const [editHtml, setEditHtml] = useState('');
  const [editText, setEditText] = useState('');
  const [editActive, setEditActive] = useState(true);
  const [editId, setEditId] = useState<string | null>(null);

  useEffect(() => { fetchTemplates(); }, []);
  useEffect(() => { loadTemplateForEdit(); }, [selectedSlug, selectedLocale, templates]);

  async function fetchTemplates() {
    setLoading(true);
    const { data, error } = await supabase
      .from('email_templates')
      .select('*')
      .is('workspace_id', null)
      .order('slug');
    if (error) { toast.error('Failed to load templates'); console.error(error); }
    else { setTemplates(data || []); }
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
    if (!editSubject.trim() || !editHtml.trim()) { toast.error('Subject and HTML body are required'); return; }
    setSaving(true);
    if (editId) {
      const { error } = await supabase.from('email_templates').update({
        subject: editSubject, html_body: editHtml, text_body: editText || null, is_active: editActive,
      }).eq('id', editId);
      if (error) { toast.error('Failed to update template'); } else { toast.success('Template updated'); await fetchTemplates(); }
    } else {
      const { error } = await supabase.from('email_templates').insert({
        slug: selectedSlug, locale: selectedLocale, subject: editSubject,
        html_body: editHtml, text_body: editText || null, is_active: editActive,
      } as any);
      if (error) { toast.error('Failed to create template'); } else { toast.success('Template created'); await fetchTemplates(); }
    }
    setSaving(false);
  }

  async function handleDelete() {
    if (!editId) return;
    const { error } = await supabase.from('email_templates').delete().eq('id', editId);
    if (error) { toast.error('Failed to delete'); } else { toast.success('Template deleted'); await fetchTemplates(); }
  }

  async function handleDuplicate() {
    const existingLocales = templates.filter(t => t.slug === selectedSlug).map(t => t.locale);
    const nextLocale = LOCALES.find(l => !existingLocales.includes(l.code));
    if (!nextLocale) { toast.info('Template exists for all locales'); return; }
    const { error } = await supabase.from('email_templates').insert({
      slug: selectedSlug, locale: nextLocale.code, subject: editSubject,
      html_body: editHtml, text_body: editText || null, is_active: editActive,
    } as any);
    if (error) { toast.error('Failed to duplicate'); }
    else { toast.success(`Duplicated to ${nextLocale.label}`); setSelectedLocale(nextLocale.code); await fetchTemplates(); }
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
          <SelectTrigger className="w-full"><SelectValue placeholder="Filter category" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Categories</SelectItem>
            {CATEGORIES.map(c => (<SelectItem key={c.key} value={c.key}>{c.label}</SelectItem>))}
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
                  <div className="text-sm font-medium">{SLUG_LABELS[slug] || slug}</div>
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
                <CardTitle className="text-lg flex items-center gap-2"><Mail className="h-5 w-5" />{SLUG_LABELS[selectedSlug] || selectedSlug}</CardTitle>
                <CardDescription>{selectedSlug}</CardDescription>
              </div>
              <div className="flex items-center gap-2">
                <Select value={selectedLocale} onValueChange={setSelectedLocale}>
                  <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
                  <SelectContent>{LOCALES.map(l => (<SelectItem key={l.code} value={l.code}>{l.label}</SelectItem>))}</SelectContent>
                </Select>
                <div className="flex items-center gap-2">
                  <Label className="text-sm">Active</Label>
                  <Switch checked={editActive} onCheckedChange={setEditActive} />
                </div>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label className="text-xs text-muted-foreground">Available Variables</Label>
              <div className="flex flex-wrap gap-1.5 mt-1">
                {(SLUG_VARIABLES[selectedSlug] || []).map(v => (
                  <Badge key={v} variant="outline" className="text-xs cursor-pointer hover:bg-accent"
                    onClick={() => navigator.clipboard.writeText(v).then(() => toast.info(`Copied ${v}`))}>{v}</Badge>
                ))}
              </div>
            </div>
            <div><Label>Subject</Label><Input value={editSubject} onChange={e => setEditSubject(e.target.value)} placeholder="Email subject line..." /></div>
            <div>
              <div className="flex items-center justify-between mb-2">
                <Label>HTML Body</Label>
                <div className="flex gap-1">
                  <Button size="sm" variant={viewMode === 'code' ? 'default' : 'outline'} onClick={() => setViewMode('code')} className="h-7 text-xs"><Code className="h-3 w-3 mr-1" /> Source</Button>
                  <Button size="sm" variant={viewMode === 'preview' ? 'default' : 'outline'} onClick={() => setViewMode('preview')} className="h-7 text-xs"><Eye className="h-3 w-3 mr-1" /> Preview</Button>
                </div>
              </div>
              {viewMode === 'code' ? (
                <Textarea value={editHtml} onChange={e => setEditHtml(e.target.value)} placeholder="<html>...</html>" className="min-h-[300px] font-mono text-xs" dir="ltr" />
              ) : (
                <div className="border rounded-lg p-4 min-h-[300px] bg-white">
                  <iframe srcDoc={editHtml} className="w-full min-h-[280px] border-0" sandbox="allow-same-origin" title="Email Preview" />
                </div>
              )}
            </div>
            <div><Label>Plain Text Body (optional)</Label><Textarea value={editText} onChange={e => setEditText(e.target.value)} placeholder="Plain text fallback..." className="min-h-[80px] font-mono text-xs" dir="ltr" /></div>
            <div className="flex items-center justify-between pt-2">
              <div className="flex gap-2">
                {editId && (<Button variant="destructive" size="sm" onClick={handleDelete}><Trash2 className="h-4 w-4 mr-1" /> Delete</Button>)}
                <Button variant="outline" size="sm" onClick={handleDuplicate}><Copy className="h-4 w-4 mr-1" /> Duplicate to Locale</Button>
              </div>
              <Button onClick={handleSave} disabled={saving}><Save className="h-4 w-4 mr-1" />{editId ? 'Update' : 'Create'} Template</Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
