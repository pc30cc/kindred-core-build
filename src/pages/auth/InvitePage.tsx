import { useTranslation } from '@/i18n';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

export default function InvitePage() {
  const { t } = useTranslation();
  return (
    <Card>
      <CardHeader className="text-center">
        <CardTitle>{t('auth.inviteTitle')}</CardTitle>
        <CardDescription>{t('auth.inviteSubtitle')}</CardDescription>
      </CardHeader>
      <div className="p-6 pt-0">
        <Button className="w-full">{t('auth.acceptInvite')}</Button>
      </div>
    </Card>
  );
}
