/**
 * Card-to-card wallet top-up (Iranian edition): the bank account the money
 * goes to, and the checks both the browser and the server run on it.
 * Migration 274; server/services/billing/account/cardTransfer.ts.
 */

/** The bank account shown to the payer. Stored in billing_settings.card_transfer. */
export interface CardTransferSettings {
  enabled: boolean;
  /** The account holder's name, as the bank shows it on a transfer. */
  holder_name: string;
  /** 16 digits, no separators. */
  card_number: string;
  /** IR + 24 digits, no separators. */
  iban: string;
  /** The bank's name as shown on the card (e.g. «بلوبانک»). */
  bank: string;
}

export const EMPTY_CARD_TRANSFER: CardTransferSettings = {
  enabled: false,
  holder_name: '',
  card_number: '',
  iban: '',
  bank: 'بلوبانک',
};

/** Persian/Arabic digits to Latin, everything else dropped. */
export function latinDigits(value: unknown): string {
  return String(value ?? '')
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/\D/g, '');
}

/** Luhn checksum, as every Iranian bank card number carries. */
export function luhnValid(digits: string): boolean {
  if (!/^\d{12,19}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** A 16-digit card number with a valid checksum, or null. */
export function normalizeCardNumber(value: unknown): string | null {
  const digits = latinDigits(value);
  return digits.length === 16 && luhnValid(digits) ? digits : null;
}

/** ISO 13616 mod-97 check of an IBAN (letters as numbers, check digits moved to the end). */
function ibanChecksumValid(iban: string): boolean {
  const moved = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of moved) {
    const chunk = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
    for (const digit of chunk) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

/** An Iranian IBAN (شبا): IR + 24 digits with a valid checksum, or null. */
export function normalizeIban(value: unknown): string | null {
  const raw = String(value ?? '').toUpperCase().replace(/[\s-]/g, '');
  const digits = latinDigits(raw.replace(/^IR/, ''));
  const iban = `IR${digits}`;
  return /^IR\d{24}$/.test(iban) && ibanChecksumValid(iban) ? iban : null;
}

/** "6219861012345678" → "6219 8610 1234 5678". */
export function formatCardNumber(digits: string): string {
  return digits.replace(/(\d{4})(?=\d)/g, '$1 ');
}

/** "IR120620000000302876128001" → "IR12 0620 0000 0030 2876 1280 01". */
export function formatIban(iban: string): string {
  return iban.replace(/(.{4})(?=.)/g, '$1 ');
}

export type CardTransferSettingsProblem =
  | 'CARD_TRANSFER_HOLDER_INVALID'
  | 'CARD_TRANSFER_CARD_INVALID'
  | 'CARD_TRANSFER_IBAN_INVALID'
  | 'CARD_TRANSFER_BANK_INVALID';

/**
 * Cleans what the Super Admin entered. An enabled method needs every field;
 * a disabled one keeps what was typed so far as long as it is well formed.
 */
export function cleanCardTransferSettings(
  input: unknown,
): { ok: true; value: CardTransferSettings } | { ok: false; problem: CardTransferSettingsProblem } {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const enabled = raw.enabled === true;
  const holder = String(raw.holder_name ?? '').replace(/\s+/g, ' ').trim();
  const bank = String(raw.bank ?? '').replace(/\s+/g, ' ').trim() || EMPTY_CARD_TRANSFER.bank;
  const cardRaw = latinDigits(raw.card_number);
  const ibanRaw = String(raw.iban ?? '').trim();
  const card = cardRaw ? normalizeCardNumber(cardRaw) : '';
  const iban = ibanRaw ? normalizeIban(ibanRaw) : '';
  if (holder.length > 80 || (enabled && holder.length < 2)) return { ok: false, problem: 'CARD_TRANSFER_HOLDER_INVALID' };
  if (card === null || (enabled && !card)) return { ok: false, problem: 'CARD_TRANSFER_CARD_INVALID' };
  if (iban === null || (enabled && !iban)) return { ok: false, problem: 'CARD_TRANSFER_IBAN_INVALID' };
  if (bank.length > 40) return { ok: false, problem: 'CARD_TRANSFER_BANK_INVALID' };
  return { ok: true, value: { enabled, holder_name: holder, card_number: card || '', iban: iban || '', bank } };
}

/** Read back from the database: anything malformed reads as not set. */
export function readCardTransferSettings(stored: unknown): CardTransferSettings {
  const cleaned = cleanCardTransferSettings(stored);
  if (cleaned.ok === true) return cleaned.value;
  return { ...EMPTY_CARD_TRANSFER };
}

/** Whether the payer can be shown the method: enabled and complete. */
export function cardTransferReady(s: CardTransferSettings): boolean {
  return s.enabled && s.holder_name.length >= 2 && Boolean(s.card_number) && Boolean(s.iban);
}

/** The bank receipt: an image or a PDF, at most 5 MB. */
export const CARD_TRANSFER_RECEIPT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const;
export const CARD_TRANSFER_RECEIPT_MAX_BYTES = 5 * 1024 * 1024;
/** Requests awaiting review per workspace. */
export const CARD_TRANSFER_MAX_PENDING = 3;
/** Requests per workspace per day (any status). */
export const CARD_TRANSFER_MAX_PER_DAY = 10;

export type CardTransferStatus = 'pending' | 'approved' | 'rejected' | 'canceled';

/** A request as its workspace and the Super Admin see it. */
export interface CardTransferRequest {
  id: string;
  workspace_id: string;
  status: CardTransferStatus;
  currency: string;
  net_minor: number;
  tax_minor: number;
  amount_minor: number;
  reference: string | null;
  paid_at: string | null;
  payer_card_last4: string | null;
  note: string | null;
  receipt_mime: string;
  receipt_name: string | null;
  review_note: string | null;
  reviewed_at: string | null;
  ledger_id: string | null;
  created_at: string;
}
