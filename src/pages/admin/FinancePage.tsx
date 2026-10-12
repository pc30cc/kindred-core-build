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
import { CreditCard, Sparkles, FileText, TrendingUp, Wallet } from 'lucide-react';
import { useTranslation } from '@/i18n';
import AdminAiBillingPage from './AiBillingPage';
import AdminAuditLogsPage from './AuditLogsPage';
import RevenueTab from './finance/RevenueTab';
import AccountsTab from './finance/AccountsTab';
import { GatewaysTab } from './finance/FinanceConfigTabs';

/**
 * The simple billing's monthly revenue and accounts (phase 6), gateways, AI
 * cost and the audit trail. Plans are edited in their own page (/admin/plans).
 */
const TABS = ['revenue', 'accounts', 'gateways', 'ai', 'audit'] as const;
type TabKey = (typeof TABS)[number];

const LABELS: Record<'fa' | 'en' | 'tr', Record<TabKey, string>> = {
  fa: { revenue: 'درآمد', accounts: 'حساب‌ها', gateways: 'درگاه‌ها', ai: 'هوش مصنوعی', audit: 'حسابرسی' },
  en: { revenue: 'Revenue', accounts: 'Accounts', gateways: 'Gateways', ai: 'AI', audit: 'Audit' },
  tr: { revenue: 'Gelir', accounts: 'Hesaplar', gateways: 'Sağlayıcılar', ai: 'Yapay zeka', audit: 'Denetim' },
};

const ICONS: Record<TabKey, typeof CreditCard> = {
  revenue: TrendingUp, accounts: Wallet, gateways: CreditCard, ai: Sparkles, audit: FileText,
};

export default function AdminFinancePage() {
  const { t, locale } = useTranslation();
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab') as TabKey | null;
  const tab: TabKey = raw && TABS.includes(raw) ? raw : TABS[0];
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

        <TabsContent value="revenue" className="mt-0"><RevenueTab /></TabsContent>
        <TabsContent value="accounts" className="mt-0"><AccountsTab /></TabsContent>
        <TabsContent value="gateways" className="mt-0"><GatewaysTab /></TabsContent>
        <TabsContent value="ai" className="mt-0"><AdminAiBillingPage /></TabsContent>
        <TabsContent value="audit" className="mt-0"><AdminAuditLogsPage /></TabsContent>
      </Tabs>
    </div>
  );
}

