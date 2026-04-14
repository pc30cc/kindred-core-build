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
import { toast } from 'sonner';
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
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from '@/hooks/use-toast';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import {
  Mail, Save, Eye, RotateCcw, Loader2, FileText,
  ShieldCheck, UserPlus, KeyRound, Link2, MailCheck, AlertTriangle,
  Send, Bell, CheckCircle2, Globe, XCircle, Code
} from 'lucide-react';

/* ─── Email Template Types ─── */
interface EmailTemplate {
  id: string;
  name: string;
  category: 'auth' | 'transactional' | 'notification';
  icon: any;
  description: string;
  subject: { fa: string; en: string; tr: string };
  body: { fa: string; en: string; tr: string };
  enabled: boolean;
  variables: string[];
}

const DEFAULT_TEMPLATES: EmailTemplate[] = [
  // Auth emails
  {
    id: 'email_verify',
    name: 'Email Verification',
    category: 'auth',
    icon: MailCheck,
    description: 'Verification link sent after signup',
    subject: {
      fa: 'تأیید آدرس ایمیل شما در {brand}',
      en: 'Verify your email address at {brand}',
      tr: '{brand} e-posta adresinizi doğrulayın',
    },
    body: {
      fa: 'سلام {name}،\n\nممنون از ثبت‌نام در {brand}! لطفاً برای تأیید آدرس ایمیلتون روی لینک زیر کلیک کنید:\n\n{action_url}\n\nاین لینک تا {expiry_time} دقیقه اعتبار دارد.\n\nبا تشکر،\nتیم {brand}',
      en: 'Hi {name},\n\nThanks for signing up at {brand}! Please verify your email by clicking the link below:\n\n{action_url}\n\nThis link expires in {expiry_time} minutes.\n\nBest regards,\nThe {brand} Team',
      tr: 'Merhaba {name},\n\n{brand}\'a kaydolduğunuz için teşekkürler! Lütfen aşağıdaki bağlantıya tıklayarak e-postanızı doğrulayın:\n\n{action_url}\n\nBu bağlantı {expiry_time} dakika geçerlidir.\n\nSaygılarımızla,\n{brand} Ekibi',
    },
    enabled: true,
    variables: ['{name}', '{brand}', '{action_url}', '{expiry_time}'],
  },
  {
    id: 'password_reset',
    name: 'Password Reset',
    category: 'auth',
    icon: KeyRound,
    description: 'Password reset link email',
    subject: {
      fa: 'بازنشانی رمز عبور {brand}',
      en: 'Reset your {brand} password',
      tr: '{brand} şifrenizi sıfırlayın',
    },
    body: {
      fa: 'سلام {name}،\n\nدرخواست بازنشانی رمز عبور حساب {brand} شما ثبت شده است. برای تنظیم رمز جدید روی لینک زیر کلیک کنید:\n\n{action_url}\n\nاگر شما این درخواست را نداده‌اید، این ایمیل را نادیده بگیرید.\n\nبا تشکر،\nتیم {brand}',
      en: 'Hi {name},\n\nWe received a request to reset your {brand} password. Click the link below to set a new password:\n\n{action_url}\n\nIf you didn\'t request this, please ignore this email.\n\nBest regards,\nThe {brand} Team',
      tr: 'Merhaba {name},\n\n{brand} şifrenizi sıfırlama isteği aldık. Yeni bir şifre belirlemek için aşağıdaki bağlantıya tıklayın:\n\n{action_url}\n\nBu isteği siz yapmadıysanız, bu e-postayı dikkate almayın.\n\nSaygılarımızla,\n{brand} Ekibi',
    },
    enabled: true,
    variables: ['{name}', '{brand}', '{action_url}'],
  },
  {
    id: 'magic_link',
    name: 'Magic Link',
    category: 'auth',
    icon: Link2,
    description: 'Passwordless login link',
    subject: {
      fa: 'لینک ورود به {brand}',
      en: 'Your {brand} login link',
      tr: '{brand} giriş bağlantınız',
    },
    body: {
      fa: 'سلام {name}،\n\nبرای ورود به حساب {brand} خود روی لینک زیر کلیک کنید:\n\n{action_url}\n\nاین لینک تا {expiry_time} دقیقه اعتبار دارد و فقط یکبار قابل استفاده است.\n\nبا تشکر،\nتیم {brand}',
      en: 'Hi {name},\n\nClick the link below to sign in to your {brand} account:\n\n{action_url}\n\nThis link expires in {expiry_time} minutes and can only be used once.\n\nBest regards,\nThe {brand} Team',
      tr: 'Merhaba {name},\n\n{brand} hesabınıza giriş yapmak için aşağıdaki bağlantıya tıklayın:\n\n{action_url}\n\nBu bağlantı {expiry_time} dakika geçerlidir ve yalnızca bir kez kullanılabilir.\n\nSaygılarımızla,\n{brand} Ekibi',
    },
    enabled: true,
    variables: ['{name}', '{brand}', '{action_url}', '{expiry_time}'],
  },
  // Transactional emails
  {
    id: 'welcome',
    name: 'Welcome',
    category: 'transactional',
    icon: UserPlus,
    description: 'Welcome email after registration completion',
    subject: {
      fa: 'به {brand} خوش آمدید! 🎉',
      en: 'Welcome to {brand}! 🎉',
      tr: '{brand}\'a hoş geldiniz! 🎉',
    },
    body: {
      fa: 'سلام {name}،\n\nبه {brand} خوش آمدید! خوشحالیم که به جمع ما پیوستید.\n\nبرای شروع، می‌تونید:\n• ویجت چت را روی سایتتون نصب کنید\n• مخاطبین خود را وارد کنید\n• تنظیمات فضای کاری را شخصی‌سازی کنید\n\nاگر سؤالی دارید، تیم پشتیبانی ما همیشه در دسترسه.\n\nبا تشکر،\nتیم {brand}',
      en: 'Hi {name},\n\nWelcome to {brand}! We\'re excited to have you on board.\n\nTo get started, you can:\n• Install the chat widget on your website\n• Import your contacts\n• Customize your workspace settings\n\nIf you have any questions, our support team is always here to help.\n\nBest regards,\nThe {brand} Team',
      tr: 'Merhaba {name},\n\n{brand}\'a hoş geldiniz! Aramıza katıldığınız için çok mutluyuz.\n\nBaşlamak için:\n• Sohbet widget\'ını web sitenize kurun\n• Kişilerinizi içe aktarın\n• Çalışma alanı ayarlarınızı özelleştirin\n\nSorularınız varsa, destek ekibimiz her zaman yardıma hazırdır.\n\nSaygılarımızla,\n{brand} Ekibi',
    },
    enabled: true,
    variables: ['{name}', '{brand}'],
  },
  {
    id: 'invite_member',
    name: 'Team Invitation',
    category: 'transactional',
    icon: UserPlus,
    description: 'Invite new member to workspace',
    subject: {
      fa: 'دعوت به تیم {workspace_name} در {brand}',
      en: 'You\'re invited to join {workspace_name} on {brand}',
      tr: '{brand}\'da {workspace_name} ekibine davet edildiniz',
    },
    body: {
      fa: 'سلام،\n\n{inviter_name} شما را به فضای کاری «{workspace_name}» در {brand} دعوت کرده است.\n\nبرای پیوستن به تیم روی لینک زیر کلیک کنید:\n\n{action_url}\n\nاین دعوتنامه تا {expiry_time} روز اعتبار دارد.\n\nبا تشکر،\nتیم {brand}',
      en: 'Hello,\n\n{inviter_name} has invited you to join the "{workspace_name}" workspace on {brand}.\n\nClick the link below to accept the invitation:\n\n{action_url}\n\nThis invitation expires in {expiry_time} days.\n\nBest regards,\nThe {brand} Team',
      tr: 'Merhaba,\n\n{inviter_name} sizi {brand}\'da "{workspace_name}" çalışma alanına davet etti.\n\nDaveti kabul etmek için aşağıdaki bağlantıya tıklayın:\n\n{action_url}\n\nBu davet {expiry_time} gün geçerlidir.\n\nSaygılarımızla,\n{brand} Ekibi',
    },
    enabled: true,
    variables: ['{inviter_name}', '{workspace_name}', '{brand}', '{action_url}', '{expiry_time}'],
  },
  {
    id: 'payment_success',
    name: 'Payment Confirmation',
    category: 'transactional',
    icon: CheckCircle2,
    description: 'Payment success confirmation email',
    subject: {
      fa: 'تأیید پرداخت - {brand}',
      en: 'Payment Confirmed - {brand}',
      tr: 'Ödeme Onaylandı - {brand}',
    },
    body: {
      fa: 'سلام {name}،\n\nپرداخت شما با موفقیت انجام شد.\n\nجزئیات:\n• پلن: {plan_name}\n• مبلغ: {amount}\n• کد رهگیری: {ref_id}\n• تاریخ: {date}\n\nاشتراک شما فعال شده است.\n\nبا تشکر،\nتیم {brand}',
      en: 'Hi {name},\n\nYour payment has been successfully processed.\n\nDetails:\n• Plan: {plan_name}\n• Amount: {amount}\n• Reference: {ref_id}\n• Date: {date}\n\nYour subscription is now active.\n\nBest regards,\nThe {brand} Team',
      tr: 'Merhaba {name},\n\nÖdemeniz başarıyla işlendi.\n\nDetaylar:\n• Plan: {plan_name}\n• Tutar: {amount}\n• Referans: {ref_id}\n• Tarih: {date}\n\nAboneliğiniz artık aktif.\n\nSaygılarımızla,\n{brand} Ekibi',
    },
    enabled: true,
    variables: ['{name}', '{brand}', '{plan_name}', '{amount}', '{ref_id}', '{date}'],
  },
  // Notification emails
  {
    id: 'new_conversation',
    name: 'New Conversation',
    category: 'notification',
    icon: Bell,
    description: 'Notify operator of new conversation',
    subject: {
      fa: 'گفتگوی جدید در {brand} - {contact_name}',
      en: 'New conversation on {brand} - {contact_name}',
      tr: '{brand}\'da yeni görüşme - {contact_name}',
    },
    body: {
      fa: 'سلام {operator_name}،\n\nیک گفتگوی جدید از طرف {contact_name} شروع شده است.\n\nپیام اول:\n«{message_preview}»\n\nبرای پاسخگویی وارد داشبورد شوید:\n{action_url}\n\nبا تشکر،\nتیم {brand}',
      en: 'Hi {operator_name},\n\nA new conversation has been started by {contact_name}.\n\nFirst message:\n"{message_preview}"\n\nLog in to your dashboard to respond:\n{action_url}\n\nBest regards,\nThe {brand} Team',
      tr: 'Merhaba {operator_name},\n\n{contact_name} tarafından yeni bir görüşme başlatıldı.\n\nİlk mesaj:\n"{message_preview}"\n\nYanıtlamak için panele giriş yapın:\n{action_url}\n\nSaygılarımızla,\n{brand} Ekibi',
    },
    enabled: true,
    variables: ['{operator_name}', '{contact_name}', '{message_preview}', '{brand}', '{action_url}'],
  },
  {
    id: 'task_assigned',
    name: 'Task Assigned',
    category: 'notification',
    icon: FileText,
    description: 'Notify user of new task assignment',
    subject: {
      fa: 'وظیفه جدید: {task_title} - {brand}',
      en: 'New task assigned: {task_title} - {brand}',
      tr: 'Yeni görev atandı: {task_title} - {brand}',
    },
    body: {
      fa: 'سلام {name}،\n\nیک وظیفه جدید به شما اختصاص داده شده:\n\n• عنوان: {task_title}\n• اولویت: {priority}\n• مهلت: {due_date}\n\nبرای مشاهده جزئیات:\n{action_url}\n\nبا تشکر،\nتیم {brand}',
      en: 'Hi {name},\n\nA new task has been assigned to you:\n\n• Title: {task_title}\n• Priority: {priority}\n• Due date: {due_date}\n\nView details:\n{action_url}\n\nBest regards,\nThe {brand} Team',
      tr: 'Merhaba {name},\n\nSize yeni bir görev atandı:\n\n• Başlık: {task_title}\n• Öncelik: {priority}\n• Son tarih: {due_date}\n\nDetayları görüntüleyin:\n{action_url}\n\nSaygılarımızla,\n{brand} Ekibi',
    },
    enabled: true,
    variables: ['{name}', '{brand}', '{task_title}', '{priority}', '{due_date}', '{action_url}'],
  },
  {
    id: 'trial_expiring',
    name: 'Trial Expiring',
    category: 'notification',
    icon: AlertTriangle,
    description: 'Trial period expiration warning',
    subject: {
      fa: 'دوره آزمایشی {brand} شما به زودی پایان می‌یابد',
      en: 'Your {brand} trial is ending soon',
      tr: '{brand} deneme süreniz yakında bitiyor',
    },
    body: {
      fa: 'سلام {name}،\n\nدوره آزمایشی شما در {brand} تا {expiry_date} به پایان می‌رسد.\n\nبرای ادامه استفاده از تمام امکانات، پلن مناسب خود را انتخاب کنید:\n{action_url}\n\nبا تشکر،\nتیم {brand}',
      en: 'Hi {name},\n\nYour {brand} trial will end on {expiry_date}.\n\nTo continue using all features, choose a plan that fits your needs:\n{action_url}\n\nBest regards,\nThe {brand} Team',
      tr: 'Merhaba {name},\n\n{brand} deneme süreniz {expiry_date} tarihinde sona erecek.\n\nTüm özellikleri kullanmaya devam etmek için size uygun bir plan seçin:\n{action_url}\n\nSaygılarımızla,\n{brand} Ekibi',
    },
    enabled: true,
    variables: ['{name}', '{brand}', '{expiry_date}', '{action_url}'],
  },
  {
    id: 'plan_expiring',
    name: 'Subscription Expiring',
    category: 'notification',
    icon: AlertTriangle,
    description: 'Subscription renewal reminder',
    subject: {
      fa: 'اشتراک {brand} شما تا {days} روز دیگر منقضی می‌شود',
      en: 'Your {brand} subscription expires in {days} days',
      tr: '{brand} aboneliğiniz {days} gün içinde sona erecek',
    },
    body: {
      fa: 'سلام {name}،\n\nاشتراک پلن «{plan_name}» شما در {brand} تا {expiry_date} به پایان می‌رسد.\n\nبرای جلوگیری از قطع دسترسی به امکانات، لطفاً اشتراک خود را تمدید کنید:\n{action_url}\n\nجزئیات اشتراک:\n• پلن: {plan_name}\n• تاریخ انقضا: {expiry_date}\n• روزهای باقی‌مانده: {days}\n\nبا تشکر،\nتیم {brand}',
      en: 'Hi {name},\n\nYour "{plan_name}" subscription on {brand} expires on {expiry_date}.\n\nTo avoid losing access to your features, please renew your subscription:\n{action_url}\n\nSubscription details:\n• Plan: {plan_name}\n• Expires: {expiry_date}\n• Days remaining: {days}\n\nBest regards,\nThe {brand} Team',
      tr: 'Merhaba {name},\n\n{brand}\'da "{plan_name}" aboneliğiniz {expiry_date} tarihinde sona erecek.\n\nÖzelliklerinize erişimi kaybetmemek için lütfen aboneliğinizi yenileyin:\n{action_url}\n\nAbonelik detayları:\n• Plan: {plan_name}\n• Son tarih: {expiry_date}\n• Kalan gün: {days}\n\nSaygılarımızla,\n{brand} Ekibi',
    },
    enabled: true,
    variables: ['{name}', '{brand}', '{plan_name}', '{expiry_date}', '{days}', '{action_url}'],
  },
  {
    id: 'plan_expired',
    name: 'Subscription Expired',
    category: 'notification',
    icon: XCircle,
    description: 'Subscription expiration notice',
    subject: {
      fa: 'اشتراک {brand} شما منقضی شده است',
      en: 'Your {brand} subscription has expired',
      tr: '{brand} aboneliğiniz sona erdi',
    },
    body: {
      fa: 'سلام {name}،\n\nاشتراک پلن «{plan_name}» شما در {brand} منقضی شده است.\n\nدسترسی شما به امکانات پیشرفته محدود شده است. برای بازگشت به امکانات کامل، لطفاً اشتراک خود را تمدید کنید:\n{action_url}\n\nبا تشکر،\nتیم {brand}',
      en: 'Hi {name},\n\nYour "{plan_name}" subscription on {brand} has expired.\n\nYour access to advanced features has been limited. To regain full access, please renew your subscription:\n{action_url}\n\nBest regards,\nThe {brand} Team',
      tr: 'Merhaba {name},\n\n{brand}\'da "{plan_name}" aboneliğiniz sona erdi.\n\nGelişmiş özelliklere erişiminiz kısıtlandı. Tam erişimi geri kazanmak için lütfen aboneliğinizi yenileyin:\n{action_url}\n\nSaygılarımızla,\n{brand} Ekibi',
    },
    enabled: true,
    variables: ['{name}', '{brand}', '{plan_name}', '{action_url}'],
  },
  {
    id: 'payment_failed',
    name: 'Payment Failed',
    category: 'notification',
    icon: XCircle,
    description: 'Payment failure notification',
    subject: {
      fa: 'خطا در پرداخت {brand}',
      en: 'Payment failed - {brand}',
      tr: 'Ödeme başarısız - {brand}',
    },
    body: {
      fa: 'سلام {name}،\n\nپرداخت شما برای پلن «{plan_name}» در {brand} با خطا مواجه شد.\n\n• مبلغ: {amount}\n• تاریخ: {date}\n• خطا: {error_message}\n\nلطفاً مجدداً تلاش کنید یا از روش پرداخت دیگری استفاده کنید:\n{action_url}\n\nبا تشکر،\nتیم {brand}',
      en: 'Hi {name},\n\nYour payment for the "{plan_name}" plan on {brand} has failed.\n\n• Amount: {amount}\n• Date: {date}\n• Error: {error_message}\n\nPlease try again or use a different payment method:\n{action_url}\n\nBest regards,\nThe {brand} Team',
      tr: 'Merhaba {name},\n\n{brand}\'da "{plan_name}" planı için ödemeniz başarısız oldu.\n\n• Tutar: {amount}\n• Tarih: {date}\n• Hata: {error_message}\n\nLütfen tekrar deneyin veya farklı bir ödeme yöntemi kullanın:\n{action_url}\n\nSaygılarımızla,\n{brand} Ekibi',
    },
    enabled: true,
    variables: ['{name}', '{brand}', '{plan_name}', '{amount}', '{date}', '{error_message}', '{action_url}'],
  },
  {
    id: 'usage_limit_warning',
    name: 'Usage Limit Warning',
    category: 'notification',
    icon: AlertTriangle,
    description: 'Usage quota approaching limit',
    subject: {
      fa: 'هشدار: مصرف {resource} در {brand} به {percent}٪ رسید',
      en: 'Warning: {resource} usage at {percent}% - {brand}',
      tr: 'Uyarı: {resource} kullanımı %{percent} - {brand}',
    },
    body: {
      fa: 'سلام {name}،\n\nمصرف {resource} فضای کاری شما در {brand} به {percent}٪ سقف مجاز رسیده است.\n\n• مصرف فعلی: {current}\n• سقف مجاز: {limit}\n\nبرای جلوگیری از محدود شدن سرویس، می‌توانید پلن خود را ارتقا دهید:\n{action_url}\n\nبا تشکر،\nتیم {brand}',
      en: 'Hi {name},\n\nYour {resource} usage on {brand} has reached {percent}% of your quota.\n\n• Current usage: {current}\n• Quota limit: {limit}\n\nTo avoid service limitations, consider upgrading your plan:\n{action_url}\n\nBest regards,\nThe {brand} Team',
      tr: 'Merhaba {name},\n\n{brand}\'da {resource} kullanımınız kotanızın %{percent}\'ine ulaştı.\n\n• Mevcut kullanım: {current}\n• Kota limiti: {limit}\n\nHizmet kısıtlamalarından kaçınmak için planınızı yükseltmeyi düşünün:\n{action_url}\n\nSaygılarımızla,\n{brand} Ekibi',
    },
    enabled: true,
    variables: ['{name}', '{brand}', '{resource}', '{percent}', '{current}', '{limit}', '{action_url}'],
  },
];

const CATEGORY_LABELS = {
  auth: { label: 'Authentication', icon: ShieldCheck, color: 'text-blue-500' },
  transactional: { label: 'Transactional', icon: Send, color: 'text-emerald-500' },
  notification: { label: 'Notification', icon: Bell, color: 'text-amber-500' },
};

const LANG_LABELS: Record<string, string> = { fa: 'فارسی', en: 'English', tr: 'Türkçe' };

export function EmailTemplatesTab() {
  const queryClient = useQueryClient();
  const [selectedTemplate, setSelectedTemplate] = useState<string>('email_verify');
  const [editLang, setEditLang] = useState<'fa' | 'en' | 'tr'>('en');
  const [templates, setTemplates] = useState<EmailTemplate[]>(DEFAULT_TEMPLATES);
  const [showPreview, setShowPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [filterCategory, setFilterCategory] = useState<'all' | 'auth' | 'transactional' | 'notification'>('all');
  const [showHtmlSource, setShowHtmlSource] = useState<string | null>(null);

  // Load saved templates from app_runtime_config
  const { isLoading } = useQuery({
    queryKey: ['email-templates-config'],
    queryFn: async () => {
      const { data } = await supabase
        .from('app_runtime_config')
        .select('value')
        .eq('key', 'email_templates')
        .maybeSingle();

      if (data?.value && typeof data.value === 'object') {
        const saved = data.value as Record<string, any>;
        const newTemplates = [...DEFAULT_TEMPLATES];
        Object.entries(saved).forEach(([tplId, val]: [string, any]) => {
          const idx = newTemplates.findIndex(t => t.id === tplId);
          if (idx !== -1 && val) {
            if (val.subject) newTemplates[idx].subject = { ...newTemplates[idx].subject, ...val.subject };
            if (val.body) newTemplates[idx].body = { ...newTemplates[idx].body, ...val.body };
            if (typeof val.enabled === 'boolean') newTemplates[idx].enabled = val.enabled;
          }
        });
        setTemplates(newTemplates);
      }
      return true;
    },
  });

  const current = templates.find(t => t.id === selectedTemplate) || templates[0];

  const updateTemplate = (field: 'subject' | 'body', lang: string, value: string) => {
    setTemplates(prev => prev.map(t =>
      t.id === selectedTemplate
        ? { ...t, [field]: { ...t[field], [lang]: value } }
        : t
    ));
  };

  const toggleEnabled = (id: string) => {
    setTemplates(prev => prev.map(t =>
      t.id === id ? { ...t, enabled: !t.enabled } : t
    ));
  };

  const saveTemplate = async () => {
    setSaving(true);
    try {
      const tpl = templates.find(t => t.id === selectedTemplate);
      if (!tpl) return;

      // Load existing config
      const { data: existing } = await supabase
        .from('app_runtime_config')
        .select('*')
        .eq('key', 'email_templates')
        .maybeSingle();

      const currentValue = (existing?.value as Record<string, any>) || {};
      const updated = {
        ...currentValue,
        [tpl.id]: { subject: tpl.subject, body: tpl.body, enabled: tpl.enabled },
      };

      if (existing) {
        await supabase
          .from('app_runtime_config')
          .update({ value: updated as any, updated_at: new Date().toISOString() })
          .eq('key', 'email_templates');
      } else {
        await supabase
          .from('app_runtime_config')
          .insert({ key: 'email_templates', value: updated as any });
      }

      toast({ title: 'Email template saved' });
      queryClient.invalidateQueries({ queryKey: ['email-templates-config'] });
    } catch {
      toast({ title: 'Error saving template', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const resetTemplate = () => {
    const def = DEFAULT_TEMPLATES.find(t => t.id === selectedTemplate);
    if (!def) return;
    setTemplates(prev => prev.map(t =>
      t.id === selectedTemplate
        ? { ...t, subject: { ...def.subject }, body: { ...def.body } }
        : t
    ));
    toast({ title: 'Template reset to default (save to apply)' });
  };

  const filteredTemplates = filterCategory === 'all'
    ? templates
    : templates.filter(t => t.category === filterCategory);

  const previewBody = current.body[editLang]
    .replace(/\{brand\}/g, '★ Brand')
    .replace(/\{name\}/g, 'John Doe')
    .replace(/\{action_url\}/g, 'https://example.com/action')
    .replace(/\{expiry_time\}/g, '60')
    .replace(/\{expiry_date\}/g, '2026-05-15')
    .replace(/\{workspace_name\}/g, 'My Workspace')
    .replace(/\{inviter_name\}/g, 'Ali M.')
    .replace(/\{plan_name\}/g, 'Professional')
    .replace(/\{amount\}/g, '$49.00')
    .replace(/\{ref_id\}/g, 'REF-123456')
    .replace(/\{date\}/g, '2026-04-14')
    .replace(/\{contact_name\}/g, 'Jane Doe')
    .replace(/\{operator_name\}/g, 'Operator')
    .replace(/\{message_preview\}/g, 'Hello, I have a question...')
    .replace(/\{task_title\}/g, 'Review ticket #42')
    .replace(/\{priority\}/g, 'High')
    .replace(/\{due_date\}/g, '2026-05-01')
    .replace(/\{days\}/g, '7')
    .replace(/\{error_message\}/g, 'Card declined')
    .replace(/\{resource\}/g, 'API calls')
    .replace(/\{percent\}/g, '85')
    .replace(/\{current\}/g, '8,500')
    .replace(/\{limit\}/g, '10,000')
    .replace(/\n/g, '<br/>');

  if (isLoading) {
    return <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>;
  }

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-4">
        <div className="flex items-center gap-2">
          <Mail className="h-5 w-5 text-primary" />
          <CardTitle className="text-foreground">Email Templates</CardTitle>
        </div>
        <p className="text-sm text-muted-foreground">
          Manage email templates with multi-language support. Templates use {'{variable}'} syntax for dynamic data.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Category filter */}
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            size="sm"
            variant={filterCategory === 'all' ? 'default' : 'outline'}
            onClick={() => setFilterCategory('all')}
            className="text-xs h-8"
          >
            <Mail className="w-3.5 h-3.5 mr-1" />
            All ({templates.length})
          </Button>
          {(Object.entries(CATEGORY_LABELS) as [string, any][]).map(([key, cat]) => {
            const count = templates.filter(t => t.category === key).length;
            return (
              <Button
                key={key}
                size="sm"
                variant={filterCategory === key ? 'default' : 'outline'}
                onClick={() => setFilterCategory(key as any)}
                className="text-xs h-8"
              >
                <cat.icon className={`w-3.5 h-3.5 mr-1 ${filterCategory !== key ? cat.color : ''}`} />
                {cat.label} ({count})
              </Button>
            );
          })}
        </div>

        <div className="grid grid-cols-12 gap-4">
          {/* Template list */}
          <div className="col-span-4 space-y-2 max-h-[600px] overflow-y-auto pr-1">
            {filteredTemplates.map(tpl => {
              const catInfo = CATEGORY_LABELS[tpl.category];
              return (
                <div
                  key={tpl.id}
                  onClick={() => setSelectedTemplate(tpl.id)}
                  className={`p-3 rounded-lg border cursor-pointer transition-all ${
                    selectedTemplate === tpl.id
                      ? 'border-primary bg-primary/5 shadow-sm'
                      : 'border-border hover:border-primary/40 hover:bg-muted/30'
                  }`}
                >
                  <div className="flex items-start gap-2">
                    <tpl.icon className={`w-4 h-4 mt-0.5 ${catInfo.color}`} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium text-foreground truncate">{tpl.name}</span>
                        {!tpl.enabled && (
                          <Badge variant="secondary" className="text-[9px] px-1.5 py-0">Disabled</Badge>
                        )}
                      </div>
                      <p className="text-[10px] text-muted-foreground mt-0.5 line-clamp-1">{tpl.description}</p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Template editor */}
          <div className="col-span-8 space-y-4">
            <Card className="bg-card border-border">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm text-foreground">{current.name}</CardTitle>
                  <div className="flex items-center gap-2">
                    <div className="flex items-center gap-2 mr-4">
                      <span className="text-xs text-muted-foreground">Enabled</span>
                      <Switch
                        checked={current.enabled}
                        onCheckedChange={() => toggleEnabled(current.id)}
                      />
                    </div>
                    <Button size="sm" variant="ghost" onClick={resetTemplate} className="text-xs h-8">
                      <RotateCcw className="w-3.5 h-3.5 mr-1" />Reset
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setShowPreview(!showPreview)} className="text-xs h-8">
                      <Eye className="w-3.5 h-3.5 mr-1" />Preview
                    </Button>
                    <Button size="sm" onClick={saveTemplate} disabled={saving} className="text-xs h-8">
                      {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : <Save className="w-3.5 h-3.5 mr-1" />}
                      Save
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-xs text-muted-foreground">{current.description}</p>

                {/* Language tabs */}
                <Tabs value={editLang} onValueChange={(v) => setEditLang(v as any)}>
                  <TabsList className="h-8 mb-4">
                    {(['fa', 'en', 'tr'] as const).map(lang => (
                      <TabsTrigger key={lang} value={lang} className="text-xs px-4 h-7 gap-1.5">
                        <Globe className="w-3 h-3" />
                        {LANG_LABELS[lang]}
                      </TabsTrigger>
                    ))}
                  </TabsList>

                  {(['fa', 'en', 'tr'] as const).map(lang => (
                    <TabsContent key={lang} value={lang} className="space-y-4">
                      <div className="space-y-2">
                        <Label className="text-xs font-medium">Subject</Label>
                        <Input
                          value={current.subject[lang]}
                          onChange={e => updateTemplate('subject', lang, e.target.value)}
                          className="text-xs"
                          dir={lang === 'fa' ? 'rtl' : 'ltr'}
                        />
                      </div>
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <Label className="text-xs font-medium">Body (HTML)</Label>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-[10px] h-6 px-2"
                            onClick={() => setShowHtmlSource(prev => prev === `${current.id}-${lang}` ? null : `${current.id}-${lang}`)}
                          >
                            <Code className="w-3 h-3 mr-1" />
                            {showHtmlSource === `${current.id}-${lang}` ? 'Preview' : 'HTML Source'}
                          </Button>
                        </div>
                        {showHtmlSource === `${current.id}-${lang}` ? (
                          <Textarea
                            value={current.body[lang]}
                            onChange={e => updateTemplate('body', lang, e.target.value)}
                            className="text-xs min-h-[300px] font-mono leading-relaxed"
                            dir="ltr"
                          />
                        ) : (
                          <div
                            className="border border-border rounded-lg p-4 min-h-[300px] text-xs bg-background overflow-auto cursor-text whitespace-pre-wrap"
                            dir={lang === 'fa' ? 'rtl' : 'ltr'}
                            onClick={() => setShowHtmlSource(`${current.id}-${lang}`)}
                          >
                            {current.body[lang]}
                          </div>
                        )}
                      </div>
                    </TabsContent>
                  ))}
                </Tabs>

                {/* Variables reference */}
                <div className="mt-4 p-3 bg-muted/30 rounded-lg border border-border/50">
                  <p className="text-[10px] text-muted-foreground mb-2 font-medium">Available variables:</p>
                  <div className="flex flex-wrap gap-1.5">
                    {current.variables.map(v => (
                      <Badge key={v} variant="secondary" className="text-[10px] font-mono px-2 py-0.5 cursor-pointer hover:bg-primary/10"
                        onClick={() => {
                          navigator.clipboard.writeText(v);
                          toast({ title: `${v} copied` });
                        }}
                      >
                        {v}
                      </Badge>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Preview */}
            {showPreview && (
              <Card className="bg-card border-border">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm text-foreground">Preview — {LANG_LABELS[editLang]}</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="bg-background border border-border rounded-lg overflow-hidden">
                    {/* Email header */}
                    <div className="bg-muted/50 px-4 py-3 border-b border-border">
                      <div className="text-[10px] text-muted-foreground">
                        <span className="font-medium">Subject:</span>{' '}
                        {current.subject[editLang].replace(/\{brand\}/g, '★ Brand')}
                      </div>
                    </div>
                    {/* Email body */}
                    <div className="p-4" dir={editLang === 'fa' ? 'rtl' : 'ltr'}>
                      <div
                        className="text-xs text-foreground leading-relaxed"
                        dangerouslySetInnerHTML={{ __html: previewBody }}
                      />
                    </div>
                    {/* Email footer */}
                    <div className="bg-muted/30 px-4 py-2 border-t border-border text-center">
                      <p className="text-[9px] text-muted-foreground">
                        {editLang === 'fa' ? 'این ایمیل به‌صورت خودکار ارسال شده است.' :
                         editLang === 'tr' ? 'Bu e-posta otomatik olarak gönderilmiştir.' :
                         'This email was sent automatically.'}
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
