import { useTranslation } from '@/i18n';

export default function ContactPage() {
  const { t } = useTranslation();
  return (
    <div className="container py-20">
      <h1 className="text-4xl font-bold text-foreground mb-6">{t('public.contact')}</h1>
      <p className="text-muted-foreground text-lg max-w-2xl">
        Get in touch with our team.
      </p>
    </div>
  );
}
