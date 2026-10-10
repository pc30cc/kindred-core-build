/** The payment methods the workspace can pay with, as a radio list. */
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { useTranslation } from '@/i18n';
import type { AccountGateway } from '@/lib/accountBillingApi';
import { gatewayLabel } from './accountUi';

export default function GatewayPicker({
  gateways,
  value,
  onChange,
  disabled,
}: {
  gateways: AccountGateway[];
  value: string | undefined;
  onChange: (provider: string) => void;
  disabled?: boolean;
}) {
  const { t, locale, dir } = useTranslation();
  return (
    <div className="space-y-2">
      <Label>{t('billing.account.topup.gateway')}</Label>
      {gateways.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('billing.account.topup.noGateway')}</p>
      ) : (
        <RadioGroup value={value} onValueChange={onChange} className="gap-2" dir={dir}>
          {gateways.map((g) => (
            <Label
              key={g.provider_name}
              htmlFor={`gw-${g.provider_name}`}
              className="flex cursor-pointer items-center gap-3 rounded-md border p-3 font-normal has-[[data-state=checked]]:border-primary"
            >
              <RadioGroupItem id={`gw-${g.provider_name}`} value={g.provider_name} disabled={disabled} />
              <span className="flex-1">{gatewayLabel(g.display_name, g.provider_name, locale)}</span>
              {g.is_test && <Badge variant="secondary">{t('billing.account.topup.testGateway')}</Badge>}
            </Label>
          ))}
        </RadioGroup>
      )}
    </div>
  );
}
