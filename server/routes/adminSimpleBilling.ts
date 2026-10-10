/**
 * SUPER ADMIN → simple billing settings (docs/billing/SIMPLE_BILLING.md).
 *
 * Mounted under adminRouter, which already gates `/api/admin/*` behind
 * `requirePlatformAdmin`.
 *
 * One row per edition (billing_settings, migration 259): the seller printed
 * on receipts, the VAT per currency and the receipt prefix. Every read and
 * write is the running edition's; WebYar's settings are never shown to RESPOK
 * or the other way round.
 */
import { Router } from 'express';
import { z } from 'zod';
import { serverConfigOf } from '../lib/workspaceAuth.js';
import { getServiceClient } from '../supabase.js';
import { getPlatformEdition, EditionUnavailableError } from '../services/platformRegion.js';
import { getBillingSettings } from '../services/billing/account/index.js';
import { SELLER_KEYS, cleanProfile, vatPercentFor } from '../../shared/simpleBilling.js';
import type { Edition } from '../../shared/edition.js';

export const adminSimpleBillingRouter = Router();

/** The currencies whose VAT each edition's admin sets: Toman in Iran; Multi Region (USD) and Turkey (TRY) abroad. */
export const VAT_CURRENCIES: Readonly<Record<Edition, readonly string[]>> = {
  iran: ['IRR'],
  international: ['USD', 'TRY'],
};

function editionFail(res: { status(code: number): { json(body: unknown): unknown } }, e: unknown) {
  if (e instanceof EditionUnavailableError) return res.status(503).json({ error: 'EDITION_UNAVAILABLE' });
  console.error('[admin-simple-billing]', e instanceof Error ? e.message : e);
  return res.status(500).json({ error: 'INTERNAL_ERROR' });
}

adminSimpleBillingRouter.get('/settings', async (req, res) => {
  try {
    const cfg = serverConfigOf(req);
    const edition = await getPlatformEdition(cfg);
    const settings = await getBillingSettings(cfg, edition);
    const vat: Record<string, number | null> = {};
    for (const currency of VAT_CURRENCIES[edition]) vat[currency] = vatPercentFor(settings.vat_percent, currency);
    res.json({ edition, seller: settings.seller, vat_percent: vat, receipt_prefix: settings.receipt_prefix, vat_currencies: VAT_CURRENCIES[edition] });
  } catch (e) {
    editionFail(res, e);
  }
});

const settingsSchema = z.object({
  seller: z.record(z.string(), z.string().max(300)).default({}),
  vat_percent: z.record(z.string(), z.union([z.number().min(0).max(99.999), z.null()])).default({}),
  receipt_prefix: z.string().trim().regex(/^[A-Za-z0-9-]{1,8}$/).default('R'),
});

adminSimpleBillingRouter.put('/settings', async (req, res) => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_REQUEST' });
  try {
    const cfg = serverConfigOf(req);
    const edition = await getPlatformEdition(cfg);
    const vat: Record<string, number | null> = {};
    for (const currency of VAT_CURRENCIES[edition]) {
      const value = parsed.data.vat_percent[currency];
      vat[currency] = typeof value === 'number' && value > 0 ? Math.round(value * 1000) / 1000 : null;
    }
    const row = {
      edition,
      seller: cleanProfile(parsed.data.seller, SELLER_KEYS),
      vat_percent: vat,
      receipt_prefix: parsed.data.receipt_prefix,
      updated_at: new Date().toISOString(),
      updated_by: (req as unknown as { adminUser?: { id?: string } }).adminUser?.id ?? null,
    };
    const { error } = await getServiceClient(cfg).from('billing_settings').upsert(row, { onConflict: 'edition' });
    if (error) throw new Error(error.message);
    res.json({ edition, seller: row.seller, vat_percent: vat, receipt_prefix: row.receipt_prefix, vat_currencies: VAT_CURRENCIES[edition] });
  } catch (e) {
    editionFail(res, e);
  }
});
