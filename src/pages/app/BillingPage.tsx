import { useState, useEffect } from 'react';
import { useTranslation } from '@/i18n';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useWorkspaces } from '@/hooks/useWorkspace';
import { billingGetPlans, billingGetStatus, billingCheckout, billingCancel, billingResume, billingGetPortal, API_BASE } from '@/lib/api';
import { CreditCard, Check, AlertCircle, ArrowRight, Loader2, ExternalLink, Clock, Shield, Sparkles, Calendar } from 'lucide-react';
import { toast } from 'sonner';
import { PlanUsagePanel } from '@/components/billing/PlanUsagePanel';
import { useCapabilityCatalog } from '@/hooks/useEntitlements';
import type { CapabilityDefinition } from '@/lib/entitlements-api';
import { bt, capLabel as sharedCapLabel, formatLimitValue as sharedFormatLimit, type BillingLocale } from '@/lib/billing-i18n';

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
  active: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30',
  trialing: 'bg-sky-500/15 text-sky-600 dark:text-sky-400 border-sky-500/30',
  past_due: 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30',
  canceled: 'bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30',
  expired: 'bg-muted text-muted-foreground border-border',
};

const STATUS_LABEL: Record<string, { fa: string; en: string; tr: string }> = {
  active: { fa: 'فعال', en: 'Active', tr: 'Aktif' },
  trialing: { fa: 'دوره آزمایشی', en: 'Trial', tr: 'Deneme' },
  past_due: { fa: 'سررسید گذشته', en: 'Past due', tr: 'Vadesi geçmiş' },
  canceled: { fa: 'لغو شده', en: 'Canceled', tr: 'İptal edildi' },
  expired: { fa: 'منقضی', en: 'Expired', tr: 'Süresi dolmuş' },
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
  const L = locale as BillingLocale;
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
        <h1 className="text-2xl font-bold text-foreground">{bt(L, 'title')}</h1>
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
  const currentPlanLocalized = currentPlan
    ? ((currentPlan.localized || {})[locale]?.name?.trim() || currentPlan.name || bt(L, 'free'))
    : bt(L, 'free');
  const statusKey = (subscription?.status || 'expired') as keyof typeof STATUS_LABEL;
  const statusText = STATUS_LABEL[statusKey]?.[L as 'fa' | 'en' | 'tr'] || subscription?.status || '';

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Colorful gradient hero */}
      <div className="relative overflow-hidden rounded-2xl border border-border/60 bg-gradient-to-br from-primary/15 via-fuchsia-500/10 to-sky-500/10 p-6">
        <div className="absolute -top-20 -right-16 w-64 h-64 rounded-full bg-primary/20 blur-3xl pointer-events-none" />
        <div className="absolute -bottom-24 -left-10 w-72 h-72 rounded-full bg-fuchsia-500/15 blur-3xl pointer-events-none" />
        <div className="relative flex flex-col md:flex-row md:items-center md:justify-between gap-5">
          <div className="space-y-2">
            <div className="inline-flex items-center gap-2 text-xs font-medium px-2.5 py-1 rounded-full bg-background/60 backdrop-blur text-foreground border border-border/60">
              <Sparkles className="w-3.5 h-3.5 text-primary" />
              {bt(L, 'title')}
            </div>
            <h1 className="text-3xl font-bold text-foreground">{currentPlanLocalized}</h1>
            <p className="text-sm text-muted-foreground max-w-xl">{bt(L, 'subtitle')}</p>
            {subscription && (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Badge className={STATUS_COLORS[subscription.status] || 'bg-muted'}>
                  {statusText}
                </Badge>
                {subscription.current_period_end && (
                  <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Calendar className="w-3.5 h-3.5" />
                    {bt(L, 'renews')}{' '}
                    {new Date(subscription.current_period_end).toLocaleDateString(locale === 'fa' ? 'fa-IR' : locale === 'tr' ? 'tr-TR' : 'en-US')}
                  </span>
                )}
                {subscription.provider_name && (
                  <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Shield className="w-3.5 h-3.5" />
                    {subscription.provider_name}
                  </span>
                )}
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {subscription?.provider_customer_id && (
              <Button variant="outline" size="sm" onClick={handlePortal}>
                <ExternalLink className="w-4 h-4 mr-2" />
                {bt(L, 'customerPortal')}
              </Button>
            )}
            {subscription?.cancel_at_period_end ? (
              <Button size="sm" onClick={handleResume}>{bt(L, 'resume')}</Button>
            ) : isActive && !currentPlan?.is_free ? (
              <Button size="sm" variant="outline" onClick={handleCancel}>{bt(L, 'cancel')}</Button>
            ) : null}
          </div>
        </div>
      </div>

      <Tabs defaultValue="usage">
        <TabsList className="bg-muted/50 p-1 h-auto">
          <TabsTrigger value="usage" className="data-[state=active]:bg-background data-[state=active]:shadow-sm">{bt(L, 'tabUsage')}</TabsTrigger>
          <TabsTrigger value="plans" className="data-[state=active]:bg-background data-[state=active]:shadow-sm">{bt(L, 'tabPlans')}</TabsTrigger>
          <TabsTrigger value="payments" className="data-[state=active]:bg-background data-[state=active]:shadow-sm">{bt(L, 'tabPayments')}</TabsTrigger>
        </TabsList>

        <TabsContent value="usage" className="mt-5">
          {workspace ? <PlanUsagePanel workspaceId={workspace.id} /> : null}
        </TabsContent>

        <TabsContent value="plans" className="space-y-4 mt-5">
          {/* Interval Toggle */}
          <div className="flex justify-center">
            <div className="inline-flex items-center rounded-full bg-muted p-1">
              <button
                onClick={() => setInterval('monthly')}
                className={`px-4 py-1.5 text-sm rounded-full transition ${interval === 'monthly' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {bt(L, 'monthly')}
              </button>
              <button
                onClick={() => setInterval('yearly')}
                className={`px-4 py-1.5 text-sm rounded-full transition inline-flex items-center gap-2 ${interval === 'yearly' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {bt(L, 'yearly')}
                <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                  {bt(L, 'yearlyBadge')}
                </span>
              </button>
            </div>
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
                <Card key={plan.id} className={`relative overflow-hidden transition hover:shadow-lg ${isCurrent ? 'ring-2 ring-primary border-primary/40' : ''}`}>
                  {isCurrent && (
                    <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-primary via-fuchsia-500 to-sky-500" />
                  )}
                  {isCurrent && (
                    <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                      <Badge className="bg-primary text-primary-foreground">
                        {bt(L, 'current')}
                      </Badge>
                    </div>
                  )}
                  <CardHeader>
                    <CardTitle>{planName}</CardTitle>
                    {planDescription ? <CardDescription>{planDescription}</CardDescription> : null}
                    <div className="pt-2">
                      <span className="text-3xl font-bold text-foreground">
                        {price === 0 ? bt(L, 'free') : formatPrice(price, currency)}
                      </span>
                      {price > 0 && (
                        <span className="text-muted-foreground text-sm">
                          {interval === 'monthly' ? bt(L, 'perMo') : bt(L, 'perYr')}
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
                        {bt(L, 'upgrade')}
                      </Button>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </TabsContent>

        <TabsContent value="payments" className="mt-5">
          {payments.length === 0 ? (
            <Card><CardContent className="py-8 text-center text-muted-foreground">
              <CreditCard className="w-8 h-8 mx-auto mb-2 opacity-40" />
              <p>{bt(L, 'noPayments')}</p>
            </CardContent></Card>
          ) : (
            <Card>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{bt(L, 'date')}</TableHead>
                    <TableHead>{bt(L, 'amount')}</TableHead>
                    <TableHead>{bt(L, 'status')}</TableHead>
                    <TableHead>{bt(L, 'provider')}</TableHead>
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
