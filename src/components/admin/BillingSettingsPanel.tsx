/**
 * Super Admin → Plans → Billing settings (simple billing): the seller printed
 * on receipts, VAT per currency and the receipt number prefix, for the
 * edition this deployment runs (server/routes/adminSimpleBilling.ts). An empty
 * VAT is not shown anywhere; with Paddle it stays empty, because Paddle adds
 * the tax itself.
 *
 * It reads and saves through the shared settings query
 * (src/lib/adminSimpleBillingApi.ts), so the plan form's read-only VAT line
 * shows a saved VAT at once. The AI credit packs of the same settings row are
 * edited next to it (AiPacksPanel); a save here leaves them as they are.
 */
import { useEffect, useState } from 'react';
import { Loader2, Receipt } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/lib/toast';
import { useSaveSimpleBillingSettings, useSimpleBillingSettings, type SimpleBillingSettings } from '@/lib/adminSimpleBillingApi';
import { parsePlanPriceInput } from '@/lib/planPrice';
import { useTranslation, type TranslationKey } from '@/i18n';
import { SELLER_KEYS, type SellerKey, type SellerProfile } from '../../../shared/simpleBilling';
import type { Edition } from '../../../shared/edition';

interface Settings {
  edition: Edition;
  seller: SellerProfile;
  vat_percent: Record<string, number | null>;
  receipt_prefix: string;
  vat_currencies: string[];
}

const SELLER_FIELDS: Record<Edition, readonly SellerKey[]> = {
  iran: ['legal_name', 'economic_code', 'national_id', 'registration_number', 'address', 'postal_code', 'phone', 'email', 'website'],
  international: ['legal_name', 'vat_id', 'registration_number', 'address', 'postal_code', 'phone', 'email', 'website'],
};

/** The editable part of the settings answer, with VAT as typed. */
function draftOf(s: SimpleBillingSettings): { settings: Settings; vat: Record<string, string> } {
  return {
    settings: { edition: s.edition, seller: s.seller as SellerProfile, vat_percent: s.vat_percent, receipt_prefix: s.receipt_prefix, vat_currencies: s.vat_currencies },
    vat: Object.fromEntries(s.vat_currencies.map((c) => [c, s.vat_percent[c] === null || s.vat_percent[c] === undefined ? '' : String(s.vat_percent[c])])),
  };
}

export default function BillingSettingsPanel() {
  const { t, dir } = useTranslation();
  const loaded = useSimpleBillingSettings();
  const saveSettings = useSaveSimpleBillingSettings();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [vatDraft, setVatDraft] = useState<Record<string, string>>({});
  const saving = saveSettings.isPending;

  // Seeded once from the first answer; later refetches never overwrite what is being typed.
  useEffect(() => {
    if (!loaded.data || settings) return;
    const draft = draftOf(loaded.data);
    setSettings(draft.settings);
    setVatDraft(draft.vat);
  }, [loaded.data, settings]);

  if (loaded.error && !settings) return <p className="text-sm text-destructive">{(loaded.error as Error).message}</p>;
  if (!settings) return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;

  const vatLabel = (currency: string) => t(`admin.simpleBilling.vatFor.${currency}` as TranslationKey);
  // Persian/Arabic digits and a decimal comma are read as typed (۱۰, 18,5).
  const vatValue = (raw: string): number | null => {
    if (!raw.trim()) return null;
    const n = parsePlanPriceInput(raw);
    return n !== null && n >= 0 && n < 100 ? n : Number.NaN;
  };
  const vatInvalid = (raw: string) => Number.isNaN(vatValue(raw) as number);

  const save = async () => {
    if (Object.values(vatDraft).some(vatInvalid)) {
      toast.error(t('admin.simpleBilling.vatInvalid'));
      return;
    }
    try {
      const next = await saveSettings.mutateAsync({
        seller: settings.seller as Record<string, string>,
        receipt_prefix: settings.receipt_prefix,
        vat_percent: Object.fromEntries(
          settings.vat_currencies.map((c) => [c, vatValue(vatDraft[c] ?? '')]),
        ),
      });
      const draft = draftOf(next);
      setSettings(draft.settings);
      setVatDraft(draft.vat);
      toast.success(t('admin.simpleBilling.saved'));
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <Card className="bg-card border-border" dir={dir}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Receipt className="h-4 w-4" aria-hidden /> {t('admin.simpleBilling.title')}
        </CardTitle>
        <CardDescription>{t(`admin.simpleBilling.editing.${settings.edition}` as TranslationKey)}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <section className="space-y-3">
          <h3 className="text-sm font-medium">{t('admin.simpleBilling.vat')}</h3>
          <p className="text-xs text-muted-foreground">{t('admin.simpleBilling.vatHint')}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {settings.vat_currencies.map((currency) => (
              <div key={currency} className="space-y-1.5">
                <Label htmlFor={`vat-${currency}`}>{vatLabel(currency)}</Label>
                <Input
                  id={`vat-${currency}`}
                  dir="ltr"
                  inputMode="decimal"
                  placeholder="—"
                  value={vatDraft[currency] ?? ''}
                  aria-invalid={vatInvalid(vatDraft[currency] ?? '')}
                  onChange={(e) => setVatDraft((d) => ({ ...d, [currency]: e.target.value }))}
                />
              </div>
            ))}
          </div>
        </section>

        <section className="space-y-3">
          <h3 className="text-sm font-medium">{t('admin.simpleBilling.receiptPrefix')}</h3>
          <Input
            className="max-w-[10rem]"
            dir="ltr"
            maxLength={8}
            value={settings.receipt_prefix}
            onChange={(e) => setSettings({ ...settings, receipt_prefix: e.target.value.replace(/[^A-Za-z0-9-]/g, '') })}
          />
        </section>

        <section className="space-y-3">
          <h3 className="text-sm font-medium">{t('admin.simpleBilling.seller')}</h3>
          <p className="text-xs text-muted-foreground">{t('admin.simpleBilling.sellerHint')}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {SELLER_FIELDS[settings.edition].map((key) => (
              <div key={key} className={key === 'address' ? 'space-y-1.5 sm:col-span-2' : 'space-y-1.5'}>
                <Label htmlFor={`seller-${key}`}>{t(`billing.account.profile.fields.${key}` as TranslationKey)}</Label>
                <Input
                  id={`seller-${key}`}
                  maxLength={300}
                  value={settings.seller[key] ?? ''}
                  dir={['legal_name', 'address'].includes(key) ? undefined : 'ltr'}
                  onChange={(e) => setSettings({ ...settings, seller: { ...settings.seller, [key]: e.target.value } })}
                />
              </div>
            ))}
          </div>
        </section>

        <Button onClick={save} disabled={saving || !settings.receipt_prefix}>
          {saving && <Loader2 className="me-2 h-4 w-4 animate-spin" aria-hidden />}
          {t('admin.simpleBilling.save')}
        </Button>
      </CardContent>
    </Card>
  );
}
