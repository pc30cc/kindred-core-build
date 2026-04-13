import { useTranslation } from '@/i18n';

export default function AIPage() {
  const { t } = useTranslation();
  return (
    <div className="space-y-4 animate-fade-in">
      <h1 className="text-2xl font-bold text-foreground">{t('ai.title')}</h1>
      <p className="text-muted-foreground">Configure AI provider, model settings, and prompt templates.</p>
    </div>
  );
}
