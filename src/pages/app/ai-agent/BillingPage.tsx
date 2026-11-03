import Placeholder from './_PlaceholderPage';
import { CreditCard } from 'lucide-react';
import { useTranslation } from '@/i18n';

export default function BillingPage() {
  const { t } = useTranslation();
  return (
    <Placeholder
      icon={CreditCard}
      title={t('aiAgent.adv.billing.title')}
      description={t('aiAgent.adv.billing.description')}
      bullets={[
        t('aiAgent.adv.billing.bullets.usageByRunType'),
        t('aiAgent.adv.billing.bullets.replyCaps'),
        t('aiAgent.adv.billing.bullets.upgradeHints'),
      ]}
    />
  );
}
