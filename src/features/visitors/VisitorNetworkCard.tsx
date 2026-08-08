/**
 * VisitorNetworkCard — shared IP/geo panel used by Inbox, Call Center and the
 * Visitors drawer so all of them render the exact same values and the exact
 * same privacy states (locked / masked / raw).
 */
import { Globe, MapPin, Network, Clock, Lock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useVisitorNetwork, flagEmoji, type VisitorNetworkRef } from '@/hooks/useVisitorNetwork';

interface Props {
  workspaceId: string | undefined;
  reference: VisitorNetworkRef;
  t: (k: string) => string | undefined;
  dir?: 'rtl' | 'ltr';
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

export function VisitorNetworkCard({ workspaceId, reference, t, dir = 'ltr', className }: Props) {
  const { data, isLoading } = useVisitorNetwork(workspaceId, reference);
  if (isLoading || !data) return null;

  const { ip, geo } = data;
  const place = [geo.city, geo.region, geo.country].filter(Boolean).join('، ') || '—';

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
          {geo.country || '—'}
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
