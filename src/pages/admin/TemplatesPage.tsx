import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useTranslation } from '@/i18n';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Mail, Save, Eye, RotateCcw, Loader2, FileText,
  ShieldCheck, UserPlus, KeyRound, Link2, MailCheck, AlertTriangle,
  Send, Bell, CheckCircle2, Globe, XCircle, Code, Copy,
} from 'lucide-react';

// ─── Types ───────────────────────────────────────────────────────
interface EmailTemplate {
  id: string;
  name: Record<string, string>;
  category: 'auth' | 'transactional' | 'notification';
  icon: any;
  description: Record<string, string>;
  subject: Record<string, string>;
  body: Record<string, string>;
  enabled: boolean;
  variables: string[];
}

// ─── Default Templates (matching WebYar pattern) ─────────────────
const DEFAULT_TEMPLATES: EmailTemplate[] = [
  {
    id: 'email_verify',
    name: { fa: 'تأیید ایمیل', en: 'Email Verification', tr: 'E-posta Doğrulama' },
    category: 'auth',
    icon: MailCheck,
    description: { fa: 'ارسال لینک تأیید ایمیل پس از ثبت‌نام', en: 'Verification link sent after signup', tr: 'Kayıt sonrası doğrulama bağlantısı' },
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
    name: { fa: 'بازیابی رمز عبور', en: 'Password Reset', tr: 'Şifre Sıfırlama' },
    category: 'auth',
    icon: KeyRound,
    description: { fa: 'ارسال لینک بازنشانی رمز عبور', en: 'Password reset link', tr: 'Şifre sıfırlama bağlantısı' },
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
    name: { fa: 'لینک ورود', en: 'Magic Link', tr: 'Giriş Bağlantısı' },
    category: 'auth',
    icon: Link2,
    description: { fa: 'ارسال لینک ورود بدون رمز عبور', en: 'Passwordless login link', tr: 'Şifresiz giriş bağlantısı' },
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
  {
    id: 'welcome',
    name: { fa: 'خوش‌آمدگویی', en: 'Welcome', tr: 'Hoş Geldiniz' },
    category: 'transactional',
    icon: UserPlus,
    description: { fa: 'ایمیل خوش‌آمدگویی پس از تکمیل ثبت‌نام', en: 'Welcome email after signup', tr: 'Kayıt sonrası hoş geldiniz e-postası' },
    subject: {
      fa: 'به {brand} خوش آمدید! 🎉',
      en: 'Welcome to {brand}! 🎉',
      tr: '{brand}\'a hoş geldiniz! 🎉',
    },
    body: {
      fa: 'سلام {name}،\n\nبه {brand} خوش آمدید! خوشحالیم که به جمع ما پیوستید.\n\nبرای شروع، می‌تونید:\n• ویجت چت را روی سایتتون نصب کنید\n• مخاطبین خود را وارد کنید\n• تنظیمات فضای کاری را شخصی‌سازی کنید\n\nبا تشکر،\nتیم {brand}',
      en: 'Hi {name},\n\nWelcome to {brand}! We\'re excited to have you on board.\n\nTo get started, you can:\n• Install the chat widget on your website\n• Import your contacts\n• Customize your workspace settings\n\nBest regards,\nThe {brand} Team',
      tr: 'Merhaba {name},\n\n{brand}\'a hoş geldiniz! Aramıza katıldığınız için çok mutluyuz.\n\nBaşlamak için:\n• Sohbet widget\'ını web sitenize kurun\n• Kişilerinizi içe aktarın\n• Çalışma alanı ayarlarınızı özelleştirin\n\nSaygılarımızla,\n{brand} Ekibi',
    },
    enabled: true,
    variables: ['{name}', '{brand}'],
  },
  {
    id: 'invite_member',
    name: { fa: 'دعوت به تیم', en: 'Team Invite', tr: 'Takım Daveti' },
    category: 'transactional',
    icon: UserPlus,
    description: { fa: 'ایمیل دعوت عضو جدید به فضای کاری', en: 'Workspace member invitation', tr: 'Çalışma alanı üye daveti' },
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
    name: { fa: 'تأیید پرداخت', en: 'Payment Confirmed', tr: 'Ödeme Onaylandı' },
    category: 'transactional',
    icon: CheckCircle2,
    description: { fa: 'ایمیل تأیید پرداخت موفق', en: 'Successful payment confirmation', tr: 'Başarılı ödeme onayı' },
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
  {
    id: 'new_conversation',
    name: { fa: 'گفتگوی جدید', en: 'New Conversation', tr: 'Yeni Görüşme' },
    category: 'notification',
    icon: Bell,
    description: { fa: 'اطلاع‌رسانی شروع گفتگوی جدید به اپراتور', en: 'New conversation notification to operator', tr: 'Operatöre yeni görüşme bildirimi' },
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
    id: 'admin_created_user',
    name: { fa: 'حساب ایجاد شده', en: 'Account Created', tr: 'Hesap Oluşturuldu' },
    category: 'auth',
    icon: ShieldCheck,
    description: { fa: 'ایمیل به کاربری که توسط ادمین ایجاد شده', en: 'Email to admin-created user', tr: 'Yönetici tarafından oluşturulan kullanıcıya e-posta' },
    subject: {
      fa: 'حساب کاربری شما در {brand} ایجاد شد',
      en: 'Your account on {brand} has been created',
      tr: '{brand}\'da hesabınız oluşturuldu',
    },
    body: {
      fa: 'سلام {name}،\n\nیک حساب کاربری در {brand} برای شما ایجاد شده است.\n\nبرای ورود از اطلاعات زیر استفاده کنید:\n• ایمیل: {email}\n• رمز عبور: {temp_password}\n\nلطفاً پس از اولین ورود رمز عبور خود را تغییر دهید.\n\n{action_url}\n\nبا تشکر،\nتیم {brand}',
      en: 'Hi {name},\n\nAn account has been created for you on {brand}.\n\nUse the following credentials to sign in:\n• Email: {email}\n• Password: {temp_password}\n\nPlease change your password after your first login.\n\n{action_url}\n\nBest regards,\nThe {brand} Team',
      tr: 'Merhaba {name},\n\n{brand}\'da sizin için bir hesap oluşturuldu.\n\nGiriş yapmak için aşağıdaki bilgileri kullanın:\n• E-posta: {email}\n• Şifre: {temp_password}\n\nLütfen ilk girişten sonra şifrenizi değiştirin.\n\n{action_url}\n\nSaygılarımızla,\n{brand} Ekibi',
    },
    enabled: true,
    variables: ['{name}', '{brand}', '{email}', '{temp_password}', '{action_url}'],
  },
  {
    id: 'trial_expiring',
    name: { fa: 'پایان دوره آزمایشی', en: 'Trial Expiring', tr: 'Deneme Süresi Bitiyor' },
    category: 'notification',
    icon: AlertTriangle,
    description: { fa: 'اطلاع‌رسانی نزدیک شدن پایان دوره رایگان', en: 'Trial ending soon', tr: 'Deneme süresi yakında bitiyor' },
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
];

const CATEGORY_LABELS: Record<string, Record<string, string>> = {
  auth: { fa: 'احراز هویت', en: 'Authentication', tr: 'Kimlik Doğrulama' },
  transactional: { fa: 'تراکنشی', en: 'Transactional', tr: 'İşlemsel' },
  notification: { fa: 'اطلاع‌رسانی', en: 'Notification', tr: 'Bildirim' },
};

const CATEGORY_ICONS: Record<string, any> = {
  auth: ShieldCheck,
  transactional: Send,
  notification: Bell,
};

const CATEGORY_COLORS: Record<string, string> = {
  auth: 'text-blue-500',
  transactional: 'text-emerald-500',
  notification: 'text-amber-500',
};

const LANG_LABELS: Record<string, string> = { fa: 'فارسی', en: 'English', tr: 'Türkçe' };

const PREVIEW_VARS: Record<string, string> = {
  '{brand}': '★ Brand',
  '{name}': 'John Doe',
  '{action_url}': 'https://example.com/action',
  '{expiry_time}': '60',
  '{expiry_date}': '2026-05-15',
  '{workspace_name}': 'My Workspace',
  '{inviter_name}': 'Ali',
  '{plan_name}': 'Professional',
  '{amount}': '$49.00',
  '{ref_id}': 'REF-123456',
  '{date}': '2026-04-14',
  '{contact_name}': 'Jane Smith',
  '{operator_name}': 'Operator',
  '{message_preview}': 'Hi, I have a question...',
  '{email}': 'user@example.com',
  '{temp_password}': '••••••••',
};

async function getAdminHeaders(): Promise<Record<string, string>> {
  const { supabase } = await import('@/lib/supabase');
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' };
}

const API_BASE = import.meta.env.VITE_API_BASE_URL || '';

export default function TemplatesPage() {
  const { t, locale, dir } = useTranslation();
  const queryClient = useQueryClient();
  const isRtl = dir === 'rtl';
  const lang = locale as 'fa' | 'en' | 'tr';

  const [selectedTemplate, setSelectedTemplate] = useState<string>('email_verify');
  const [editLang, setEditLang] = useState<'fa' | 'en' | 'tr'>(lang);
  const [templates, setTemplates] = useState<EmailTemplate[]>(DEFAULT_TEMPLATES);
  const [showPreview, setShowPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [filterCategory, setFilterCategory] = useState<'all' | 'auth' | 'transactional' | 'notification'>('all');
  const [showHtmlSource, setShowHtmlSource] = useState<string | null>(null);

  // Load saved templates from DB
  const { isLoading } = useQuery({
    queryKey: ['admin-email-templates'],
    queryFn: async () => {
      const headers = await getAdminHeaders();
      const res = await fetch(`${API_BASE}/api/admin/templates/list`, { headers });
      if (!res.ok) return null;
      const { templates: dbTemplates } = await res.json();
      if (dbTemplates && Array.isArray(dbTemplates)) {
        const newTemplates = [...DEFAULT_TEMPLATES];
        dbTemplates.forEach((dt: any) => {
          const idx = newTemplates.findIndex(t => t.id === dt.slug);
          if (idx !== -1) {
            // Override from DB
            if (dt.subject) newTemplates[idx].subject = { ...newTemplates[idx].subject, [dt.locale]: dt.subject };
            if (dt.html_body) newTemplates[idx].body = { ...newTemplates[idx].body, [dt.locale]: dt.html_body };
          }
        });
        setTemplates(newTemplates);
      }
      return true;
    },
  });

  const current = templates.find(t => t.id === selectedTemplate) || templates[0];

  const updateTemplate = (field: 'subject' | 'body', langKey: string, value: string) => {
    setTemplates(prev => prev.map(t =>
      t.id === selectedTemplate
        ? { ...t, [field]: { ...t[field], [langKey]: value } }
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
      const headers = await getAdminHeaders();

      // Save all locales
      for (const loc of ['fa', 'en', 'tr'] as const) {
        await fetch(`${API_BASE}/api/admin/templates/save`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            slug: tpl.id,
            locale: loc,
            subject: tpl.subject[loc],
            htmlBody: tpl.body[loc],
            textBody: tpl.body[loc].replace(/<[^>]*>/g, ''),
            enabled: tpl.enabled,
          }),
        });
      }

      toast.success(lang === 'fa' ? 'قالب ایمیل ذخیره شد' : 'Email template saved');
      queryClient.invalidateQueries({ queryKey: ['admin-email-templates'] });
    } catch {
      toast.error(lang === 'fa' ? 'خطا در ذخیره قالب' : 'Error saving template');
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
    toast.info(lang === 'fa' ? 'قالب به حالت پیش‌فرض بازگردانده شد' : 'Template reset to default (save to apply)');
  };

  const filteredTemplates = filterCategory === 'all'
    ? templates
    : templates.filter(t => t.category === filterCategory);

  const previewBody = (() => {
    let text = current.body[editLang] || '';
    for (const [key, val] of Object.entries(PREVIEW_VARS)) {
      text = text.replace(new RegExp(key.replace(/[{}]/g, '\\$&'), 'g'), val);
    }
    return text;
  })();

  if (isLoading) {
    return <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>;
  }

  return (
    <div className="space-y-6" dir={dir}>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">
            {lang === 'fa' ? 'قالب‌ها' : lang === 'tr' ? 'Şablonlar' : 'Templates'}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {lang === 'fa' ? 'مدیریت قالب‌های ایمیل پلتفرم' : lang === 'tr' ? 'Platform e-posta şablonlarını yönetin' : 'Manage platform email templates'}
          </p>
        </div>
      </div>

      <Tabs defaultValue="email" className="w-full">
        <TabsList>
          <TabsTrigger value="email" className="gap-2">
            <Mail className="w-4 h-4" />
            {lang === 'fa' ? 'قالب‌های ایمیل' : lang === 'tr' ? 'E-posta Şablonları' : 'Email Templates'}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="email" className="mt-6 space-y-6">
          {/* Category filter */}
          <div className="flex items-center gap-2 flex-wrap">
            <Button
              size="sm"
              variant={filterCategory === 'all' ? 'default' : 'outline'}
              onClick={() => setFilterCategory('all')}
              className="text-xs h-8"
            >
              <Mail className="w-3.5 h-3.5 me-1" />
              {lang === 'fa' ? 'همه' : 'All'} ({templates.length})
            </Button>
            {(Object.entries(CATEGORY_LABELS) as [string, Record<string, string>][]).map(([key, cat]) => {
              const count = templates.filter(t => t.category === key).length;
              const CatIcon = CATEGORY_ICONS[key];
              return (
                <Button
                  key={key}
                  size="sm"
                  variant={filterCategory === key ? 'default' : 'outline'}
                  onClick={() => setFilterCategory(key as any)}
                  className="text-xs h-8"
                >
                  <CatIcon className={`w-3.5 h-3.5 me-1 ${filterCategory !== key ? CATEGORY_COLORS[key] : ''}`} />
                  {cat[lang] || cat.en} ({count})
                </Button>
              );
            })}
          </div>

          <div className="grid grid-cols-12 gap-4">
            {/* Template list */}
            <div className="col-span-12 md:col-span-4 space-y-2">
              {filteredTemplates.map(tpl => {
                const catColor = CATEGORY_COLORS[tpl.category];
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
                      <tpl.icon className={`w-4 h-4 mt-0.5 shrink-0 ${catColor}`} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-medium text-foreground truncate">
                            {tpl.name[lang] || tpl.name.en}
                          </span>
                          {!tpl.enabled && (
                            <Badge variant="secondary" className="text-[9px] px-1.5 py-0">
                              {lang === 'fa' ? 'غیرفعال' : 'Disabled'}
                            </Badge>
                          )}
                        </div>
                        <p className="text-[10px] text-muted-foreground mt-0.5 line-clamp-1">
                          {tpl.description[lang] || tpl.description.en}
                        </p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Template editor */}
            <div className="col-span-12 md:col-span-8 space-y-4">
              <Card>
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <CardTitle className="text-base">{current.name[lang] || current.name.en}</CardTitle>
                    <div className="flex items-center gap-2 flex-wrap">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">
                          {lang === 'fa' ? 'فعال' : 'Active'}
                        </span>
                        <Switch
                          checked={current.enabled}
                          onCheckedChange={() => toggleEnabled(current.id)}
                        />
                      </div>
                      <Button size="sm" variant="ghost" onClick={resetTemplate} className="text-xs h-8">
                        <RotateCcw className="w-3.5 h-3.5 me-1" />
                        {lang === 'fa' ? 'پیش‌فرض' : 'Reset'}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setShowPreview(!showPreview)} className="text-xs h-8">
                        <Eye className="w-3.5 h-3.5 me-1" />
                        {lang === 'fa' ? 'پیش‌نمایش' : 'Preview'}
                      </Button>
                      <Button size="sm" onClick={saveTemplate} disabled={saving} className="text-xs h-8">
                        {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin me-1" /> : <Save className="w-3.5 h-3.5 me-1" />}
                        {lang === 'fa' ? 'ذخیره' : 'Save'}
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <p className="text-xs text-muted-foreground">{current.description[lang] || current.description.en}</p>

                  {/* Language tabs */}
                  <Tabs value={editLang} onValueChange={(v) => setEditLang(v as any)}>
                    <TabsList className="h-8 mb-4">
                      {(['fa', 'en', 'tr'] as const).map(l => (
                        <TabsTrigger key={l} value={l} className="text-xs px-4 h-7 gap-1.5">
                          <Globe className="w-3 h-3" />
                          {LANG_LABELS[l]}
                        </TabsTrigger>
                      ))}
                    </TabsList>

                    {(['fa', 'en', 'tr'] as const).map(l => (
                      <TabsContent key={l} value={l} className="space-y-4">
                        <div className="space-y-2">
                          <Label className="text-xs font-medium">
                            {lang === 'fa' ? 'موضوع ایمیل' : 'Email Subject'}
                          </Label>
                          <Input
                            value={current.subject[l] || ''}
                            onChange={e => updateTemplate('subject', l, e.target.value)}
                            className="text-xs"
                            dir={l === 'fa' ? 'rtl' : 'ltr'}
                          />
                        </div>
                        <div className="space-y-2">
                          <div className="flex items-center justify-between">
                            <Label className="text-xs font-medium">
                              {lang === 'fa' ? 'متن ایمیل' : 'Email Body'}
                            </Label>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-[10px] h-6 px-2"
                              onClick={() => setShowHtmlSource(prev => prev === `${current.id}-${l}` ? null : `${current.id}-${l}`)}
                            >
                              <Code className="w-3 h-3 me-1" />
                              {showHtmlSource === `${current.id}-${l}`
                                ? (lang === 'fa' ? 'پیش‌نمایش' : 'Preview')
                                : (lang === 'fa' ? 'سورس' : 'Source')}
                            </Button>
                          </div>
                          {showHtmlSource === `${current.id}-${l}` ? (
                            <Textarea
                              value={current.body[l] || ''}
                              onChange={e => updateTemplate('body', l, e.target.value)}
                              className="text-xs min-h-[300px] font-mono leading-relaxed"
                              dir="ltr"
                            />
                          ) : (
                            <div
                              className="border border-border rounded-lg p-4 min-h-[300px] text-xs bg-background overflow-auto cursor-text whitespace-pre-wrap"
                              dir={l === 'fa' ? 'rtl' : 'ltr'}
                              onClick={() => setShowHtmlSource(`${current.id}-${l}`)}
                            >
                              {current.body[l] || ''}
                            </div>
                          )}
                        </div>
                      </TabsContent>
                    ))}
                  </Tabs>

                  {/* Variables reference */}
                  <div className="p-3 bg-muted/30 rounded-lg border border-border/50">
                    <p className="text-[10px] text-muted-foreground mb-2 font-medium">
                      {lang === 'fa' ? 'متغیرهای قابل استفاده:' : 'Available variables:'}
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {current.variables.map(v => (
                        <Badge key={v} variant="secondary" className="text-[10px] font-mono px-2 py-0.5 cursor-pointer hover:bg-primary/10"
                          onClick={() => {
                            navigator.clipboard.writeText(v);
                            toast.success(lang === 'fa' ? `${v} کپی شد` : `${v} copied`);
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
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm">
                      {lang === 'fa' ? 'پیش‌نمایش' : 'Preview'} — {LANG_LABELS[editLang]}
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="bg-background border border-border rounded-lg overflow-hidden">
                      <div className="bg-muted/50 px-4 py-3 border-b border-border">
                        <div className="text-[10px] text-muted-foreground">
                          <span className="font-medium">{lang === 'fa' ? 'موضوع:' : 'Subject:'}</span>{' '}
                          {(() => {
                            let s = current.subject[editLang] || '';
                            for (const [k, v] of Object.entries(PREVIEW_VARS)) {
                              s = s.replace(new RegExp(k.replace(/[{}]/g, '\\$&'), 'g'), v);
                            }
                            return s;
                          })()}
                        </div>
                      </div>
                      <div className="p-4" dir={editLang === 'fa' ? 'rtl' : 'ltr'}>
                        <div className="text-xs text-foreground leading-relaxed whitespace-pre-wrap">
                          {previewBody}
                        </div>
                      </div>
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
        </TabsContent>
      </Tabs>
    </div>
  );
}
