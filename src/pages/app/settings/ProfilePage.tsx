import { useTranslation } from '@/i18n';

export default function SettingsProfilePage() {
  const { t } = useTranslation();
  return (
    <div className="space-y-4 animate-fade-in">
      <h1 className="text-2xl font-bold text-foreground">{t('settings.profile')}</h1>
      <p className="text-muted-foreground">Manage your personal profile and preferences.</p>
    </div>
  );
}
