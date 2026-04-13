import { useTranslation } from '@/i18n';

export default function SettingsTranslationsPage() {
  const { t } = useTranslation();
  return (
    <div className="space-y-4 animate-fade-in">
      <h1 className="text-2xl font-bold text-foreground">{t('settings.translations')}</h1>
      <p className="text-muted-foreground">Manage translations and locale settings.</p>
    </div>
  );
}
