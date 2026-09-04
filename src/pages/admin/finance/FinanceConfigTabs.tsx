/**
 * Super-admin — unified billing configuration surfaces.
 *
 * Currencies, exchange rates, payment gateways, tax rates, coupons and metered
 * usage items. Every mutation goes to /api/admin/billing; nothing here decides
 * money, it only edits the platform's commercial configuration.
 */
import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger } from '@/components/ui/dialog';
import { Plus, Trash2, Save } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslation } from '@/i18n';
import {
  adminBillingApi,
  type AdminCurrency,
  type AdminGateway,
  type AdminTaxRate,
  type AdminCoupon,
  type AdminUsageItem,
  type AdminExchangeRate,
} from '@/lib/adminBillingApi';

const DICT = {
  fa: {
    currencies: 'ارزها', currencyCode: 'کد', name: 'نام', symbol: 'نماد', decimals: 'اعشار',
    base: 'ارز پایه', active: 'فعال', actions: '', add: 'افزودن', save: 'ذخیره', remove: 'حذف',
    rates: 'نرخ تبدیل', from: 'از', to: 'به', rate: 'نرخ', publish: 'ثبت نرخ', date: 'تاریخ',
    gateways: 'درگاه‌های پرداخت', provider: 'درگاه', allowedCurrencies: 'ارزهای مجاز',
    test: 'تست', notImplemented: 'بدون پیاده‌سازی', order: 'ترتیب',
    tax: 'مالیات', taxName: 'عنوان', percent: 'درصد', country: 'کشور', currency: 'ارز',
    coupons: 'کوپن‌های تخفیف', code: 'کد', type: 'نوع', value: 'مقدار', used: 'استفاده‌شده',
    expires: 'انقضا', percentOff: 'درصدی', fixedOff: 'مبلغ ثابت', maxUses: 'حداکثر استفاده',
    usage: 'آیتم‌های مصرفی', unit: 'واحد', prices: 'قیمت هر ارز',
    saved: 'ذخیره شد', failed: 'انجام نشد', empty: 'موردی ثبت نشده است',
    newCurrency: 'ارز جدید', newTax: 'نرخ مالیات جدید', newCoupon: 'کوپن جدید',
  },
  en: {
    currencies: 'Currencies', currencyCode: 'Code', name: 'Name', symbol: 'Symbol', decimals: 'Decimals',
    base: 'Base', active: 'Active', actions: '', add: 'Add', save: 'Save', remove: 'Delete',
    rates: 'Exchange rates', from: 'From', to: 'To', rate: 'Rate', publish: 'Publish', date: 'Date',
    gateways: 'Payment gateways', provider: 'Gateway', allowedCurrencies: 'Allowed currencies',
    test: 'Test', notImplemented: 'Not implemented', order: 'Order',
    tax: 'Tax', taxName: 'Name', percent: 'Percent', country: 'Country', currency: 'Currency',
    coupons: 'Coupons', code: 'Code', type: 'Type', value: 'Value', used: 'Used',
    expires: 'Expires', percentOff: 'Percent', fixedOff: 'Fixed amount', maxUses: 'Max uses',
    usage: 'Metered items', unit: 'Unit', prices: 'Price per currency',
    saved: 'Saved', failed: 'Failed', empty: 'Nothing configured yet',
    newCurrency: 'New currency', newTax: 'New tax rate', newCoupon: 'New coupon',
  },
  tr: {
    currencies: 'Para birimleri', currencyCode: 'Kod', name: 'Ad', symbol: 'Sembol', decimals: 'Ondalık',
    base: 'Ana', active: 'Aktif', actions: '', add: 'Ekle', save: 'Kaydet', remove: 'Sil',
    rates: 'Kur', from: 'Kaynak', to: 'Hedef', rate: 'Kur', publish: 'Yayınla', date: 'Tarih',
    gateways: 'Ödeme sağlayıcıları', provider: 'Sağlayıcı', allowedCurrencies: 'İzinli para birimleri',
    test: 'Test', notImplemented: 'Uygulanmadı', order: 'Sıra',
    tax: 'Vergi', taxName: 'Ad', percent: 'Yüzde', country: 'Ülke', currency: 'Para birimi',
    coupons: 'Kuponlar', code: 'Kod', type: 'Tür', value: 'Değer', used: 'Kullanım',
    expires: 'Bitiş', percentOff: 'Yüzde', fixedOff: 'Sabit tutar', maxUses: 'Azami kullanım',
    usage: 'Kullanım kalemleri', unit: 'Birim', prices: 'Para birimi başına fiyat',
    saved: 'Kaydedildi', failed: 'Başarısız', empty: 'Henüz kayıt yok',
    newCurrency: 'Yeni para birimi', newTax: 'Yeni vergi oranı', newCoupon: 'Yeni kupon',
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

// ─── Currencies + exchange rates ───────────────────────────────────────────

export function CurrenciesTab() {
  const { d, locale } = useDict();
  const [loading, setLoading] = useState(true);
  const [currencies, setCurrencies] = useState<AdminCurrency[]>([]);
  const [rates, setRates] = useState<AdminExchangeRate[]>([]);
  const [draft, setDraft] = useState({ code: '', name: '', symbol: '', minor_units: 2 });
  const [rateDraft, setRateDraft] = useState({ base_code: '', quote_code: '', rate: '' });

  const load = async () => {
    setLoading(true);
    try {
      const [c, r] = await Promise.all([adminBillingApi.currencies(), adminBillingApi.exchangeRates()]);
      setCurrencies(c.currencies);
      setRates(r.rates);
    } catch {
      toast.error(d.failed);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const patch = async (code: string, changes: Partial<AdminCurrency>) => {
    try {
      await adminBillingApi.saveCurrency({ code, ...changes });
      toast.success(d.saved);
      void load();
    } catch { toast.error(d.failed); }
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle>{d.currencies}</CardTitle>
          <Dialog>
            <DialogTrigger asChild>
              <Button size="sm" className="gap-2"><Plus className="w-4 h-4" />{d.add}</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader><DialogTitle>{d.newCurrency}</DialogTitle></DialogHeader>
              <div className="space-y-3">
                <div><Label>{d.currencyCode}</Label><Input value={draft.code} maxLength={3}
                  onChange={(e) => setDraft({ ...draft, code: e.target.value.toUpperCase() })} /></div>
                <div><Label>{d.name}</Label><Input value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></div>
                <div><Label>{d.symbol}</Label><Input value={draft.symbol}
                  onChange={(e) => setDraft({ ...draft, symbol: e.target.value })} /></div>
                <div><Label>{d.decimals}</Label><Input type="number" min={0} max={4} value={draft.minor_units}
                  onChange={(e) => setDraft({ ...draft, minor_units: Number(e.target.value) })} /></div>
              </div>
              <DialogFooter>
                <Button onClick={async () => {
                  try {
                    await adminBillingApi.saveCurrency({
                      code: draft.code,
                      display_name: { [locale]: draft.name || draft.code },
                      symbol: draft.symbol,
                      minor_units: draft.minor_units,
                      is_active: true,
                    });
                    toast.success(d.saved);
                    setDraft({ code: '', name: '', symbol: '', minor_units: 2 });
                    void load();
                  } catch { toast.error(d.failed); }
                }}>{d.save}</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </CardHeader>
        <CardContent>
          {loading ? <TableSkeleton /> : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{d.currencyCode}</TableHead>
                  <TableHead>{d.name}</TableHead>
                  <TableHead>{d.symbol}</TableHead>
                  <TableHead>{d.decimals}</TableHead>
                  <TableHead>{d.base}</TableHead>
                  <TableHead>{d.active}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {currencies.map((c) => (
                  <TableRow key={c.code}>
                    <TableCell className="font-mono font-medium">{c.code}</TableCell>
                    <TableCell>{c.display_name?.[locale] || c.display_name?.en || '—'}</TableCell>
                    <TableCell>{c.symbol}</TableCell>
                    <TableCell>{c.minor_units}</TableCell>
                    <TableCell>
                      <Switch checked={c.is_base} onCheckedChange={(v) => v && patch(c.code, { is_base: true })} />
                    </TableCell>
                    <TableCell>
                      <Switch checked={c.is_active} onCheckedChange={(v) => patch(c.code, { is_active: v })} />
                    </TableCell>
                    <TableCell className="text-end">
                      {!c.is_base && (
                        <Button variant="ghost" size="icon" onClick={async () => {
                          try { await adminBillingApi.deleteCurrency(c.code); void load(); }
                          catch { toast.error(d.failed); }
                        }}><Trash2 className="w-4 h-4 text-destructive" /></Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{d.rates}</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-28"><Label>{d.from}</Label>
              <Input value={rateDraft.base_code} maxLength={3}
                onChange={(e) => setRateDraft({ ...rateDraft, base_code: e.target.value.toUpperCase() })} /></div>
            <div className="w-28"><Label>{d.to}</Label>
              <Input value={rateDraft.quote_code} maxLength={3}
                onChange={(e) => setRateDraft({ ...rateDraft, quote_code: e.target.value.toUpperCase() })} /></div>
            <div className="w-40"><Label>{d.rate}</Label>
              <Input value={rateDraft.rate} inputMode="decimal"
                onChange={(e) => setRateDraft({ ...rateDraft, rate: e.target.value })} /></div>
            <Button className="gap-2" onClick={async () => {
              try {
                await adminBillingApi.publishRate({
                  base_code: rateDraft.base_code,
                  quote_code: rateDraft.quote_code,
                  rate: Number(rateDraft.rate),
                });
                setRateDraft({ base_code: '', quote_code: '', rate: '' });
                toast.success(d.saved);
                void load();
              } catch { toast.error(d.failed); }
            }}><Save className="w-4 h-4" />{d.publish}</Button>
          </div>
          {loading ? <TableSkeleton rows={2} /> : rates.length === 0 ? (
            <p className="text-sm text-muted-foreground">{d.empty}</p>
          ) : (
            <Table>
              <TableHeader><TableRow>
                <TableHead>{d.from}</TableHead><TableHead>{d.to}</TableHead>
                <TableHead>{d.rate}</TableHead><TableHead>{d.date}</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {rates.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-mono">{r.base_code}</TableCell>
                    <TableCell className="font-mono">{r.quote_code}</TableCell>
                    <TableCell>{r.rate}</TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {new Date(r.effective_at).toLocaleString(locale === 'fa' ? 'fa-IR' : locale)}
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

// ─── Gateways ──────────────────────────────────────────────────────────────

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
  );
}

// ─── Tax + coupons ─────────────────────────────────────────────────────────

export function TaxCouponsTab() {
  const { d, locale } = useDict();
  const [loading, setLoading] = useState(true);
  const [taxRates, setTaxRates] = useState<AdminTaxRate[]>([]);
  const [coupons, setCoupons] = useState<AdminCoupon[]>([]);
  const [taxDraft, setTaxDraft] = useState({ name: '', rate_percent: 0, country_code: '', currency: '' });
  const [couponDraft, setCouponDraft] = useState({
    code: '', discount_type: 'percent' as 'percent' | 'fixed', percent_off: 10,
    amount_off_minor: 0, currency: 'IRR', max_redemptions: '', expires_at: '',
  });

  const load = async () => {
    setLoading(true);
    try {
      const [t, c] = await Promise.all([adminBillingApi.taxRates(), adminBillingApi.coupons()]);
      setTaxRates(t.taxRates);
      setCoupons(c.coupons);
    } catch { toast.error(d.failed); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle>{d.tax}</CardTitle>
          <Dialog>
            <DialogTrigger asChild><Button size="sm" className="gap-2"><Plus className="w-4 h-4" />{d.add}</Button></DialogTrigger>
            <DialogContent>
              <DialogHeader><DialogTitle>{d.newTax}</DialogTitle></DialogHeader>
              <div className="space-y-3">
                <div><Label>{d.taxName}</Label><Input value={taxDraft.name}
                  onChange={(e) => setTaxDraft({ ...taxDraft, name: e.target.value })} /></div>
                <div><Label>{d.percent}</Label><Input type="number" min={0} max={100} value={taxDraft.rate_percent}
                  onChange={(e) => setTaxDraft({ ...taxDraft, rate_percent: Number(e.target.value) })} /></div>
                <div><Label>{d.country}</Label><Input maxLength={2} value={taxDraft.country_code}
                  onChange={(e) => setTaxDraft({ ...taxDraft, country_code: e.target.value.toUpperCase() })} /></div>
                <div><Label>{d.currency}</Label><Input maxLength={3} value={taxDraft.currency}
                  onChange={(e) => setTaxDraft({ ...taxDraft, currency: e.target.value.toUpperCase() })} /></div>
              </div>
              <DialogFooter>
                <Button onClick={async () => {
                  try {
                    await adminBillingApi.saveTaxRate({
                      name: taxDraft.name,
                      rate_percent: taxDraft.rate_percent,
                      country_code: taxDraft.country_code || null,
                      currency: taxDraft.currency || null,
                      is_active: true,
                    });
                    setTaxDraft({ name: '', rate_percent: 0, country_code: '', currency: '' });
                    toast.success(d.saved);
                    void load();
                  } catch { toast.error(d.failed); }
                }}>{d.save}</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </CardHeader>
        <CardContent>
          {loading ? <TableSkeleton rows={2} /> : taxRates.length === 0 ? (
            <p className="text-sm text-muted-foreground">{d.empty}</p>
          ) : (
            <Table>
              <TableHeader><TableRow>
                <TableHead>{d.taxName}</TableHead><TableHead>{d.percent}</TableHead>
                <TableHead>{d.country}</TableHead><TableHead>{d.currency}</TableHead>
                <TableHead>{d.active}</TableHead><TableHead />
              </TableRow></TableHeader>
              <TableBody>
                {taxRates.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell>{t.name}</TableCell>
                    <TableCell>{t.rate_percent}%</TableCell>
                    <TableCell>{t.country_code || '—'}</TableCell>
                    <TableCell>{t.currency || '—'}</TableCell>
                    <TableCell>
                      <Switch checked={t.is_active} onCheckedChange={async (v) => {
                        try {
                          await adminBillingApi.saveTaxRate({ ...t, is_active: v });
                          void load();
                        } catch { toast.error(d.failed); }
                      }} />
                    </TableCell>
                    <TableCell className="text-end">
                      <Button variant="ghost" size="icon" onClick={async () => {
                        try { await adminBillingApi.deleteTaxRate(t.id); void load(); }
                        catch { toast.error(d.failed); }
                      }}><Trash2 className="w-4 h-4 text-destructive" /></Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle>{d.coupons}</CardTitle>
          <Dialog>
            <DialogTrigger asChild><Button size="sm" className="gap-2"><Plus className="w-4 h-4" />{d.add}</Button></DialogTrigger>
            <DialogContent>
              <DialogHeader><DialogTitle>{d.newCoupon}</DialogTitle></DialogHeader>
              <div className="space-y-3">
                <div><Label>{d.code}</Label><Input value={couponDraft.code}
                  onChange={(e) => setCouponDraft({ ...couponDraft, code: e.target.value.toUpperCase() })} /></div>
                <div className="flex items-center gap-3">
                  <Switch checked={couponDraft.discount_type === 'fixed'}
                    onCheckedChange={(v) => setCouponDraft({ ...couponDraft, discount_type: v ? 'fixed' : 'percent' })} />
                  <span className="text-sm">{couponDraft.discount_type === 'fixed' ? d.fixedOff : d.percentOff}</span>
                </div>
                {couponDraft.discount_type === 'percent' ? (
                  <div><Label>{d.percent}</Label><Input type="number" min={1} max={100} value={couponDraft.percent_off}
                    onChange={(e) => setCouponDraft({ ...couponDraft, percent_off: Number(e.target.value) })} /></div>
                ) : (
                  <>
                    <div><Label>{d.value}</Label><Input type="number" min={1} value={couponDraft.amount_off_minor}
                      onChange={(e) => setCouponDraft({ ...couponDraft, amount_off_minor: Number(e.target.value) })} /></div>
                    <div><Label>{d.currency}</Label><Input maxLength={3} value={couponDraft.currency}
                      onChange={(e) => setCouponDraft({ ...couponDraft, currency: e.target.value.toUpperCase() })} /></div>
                  </>
                )}
                <div><Label>{d.maxUses}</Label><Input type="number" min={1} value={couponDraft.max_redemptions}
                  onChange={(e) => setCouponDraft({ ...couponDraft, max_redemptions: e.target.value })} /></div>
                <div><Label>{d.expires}</Label><Input type="date" value={couponDraft.expires_at}
                  onChange={(e) => setCouponDraft({ ...couponDraft, expires_at: e.target.value })} /></div>
              </div>
              <DialogFooter>
                <Button onClick={async () => {
                  try {
                    await adminBillingApi.saveCoupon({
                      code: couponDraft.code,
                      discount_type: couponDraft.discount_type,
                      percent_off: couponDraft.discount_type === 'percent' ? couponDraft.percent_off : null,
                      amount_off_minor: couponDraft.discount_type === 'fixed' ? couponDraft.amount_off_minor : null,
                      currency: couponDraft.discount_type === 'fixed' ? couponDraft.currency : null,
                      max_redemptions: couponDraft.max_redemptions ? Number(couponDraft.max_redemptions) : null,
                      expires_at: couponDraft.expires_at ? new Date(couponDraft.expires_at).toISOString() : null,
                      is_active: true,
                    });
                    setCouponDraft({ ...couponDraft, code: '' });
                    toast.success(d.saved);
                    void load();
                  } catch { toast.error(d.failed); }
                }}>{d.save}</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </CardHeader>
        <CardContent>
          {loading ? <TableSkeleton rows={2} /> : coupons.length === 0 ? (
            <p className="text-sm text-muted-foreground">{d.empty}</p>
          ) : (
            <Table>
              <TableHeader><TableRow>
                <TableHead>{d.code}</TableHead><TableHead>{d.type}</TableHead>
                <TableHead>{d.value}</TableHead><TableHead>{d.used}</TableHead>
                <TableHead>{d.expires}</TableHead><TableHead>{d.active}</TableHead><TableHead />
              </TableRow></TableHeader>
              <TableBody>
                {coupons.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-mono font-medium">{c.code}</TableCell>
                    <TableCell>{c.discount_type === 'percent' ? d.percentOff : d.fixedOff}</TableCell>
                    <TableCell>
                      {c.discount_type === 'percent'
                        ? `${c.percent_off}%`
                        : formatMoney(c.amount_off_minor ?? 0, c.currency, locale === 'fa' ? 'fa-IR' : locale)}
                    </TableCell>
                    <TableCell>{c.redeemed_count}{c.max_redemptions ? ` / ${c.max_redemptions}` : ''}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {c.expires_at ? new Date(c.expires_at).toLocaleDateString(locale === 'fa' ? 'fa-IR' : locale) : '—'}
                    </TableCell>
                    <TableCell>
                      <Switch checked={c.is_active} onCheckedChange={async (v) => {
                        try { await adminBillingApi.saveCoupon({ id: c.id, is_active: v }); void load(); }
                        catch { toast.error(d.failed); }
                      }} />
                    </TableCell>
                    <TableCell className="text-end">
                      <Button variant="ghost" size="icon" onClick={async () => {
                        try { await adminBillingApi.deleteCoupon(c.id); void load(); }
                        catch { toast.error(d.failed); }
                      }}><Trash2 className="w-4 h-4 text-destructive" /></Button>
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

// ─── Metered usage items ───────────────────────────────────────────────────

export function UsageItemsTab() {
  const { d, locale } = useDict();
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<AdminUsageItem[]>([]);

  const load = async () => {
    setLoading(true);
    try { setItems((await adminBillingApi.usageItems()).usageItems); }
    catch { toast.error(d.failed); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  return (
    <Card>
      <CardHeader><CardTitle>{d.usage}</CardTitle><CardDescription>{d.prices}</CardDescription></CardHeader>
      <CardContent>
        {loading ? <TableSkeleton rows={3} /> : (
          <Table>
            <TableHeader><TableRow>
              <TableHead>{d.name}</TableHead><TableHead>{d.unit}</TableHead>
              <TableHead>{d.prices}</TableHead><TableHead>{d.active}</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow key={item.key}>
                  <TableCell>
                    <div className="font-medium">{item.display_name?.[locale] || item.key}</div>
                    <div className="text-xs text-muted-foreground font-mono">{item.key}</div>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{item.unit}</TableCell>
                  <TableCell>
                    <Input
                      className="max-w-[320px] font-mono text-xs"
                      defaultValue={JSON.stringify(item.prices)}
                      onBlur={async (e) => {
                        try {
                          const prices = JSON.parse(e.target.value);
                          await adminBillingApi.saveUsageItem({ key: item.key, prices });
                          toast.success(d.saved);
                          void load();
                        } catch { toast.error(d.failed); }
                      }}
                    />
                  </TableCell>
                  <TableCell>
                    <Switch checked={item.is_active} onCheckedChange={async (v) => {
                      try { await adminBillingApi.saveUsageItem({ key: item.key, is_active: v }); void load(); }
                      catch { toast.error(d.failed); }
                    }} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
