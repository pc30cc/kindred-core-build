import { useTranslation } from '@/i18n';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';

export default function VerifyEmailPage() {
  const { t } = useTranslation();
  return (
    <Card>
      <CardHeader className="text-center">
        <CardTitle>{t('auth.verifyEmail')}</CardTitle>
        <CardDescription>{t('auth.checkEmail')}</CardDescription>
      </CardHeader>
    </Card>
  );
}
