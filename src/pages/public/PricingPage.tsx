import { useTranslation } from '@/i18n';

export default function PricingPage() {
  const { t } = useTranslation();
  return (
    <div className="container py-20">
      <h1 className="text-4xl font-bold text-foreground mb-6">{t('public.pricing')}</h1>
      <p className="text-muted-foreground text-lg max-w-2xl">
        Simple, transparent pricing for teams of all sizes.
      </p>
    </div>
  );
}
