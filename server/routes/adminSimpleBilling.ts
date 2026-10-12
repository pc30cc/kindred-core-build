/**
 * SUPER ADMIN → simple billing settings (docs/billing/SIMPLE_BILLING.md).
 *
 * Mounted under adminRouter, which already gates `/api/admin/*` behind
 * `requirePlatformAdmin`.
 *
 * One row per edition (billing_settings, migration 259): the seller printed
 * on receipts, the VAT per currency and the receipt prefix; and the AI credit
 * packs per currency (phase 5, /ai-packs, saved on their own). Every read and
 * write is the running edition's; WebYar's settings are never shown to RESPOK
 * or the other way round.
 *
 * Phase 6 (migration 266): the accounts with their balances, an account's
 * ledger, payments and receipts, the manual credit and debit, the monthly
 * revenue and the gateways' readiness. Reading an account never changes it
 * (no due processing, no account creation, no card sync).
 */
import { Router, type Request } from 'express';
import { z } from 'zod';
import { serverConfigOf } from '../lib/workspaceAuth.js';
import { getServiceClient } from '../supabase.js';
import { getPlatformEdition, EditionUnavailableError } from '../services/platformRegion.js';
import { AccountBillingError, getBillingSettings } from '../services/billing/account/index.js';
import {
  adminAccountDetail,
  adminAdjust,
  gatewayReadiness,
  getAdminReceipt,
  listAdminAccounts,
  listAdminLedger,
  listAdminPayments,
  revenueReport,
} from '../services/billing/account/adminReports.js';
import { insertAuditLogRows } from '../services/auditLog.js';
import {
  ACCOUNT_CURRENCIES,
  ACCOUNT_SORTS,
  ADJUST_CATEGORIES,
  ADJUST_REASON_MAX,
  ADJUST_REASON_MIN,
  REVENUE_MONTHS,
  adjustAmountProblem,
  parseAccountFilter,
} from '../../shared/simpleBillingAdmin.js';
import { adjustAllowed } from '../services/billing/account/adjustRateLimit.js';
import { aiWalletRate } from '../services/billing/account/aiPacks.js';
import { getBillingMode } from '../services/ai-billing/mode.js';
import { SELLER_KEYS, cleanProfile, vatPercentFor } from '../../shared/simpleBilling.js';
import { AI_PACK_CURRENCIES, validateAiPacks, type AiPack } from '../../shared/aiPacks.js';
import type { Edition } from '../../shared/edition.js';

export const adminSimpleBillingRouter = Router();

type AdminRequest = Request & { adminUser?: { id?: string } };

function adminIdOf(req: Request): string | null {
  return (req as AdminRequest).adminUser?.id ?? null;
}

/** The currencies whose VAT each edition's admin sets: Toman in Iran; Multi Region (USD) and Turkey (TRY) abroad. */
export const VAT_CURRENCIES: Readonly<Record<Edition, readonly string[]>> = {
  iran: ['IRR'],
  international: ['USD', 'TRY'],
};

function editionFail(res: { status(code: number): { json(body: unknown): unknown } }, e: unknown) {
  if (e instanceof EditionUnavailableError) return res.status(503).json({ error: 'EDITION_UNAVAILABLE' });
  if (e instanceof AccountBillingError) return res.status(e.status).json({ error: e.code, ...(e.details ?? {}) });
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
    res.json({
      edition,
      seller: settings.seller,
      vat_percent: vat,
      receipt_prefix: settings.receipt_prefix,
      vat_currencies: VAT_CURRENCIES[edition],
      ...aiPacksOfSettings(edition, settings.ai_packs),
    });
  } catch (e) {
    editionFail(res, e);
  }
});

const settingsSchema = z.object({
  seller: z.record(z.string(), z.string().max(300)).default({}),
  vat_percent: z.record(z.string(), z.union([z.number().min(0).max(99.999), z.null()])).default({}),
  receipt_prefix: z.string().trim().regex(/^[A-Za-z0-9-]{1,8}$/).default('R'),
  // Optional (phase 6): when absent the stored packs stay, as with PUT /ai-packs.
  ai_packs: z.record(z.string(), z.unknown()).optional(),
});

/**
 * The AI credit packs as GET /settings shows them: this edition's
 * currencies (`ai_currencies`, also the plan form's monthly AI credit
 * currencies) and their stored packs, normalised when they pass the rules.
 */
function aiPacksOfSettings(edition: Edition, stored: Record<string, unknown>) {
  const currencies = AI_PACK_CURRENCIES[edition];
  const listOf = (currency: string): unknown[] => (Array.isArray(stored[currency]) ? (stored[currency] as unknown[]) : []);
  const valid = validateAiPacks(Object.fromEntries(currencies.map((c) => [c, listOf(c)])), edition);
  const packs: Record<string, AiPack[]> = {};
  for (const currency of currencies) packs[currency] = valid.ok === true ? valid.packs[currency] : (listOf(currency) as AiPack[]);
  return { ai_currencies: currencies, ai_packs: packs };
}

adminSimpleBillingRouter.put('/settings', async (req, res) => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_REQUEST' });
  try {
    const cfg = serverConfigOf(req);
    const edition = await getPlatformEdition(cfg);
    let aiPacks: Record<string, AiPack[]> | null = null;
    if (parsed.data.ai_packs !== undefined) {
      const valid = validateAiPacks(parsed.data.ai_packs, edition);
      if (valid.ok === false) return res.status(400).json({ error: valid.error, field: valid.field, reason: valid.reason });
      aiPacks = valid.packs;
    }
    const vat: Record<string, number | null> = {};
    for (const currency of VAT_CURRENCIES[edition]) {
      const value = parsed.data.vat_percent[currency];
      vat[currency] = typeof value === 'number' && value > 0 ? Math.round(value * 1000) / 1000 : null;
    }
    const row: Record<string, unknown> = {
      edition,
      seller: cleanProfile(parsed.data.seller, SELLER_KEYS),
      vat_percent: vat,
      receipt_prefix: parsed.data.receipt_prefix,
      updated_at: new Date().toISOString(),
      updated_by: adminIdOf(req),
    };
    // Sent only when the form sent them, so saving the seller never overwrites the packs.
    if (aiPacks) row.ai_packs = aiPacks;
    const { error } = await getServiceClient(cfg).from('billing_settings').upsert(row, { onConflict: 'edition' });
    if (error) throw new Error(error.message);
    const packs = aiPacks
      ? { ai_currencies: AI_PACK_CURRENCIES[edition], ai_packs: aiPacks }
      : aiPacksOfSettings(edition, (await getBillingSettings(cfg, edition)).ai_packs);
    res.json({ edition, seller: row.seller, vat_percent: vat, receipt_prefix: row.receipt_prefix, vat_currencies: VAT_CURRENCIES[edition], ...packs });
  } catch (e) {
    editionFail(res, e);
  }
});

// ─── AI credit packs (phase 5) ─────────────────────────────────────────────
// Per edition currency: Iran IRR; abroad USD and TRY. Saved on their own: a
// PUT writes only ai_packs (a missing row is created with the other settings'
// defaults), and PUT /settings never sends them, so neither form overwrites
// the other. Packs are offered only while AI billing is ENFORCED and the
// currency has an AI exchange rate (the page shows both).

type ServerConfig = ReturnType<typeof serverConfigOf>;

/**
 * The editor's view: the stored packs (inactive ones too; normalised when they
 * pass the rules, else as stored), each currency's rate (null = none), the
 * AI billing mode and the VAT. `saved`: what a PUT just wrote.
 */
async function aiPacksView(cfg: ServerConfig, edition: Edition, saved: Record<string, AiPack[]> | null) {
  const currencies = AI_PACK_CURRENCIES[edition];
  const settings = await getBillingSettings(cfg, edition);
  const stored = saved ?? settings.ai_packs;
  const listOf = (currency: string): unknown[] => (Array.isArray(stored[currency]) ? (stored[currency] as unknown[]) : []);
  const valid = validateAiPacks(Object.fromEntries(currencies.map((c) => [c, listOf(c)])), edition);
  const packs: Record<string, AiPack[]> = {};
  const rates: Record<string, number | null> = {};
  const vat: Record<string, number | null> = {};
  await Promise.all(currencies.map(async (currency) => {
    packs[currency] = valid.ok === true ? valid.packs[currency] : (listOf(currency) as AiPack[]);
    rates[currency] = await aiWalletRate(cfg, currency);
    vat[currency] = vatPercentFor(settings.vat_percent, currency);
  }));
  return { edition, currencies, packs, rates, mode: await getBillingMode(cfg), vat_percent: vat };
}

adminSimpleBillingRouter.get('/ai-packs', async (req, res) => {
  try {
    const cfg = serverConfigOf(req);
    const edition = await getPlatformEdition(cfg);
    res.json(await aiPacksView(cfg, edition, null));
  } catch (e) {
    editionFail(res, e);
  }
});

const aiPacksSchema = z.object({ packs: z.record(z.string(), z.unknown()) });

adminSimpleBillingRouter.put('/ai-packs', async (req, res) => {
  const parsed = aiPacksSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_REQUEST' });
  try {
    const cfg = serverConfigOf(req);
    const edition = await getPlatformEdition(cfg);
    const valid = validateAiPacks(parsed.data.packs, edition);
    if (valid.ok === false) return res.status(400).json({ error: valid.error, field: valid.field, reason: valid.reason });
    const row = {
      edition,
      ai_packs: valid.packs,
      updated_at: new Date().toISOString(),
      updated_by: adminIdOf(req),
    };
    const { error } = await getServiceClient(cfg).from('billing_settings').upsert(row, { onConflict: 'edition' });
    if (error) throw new Error(error.message);
    res.json(await aiPacksView(cfg, edition, valid.packs));
  } catch (e) {
    editionFail(res, e);
  }
});

// ─── Accounts (phase 6) ────────────────────────────────────────────────────

const pageSchema = {
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
};

const accountsQuerySchema = z.object({
  q: z.string().max(100).default(''),
  filter: z.string().max(60).optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  sort: z.enum(ACCOUNT_SORTS).default('balance_desc'),
  ...pageSchema,
});

adminSimpleBillingRouter.get('/accounts', async (req, res) => {
  const parsed = accountsQuerySchema.safeParse(req.query);
  const filter = parsed.success ? parseAccountFilter(parsed.data.filter) : null;
  if (!parsed.success || !filter) return res.status(400).json({ error: 'INVALID_REQUEST' });
  try {
    const cfg = serverConfigOf(req);
    const edition = await getPlatformEdition(cfg);
    const result = await listAdminAccounts(cfg, {
      q: parsed.data.q,
      filter,
      currency: parsed.data.currency ?? null,
      sort: parsed.data.sort,
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
    });
    res.json({ edition, currencies: ACCOUNT_CURRENCIES[edition], ...result });
  } catch (e) {
    editionFail(res, e);
  }
});

const workspaceParam = z.string().uuid();

/** The `:workspaceId` param, or null after answering 400. */
function workspaceIdOf(req: Request, res: { status(code: number): { json(body: unknown): unknown } }): string | null {
  const parsed = workspaceParam.safeParse(req.params.workspaceId);
  if (!parsed.success) {
    res.status(400).json({ error: 'INVALID_REQUEST' });
    return null;
  }
  return parsed.data;
}

adminSimpleBillingRouter.get('/accounts/:workspaceId', async (req, res) => {
  const workspaceId = workspaceIdOf(req, res);
  if (!workspaceId) return;
  try {
    const detail = await adminAccountDetail(serverConfigOf(req), workspaceId);
    if (!detail) return res.status(404).json({ error: 'NOT_FOUND' });
    res.json(detail);
  } catch (e) {
    editionFail(res, e);
  }
});

const pageQuerySchema = z.object({ ...pageSchema, pageSize: pageSchema.pageSize.default(20) });

adminSimpleBillingRouter.get('/accounts/:workspaceId/ledger', async (req, res) => {
  const workspaceId = workspaceIdOf(req, res);
  if (!workspaceId) return;
  const parsed = pageQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_REQUEST' });
  try {
    res.json(await listAdminLedger(serverConfigOf(req), workspaceId, parsed.data));
  } catch (e) {
    editionFail(res, e);
  }
});

adminSimpleBillingRouter.get('/accounts/:workspaceId/payments', async (req, res) => {
  const workspaceId = workspaceIdOf(req, res);
  if (!workspaceId) return;
  const parsed = pageQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_REQUEST' });
  try {
    res.json(await listAdminPayments(serverConfigOf(req), workspaceId, parsed.data));
  } catch (e) {
    editionFail(res, e);
  }
});

adminSimpleBillingRouter.get('/accounts/:workspaceId/receipts/:ledgerId', async (req, res) => {
  const workspaceId = workspaceIdOf(req, res);
  if (!workspaceId) return;
  const ledgerId = workspaceParam.safeParse(req.params.ledgerId);
  if (!ledgerId.success) return res.status(400).json({ error: 'INVALID_REQUEST' });
  try {
    const receipt = await getAdminReceipt(serverConfigOf(req), workspaceId, ledgerId.data);
    if (!receipt) return res.status(404).json({ error: 'NOT_FOUND' });
    res.json({ receipt });
  } catch (e) {
    editionFail(res, e);
  }
});

// ─── Manual credit and debit (phase 6) ─────────────────────────────────────
// Safeguards (decision D2): a reason and a category, the balance and the
// currency the dialog showed (409 when either moved), a key that makes a
// double submit replay, a per-admin rate limit (counted from the ledger,
// services/billing/account/adjustRateLimit.ts), and an audit row. The actor
// is the signed-in Super Admin, never a field of the body.

const adjustSchema = z.object({
  direction: z.enum(['credit', 'debit']),
  amountMinor: z.number().int().positive(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  reason: z.string().refine((r) => {
    const length = r.trim().length;
    return length >= ADJUST_REASON_MIN && length <= ADJUST_REASON_MAX;
  }),
  category: z.enum(ADJUST_CATEGORIES),
  expectedBalanceMinor: z.number().int().min(0),
  commandKey: z.string().uuid(),
}).strict();

function clientIp(req: Request): string | null {
  return (req.ip || req.socket?.remoteAddress || '').slice(0, 64) || null;
}

adminSimpleBillingRouter.post('/accounts/:workspaceId/adjust', async (req, res) => {
  const workspaceId = workspaceIdOf(req, res);
  if (!workspaceId) return;
  const actorId = adminIdOf(req);
  if (!actorId) return res.status(401).json({ error: 'UNAUTHORIZED' });
  const parsed = adjustSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_REQUEST' });
  const body = parsed.data;
  const problem = adjustAmountProblem(body.amountMinor, body.currency);
  if (problem) return res.status(400).json({ error: problem === 'ADJUST_TOO_LARGE' ? 'ADJUST_TOO_LARGE' : 'INVALID_REQUEST' });
  const cfg = serverConfigOf(req);
  try {
    const detail = await adminAccountDetail(cfg, workspaceId);
    if (!detail) return res.status(404).json({ error: 'NOT_FOUND' });
    // The server decides the currency (decision D5): the account's, else the region's (accountCurrency's rule).
    const currency = detail.currency;
    if (currency !== body.currency) return res.status(409).json({ error: 'CURRENCY_CHANGED', account: detail });
    // Counted from the ledger, shared by every process; a replay of a booked key is not a new change.
    if (!(await adjustAllowed(cfg, actorId, body.commandKey))) return res.status(429).json({ error: 'TOO_MANY_ADJUSTMENTS' });
    const amountMinor = body.direction === 'debit' ? -body.amountMinor : body.amountMinor;
    const reason = body.reason.trim();
    let outcome;
    try {
      outcome = await adminAdjust(cfg, {
        workspaceId,
        amountMinor,
        currency,
        reason,
        category: body.category,
        expectedBalanceMinor: body.expectedBalanceMinor,
        commandKey: body.commandKey,
        actorId,
      });
    } catch (e) {
      if (e instanceof AccountBillingError && (e.code === 'BALANCE_CHANGED' || e.code === 'CURRENCY_CHANGED')) {
        const fresh = await adminAccountDetail(cfg, workspaceId).catch(() => null);
        return res.status(e.status).json({ error: e.code, account: fresh });
      }
      throw e;
    }
    if (!outcome.replayed) {
      // Best effort (decision D9): the ledger row is the record; a failed audit write never fails the adjust.
      try {
        const { error } = await insertAuditLogRows(cfg, getServiceClient(cfg), {
          workspace_id: workspaceId,
          user_id: actorId,
          action: 'billing.admin_adjust',
          entity_type: 'billing_account',
          entity_id: outcome.ledger_id || null,
          new_value: { amount_minor: amountMinor, currency, category: body.category, reason, balance_after: outcome.balance_minor },
          ip_address: clientIp(req),
        });
        if (error) console.error('[admin-simple-billing] audit write failed', error.message);
      } catch (auditError) {
        console.error('[admin-simple-billing] audit write failed', auditError instanceof Error ? auditError.message : auditError);
      }
    }
    const account = await adminAccountDetail(cfg, workspaceId);
    res.json({ replayed: outcome.replayed, ledger_id: outcome.ledger_id, balance_minor: outcome.balance_minor, account });
  } catch (e) {
    editionFail(res, e);
  }
});

// ─── Monthly revenue (phase 6) ─────────────────────────────────────────────

const revenueQuerySchema = z.object({
  months: z.coerce.number().int().min(REVENUE_MONTHS.min).max(REVENUE_MONTHS.max).default(REVENUE_MONTHS.default),
  includeTest: z.enum(['0', '1', 'true', 'false']).optional(),
});

adminSimpleBillingRouter.get('/revenue', async (req, res) => {
  const parsed = revenueQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_REQUEST' });
  try {
    const includeTest = parsed.data.includeTest === '1' || parsed.data.includeTest === 'true';
    res.json(await revenueReport(serverConfigOf(req), { months: parsed.data.months, includeTest }));
  } catch (e) {
    editionFail(res, e);
  }
});

// ─── Gateway readiness (phase 6) ───────────────────────────────────────────

adminSimpleBillingRouter.get('/gateways', async (req, res) => {
  try {
    res.json(await gatewayReadiness(serverConfigOf(req)));
  } catch (e) {
    editionFail(res, e);
  }
});
