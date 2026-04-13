import { useTranslation } from '@/i18n';

export default function FeaturesPage() {
  const { t } = useTranslation();
  return (
    <div className="container py-20">
      <h1 className="text-4xl font-bold text-foreground mb-6">{t('public.features')}</h1>
      <p className="text-muted-foreground text-lg max-w-2xl">
        Explore the full suite of tools designed to help you engage visitors, manage conversations, and deliver exceptional support.
      </p>
    </div>
  );
}
