/**
 * Super Admin → Plans → Billing settings → AI credit packs (simple billing,
 * phase 5; docs/billing/SIMPLE_BILLING.md). The packs customers buy from
 * their balance or online, per currency of the edition this deployment runs
 * (Iran: IRR; abroad: USD and TRY), saved on their own through
 * /api/admin/simple-billing/ai-packs (server/routes/adminSimpleBilling.ts).
 *
 * Price and credit are typed as people read them (Toman for IRR, dollars and
 * lira with cents) and stored in minor units (Rial / cent / kuruş). A pack's
 * id names it in every purchase, so it is fixed once saved. The rules are the
 * server's own (shared/aiPacks.ts), checked here first; a 400 from the server
 * highlights the same field.
 */
import { useEffect, useState } from 'react';
import { AlertTriangle, ArrowDown, ArrowUp, ChevronDown, ChevronUp, Loader2, Plus, Sparkles, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/lib/toast';
import { API_BASE } from '@/lib/apiBase';
import { parsePlanPriceInput, planPriceFromDisplay, planPriceInputValue, planPriceUnitLabel } from '@/lib/planPrice';
import { useTranslation, type TranslationKey } from '@/i18n';
import {
  AI_PACK_LIMITS,
  AI_PACK_LOCALES,
  bonusPercent,
  creditToWallet,
  validateAiPacks,
  type AiPack,
  type AiPackLocale,
  type AiPacksProblem,
} from '../../../shared/aiPacks';
import type { Edition } from '../../../shared/edition';

/** GET / PUT /api/admin/simple-billing/ai-packs. */
export interface AiPacksView {
  edition: Edition;
  currencies: string[];
  packs: Record<string, AiPack[]>;
  /** AI wallet units (IRR) per one major unit of the currency; null = no rate, nothing offered. */
  rates: Record<string, number | null>;
  mode: 'METER_ONLY' | 'ENFORCED';
  vat_percent: Record<string, number | null>;
}

/** One pack being edited: amounts as typed, `saved` once the server has it (its id is then fixed). */
interface Row {
  key: string;
  id: string;
  price: string;
  credit: string;
  active: boolean;
  label: Partial<Record<AiPackLocale, string>>;
  saved: boolean;
}

interface Problem {
  field: string;
  reason: AiPacksProblem;
}

class SaveError extends Error {
  constructor(message: string, readonly problem: Problem | null) {
    super(message);
  }
}

async function call(method: 'GET' | 'PUT', body?: unknown): Promise<AiPacksView> {
  const res = await fetch(`${API_BASE}/api/admin/simple-billing/ai-packs`, {
    method,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await res.json().catch(() => ({}))) as Partial<AiPacksView> & { error?: string; field?: string; reason?: AiPacksProblem };
  if (!res.ok) {
    const problem = json.error === 'AI_PACKS_INVALID' && json.field ? { field: json.field, reason: json.reason ?? 'invalid' } : null;
    throw new SaveError(json.error || `HTTP_${res.status}`, problem);
  }
  return json as AiPacksView;
}

let rowSeq = 0;
const rowKey = () => `row-${++rowSeq}`;

function rowsOf(view: AiPacksView): Record<string, Row[]> {
  return Object.fromEntries(view.currencies.map((currency) => [
    currency,
    (view.packs[currency] ?? []).map((pack) => ({
      key: rowKey(),
      id: pack.id,
      price: planPriceInputValue(pack.price_minor, currency),
      credit: planPriceInputValue(pack.credit_minor, currency),
      active: pack.active !== false,
      label: { ...(pack.label ?? {}) },
      saved: true,
    })),
  ]));
}

/** A typed amount in stored units; NaN when it is not an amount (the rules then name the field). */
function storedAmount(text: string, currency: string): number {
  const value = parsePlanPriceInput(text);
  return value === null ? Number.NaN : planPriceFromDisplay(value, currency);
}

function packOf(row: Row, currency: string): AiPack {
  const label: Partial<Record<AiPackLocale, string>> = {};
  for (const locale of AI_PACK_LOCALES) {
    const value = row.label[locale]?.trim();
    if (value) label[locale] = value;
  }
  return {
    id: row.id.trim(),
    price_minor: storedAmount(row.price, currency),
    credit_minor: storedAmount(row.credit, currency),
    active: row.active,
    ...(Object.keys(label).length ? { label } : {}),
  };
}

/** The first free `p1`, `p2`, … of a currency. */
function nextId(rows: Row[]): string {
  const taken = new Set(rows.map((r) => r.id));
  let n = 1;
  while (taken.has(`p${n}`)) n++;
  return `p${n}`;
}

function intlTag(locale: string): string {
  if (locale === 'fa') return 'fa-IR';
  if (locale === 'tr') return 'tr-TR';
  return 'en-US';
}

export default function AiPacksPanel() {
  const { t, dir, locale } = useTranslation();
  const [view, setView] = useState<AiPacksView | null>(null);
  const [rows, setRows] = useState<Record<string, Row[]>>({});
  const [openLabels, setOpenLabels] = useState<Record<string, boolean>>({});
  const [problem, setProblem] = useState<Problem | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const show = (next: AiPacksView) => {
    setView(next);
    setRows(rowsOf(next));
    setProblem(null);
  };

  useEffect(() => {
    call('GET').then(show).catch((e: Error) => setLoadError(e.message));
  }, []);

  if (loadError && !view) return <p className="text-sm text-destructive">{loadError}</p>;
  if (!view) return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;

  const k = (key: string) => `admin.billingSettings.aiPacks.${key}` as TranslationKey;
  const currencyName = (currency: string) => t(`admin.simpleBilling.vatFor.${currency}` as TranslationKey);
  const numberText = (n: number) => new Intl.NumberFormat(intlTag(locale)).format(n);

  const edit = (currency: string, update: (list: Row[]) => Row[]) => {
    setRows((all) => ({ ...all, [currency]: update(all[currency] ?? []) }));
    setProblem(null);
  };
  const patch = (currency: string, key: string, change: Partial<Row>) =>
    edit(currency, (list) => list.map((r) => (r.key === key ? { ...r, ...change } : r)));
  const move = (currency: string, index: number, by: -1 | 1) =>
    edit(currency, (list) => {
      const next = [...list];
      [next[index], next[index + by]] = [next[index + by], next[index]];
      return next;
    });

  const payload = () => Object.fromEntries(view.currencies.map((c) => [c, (rows[c] ?? []).map((r) => packOf(r, c))]));

  const reveal = (found: Problem) => {
    setProblem(found);
    // A wrong name is inside the collapsed names: open them.
    const m = /^([A-Z]{3})\.(\d+)\.label\b/.exec(found.field);
    const row = m ? rows[m[1]]?.[Number(m[2])] : undefined;
    if (row) setOpenLabels((o) => ({ ...o, [row.key]: true }));
  };

  const problemText = (found: Problem): string => {
    const currency = found.field.split('.')[0];
    if (found.reason === 'duplicate') return t(k('errors.duplicate'), { currency });
    if (found.reason === 'too_many') return t(k('errors.tooMany'), { max: AI_PACK_LIMITS.maxPerCurrency });
    if (found.reason === 'currency') return t(k('errors.currency'), { currency });
    return t(k('errors.invalid'));
  };

  const save = async () => {
    const packs = payload();
    const checked = validateAiPacks(packs, view.edition);
    if (checked.ok === false) {
      reveal({ field: checked.field, reason: checked.reason });
      toast.error(problemText({ field: checked.field, reason: checked.reason }));
      return;
    }
    setSaving(true);
    try {
      show(await call('PUT', { packs: checked.packs }));
      toast.success(t(k('saved')));
    } catch (e) {
      if (e instanceof SaveError && e.problem) {
        reveal(e.problem);
        toast.error(problemText(e.problem));
      } else {
        toast.error((e as Error).message);
      }
    } finally {
      setSaving(false);
    }
  };

  const invalid = (field: string) => problem?.field === field;
  const hasUsdPacks = (rows.USD ?? []).length > 0;

  return (
    <Card className="bg-card border-border" dir={dir} data-testid="ai-packs-panel">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="h-4 w-4" aria-hidden /> {t(k('title'))}
        </CardTitle>
        <CardDescription>{t(k('description'))}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {view.mode !== 'ENFORCED' && (
          <p role="status" data-testid="ai-packs-mode-warning" className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden /> {t(k('modeWarning'))}
          </p>
        )}
        {view.edition === 'international' && hasUsdPacks && (
          <p role="status" data-testid="ai-packs-fx-warning" className="flex items-start gap-2 rounded-md border border-border bg-muted/40 p-3 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden /> {t(k('fxWarning'))}
          </p>
        )}

        {view.currencies.map((currency) => {
          const list = rows[currency] ?? [];
          const rate = view.rates[currency] ?? null;
          const unit = planPriceUnitLabel(currency, locale);
          return (
            <section key={currency} className="space-y-3" data-testid={`ai-packs-${currency}`}>
              <h3 className={`text-sm font-medium ${invalid(currency) ? 'text-destructive' : ''}`}>
                {t(k('currency'), { currency: currencyName(currency) })}
              </h3>
              {list.length === 0 && <p className="text-xs text-muted-foreground">{t(k('empty'))}</p>}
              {list.map((row, index) => {
                const at = `${currency}.${index}`;
                const pack = packOf(row, currency);
                const amountsValid = Number.isSafeInteger(pack.price_minor) && pack.price_minor > 0
                  && Number.isSafeInteger(pack.credit_minor) && pack.credit_minor > 0;
                const bonus = amountsValid ? bonusPercent(pack) : 0;
                const wallet = amountsValid ? creditToWallet(pack.credit_minor, rate, currency) : null;
                const labelsOpen = openLabels[row.key] ?? false;
                return (
                  <div key={row.key} className="space-y-3 rounded-md border border-border p-3" data-testid={`ai-pack-row-${at}`}>
                    <div className="grid gap-3 sm:grid-cols-[8rem_1fr_1fr_auto] sm:items-end">
                      <div className="space-y-1.5">
                        <Label htmlFor={`ai-pack-${row.key}-id`}>{t(k('id'))}</Label>
                        <Input
                          id={`ai-pack-${row.key}-id`}
                          dir="ltr"
                          maxLength={24}
                          value={row.id}
                          readOnly={row.saved}
                          aria-invalid={invalid(`${at}.id`)}
                          onChange={(e) => patch(currency, row.key, { id: e.target.value.toLowerCase() })}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor={`ai-pack-${row.key}-price`}>{t(k('price'))} ({unit})</Label>
                        <Input
                          id={`ai-pack-${row.key}-price`}
                          dir="ltr"
                          inputMode="decimal"
                          value={row.price}
                          aria-invalid={invalid(`${at}.price_minor`)}
                          onChange={(e) => patch(currency, row.key, { price: e.target.value })}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor={`ai-pack-${row.key}-credit`}>{t(k('credit'))} ({unit})</Label>
                        <Input
                          id={`ai-pack-${row.key}-credit`}
                          dir="ltr"
                          inputMode="decimal"
                          value={row.credit}
                          aria-invalid={invalid(`${at}.credit_minor`)}
                          onChange={(e) => patch(currency, row.key, { credit: e.target.value })}
                        />
                      </div>
                      <div className="flex items-center gap-2 pb-1">
                        <Switch
                          id={`ai-pack-${row.key}-active`}
                          checked={row.active}
                          onCheckedChange={(active) => patch(currency, row.key, { active })}
                        />
                        <Label htmlFor={`ai-pack-${row.key}-active`}>{t(k('active'))}</Label>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      {bonus > 0 && <span data-testid="ai-pack-bonus">{t(k('bonus'), { percent: numberText(bonus) })}</span>}
                      {rate === null ? (
                        <span className="text-amber-700 dark:text-amber-400" data-testid="ai-pack-no-rate">{t(k('noRate'), { currency })}</span>
                      ) : wallet !== null ? (
                        <span data-testid="ai-pack-wallet">{t(k('walletEquivalent'), { wallet: numberText(wallet) })}</span>
                      ) : null}
                    </div>

                    <div className="flex flex-wrap items-center gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-expanded={labelsOpen}
                        onClick={() => setOpenLabels((o) => ({ ...o, [row.key]: !labelsOpen }))}
                      >
                        {labelsOpen ? <ChevronUp className="me-1 h-4 w-4" aria-hidden /> : <ChevronDown className="me-1 h-4 w-4" aria-hidden />}
                        {t(k('labels'))}
                      </Button>
                      <span className="flex-1" />
                      <Button type="button" variant="ghost" size="icon" aria-label={t(k('up'))} disabled={index === 0} onClick={() => move(currency, index, -1)}>
                        <ArrowUp className="h-4 w-4" aria-hidden />
                      </Button>
                      <Button type="button" variant="ghost" size="icon" aria-label={t(k('down'))} disabled={index === list.length - 1} onClick={() => move(currency, index, 1)}>
                        <ArrowDown className="h-4 w-4" aria-hidden />
                      </Button>
                      <Button type="button" variant="ghost" size="icon" aria-label={t(k('remove'))} onClick={() => edit(currency, (l) => l.filter((r) => r.key !== row.key))}>
                        <Trash2 className="h-4 w-4" aria-hidden />
                      </Button>
                    </div>

                    {labelsOpen && (
                      <div className="space-y-2">
                        <p className="text-xs text-muted-foreground">{t(k('labelHint'))}</p>
                        <div className="grid gap-3 sm:grid-cols-3">
                          {AI_PACK_LOCALES.map((lang) => (
                            <div key={lang} className="space-y-1.5">
                              <Label htmlFor={`ai-pack-${row.key}-label-${lang}`}>{t(k(`labelLocales.${lang}`))}</Label>
                              <Input
                                id={`ai-pack-${row.key}-label-${lang}`}
                                dir={lang === 'fa' ? 'rtl' : 'ltr'}
                                maxLength={AI_PACK_LIMITS.maxLabelLength}
                                value={row.label[lang] ?? ''}
                                aria-invalid={invalid(`${at}.label.${lang}`)}
                                onChange={(e) => patch(currency, row.key, { label: { ...row.label, [lang]: e.target.value } })}
                              />
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={list.length >= AI_PACK_LIMITS.maxPerCurrency}
                onClick={() => edit(currency, (l) => [...l, { key: rowKey(), id: nextId(l), price: '', credit: '', active: true, label: {}, saved: false }])}
              >
                <Plus className="me-1 h-4 w-4" aria-hidden /> {t(k('add'))}
              </Button>
            </section>
          );
        })}

        {problem && <p role="alert" className="text-sm text-destructive">{problemText(problem)}</p>}

        <Button onClick={save} disabled={saving}>
          {saving && <Loader2 className="me-2 h-4 w-4 animate-spin" aria-hidden />}
          {t(k('save'))}
        </Button>
      </CardContent>
    </Card>
  );
}
