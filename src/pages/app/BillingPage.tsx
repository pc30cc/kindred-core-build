import { useState, useEffect } from 'react';
import { useTranslation } from '@/i18n';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useWorkspaces } from '@/hooks/useWorkspace';
import { billingGetPlans, billingGetStatus, billingCheckout, billingCancel, billingResume, billingGetPortal, API_BASE } from '@/lib/api';
import { CreditCard, Check, X, AlertCircle, ArrowRight, Loader2, ExternalLink, Clock, Shield, Infinity as InfinityIcon } from 'lucide-react';
import { toast } from 'sonner';
import { PlanUsagePanel } from '@/components/billing/PlanUsagePanel';
import { useCapabilityCatalog } from '@/hooks/useEntitlements';
import type { CapabilityDefinition } from '@/lib/entitlements-api';

const CURRENCY_MAP: Record<string, { symbol: string; locale: string; divider: number }> = {
  USD: { symbol: '$', locale: 'en-US', divider: 100 },
  EUR: { symbol: '€', locale: 'de-DE', divider: 100 },
  IRR: { symbol: 'ریال', locale: 'fa-IR', divider: 1 },
  IRT: { symbol: 'تومان', locale: 'fa-IR', divider: 1 },
  TRY: { symbol: '₺', locale: 'tr-TR', divider: 100 },
};

function formatPrice(amount: number, currency: string): string {
  const cfg = CURRENCY_MAP[currency] || CURRENCY_MAP.USD;
  const value = amount / cfg.divider;
  if (currency === 'IRR' || currency === 'IRT') {
    return `${value.toLocaleString('fa-IR')} ${cfg.symbol}`;
  }
  return new Intl.NumberFormat(cfg.locale, { style: 'currency', currency }).format(value);
}

const STATUS_COLORS: Record<string, string> = {
  active: 'bg-green-500/20 text-green-400 border-green-500/30',
  trialing: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  past_due: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  canceled: 'bg-red-500/20 text-red-400 border-red-500/30',
  expired: 'bg-muted text-muted-foreground',
};

export default function BillingPage() {
  const { t } = useTranslation();
  const { data: workspaces } = useWorkspaces();
  const workspace = workspaces?.[0];
  const { capabilities } = useCapabilityCatalog();
  const [plans, setPlans] = useState<any[]>([]);
  const [subscription, setSubscription] = useState<any>(null);
  const [payments, setPayments] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [checkoutLoading, setCheckoutLoading] = useState<string | null>(null);
  const [interval, setInterval] = useState<'monthly' | 'yearly'>('monthly');

  const locale = workspace?.panel_locale || workspace?.default_locale || 'en';
  const currency = locale === 'fa' ? 'IRR' : locale === 'tr' ? 'TRY' : 'USD';

  useEffect(() => {
    if (!workspace || !API_BASE) return;
    loadData();
  }, [workspace]);

  async function loadData() {
    setLoading(true);
    try {
      const [plansRes, statusRes] = await Promise.all([
        billingGetPlans(locale),
        billingGetStatus(workspace!.id),
      ]);
      setPlans(plansRes.plans || []);
      setSubscription(statusRes.subscription);
      setPayments(statusRes.payments || []);
    } catch (e) {
      console.error('Failed to load billing data:', e);
    } finally {
      setLoading(false);
    }
  }

  async function handleCheckout(plan: any) {
    if (!workspace) return;
    setCheckoutLoading(plan.id);
    try {
      const prices = plan.prices?.[currency] || plan.prices?.USD || {};
      const amount = prices[interval] || 0;
      const result = await billingCheckout({
        workspaceId: workspace.id,
        planId: plan.provider_price_ids?.[currency]?.[interval] || plan.id,
        interval,
        currency,
        callbackUrl: `${window.location.origin}/app/billing?callback=true`,
        customerEmail: undefined,
        amount,
      });
      if (result.paymentUrl) {
        window.location.href = result.paymentUrl;
      }
    } catch (e: any) {
      toast.error(e.message || 'Checkout failed');
    } finally {
      setCheckoutLoading(null);
    }
  }

  async function handleCancel() {
    if (!workspace) return;
    try {
      await billingCancel(workspace.id);
      toast.success('Subscription will be canceled at end of period');
      loadData();
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  async function handleResume() {
    if (!workspace) return;
    try {
      await billingResume(workspace.id);
      toast.success('Subscription resumed');
      loadData();
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  async function handlePortal() {
    if (!workspace) return;
    try {
      const result = await billingGetPortal(workspace.id, window.location.href);
      if (result.url) window.open(result.url, '_blank');
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  if (!API_BASE) {
    return (
      <div className="space-y-4 animate-fade-in">
        <h1 className="text-2xl font-bold text-foreground">{t('nav.billing')}</h1>
        <Card><CardContent className="py-8 text-center text-muted-foreground">
          <AlertCircle className="w-8 h-8 mx-auto mb-2" />
          <p>Billing requires the self-hosted backend to be configured.</p>
        </CardContent></Card>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const currentPlan = subscription?.billing_plans || plans.find(p => p.is_free);
  const isActive = subscription?.status === 'active' || subscription?.status === 'trialing';

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t('nav.billing')}</h1>
          <p className="text-muted-foreground text-sm mt-1">
            {locale === 'fa' ? 'مدیریت اشتراک و پرداخت' : locale === 'tr' ? 'Abonelik ve ödeme yönetimi' : 'Manage your subscription and billing'}
          </p>
        </div>
        {subscription?.provider_customer_id && (
          <Button variant="outline" size="sm" onClick={handlePortal}>
            <ExternalLink className="w-4 h-4 mr-2" />
            {locale === 'fa' ? 'پنل پرداخت' : locale === 'tr' ? 'Ödeme Paneli' : 'Customer Portal'}
          </Button>
        )}
      </div>

      {/* Current Plan Status */}
      {subscription && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg flex items-center gap-2">
                <Shield className="w-5 h-5 text-primary" />
                {locale === 'fa' ? 'پلن فعلی' : locale === 'tr' ? 'Mevcut Plan' : 'Current Plan'}
              </CardTitle>
              <Badge className={STATUS_COLORS[subscription.status] || 'bg-muted'}>
                {subscription.status}
              </Badge>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div>
                <p className="text-xs text-muted-foreground">{locale === 'fa' ? 'پلن' : 'Plan'}</p>
                <p className="font-semibold text-foreground">{currentPlan?.name || 'Free'}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">{locale === 'fa' ? 'ارائه‌دهنده' : 'Provider'}</p>
                <p className="font-semibold text-foreground">{subscription.provider_name}</p>
              </div>
              {subscription.current_period_end && (
                <div>
                  <p className="text-xs text-muted-foreground">{locale === 'fa' ? 'تمدید' : 'Renews'}</p>
                  <p className="font-semibold text-foreground">
                    {new Date(subscription.current_period_end).toLocaleDateString(locale === 'fa' ? 'fa-IR' : locale === 'tr' ? 'tr-TR' : 'en-US')}
                  </p>
                </div>
              )}
              <div className="flex items-end gap-2">
                {subscription.cancel_at_period_end ? (
                  <Button size="sm" onClick={handleResume}>
                    {locale === 'fa' ? 'ادامه اشتراک' : 'Resume'}
                  </Button>
                ) : isActive && !currentPlan?.is_free ? (
                  <Button size="sm" variant="destructive" onClick={handleCancel}>
                    {locale === 'fa' ? 'لغو اشتراک' : 'Cancel'}
                  </Button>
                ) : null}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <Tabs defaultValue="usage">
        <TabsList>
          <TabsTrigger value="usage">{locale === 'fa' ? 'پلن و مصرف' : locale === 'tr' ? 'Plan ve Kullanım' : 'Plan & Usage'}</TabsTrigger>
          <TabsTrigger value="plans">{locale === 'fa' ? 'پلن‌ها' : locale === 'tr' ? 'Planlar' : 'Plans'}</TabsTrigger>
          <TabsTrigger value="payments">{locale === 'fa' ? 'پرداخت‌ها' : locale === 'tr' ? 'Ödemeler' : 'Payments'}</TabsTrigger>
        </TabsList>

        <TabsContent value="usage">
          {workspace ? <PlanUsagePanel workspaceId={workspace.id} /> : null}
        </TabsContent>

        <TabsContent value="plans" className="space-y-4">
          {/* Interval Toggle */}
          <div className="flex justify-center gap-2">
            <Button variant={interval === 'monthly' ? 'default' : 'outline'} size="sm" onClick={() => setInterval('monthly')}>
              {locale === 'fa' ? 'ماهانه' : locale === 'tr' ? 'Aylık' : 'Monthly'}
            </Button>
            <Button variant={interval === 'yearly' ? 'default' : 'outline'} size="sm" onClick={() => setInterval('yearly')}>
              {locale === 'fa' ? 'سالانه' : locale === 'tr' ? 'Yıllık' : 'Yearly'}
              <Badge variant="secondary" className="ml-2 text-xs">
                {locale === 'fa' ? '۲ ماه رایگان' : locale === 'tr' ? '2 ay ücretsiz' : '2 months free'}
              </Badge>
            </Button>
          </div>

          <div className="grid md:grid-cols-3 gap-4">
            {plans.map((plan) => {
              const prices = plan.prices?.[currency] || plan.prices?.USD || {};
              const price = prices[interval] || 0;
              const isCurrent = currentPlan?.slug === plan.slug;
              const localizedPlan = (plan.localized || {})[locale] || {};
              const planName: string = (localizedPlan.name || '').trim() || plan.name;
              const planDescription: string = (localizedPlan.description || '').trim() || plan.description || '';
              return (
                <Card key={plan.id} className={`relative ${isCurrent ? 'ring-2 ring-primary' : ''}`}>
                  {isCurrent && (
                    <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                      <Badge className="bg-primary text-primary-foreground">
                        {locale === 'fa' ? 'فعلی' : locale === 'tr' ? 'Mevcut' : 'Current'}
                      </Badge>
                    </div>
                  )}
                  <CardHeader>
                    <CardTitle>{planName}</CardTitle>
                    {planDescription ? <CardDescription>{planDescription}</CardDescription> : null}
                    <div className="pt-2">
                      <span className="text-3xl font-bold text-foreground">
                        {price === 0 ? (locale === 'fa' ? 'رایگان' : locale === 'tr' ? 'Ücretsiz' : 'Free') : formatPrice(price, currency)}
                      </span>
                      {price > 0 && (
                        <span className="text-muted-foreground text-sm">
                          /{interval === 'monthly' ? (locale === 'fa' ? 'ماه' : locale === 'tr' ? 'ay' : 'mo') : (locale === 'fa' ? 'سال' : locale === 'tr' ? 'yıl' : 'yr')}
                        </span>
                      )}
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <PlanCapabilityList plan={plan} capabilities={capabilities || []} locale={locale} />

                    {!isCurrent && !plan.is_free && (
                      <Button
                        className="w-full mt-4"
                        onClick={() => handleCheckout(plan)}
                        disabled={!!checkoutLoading}
                      >
                        {checkoutLoading === plan.id ? (
                          <Loader2 className="w-4 h-4 animate-spin mr-2" />
                        ) : (
                          <ArrowRight className="w-4 h-4 mr-2" />
                        )}
                        {locale === 'fa' ? 'خرید' : locale === 'tr' ? 'Satın Al' : 'Upgrade'}
                      </Button>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </TabsContent>

        <TabsContent value="payments">
          {payments.length === 0 ? (
            <Card><CardContent className="py-8 text-center text-muted-foreground">
              <CreditCard className="w-8 h-8 mx-auto mb-2 opacity-40" />
              <p>{locale === 'fa' ? 'هنوز پرداختی ثبت نشده' : 'No payments yet'}</p>
            </CardContent></Card>
          ) : (
            <Card>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{locale === 'fa' ? 'تاریخ' : 'Date'}</TableHead>
                    <TableHead>{locale === 'fa' ? 'مبلغ' : 'Amount'}</TableHead>
                    <TableHead>{locale === 'fa' ? 'وضعیت' : 'Status'}</TableHead>
                    <TableHead>{locale === 'fa' ? 'ارائه‌دهنده' : 'Provider'}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {payments.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="flex items-center gap-2">
                        <Clock className="w-3.5 h-3.5 text-muted-foreground" />
                        {new Date(p.created_at).toLocaleDateString(locale === 'fa' ? 'fa-IR' : 'en-US')}
                      </TableCell>
                      <TableCell>{formatPrice(p.amount, p.currency)}</TableCell>
                      <TableCell>
                        <Badge variant={p.status === 'succeeded' ? 'default' : 'destructive'} className="text-xs">
                          {p.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{p.provider_name}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Plan capability list — renders ONLY what the plan actually
// grants, driven by the central capability registry. Auto-syncs
// whenever the registry or a plan's entitlements/limits change.
// ─────────────────────────────────────────────────────────────

const CAP_LABELS_FA: Record<string, string> = {
  chat: 'گفتگوی زنده', knowledge_base: 'پایگاه دانش', ai_assistant: 'دستیار هوشمند',
  visitor_tracking: 'ردیابی بازدیدکنندگان', email_campaigns: 'کمپین ایمیلی', automation: 'اتوماسیون',
  analytics: 'تحلیل و گزارش', omnichannel: 'چندکاناله', custom_branding: 'برندینگ سفارشی',
  api_access: 'دسترسی API', voice_video: 'صوت و تصویر', help_center: 'مرکز راهنما',
  call_center: 'مرکز تماس', contacts: 'مخاطبین',
  chat_widget: 'ویجت چت', email: 'ایمیل', whatsapp: 'واتس‌اپ', sms: 'پیامک',
  instagram: 'اینستاگرام', telegram: 'تلگرام', voice: 'تماس صوتی', video: 'تماس تصویری',
  advanced_ai_agent: 'دستیار هوش مصنوعی پیشرفته', ai_operator_assist: 'کمک‌کار هوشمند اپراتور',
  ai_kb_builder: 'سازنده پایگاه دانش با هوش مصنوعی', priority_support: 'پشتیبانی اولویت‌دار',
  sso: 'ورود یکپارچه (SSO/SAML)', audit_logs: 'گزارش‌های ممیزی',
  white_label: 'برندینگ کاملاً سفارشی', remove_powered_by: 'حذف نشان «Powered by»',
  call_recording: 'ضبط تماس', call_queue: 'صف تماس', call_callbacks: 'درخواست تماس مجدد',
  contact_import: 'ورود مخاطبین', contact_export: 'خروجی مخاطبین', contact_tags: 'برچسب مخاطبین',
  contact_notes: 'یادداشت مخاطبین', bulk_contact_actions: 'عملیات گروهی مخاطبین',
  max_agents: 'حداکثر اپراتور', max_workspaces: 'حداکثر فضای کاری',
  max_conversations: 'گفتگو در ماه', max_visitors: 'بازدیدکننده در ماه',
  ai_credits_per_month: 'اعتبار هوش مصنوعی در ماه',
  ai_kb_max_pages: 'حداکثر صفحات هر کار KB', ai_kb_max_depth: 'عمق پیمایش KB',
  ai_kb_jobs_per_month: 'کارهای KB در ماه', ai_kb_file_size_mb: 'حداکثر حجم فایل KB',
  ai_kb_file_count: 'حداکثر تعداد فایل KB', storage_gb: 'فضای ذخیره‌سازی',
  data_retention_days: 'نگهداری داده', max_contacts: 'حداکثر مخاطبین',
  max_concurrent_calls: 'حداکثر تماس هم‌زمان', max_call_minutes_per_month: 'دقیقه تماس در ماه',
  recording_retention_days: 'نگهداری فایل ضبط تماس', max_call_recordings: 'حداکثر فایل ضبط تماس',
  max_call_recording_storage_mb: 'فضای ذخیره ضبط تماس',
};

const CAP_LABELS_TR: Record<string, string> = {
  chat: 'Canlı Sohbet', knowledge_base: 'Bilgi Tabanı', ai_assistant: 'AI Asistanı',
  visitor_tracking: 'Ziyaretçi Takibi', email_campaigns: 'E-posta Kampanyaları', automation: 'Otomasyon',
  analytics: 'Analitik', omnichannel: 'Çoklu Kanal', custom_branding: 'Özel Marka',
  api_access: 'API Erişimi', voice_video: 'Ses ve Video', help_center: 'Yardım Merkezi',
  call_center: 'Çağrı Merkezi', contacts: 'Kişiler',
  chat_widget: 'Sohbet Widget', email: 'E-posta', whatsapp: 'WhatsApp', sms: 'SMS',
  instagram: 'Instagram', telegram: 'Telegram', voice: 'Sesli Arama', video: 'Görüntülü Arama',
  advanced_ai_agent: 'Gelişmiş AI Asistanı', ai_operator_assist: 'AI Operatör Yardımı',
  ai_kb_builder: 'AI Bilgi Tabanı Oluşturucu', priority_support: 'Öncelikli Destek',
  sso: 'SSO / SAML', audit_logs: 'Denetim Kayıtları',
  white_label: 'White-label Marka', remove_powered_by: '"Powered by" Kaldırma',
  call_recording: 'Çağrı Kaydı', call_queue: 'Çağrı Kuyruğu', call_callbacks: 'Geri Arama',
  contact_import: 'Kişi İçe Aktar', contact_export: 'Kişi Dışa Aktar', contact_tags: 'Kişi Etiketleri',
  contact_notes: 'Kişi Notları', bulk_contact_actions: 'Toplu Kişi İşlemleri',
  max_agents: 'Maks. Operatör', max_workspaces: 'Maks. Çalışma Alanı',
  max_conversations: 'Aylık Konuşma', max_visitors: 'Aylık Ziyaretçi',
  ai_credits_per_month: 'Aylık AI Kredisi',
  ai_kb_max_pages: 'KB İşi Başına Maks. Sayfa', ai_kb_max_depth: 'KB Tarama Derinliği',
  ai_kb_jobs_per_month: 'Aylık KB İşi', ai_kb_file_size_mb: 'Maks. KB Dosya Boyutu',
  ai_kb_file_count: 'Maks. KB Dosya', storage_gb: 'Depolama',
  data_retention_days: 'Veri Saklama', max_contacts: 'Maks. Kişi',
  max_concurrent_calls: 'Eşzamanlı Maks. Çağrı', max_call_minutes_per_month: 'Aylık Çağrı Dakikası',
  recording_retention_days: 'Çağrı Kaydı Saklama', max_call_recordings: 'Maks. Çağrı Kaydı',
  max_call_recording_storage_mb: 'Çağrı Kaydı Depolama',
};

function capLabel(cap: CapabilityDefinition, locale: string): string {
  if (locale === 'fa' && CAP_LABELS_FA[cap.key]) return CAP_LABELS_FA[cap.key];
  if (locale === 'tr' && CAP_LABELS_TR[cap.key]) return CAP_LABELS_TR[cap.key];
  return cap.label;
}

function formatLimitValue(value: number, cap: CapabilityDefinition, locale: string): string {
  if (value === -1) return locale === 'fa' ? 'نامحدود' : locale === 'tr' ? 'Sınırsız' : 'Unlimited';
  const fmt = locale === 'fa'
    ? value.toLocaleString('fa-IR')
    : value.toLocaleString(locale === 'tr' ? 'tr-TR' : 'en-US');
  const unit = cap.unit;
  const perMo = locale === 'fa' ? '/ماه' : locale === 'tr' ? '/ay' : '/mo';
  const perDay = locale === 'fa' ? '/روز' : locale === 'tr' ? '/gün' : '/day';
  const days = locale === 'fa' ? 'روز' : locale === 'tr' ? 'gün' : 'days';
  const mins = locale === 'fa' ? 'دقیقه' : locale === 'tr' ? 'dk' : 'min';
  switch (unit) {
    case 'per_month': return `${fmt}${perMo}`;
    case 'per_day': return `${fmt}${perDay}`;
    case 'gb': return `${fmt} GB`;
    case 'mb': return `${fmt} MB`;
    case 'days': return `${fmt} ${days}`;
    case 'minutes': return `${fmt} ${mins}`;
    default: return fmt;
  }
}

function PlanCapabilityList({
  plan, capabilities, locale,
}: { plan: any; capabilities: CapabilityDefinition[]; locale: string }) {
  if (!capabilities.length) return null;

  const ent = (plan.entitlements || {}) as Record<string, unknown>;
  const lim = (plan.limits || {}) as Record<string, unknown>;

  // Only include user-visible, plan-configurable capabilities.
  const visible = capabilities.filter((c) => c.userVisible && !c.internalOnly && c.planConfigurable);

  type Row = { key: string; label: string; included: boolean; valueText?: string; isLimit: boolean };
  const rows: Row[] = [];

  for (const cap of visible) {
    const label = capLabel(cap, locale);
    if (cap.type === 'limit') {
      const raw = cap.key in lim ? lim[cap.key] : cap.defaultValue;
      const num = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(num)) continue;
      // 0 = not available → skip ("don't include what the plan doesn't have")
      if (num === 0) continue;
      rows.push({
        key: cap.key, label, included: true, isLimit: true,
        valueText: formatLimitValue(num, cap, locale),
      });
    } else {
      const raw = cap.key in ent ? ent[cap.key] : cap.defaultValue;
      const enabled = Boolean(raw);
      if (!enabled) continue; // skip what the plan doesn't have
      rows.push({ key: cap.key, label, included: true, isLimit: false });
    }
  }

  // Group: modules → channels → features → limits, by registry sort.
  const order = new Map(visible.map((c, i) => [c.key, i]));
  rows.sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0));

  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {locale === 'fa' ? 'این پلن ویژگی فعالی ندارد.' : locale === 'tr' ? 'Bu planda etkin özellik yok.' : 'No features enabled on this plan.'}
      </p>
    );
  }

  return (
    <ul className="space-y-2">
      {rows.map((r) => (
        <li key={r.key} className="flex items-start gap-2 text-sm">
          <Check className="w-4 h-4 mt-0.5 shrink-0 text-green-500" />
          <span className="text-foreground">
            {r.isLimit ? (
              <><span className="font-medium">{r.valueText}</span>{' '}<span className="text-muted-foreground">{r.label}</span></>
            ) : (
              r.label
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}
