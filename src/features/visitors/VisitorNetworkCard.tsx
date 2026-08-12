/**
 * VisitorNetworkCard — shared IP/geo panel used by Inbox, Call Center and the
 * Visitors drawer so all of them render the exact same values and the exact
 * same privacy states (locked / masked / raw).
 */
import { Globe, MapPin, Network, Clock, Lock, HelpCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  useVisitorNetwork,
  flagEmoji,
  type VisitorNetworkRef,
  type VisitorNetworkProfile,
} from '@/hooks/useVisitorNetwork';
import { localizedCountryName } from '@/lib/geo/countryLocalization';
import { localizedLocationLabel } from '@/lib/geo/localizedGeo';

interface Props {
  workspaceId: string | undefined;
  /** Omit when `profile` is supplied by a batched list read. */
  reference?: VisitorNetworkRef;
  /**
   * Pre-fetched profile from the batch endpoint. When provided the card does
   * NOT fetch — this is how list surfaces avoid one request per row.
   */
  profile?: VisitorNetworkProfile | null;
  /** Render an explicit "unknown" state instead of nothing when there's no data. */
  showUnknown?: boolean;
  t: (k: string) => string | undefined;
  dir?: 'rtl' | 'ltr';
  /** Active UI locale — drives country/city localization. Defaults to 'en' (canonical). */
  locale?: string;
  className?: string;
}

function Row({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 px-3 py-2.5">
      <span className="text-primary shrink-0">{icon}</span>
      <span className="text-[11.5px] text-muted-foreground shrink-0">{label}</span>
      <span className="text-[12.5px] font-medium text-foreground truncate ms-auto">{children}</span>
    </div>
  );
}

export function VisitorNetworkCard({
  workspaceId,
  reference,
  profile,
  showUnknown,
  t,
  dir = 'ltr',
  locale = 'en',
  className,
}: Props) {
  const hasInjected = profile !== undefined;
  const query = useVisitorNetwork(
    hasInjected ? undefined : workspaceId,
    reference ?? { sessionId: null },
  );
  const data = hasInjected ? profile : query.data;
  const isLoading = hasInjected ? false : query.isLoading;

  if (isLoading) return null;
  if (!data) {
    if (!showUnknown) return null;
    return (
      <div
        className={cn(
          'rounded-xl border border-border/50 bg-card/60 px-3 py-2.5 flex items-center gap-2.5',
          className,
        )}
        dir={dir}
      >
        <HelpCircle className="w-4 h-4 text-muted-foreground shrink-0" />
        <span className="text-[12px] text-muted-foreground">
          {t('visitors.networkUnknown') || 'Network location unavailable for this call'}
        </span>
      </div>
    );
  }

  const { ip, geo } = data;
  const place = localizedLocationLabel(geo, locale, ['city', 'region', 'country']) || '—';
  const localizedCountry = localizedCountryName(geo.country_code, locale, geo.country);

  return (
    <div className={cn('rounded-xl border border-border/50 bg-card/60 divide-y divide-border/20', className)} dir={dir}>
      <Row icon={<Network className="w-4 h-4" />} label={t('visitors.ip') || 'IP'}>
        {ip.locked ? (
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            <Lock className="w-3 h-3" />
            {t('plans.upgradeRequired') || 'Upgrade required'}
          </span>
        ) : (
          <bdi dir="ltr" className="tabular-nums">{ip.display || '—'}</bdi>
        )}
      </Row>
      <Row icon={<Globe className="w-4 h-4" />} label={t('visitors.country') || 'Country'}>
        <span>
          {geo.country_code ? `${flagEmoji(geo.country_code)} ` : ''}
          {localizedCountry || '—'}
        </span>
      </Row>
      <Row icon={<MapPin className="w-4 h-4" />} label={t('visitors.location') || 'Location'}>
        <span className={cn(geo.is_fallback && 'text-muted-foreground')}>{place}</span>
      </Row>
      {geo.timezone && (
        <Row icon={<Clock className="w-4 h-4" />} label={t('visitors.timezone') || 'Timezone'}>
          <bdi dir="ltr">{geo.timezone}</bdi>
        </Row>
      )}
    </div>
  );
}

/**
 * Compact one-line variant for dense list rows (Live Queue, Calls list).
 * Always fed from a batched read — it never fetches on its own.
 */
export function VisitorNetworkInline({
  profile,
  t,
  locale = 'en',
  className,
}: {
  profile: VisitorNetworkProfile | null | undefined;
  t: (k: string) => string | undefined;
  /** Active UI locale — drives country/city localization. Defaults to 'en' (canonical). */
  locale?: string;
  className?: string;
}) {
  if (!profile) {
    return (
      <span className={cn('text-[11px] text-muted-foreground', className)}>
        {t('visitors.networkUnknownShort') || 'Location unknown'}
      </span>
    );
  }
  const { ip, geo } = profile;
  const place = localizedLocationLabel(geo, locale, ['city', 'region']);
  const localizedCountry = localizedCountryName(geo.country_code, locale, geo.country);
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-[11px] text-muted-foreground', className)}>
      {geo.country_code && <span>{flagEmoji(geo.country_code)}</span>}
      <span className="truncate">{place || localizedCountry || t('visitors.networkUnknownShort') || 'Location unknown'}</span>
      {!ip.locked && ip.display && (
        <bdi dir="ltr" className="tabular-nums opacity-80">· {ip.display}</bdi>
      )}
    </span>
  );
}
