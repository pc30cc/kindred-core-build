import { useTranslation } from '@/i18n';

export default function EmailPage() {
  const { t } = useTranslation();
  return (
    <div className="space-y-4 animate-fade-in">
      <h1 className="text-2xl font-bold text-foreground">{t('email.title')}</h1>
      <p className="text-muted-foreground">Configure email provider, sender identity, and templates.</p>
    </div>
  );
}
