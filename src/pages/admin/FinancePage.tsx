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
import { CreditCard, Sparkles, FileText } from 'lucide-react';
import { useTranslation } from '@/i18n';
import AdminBillingPage from './BillingPage';
import AdminAiBillingPage from './AiBillingPage';
import AdminAuditLogsPage from './AuditLogsPage';

const TABS = ['billing', 'ai', 'audit'] as const;
type TabKey = (typeof TABS)[number];

export default function AdminFinancePage() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab') as TabKey | null;
  const tab: TabKey = raw && (TABS as readonly string[]).includes(raw) ? raw : 'billing';

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
        <TabsList className="flex w-full flex-wrap justify-start gap-1">
          <TabsTrigger value="billing" className="gap-2">
            <CreditCard className="w-4 h-4" />
            {t('admin.finance.tabs.billing' as never)}
          </TabsTrigger>
          <TabsTrigger value="ai" className="gap-2">
            <Sparkles className="w-4 h-4" />
            {t('admin.finance.tabs.ai' as never)}
          </TabsTrigger>
          <TabsTrigger value="audit" className="gap-2">
            <FileText className="w-4 h-4" />
            {t('admin.finance.tabs.audit' as never)}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="billing" className="mt-0"><AdminBillingPage /></TabsContent>
        <TabsContent value="ai" className="mt-0"><AdminAiBillingPage /></TabsContent>
        <TabsContent value="audit" className="mt-0"><AdminAuditLogsPage /></TabsContent>
      </Tabs>
    </div>
  );
}
