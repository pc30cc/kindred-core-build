import { useTranslation } from '@/i18n';

export default function SettingsGeneralPage() {
  const { t } = useTranslation();
  return (
    <div className="space-y-4 animate-fade-in">
      <h1 className="text-2xl font-bold text-foreground">{t('settings.general')}</h1>
      <p className="text-muted-foreground">Workspace general settings, default locale, and feature toggles.</p>
    </div>
  );
}
