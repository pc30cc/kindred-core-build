import { useTranslation } from '@/i18n';

export default function BillingPage() {
  const { t } = useTranslation();
  return (
    <div className="space-y-4 animate-fade-in">
      <h1 className="text-2xl font-bold text-foreground">{t('nav.billing')}</h1>
      <p className="text-muted-foreground">Manage your subscription and billing.</p>
    </div>
  );
}
