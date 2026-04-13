import { useTranslation } from '@/i18n';

export default function SettingsProvidersPage() {
  const { t } = useTranslation();
  return (
    <div className="space-y-4 animate-fade-in">
      <h1 className="text-2xl font-bold text-foreground">{t('settings.providers')}</h1>
      <p className="text-muted-foreground">Configure auth, email, AI, storage, and other provider settings.</p>
    </div>
  );
}
