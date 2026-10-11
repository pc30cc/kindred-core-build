/**
 * Super Admin → Plans → Billing settings (simple billing): the seller printed
 * on receipts, VAT per currency and the receipt number prefix, for the
 * edition this deployment runs (server/routes/adminSimpleBilling.ts). An empty
 * VAT is not shown anywhere; with Paddle it stays empty, because Paddle adds
 * the tax itself.
 *
 * Below it, the edition's billing locks switch (phase 4,
 * server/routes/adminBillingLocks.ts): off by default; its preview lists the
 * workspaces it would lock now, and turning it on asks first.
 */
import { useEffect, useState } from 'react';
import { Eye, Loader2, Lock, Receipt } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/lib/toast';
import { API_BASE } from '@/lib/apiBase';
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

async function call<T>(method: 'GET' | 'PUT', body?: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}/api/admin/simple-billing/settings`, {
    method,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error || `HTTP_${res.status}`);
  return json;
}

export default function BillingSettingsPanel() {
  return (
    <div className="space-y-6">
      <ReceiptSettingsCard />
      <BillingLocksCard />
    </div>
  );
}

function ReceiptSettingsCard() {
  const { t, dir } = useTranslation();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [vatDraft, setVatDraft] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    call<Settings>('GET')
      .then((s) => {
        setSettings(s);
        setVatDraft(Object.fromEntries(s.vat_currencies.map((c) => [c, s.vat_percent[c] === null || s.vat_percent[c] === undefined ? '' : String(s.vat_percent[c])])));
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  if (error && !settings) return <p className="text-sm text-destructive">{error}</p>;
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
    setSaving(true);
    try {
      const next = await call<Settings>('PUT', {
        seller: settings.seller,
        receipt_prefix: settings.receipt_prefix,
        vat_percent: Object.fromEntries(
          settings.vat_currencies.map((c) => [c, vatValue(vatDraft[c] ?? '')]),
        ),
      });
      setSettings(next);
      toast.success(t('admin.simpleBilling.saved'));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
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

// ─── Billing locks (phase 4) ───────────────────────────────────────────────

interface LocksSwitch {
  edition: Edition;
  locks_enabled: boolean;
}

type LockKindCounts = Record<'kb_article' | 'contact' | 'member' | 'conversation', number>;

interface LocksPreview extends LocksSwitch {
  scanned: number;
  truncated: boolean;
  failed: number;
  workspaces_locking: number;
  totals: LockKindCounts;
  workspaces: Array<{ workspace_id: string; name: string | null; plan_id: string } & LockKindCounts>;
  x_channel_stops: Array<{ workspace_id: string; name: string | null }>;
}

const LOCK_COLUMNS = ['kb_article', 'contact', 'member', 'conversation'] as const;
/** Workspaces listed in the preview table (the rest are in the totals). */
const PREVIEW_ROWS = 50;

async function locksCall<T>(path: '' | '/preview', method: 'GET' | 'PUT' = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}/api/admin/billing/locks${path}`, {
    method,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error || `HTTP_${res.status}`);
  return json;
}

export function BillingLocksCard() {
  const { t, dir, locale } = useTranslation();
  const [state, setState] = useState<LocksSwitch | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<LocksPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [confirm, setConfirm] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const n = (value: number) => new Intl.NumberFormat(locale).format(value);

  useEffect(() => {
    locksCall<LocksSwitch>('')
      .then(setState)
      .catch((e: Error) => setError(e.message));
  }, []);

  const runPreview = async () => {
    setPreviewing(true);
    try {
      setPreview(await locksCall<LocksPreview>('/preview'));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setPreviewing(false);
    }
  };

  const save = async (enabled: boolean) => {
    setSaving(true);
    try {
      const next = await locksCall<LocksSwitch>('', 'PUT', { enabled });
      setState(next);
      setPreview((p) => (p ? { ...p, locks_enabled: next.locks_enabled } : p));
      toast.success(t(next.locks_enabled ? 'admin.billingLocks.savedOn' : 'admin.billingLocks.savedOff'));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
      setConfirm(null);
    }
  };

  if (error && !state) return <p className="text-sm text-destructive">{error}</p>;
  if (!state) return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;

  return (
    <Card className="bg-card border-border" dir={dir} data-testid="billing-locks-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Lock className="h-4 w-4" aria-hidden /> {t('admin.billingLocks.title')}
        </CardTitle>
        <CardDescription>{t(`admin.billingLocks.editing.${state.edition}` as TranslationKey)}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">{t('admin.billingLocks.desc')}</p>
        <div className="flex flex-wrap items-center gap-3">
          <Switch
            id="billing-locks-switch"
            checked={state.locks_enabled}
            disabled={saving}
            onCheckedChange={(v) => setConfirm(v)}
            data-testid="billing-locks-switch"
          />
          <Label htmlFor="billing-locks-switch">{t('admin.billingLocks.switchLabel')}</Label>
          <span className={`text-xs font-medium ${state.locks_enabled ? 'text-amber-600' : 'text-muted-foreground'}`}>
            {t(state.locks_enabled ? 'admin.billingLocks.on' : 'admin.billingLocks.off')}
          </span>
        </div>

        <section className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void runPreview()} disabled={previewing} data-testid="billing-locks-preview">
              {previewing ? <Loader2 className="me-2 h-4 w-4 animate-spin" aria-hidden /> : <Eye className="me-2 h-4 w-4" aria-hidden />}
              {t(previewing ? 'admin.billingLocks.previewing' : 'admin.billingLocks.preview')}
            </Button>
            <span className="text-xs text-muted-foreground">{t('admin.billingLocks.previewHint')}</span>
          </div>
          {preview && (
            <div className="space-y-2 text-sm" data-testid="billing-locks-preview-result">
              <p className="text-xs text-muted-foreground">
                {t('admin.billingLocks.scanned', { count: n(preview.scanned) })}
                {preview.truncated && <> {t('admin.billingLocks.truncated', { count: n(preview.scanned) })}</>}
                {preview.failed > 0 && <span className="text-destructive"> {t('admin.billingLocks.failed', { count: n(preview.failed) })}</span>}
              </p>
              <p className="font-medium">
                {preview.workspaces_locking > 0
                  ? t('admin.billingLocks.locking', { count: n(preview.workspaces_locking) })
                  : t('admin.billingLocks.none')}
              </p>
              {preview.workspaces.length > 0 && (
                <div className="overflow-x-auto rounded-md border">
                  <table className="w-full text-xs">
                    <thead className="bg-muted/40">
                      <tr>
                        <th className="px-2 py-1.5 text-start font-medium">{t('admin.billingLocks.columns.workspace')}</th>
                        {LOCK_COLUMNS.map((c) => (
                          <th key={c} className="px-2 py-1.5 text-end font-medium">{t(`admin.billingLocks.columns.${c}` as TranslationKey)}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {preview.workspaces.slice(0, PREVIEW_ROWS).map((w) => (
                        <tr key={w.workspace_id} className="border-t">
                          <td className="max-w-[16rem] truncate px-2 py-1.5" title={w.workspace_id}>{w.name || w.workspace_id}</td>
                          {LOCK_COLUMNS.map((c) => <td key={c} className="px-2 py-1.5 text-end tabular-nums">{n(w[c])}</td>)}
                        </tr>
                      ))}
                      <tr className="border-t bg-muted/20 font-medium">
                        <td className="px-2 py-1.5">{t('admin.billingLocks.total')}</td>
                        {LOCK_COLUMNS.map((c) => <td key={c} className="px-2 py-1.5 text-end tabular-nums">{n(preview.totals[c])}</td>)}
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}
              {preview.x_channel_stops.length > 0 && (
                <div className="space-y-1 rounded-md border border-amber-500/40 bg-amber-500/5 p-2" data-testid="billing-locks-x-stops">
                  <p className="text-xs font-medium">{t('admin.billingLocks.xStops', { count: n(preview.x_channel_stops.length) })}</p>
                  <p className="text-xs text-muted-foreground">{t('admin.billingLocks.xStopsHint')}</p>
                  <p className="text-xs">{preview.x_channel_stops.map((w) => w.name || w.workspace_id).join(locale === 'fa' ? '، ' : ', ')}</p>
                </div>
              )}
            </div>
          )}
        </section>
      </CardContent>

      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && !saving && setConfirm(null)}>
        <AlertDialogContent dir={dir}>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(confirm ? 'admin.billingLocks.confirmOnTitle' : 'admin.billingLocks.confirmOffTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm
                ? preview
                  ? t('admin.billingLocks.confirmOn', { count: n(preview.workspaces_locking) })
                  : t('admin.billingLocks.confirmOnUnknown')
                : t('admin.billingLocks.confirmOff')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>{t('admin.billingLocks.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              disabled={saving}
              onClick={(e) => {
                e.preventDefault();
                if (confirm !== null) void save(confirm);
              }}
              data-testid="billing-locks-confirm"
            >
              {saving && <Loader2 className="me-2 h-4 w-4 animate-spin" aria-hidden />}
              {t(confirm ? 'admin.billingLocks.turnOn' : 'admin.billingLocks.turnOff')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
