import { useTranslation } from '@/i18n';

export default function TeamPage() {
  const { t } = useTranslation();
  return (
    <div className="space-y-4 animate-fade-in">
      <h1 className="text-2xl font-bold text-foreground">{t('team.title')}</h1>
      <p className="text-muted-foreground">{t('team.noMembers')}</p>
    </div>
  );
}
