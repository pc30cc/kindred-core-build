import { useTranslation } from '@/i18n';

export default function SettingsBrandingPage() {
  const { t } = useTranslation();
  return (
    <div className="space-y-4 animate-fade-in">
      <h1 className="text-2xl font-bold text-foreground">{t('settings.branding')}</h1>
      <p className="text-muted-foreground">Platform name, logo, colors, favicon, meta tags, and more.</p>
    </div>
  );
}
