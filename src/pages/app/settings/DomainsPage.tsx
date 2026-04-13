import { useTranslation } from '@/i18n';

export default function SettingsDomainsPage() {
  const { t } = useTranslation();
  return (
    <div className="space-y-4 animate-fade-in">
      <h1 className="text-2xl font-bold text-foreground">{t('settings.domains')}</h1>
      <p className="text-muted-foreground">Manage workspace domains and base URLs.</p>
    </div>
  );
}
