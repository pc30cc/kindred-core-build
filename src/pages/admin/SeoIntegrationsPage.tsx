import { Radar } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { AdminBacklinksProviderCard } from '@/features/providers/AdminBacklinksProviderCard';

export default function AdminSeoIntegrationsPage() {
  const { t } = useTranslation();

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="p-2.5 rounded-xl bg-primary/10 text-primary">
          <Radar className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t('admin.seoIntegrations.title' as any)}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t('admin.seoIntegrations.subtitle' as any)}</p>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <AdminBacklinksProviderCard />
      </div>
    </div>
  );
}
