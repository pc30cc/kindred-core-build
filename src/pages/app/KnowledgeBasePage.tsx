import { useTranslation } from '@/i18n';

export default function KnowledgeBasePage() {
  const { t } = useTranslation();
  return (
    <div className="space-y-4 animate-fade-in">
      <h1 className="text-2xl font-bold text-foreground">{t('knowledgeBase.title')}</h1>
      <p className="text-muted-foreground">{t('knowledgeBase.noArticles')}</p>
    </div>
  );
}
