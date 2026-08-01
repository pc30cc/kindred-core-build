/**
 * Compact three-state phone badge for super-admin lists.
 * Only ever renders the masked number returned by the backend.
 */
import { Badge } from '@/components/ui/badge';
import { useTranslation } from '@/i18n';
import { PHONE_STATUS_CLASS, PHONE_STATUS_LABEL_KEY, resolvePhoneStatus } from './status';

export function PhoneStatusCell({
  masked,
  verified,
}: {
  masked: string | null | undefined;
  verified: boolean | null | undefined;
}) {
  const { t } = useTranslation();
  const status = resolvePhoneStatus({ phoneMasked: masked, verified });

  return (
    <div className="flex items-center gap-2">
      <Badge variant="outline" className={`text-xs ${PHONE_STATUS_CLASS[status]}`}>
        {t(PHONE_STATUS_LABEL_KEY[status] as never)}
      </Badge>
      {masked && (
        <span className="text-xs text-muted-foreground font-mono" dir="ltr">
          {masked}
        </span>
      )}
    </div>
  );
}
