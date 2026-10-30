/**
 * Card-to-card wallet top-up (Iranian edition; migration 274).
 *
 * A temporary way to add credit while no online gateway is live. The
 * workspace owner transfers the amount (credit + VAT) to the bank account the
 * Super Admin set, uploads the bank receipt, and a Super Admin approves or
 * rejects the request. Approval books what a gateway payment books
 * (billing_card_transfer_approve: a `manual` payment, verified and settled),
 * so the wallet, the numbered receipt, the receipt mail and revenue are the
 * same as for an online top-up.
 *
 * The receipt file is platform-owned (platform/billing/card-transfers/…):
 * never counted toward the workspace's storage, streamed by the backend only
 * to the workspace's managers and to Super Admins.
 */
import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import { getPlatformEdition } from '../../platformRegion.js';
import { uploadForOwner, downloadForOwner, deleteForOwner } from '../../storage/index.js';
import { platformCardTransferReceiptKey } from '../../storage/keys.js';
import { insertAuditLogRows } from '../../auditLog.js';
import {
  AccountBillingError,
  UPSTREAM_FAILURE_STATUS,
  accountCurrency,
  getBillingSettings,
} from './index.js';
import { chargeFor, topupAmountProblem, vatPercentFor } from '../../../../shared/simpleBilling.js';
import {
  CARD_TRANSFER_MAX_PENDING,
  CARD_TRANSFER_MAX_PER_DAY,
  CARD_TRANSFER_RECEIPT_MAX_BYTES,
  CARD_TRANSFER_RECEIPT_TYPES,
  cardTransferReady,
  cleanCardTransferSettings,
  latinDigits,
  readCardTransferSettings,
  type CardTransferRequest,
  type CardTransferSettings,
  type CardTransferStatus,
} from '../../../../shared/cardTransfer.js';

const TABLE = 'billing_card_transfers';
const COLUMNS =
  'id, workspace_id, created_by, status, currency, net_minor, tax_minor, amount_minor, reference, paid_at, '
  + 'payer_card_last4, note, receipt_key, receipt_mime, receipt_size, receipt_name, review_note, reviewed_by, '
  + 'reviewed_at, payment_id, ledger_id, created_at';

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function toRequest(row: Record<string, unknown>): CardTransferRequest {
  return {
    id: String(row.id),
    workspace_id: String(row.workspace_id),
    status: String(row.status) as CardTransferStatus,
    currency: String(row.currency ?? 'IRR'),
    net_minor: num(row.net_minor),
    tax_minor: num(row.tax_minor),
    amount_minor: num(row.amount_minor),
    reference: str(row.reference),
    paid_at: str(row.paid_at),
    payer_card_last4: str(row.payer_card_last4),
    note: str(row.note),
    receipt_mime: String(row.receipt_mime ?? ''),
    receipt_name: str(row.receipt_name),
    review_note: str(row.review_note),
    reviewed_at: str(row.reviewed_at),
    ledger_id: str(row.ledger_id),
    created_at: String(row.created_at ?? ''),
  };
}

function dbFail(error: { message?: string; code?: string } | null, what: string): never {
  console.error(`[card-transfer] ${what}:`, error?.message ?? error);
  throw new AccountBillingError('INTERNAL_ERROR', 500);
}

// ─── Settings ──────────────────────────────────────────────────────────────

/** The Iranian edition's bank account (whatever the platform runs, for the Super Admin). */
export async function getCardTransferSettings(config: ServerConfig): Promise<CardTransferSettings> {
  const { data, error } = await getServiceClient(config)
    .from('billing_settings')
    .select('card_transfer')
    .eq('edition', 'iran')
    .maybeSingle();
  if (error) dbFail(error, 'settings read');
  return readCardTransferSettings(asRecord(data).card_transfer);
}

export async function saveCardTransferSettings(
  config: ServerConfig,
  input: unknown,
  adminId: string,
): Promise<CardTransferSettings> {
  const cleaned = cleanCardTransferSettings(input);
  if (cleaned.ok === false) throw new AccountBillingError(cleaned.problem, 400);
  const sb = getServiceClient(config);
  const { data: existing, error: readError } = await sb
    .from('billing_settings')
    .select('edition')
    .eq('edition', 'iran')
    .maybeSingle();
  if (readError) dbFail(readError, 'settings read');
  const now = new Date().toISOString();
  const { error } = existing
    ? await sb.from('billing_settings')
      .update({ card_transfer: cleaned.value, updated_at: now, updated_by: adminId })
      .eq('edition', 'iran')
    : await sb.from('billing_settings')
      .insert({ edition: 'iran', card_transfer: cleaned.value, updated_at: now, updated_by: adminId });
  if (error) dbFail(error, 'settings save');
  return cleaned.value;
}

/**
 * What a workspace's billing page may show: the account to pay into, only in
 * the Iranian edition, only when enabled and complete, only for an IRR
 * account. Null otherwise.
 */
export async function cardTransferForAccount(
  config: ServerConfig,
  workspaceId: string,
): Promise<CardTransferSettings | null> {
  if ((await getPlatformEdition(config)) !== 'iran') return null;
  const settings = await getCardTransferSettings(config);
  if (!cardTransferReady(settings)) return null;
  if ((await accountCurrency(config, workspaceId)) !== 'IRR') return null;
  return settings;
}

// ─── Requests (workspace) ──────────────────────────────────────────────────

/** First bytes of each accepted type: the declared type must match the file. */
function sniffMime(bytes: Buffer): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  return null;
}

const EXTENSION: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

export interface CreateCardTransferInput {
  workspaceId: string;
  userId: string;
  /** The credit asked for (Rial); the payer transferred this plus VAT. */
  netMinor: number;
  reference?: string | null;
  paidAt?: string | null;
  payerCardLast4?: string | null;
  note?: string | null;
  receipt: { fileName: string; mimeType: string; dataBase64: string };
}

export async function createCardTransfer(config: ServerConfig, input: CreateCardTransferInput): Promise<CardTransferRequest> {
  const settings = await cardTransferForAccount(config, input.workspaceId);
  if (!settings) throw new AccountBillingError('CARD_TRANSFER_UNAVAILABLE', 409);

  const problem = topupAmountProblem(input.netMinor, 'IRR');
  if (problem) throw new AccountBillingError(problem, 400);

  const reference = input.reference ? latinDigits(input.reference) : '';
  if (input.reference && !/^\d{4,30}$/.test(reference)) throw new AccountBillingError('CARD_TRANSFER_REFERENCE_INVALID', 400);
  const last4 = input.payerCardLast4 ? latinDigits(input.payerCardLast4) : '';
  if (input.payerCardLast4 && !/^\d{4}$/.test(last4)) throw new AccountBillingError('CARD_TRANSFER_LAST4_INVALID', 400);
  let paidAt: string | null = null;
  if (input.paidAt) {
    const t = Date.parse(input.paidAt);
    // Not in the future (a few minutes of clock skew allowed), not older than 30 days.
    if (!Number.isFinite(t) || t > Date.now() + 10 * 60_000 || t < Date.now() - 30 * 86_400_000) {
      throw new AccountBillingError('CARD_TRANSFER_DATE_INVALID', 400);
    }
    paidAt = new Date(t).toISOString();
  }
  const note = input.note ? String(input.note).trim().slice(0, 500) : null;

  // The receipt: an accepted type whose bytes say the same, at most 5 MB.
  const mime = String(input.receipt.mimeType || '').toLowerCase();
  if (!(CARD_TRANSFER_RECEIPT_TYPES as readonly string[]).includes(mime)) {
    throw new AccountBillingError('CARD_TRANSFER_RECEIPT_TYPE', 400);
  }
  const base64 = String(input.receipt.dataBase64 || '').replace(/^data:[^,]*,/, '');
  if (base64.length > Math.ceil((CARD_TRANSFER_RECEIPT_MAX_BYTES * 4) / 3) + 8) {
    throw new AccountBillingError('CARD_TRANSFER_RECEIPT_TOO_LARGE', 413);
  }
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length === 0) throw new AccountBillingError('CARD_TRANSFER_RECEIPT_MISSING', 400);
  if (bytes.length > CARD_TRANSFER_RECEIPT_MAX_BYTES) throw new AccountBillingError('CARD_TRANSFER_RECEIPT_TOO_LARGE', 413);
  if (sniffMime(bytes) !== mime) throw new AccountBillingError('CARD_TRANSFER_RECEIPT_TYPE', 400);

  const sb = getServiceClient(config);
  // Abuse limits: a few requests awaiting review, a handful a day.
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const { data: recent, error: recentError } = await sb
    .from(TABLE)
    .select('status, created_at')
    .eq('workspace_id', input.workspaceId)
    .gte('created_at', since);
  if (recentError) dbFail(recentError, 'recent read');
  const { count: pendingCount, error: pendingError } = await sb
    .from(TABLE)
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', input.workspaceId)
    .eq('status', 'pending');
  if (pendingError) dbFail(pendingError, 'pending count');
  if ((pendingCount ?? 0) >= CARD_TRANSFER_MAX_PENDING) throw new AccountBillingError('CARD_TRANSFER_TOO_MANY_PENDING', 429);
  if ((recent ?? []).length >= CARD_TRANSFER_MAX_PER_DAY) throw new AccountBillingError('CARD_TRANSFER_TOO_MANY', 429);

  if (reference) {
    const { data: used, error: usedError } = await sb
      .from(TABLE)
      .select('id')
      .eq('reference', reference)
      .in('status', ['pending', 'approved'])
      .limit(1);
    if (usedError) dbFail(usedError, 'reference read');
    if ((used ?? []).length > 0) throw new AccountBillingError('CARD_TRANSFER_REFERENCE_USED', 409);
  }

  const settingsRow = await getBillingSettings(config, 'iran');
  const taxPercent = vatPercentFor(settingsRow.vat_percent, 'IRR');
  const charge = chargeFor(input.netMinor, taxPercent);

  const requestId = crypto.randomUUID();
  const fileName = `receipt.${EXTENSION[mime]}`;
  const receiptKey = platformCardTransferReceiptKey({ workspaceId: input.workspaceId, requestId, fileName });
  const uploaded = await uploadForOwner(config, {
    owner: { kind: 'platform' },
    fileKey: receiptKey,
    data: bytes,
    contentType: mime,
  });
  if (!uploaded.success) {
    console.error('[card-transfer] receipt upload failed:', uploaded.error);
    throw new AccountBillingError('CARD_TRANSFER_RECEIPT_UPLOAD_FAILED', UPSTREAM_FAILURE_STATUS);
  }

  const { data, error } = await sb
    .from(TABLE)
    .insert({
      id: requestId,
      workspace_id: input.workspaceId,
      created_by: input.userId,
      currency: 'IRR',
      net_minor: charge.net,
      tax_minor: charge.tax,
      tax_percent: taxPercent,
      amount_minor: charge.total,
      reference: reference || null,
      paid_at: paidAt,
      payer_card_last4: last4 || null,
      note,
      receipt_key: receiptKey,
      receipt_mime: mime,
      receipt_size: bytes.length,
      receipt_name: String(input.receipt.fileName || '').slice(0, 200) || null,
    })
    .select(COLUMNS)
    .single();
  if (error) {
    // The file is useless without its row.
    void deleteForOwner(config, { kind: 'platform' }, receiptKey).catch(() => undefined);
    if (error.code === '23505') throw new AccountBillingError('CARD_TRANSFER_REFERENCE_USED', 409);
    dbFail(error, 'insert');
  }
  return toRequest(asRecord(data));
}

export async function listCardTransfers(config: ServerConfig, workspaceId: string, limit = 20): Promise<CardTransferRequest[]> {
  const { data, error } = await getServiceClient(config)
    .from(TABLE)
    .select(COLUMNS)
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) dbFail(error, 'list');
  return (data ?? []).map((r) => toRequest(asRecord(r)));
}

/** The workspace withdraws a request still awaiting review. */
export async function cancelCardTransfer(config: ServerConfig, workspaceId: string, requestId: string): Promise<CardTransferRequest> {
  const { data, error } = await getServiceClient(config)
    .from(TABLE)
    .update({ status: 'canceled', updated_at: new Date().toISOString() })
    .eq('id', requestId)
    .eq('workspace_id', workspaceId)
    .eq('status', 'pending')
    .select(COLUMNS)
    .maybeSingle();
  if (error) dbFail(error, 'cancel');
  if (!data) throw new AccountBillingError('CARD_TRANSFER_NOT_PENDING', 409);
  return toRequest(asRecord(data));
}

/** The receipt file, for its workspace (pass workspaceId) or a Super Admin (omit it). */
export async function readCardTransferReceipt(
  config: ServerConfig,
  requestId: string,
  workspaceId?: string,
): Promise<{ data: Buffer; mime: string; fileName: string }> {
  if (!/^[0-9a-f-]{36}$/i.test(requestId)) throw new AccountBillingError('CARD_TRANSFER_NOT_FOUND', 404);
  let query = getServiceClient(config).from(TABLE).select('id, workspace_id, receipt_key, receipt_mime').eq('id', requestId);
  if (workspaceId) query = query.eq('workspace_id', workspaceId);
  const { data, error } = await query.maybeSingle();
  if (error) dbFail(error, 'receipt read');
  const row = asRecord(data);
  if (!row.id) throw new AccountBillingError('CARD_TRANSFER_NOT_FOUND', 404);
  const mime = String(row.receipt_mime);
  const file = await downloadForOwner(config, { kind: 'platform' }, String(row.receipt_key));
  if (!file.success || !file.data) throw new AccountBillingError('CARD_TRANSFER_RECEIPT_UNAVAILABLE', UPSTREAM_FAILURE_STATUS);
  return { data: Buffer.from(file.data), mime, fileName: `receipt-${requestId.slice(0, 8)}.${EXTENSION[mime] ?? 'bin'}` };
}

// ─── Review (Super Admin) ──────────────────────────────────────────────────

export interface AdminCardTransfer extends CardTransferRequest {
  workspace_name: string | null;
  workspace_slug: string | null;
  requester_email: string | null;
}

export async function listAdminCardTransfers(
  config: ServerConfig,
  opts: { status?: CardTransferStatus | 'all'; limit?: number } = {},
): Promise<{ items: AdminCardTransfer[]; pending: number }> {
  const sb = getServiceClient(config);
  let query = sb.from(TABLE).select(COLUMNS).order('created_at', { ascending: opts.status === 'pending' }).limit(Math.min(200, opts.limit ?? 100));
  if (opts.status && opts.status !== 'all') query = query.eq('status', opts.status);
  const { data, error } = await query;
  if (error) dbFail(error, 'admin list');
  const rows = (data ?? []).map((r) => asRecord(r));
  const workspaceIds = [...new Set(rows.map((r) => String(r.workspace_id)))];
  const userIds = [...new Set(rows.map((r) => str(r.created_by)).filter((v): v is string => Boolean(v)))];
  const [workspaces, profiles, pending] = await Promise.all([
    workspaceIds.length
      ? sb.from('workspaces').select('id, name, slug').in('id', workspaceIds)
      : Promise.resolve({ data: [], error: null }),
    userIds.length
      ? sb.from('profiles').select('id, email').in('id', userIds)
      : Promise.resolve({ data: [], error: null }),
    sb.from(TABLE).select('id', { count: 'exact', head: true }).eq('status', 'pending'),
  ]);
  const wsById = new Map((workspaces.data ?? []).map((w) => [String(asRecord(w).id), asRecord(w)]));
  const emailById = new Map((profiles.data ?? []).map((p) => [String(asRecord(p).id), str(asRecord(p).email)]));
  return {
    items: rows.map((r) => {
      const ws = wsById.get(String(r.workspace_id));
      return {
        ...toRequest(r),
        workspace_name: str(ws?.name),
        workspace_slug: str(ws?.slug),
        requester_email: emailById.get(String(r.created_by)) ?? null,
      };
    }),
    pending: pending.count ?? 0,
  };
}

const APPROVE_ERRORS: Record<string, [string, number]> = {
  card_transfer_not_found: ['CARD_TRANSFER_NOT_FOUND', 404],
  card_transfer_not_pending: ['CARD_TRANSFER_NOT_PENDING', 409],
  card_transfer_not_available: ['CARD_TRANSFER_UNAVAILABLE', 409],
  card_transfer_amount_invalid: ['TOPUP_AMOUNT_INVALID', 400],
  billing_payment_reference_reused: ['PAYMENT_REFERENCE_REUSED', 409],
  billing_account_currency_mismatch: ['CURRENCY_CHANGED', 409],
};

/**
 * Credits the wallet with `netMinor` (default: what was asked for), plus its
 * receipt. The admin may credit a different amount when the transfer did not
 * match; VAT is recomputed on it. Idempotent.
 */
export async function approveCardTransfer(
  config: ServerConfig,
  input: { requestId: string; adminId: string; netMinor?: number; ipAddress?: string | null },
): Promise<{ replayed: boolean; ledger_id: string | null; receipt_number: string | null; balance_minor: number | null }> {
  const sb = getServiceClient(config);
  const { data: reqRow, error: readError } = await sb.from(TABLE).select(COLUMNS).eq('id', input.requestId).maybeSingle();
  if (readError) dbFail(readError, 'approve read');
  if (!reqRow) throw new AccountBillingError('CARD_TRANSFER_NOT_FOUND', 404);
  const request = toRequest(asRecord(reqRow));
  const netMinor = input.netMinor ?? request.net_minor;
  const problem = topupAmountProblem(netMinor, request.currency);
  if (problem) throw new AccountBillingError(problem, 400);
  const settings = await getBillingSettings(config, 'iran');
  const taxPercent = vatPercentFor(settings.vat_percent, request.currency);
  const charge = chargeFor(netMinor, taxPercent);

  const { data, error } = await sb.rpc('billing_card_transfer_approve', {
    p_request_id: input.requestId,
    p_admin_id: input.adminId,
    p_net_minor: charge.net,
    p_tax_minor: charge.tax,
    p_tax_percent: taxPercent,
  });
  if (error) {
    const key = Object.keys(APPROVE_ERRORS).find((k) => String(error.message ?? '').includes(k));
    if (key) {
      const [code, status] = APPROVE_ERRORS[key];
      throw new AccountBillingError(code, status);
    }
    dbFail(error, 'approve');
  }
  const result = asRecord(data);
  const replayed = result.replayed === true;
  if (!replayed) {
    // The receipt mail, exactly as after a gateway payment.
    void import('./effects.js')
      .then((m) => m.afterAccountSettlement(config, result as never))
      .catch((e) => console.warn('[card-transfer] after settlement:', e instanceof Error ? e.message : e));
    await insertAuditLogRows(config, sb, {
      workspace_id: request.workspace_id,
      user_id: input.adminId,
      action: 'billing.card_transfer_approved',
      entity_type: 'billing_card_transfer',
      entity_id: request.id,
      new_value: {
        net_minor: charge.net,
        tax_minor: charge.tax,
        asked_net_minor: request.net_minor,
        reference: request.reference,
        ledger_id: str(result.ledger_id),
        receipt_number: str(result.receipt_number),
      },
      ip_address: input.ipAddress ?? null,
    }).catch(() => undefined);
  }
  return {
    replayed,
    ledger_id: str(result.ledger_id),
    receipt_number: str(result.receipt_number),
    balance_minor: typeof result.balance_minor === 'number' ? result.balance_minor : null,
  };
}

export async function rejectCardTransfer(
  config: ServerConfig,
  input: { requestId: string; adminId: string; reason: string; ipAddress?: string | null },
): Promise<CardTransferRequest> {
  const reason = String(input.reason ?? '').trim();
  if (reason.length < 3 || reason.length > 500) throw new AccountBillingError('CARD_TRANSFER_REASON_INVALID', 400);
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from(TABLE)
    .update({
      status: 'rejected',
      review_note: reason,
      reviewed_by: input.adminId,
      reviewed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', input.requestId)
    .eq('status', 'pending')
    .select(COLUMNS)
    .maybeSingle();
  if (error) dbFail(error, 'reject');
  if (!data) throw new AccountBillingError('CARD_TRANSFER_NOT_PENDING', 409);
  const request = toRequest(asRecord(data));
  await insertAuditLogRows(config, sb, {
    workspace_id: request.workspace_id,
    user_id: input.adminId,
    action: 'billing.card_transfer_rejected',
    entity_type: 'billing_card_transfer',
    entity_id: request.id,
    new_value: { reason, net_minor: request.net_minor, reference: request.reference },
    ip_address: input.ipAddress ?? null,
  }).catch(() => undefined);
  return request;
}
