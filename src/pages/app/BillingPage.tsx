import { useState, useEffect } from 'react';
import { useTranslation } from '@/i18n';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useWorkspaces } from '@/hooks/useWorkspace';
import { billingGetPlans, billingGetStatus, billingCheckout, billingCancel, billingResume, billingGetPortal, API_BASE } from '@/lib/api';
import { CreditCard, Check, AlertCircle, ArrowRight, Loader2, ExternalLink, Clock, Shield } from 'lucide-react';
import { toast } from 'sonner';
import { PlanUsagePanel } from '@/components/billing/PlanUsagePanel';

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

      <Tabs defaultValue="plans">
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
                    <CardTitle>{plan.name}</CardTitle>
                    <CardDescription>{plan.description}</CardDescription>
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
                    {/* Entitlements */}
                    {Object.entries(plan.entitlements || {}).map(([key, val]) => (
                      <div key={key} className="flex items-center gap-2 text-sm">
                        <Check className={`w-4 h-4 ${val ? 'text-green-500' : 'text-muted-foreground'}`} />
                        <span className={val ? 'text-foreground' : 'text-muted-foreground line-through'}>
                          {key.replace(/_/g, ' ')}
                        </span>
                      </div>
                    ))}
                    {/* Limits */}
                    {Object.entries(plan.limits || {}).map(([key, val]) => (
                      <div key={key} className="flex items-center gap-2 text-sm">
                        <Check className="w-4 h-4 text-primary" />
                        <span className="text-foreground">
                          {(val as number) === -1 ? (locale === 'fa' ? 'نامحدود' : 'Unlimited') : String(val)} {key.replace(/_/g, ' ')}
                        </span>
                      </div>
                    ))}

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
