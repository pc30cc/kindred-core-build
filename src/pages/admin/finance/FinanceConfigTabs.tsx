/**
 * Super-admin — payment gateway configuration.
 *
 * Which gateways are active, which currencies each one may take, and the
 * name customers see for it. Every mutation goes to
 * /api/admin/billing/gateways; nothing here decides money.
 */
import { useEffect, useState } from 'react';
import { Pencil } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from 'sonner';
import { useTranslation } from '@/i18n';
import { adminBillingApi, type AdminGateway } from '@/lib/adminBillingApi';
import { gatewayLabel } from '@/pages/app/billing/account/accountUi';
import {
  GATEWAY_NAME_LOCALES, GATEWAY_NAME_MAX, normalizeGatewayDisplayName,
  type GatewayNameLocale, type GatewayNameProblem,
} from '../../../../shared/simpleBillingAdmin';
import GatewaysReadinessCard from './GatewaysReadinessCard';

const DICT = {
  fa: {
    active: 'فعال', gateways: 'درگاه‌های پرداخت', provider: 'درگاه', allowedCurrencies: 'ارزهای مجاز',
    test: 'تست', notImplemented: 'بدون پیاده‌سازی', saved: 'ذخیره شد', failed: 'انجام نشد',
    editName: 'تغییر عنوان نمایشی', nameTitle: 'عنوان نمایشی درگاه',
    nameHint: 'مشتری همین عنوان را در فهرست روش‌های پرداخت می‌بیند، و روی رسید پرداخت‌هایی که از این پس انجام شوند می‌آید. زبانی که خالی بماند عنوان زبان دیگری را نشان می‌دهد (اول انگلیسی، بعد فارسی، بعد ترکی).',
    save: 'ذخیره', cancel: 'انصراف',
    GATEWAY_NAME_REQUIRED: 'دست‌کم یک عنوان لازم است.', GATEWAY_NAME_TOO_LONG: `هر عنوان حداکثر ${GATEWAY_NAME_MAX} نویسه است.`,
    GATEWAY_NAME_LOCALE: 'زبان این عنوان پشتیبانی نمی‌شود.',
    locale: { fa: 'فارسی', en: 'انگلیسی', tr: 'ترکی' },
  },
  en: {
    active: 'Active', gateways: 'Payment gateways', provider: 'Gateway', allowedCurrencies: 'Allowed currencies',
    test: 'Test', notImplemented: 'Not implemented', saved: 'Saved', failed: 'Failed',
    editName: 'Edit display name', nameTitle: 'Gateway display name',
    nameHint: 'Customers see this name in the list of payment methods, and it is printed on the receipt of every payment made from now on. A language left empty shows the name of another language (English first, then Persian, then Turkish).',
    save: 'Save', cancel: 'Cancel',
    GATEWAY_NAME_REQUIRED: 'At least one name is required.', GATEWAY_NAME_TOO_LONG: `Each name is at most ${GATEWAY_NAME_MAX} characters.`,
    GATEWAY_NAME_LOCALE: 'This language is not supported.',
    locale: { fa: 'Persian', en: 'English', tr: 'Turkish' },
  },
  tr: {
    active: 'Aktif', gateways: 'Ödeme sağlayıcıları', provider: 'Sağlayıcı', allowedCurrencies: 'İzinli para birimleri',
    test: 'Test', notImplemented: 'Uygulanmadı', saved: 'Kaydedildi', failed: 'Başarısız',
    editName: 'Görünen adı düzenle', nameTitle: 'Sağlayıcının görünen adı',
    nameHint: 'Müşteriler ödeme yöntemleri listesinde bu adı görür; bundan sonra yapılan her ödemenin makbuzunda da bu ad yer alır. Boş bırakılan bir dil başka bir dilin adını gösterir (önce İngilizce, sonra Farsça, sonra Türkçe).',
    save: 'Kaydet', cancel: 'Vazgeç',
    GATEWAY_NAME_REQUIRED: 'En az bir ad gerekli.', GATEWAY_NAME_TOO_LONG: `Her ad en fazla ${GATEWAY_NAME_MAX} karakter olabilir.`,
    GATEWAY_NAME_LOCALE: 'Bu dil desteklenmiyor.',
    locale: { fa: 'Farsça', en: 'İngilizce', tr: 'Türkçe' },
  },
} as const;

type Dict = (typeof DICT)[keyof typeof DICT];

function isNameProblem(code: unknown): code is GatewayNameProblem {
  return code === 'GATEWAY_NAME_REQUIRED' || code === 'GATEWAY_NAME_TOO_LONG' || code === 'GATEWAY_NAME_LOCALE';
}

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

/** The names customers see for one gateway, one field per panel language. */
function GatewayNameDialog({
  gateway, d, onClose, onSaved,
}: {
  gateway: AdminGateway | null;
  d: Dict;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [names, setNames] = useState<Record<GatewayNameLocale, string>>({ fa: '', en: '', tr: '' });
  const [problem, setProblem] = useState<GatewayNameProblem | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!gateway) return;
    const current = gateway.display_name ?? {};
    setNames({ fa: current.fa ?? '', en: current.en ?? '', tr: current.tr ?? '' });
    setProblem(null);
  }, [gateway]);

  const save = async () => {
    if (!gateway) return;
    const normalized = normalizeGatewayDisplayName(names);
    if ('problem' in normalized) { setProblem(normalized.problem); return; }
    setBusy(true);
    try {
      await adminBillingApi.saveGateway({ provider_name: gateway.provider_name, display_name: normalized.names });
      toast.success(d.saved);
      onSaved();
      onClose();
    } catch (e) {
      const code = (e as { code?: unknown }).code;
      if (isNameProblem(code)) setProblem(code);
      else toast.error(d.failed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={gateway !== null} onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{d.nameTitle}</DialogTitle>
          <DialogDescription>{d.nameHint}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground font-mono">{gateway?.provider_name}</p>
          {GATEWAY_NAME_LOCALES.map((code) => (
            <div key={code} className="space-y-1">
              <Label htmlFor={`gateway-name-${code}`}>{d.locale[code]}</Label>
              <Input
                id={`gateway-name-${code}`}
                dir={code === 'fa' ? 'rtl' : 'ltr'}
                maxLength={GATEWAY_NAME_MAX * 2}
                value={names[code]}
                disabled={busy}
                onChange={(e) => { setNames((prev) => ({ ...prev, [code]: e.target.value })); setProblem(null); }}
              />
            </div>
          ))}
          {problem && <p role="alert" className="text-sm text-destructive">{d[problem]}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>{d.cancel}</Button>
          <Button onClick={() => void save()} disabled={busy}>{d.save}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function GatewaysTab() {
  const { d, locale } = useDict();
  const [loading, setLoading] = useState(true);
  const [gateways, setGateways] = useState<AdminGateway[]>([]);
  const [naming, setNaming] = useState<AdminGateway | null>(null);

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
    <GatewaysReadinessCard refreshKey={gateways.map((g) => `${g.provider_name}:${g.is_active}:${g.currencies.join('|')}:${JSON.stringify(g.display_name ?? {})}`).join(',')} />
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
                      <span className="font-medium">{gatewayLabel(g.display_name, g.provider_name, locale)}</span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        aria-label={d.editName}
                        title={d.editName}
                        onClick={() => setNaming(g)}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
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
    <GatewayNameDialog gateway={naming} d={d} onClose={() => setNaming(null)} onSaved={() => void load()} />
    </div>
  );
}
