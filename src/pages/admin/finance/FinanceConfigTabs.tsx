/**
 * Super-admin — payment gateway configuration.
 *
 * Which gateways are active and which currencies each one may take. Every
 * mutation goes to /api/admin/billing/gateways; nothing here decides money.
 */
import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from 'sonner';
import { useTranslation } from '@/i18n';
import { adminBillingApi, type AdminGateway } from '@/lib/adminBillingApi';
import GatewaysReadinessCard from './GatewaysReadinessCard';

const DICT = {
  fa: {
    active: 'فعال', gateways: 'درگاه‌های پرداخت', provider: 'درگاه', allowedCurrencies: 'ارزهای مجاز',
    test: 'تست', notImplemented: 'بدون پیاده‌سازی', saved: 'ذخیره شد', failed: 'انجام نشد',
  },
  en: {
    active: 'Active', gateways: 'Payment gateways', provider: 'Gateway', allowedCurrencies: 'Allowed currencies',
    test: 'Test', notImplemented: 'Not implemented', saved: 'Saved', failed: 'Failed',
  },
  tr: {
    active: 'Aktif', gateways: 'Ödeme sağlayıcıları', provider: 'Sağlayıcı', allowedCurrencies: 'İzinli para birimleri',
    test: 'Test', notImplemented: 'Uygulanmadı', saved: 'Kaydedildi', failed: 'Başarısız',
  },
} as const;

function useDict() {
  const { locale } = useTranslation();
  const key = (['fa', 'en', 'tr'] as const).includes(locale as never) ? (locale as 'fa' | 'en' | 'tr') : 'en';
  return { d: DICT[key], locale: key };
}

function TableSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  );
}

export function GatewaysTab() {
  const { d, locale } = useDict();
  const [loading, setLoading] = useState(true);
  const [gateways, setGateways] = useState<AdminGateway[]>([]);

  const load = async () => {
    setLoading(true);
    try { setGateways((await adminBillingApi.gateways()).gateways); }
    catch { toast.error(d.failed); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const patch = async (provider_name: string, changes: Partial<AdminGateway>) => {
    try {
      await adminBillingApi.saveGateway({ provider_name, ...changes });
      toast.success(d.saved);
      void load();
    } catch { toast.error(d.failed); }
  };

  return (
    <div className="space-y-6">
    {/* Phase 6: whether each gateway is offered per account currency, refreshed after every change below. */}
    <GatewaysReadinessCard refreshKey={gateways.map((g) => `${g.provider_name}:${g.is_active}:${g.currencies.join('|')}`).join(',')} />
    <Card>
      <CardHeader>
        <CardTitle>{d.gateways}</CardTitle>
        <CardDescription>{d.allowedCurrencies}</CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? <TableSkeleton rows={6} /> : (
          <Table>
            <TableHeader><TableRow>
              <TableHead>{d.provider}</TableHead>
              <TableHead>{d.allowedCurrencies}</TableHead>
              <TableHead>{d.active}</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {gateways.map((g) => (
                <TableRow key={g.provider_name}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{g.display_name?.[locale] || g.provider_name}</span>
                      {g.is_test && <Badge variant="secondary">{d.test}</Badge>}
                      {!g.implemented && <Badge variant="outline">{d.notImplemented}</Badge>}
                    </div>
                    <span className="text-xs text-muted-foreground font-mono">{g.provider_name}</span>
                  </TableCell>
                  <TableCell>
                    <Input
                      defaultValue={g.currencies.join(', ')}
                      className="max-w-[220px]"
                      onBlur={(e) => {
                        const next = e.target.value.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
                        if (next.join(',') !== g.currencies.join(',')) patch(g.provider_name, { currencies: next });
                      }}
                    />
                  </TableCell>
                  <TableCell>
                    <Switch
                      checked={g.is_active}
                      disabled={!g.implemented}
                      onCheckedChange={(v) => patch(g.provider_name, { is_active: v })}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
    </div>
  );
}
