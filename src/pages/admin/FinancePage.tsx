/**
 * Super Admin — unified Auditing & Finance workspace.
 *
 * Previously the platform exposed three disconnected entries (billing, AI
 * billing, audit logs) that overlapped conceptually. They are now a single
 * section with explicit tabs so an operator always knows where money, AI cost
 * and the change trail live. The underlying pages are unchanged — this page
 * only composes them.
 */
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useSearchParams } from 'react-router-dom';
import {
  CreditCard, Sparkles, FileText, LayoutDashboard, Coins,
  Landmark, Percent, Gauge, Receipt, Users,
} from 'lucide-react';
import { useTranslation } from '@/i18n';
import AdminBillingPage from './BillingPage';
import AdminAiBillingPage from './AiBillingPage';
import AdminAuditLogsPage from './AuditLogsPage';
import { CurrenciesTab, GatewaysTab, TaxCouponsTab, UsageItemsTab } from './finance/FinanceConfigTabs';
import {
  FinanceOverviewTab, InvoicesLedgerTab, PaymentsLedgerTab, CustomersLedgerTab,
} from './finance/FinanceLedgerTabs';

const TABS = [
  'overview', 'billing', 'invoices', 'payments', 'customers',
  'currencies', 'gateways', 'tax', 'usage', 'ai', 'audit',
] as const;
type TabKey = (typeof TABS)[number];

const LABELS: Record<'fa' | 'en' | 'tr', Record<TabKey, string>> = {
  fa: {
    overview: 'نمای کلی', billing: 'پلن‌ها', invoices: 'فاکتورها', payments: 'پرداخت‌ها',
    customers: 'مشتریان', currencies: 'ارزها', gateways: 'درگاه‌ها', tax: 'مالیات و کوپن',
    usage: 'مصرف', ai: 'هوش مصنوعی', audit: 'حسابرسی',
  },
  en: {
    overview: 'Overview', billing: 'Plans', invoices: 'Invoices', payments: 'Payments',
    customers: 'Customers', currencies: 'Currencies', gateways: 'Gateways', tax: 'Tax & coupons',
    usage: 'Usage', ai: 'AI', audit: 'Audit',
  },
  tr: {
    overview: 'Genel', billing: 'Planlar', invoices: 'Faturalar', payments: 'Ödemeler',
    customers: 'Müşteriler', currencies: 'Para birimleri', gateways: 'Sağlayıcılar', tax: 'Vergi & kupon',
    usage: 'Kullanım', ai: 'Yapay zeka', audit: 'Denetim',
  },
};

const ICONS: Record<TabKey, typeof CreditCard> = {
  overview: LayoutDashboard, billing: CreditCard, invoices: Receipt, payments: Landmark,
  customers: Users, currencies: Coins, gateways: CreditCard, tax: Percent,
  usage: Gauge, ai: Sparkles, audit: FileText,
};

export default function AdminFinancePage() {
  const { t, locale } = useTranslation();
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab') as TabKey | null;
  const tab: TabKey = raw && (TABS as readonly string[]).includes(raw) ? raw : 'overview';
  const lang = (['fa', 'en', 'tr'] as const).includes(locale as never) ? (locale as 'fa' | 'en' | 'tr') : 'en';
  const labels = LABELS[lang];

  const setTab = (value: string) => {
    const next = new URLSearchParams(params);
    next.set('tab', value);
    setParams(next, { replace: true });
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t('admin.finance.title' as never)}</h1>
        <p className="text-muted-foreground text-sm mt-1">{t('admin.finance.subtitle' as never)}</p>
      </div>

      <Tabs value={tab} onValueChange={setTab} className="space-y-6">
        <TabsList className="flex w-full flex-wrap justify-start gap-1 h-auto p-1">
          {TABS.map((key) => {
            const Icon = ICONS[key];
            return (
              <TabsTrigger key={key} value={key} className="gap-2">
                <Icon className="w-4 h-4" />
                {labels[key]}
              </TabsTrigger>
            );
          })}
        </TabsList>

        <TabsContent value="overview" className="mt-0"><FinanceOverviewTab /></TabsContent>
        <TabsContent value="billing" className="mt-0"><AdminBillingPage /></TabsContent>
        <TabsContent value="invoices" className="mt-0"><InvoicesLedgerTab /></TabsContent>
        <TabsContent value="payments" className="mt-0"><PaymentsLedgerTab /></TabsContent>
        <TabsContent value="customers" className="mt-0"><CustomersLedgerTab /></TabsContent>
        <TabsContent value="currencies" className="mt-0"><CurrenciesTab /></TabsContent>
        <TabsContent value="gateways" className="mt-0"><GatewaysTab /></TabsContent>
        <TabsContent value="tax" className="mt-0"><TaxCouponsTab /></TabsContent>
        <TabsContent value="usage" className="mt-0"><UsageItemsTab /></TabsContent>
        <TabsContent value="ai" className="mt-0"><AdminAiBillingPage /></TabsContent>
        <TabsContent value="audit" className="mt-0"><AdminAuditLogsPage /></TabsContent>
      </Tabs>
    </div>
  );
}

