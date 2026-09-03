// ============================================================
// PROFORMA DOCUMENT NUMBERS — the human-facing identifier of every
// pre-payment document ("پیش‌فاکتور") the customer sees.
//
// Format (canonical): ^[A-Z]{2}[0-9]{8}$ — two RANDOM uppercase letters (the
// prefix is NOT a fixed series) followed by eight random digits, e.g.
// "QF58392017".
//
// Financial identifiers are never generated with Math.random(): the digits and
// letters come from Node's CSPRNG (`node:crypto.randomInt`).
//
// Uniqueness is enforced by the DATABASE (unique index on
// `billing_payment_intents.invoice_number`). A check-before-insert is racy, so
// this module instead uses insert-and-retry: generate → insert → on a unique
// violation generate a fresh candidate → bounded retries → fail closed.
//
// NOTE ON NAMING: this is a proforma / order number, NOT a legal tax invoice
// number. A future formal invoice (سامانه مؤدیان) must get its own contract.
// ============================================================

import { randomInt } from 'node:crypto';

/** Visually unambiguous alphabet (no I/O so receipts cannot be misread). */
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

export const DOCUMENT_NUMBER_PATTERN = /^[A-Z]{2}[0-9]{8}$/;

export function generateDocumentNumber(): string {
  const a = LETTERS[randomInt(0, LETTERS.length)];
  const b = LETTERS[randomInt(0, LETTERS.length)];
  let digits = '';
  for (let i = 0; i < 8; i += 1) digits += String(randomInt(0, 10));
  return `${a}${b}${digits}`;
}

/** Back-compat alias — the value is the same document number. */
export const generateInvoiceNumber = generateDocumentNumber;

export interface InsertResult<T> {
  data: T | null;
  error: { code?: string | null; message?: string | null } | null;
}

function isDocumentNumberCollision(error: InsertResult<unknown>['error']): boolean {
  if (!error) return false;
  const code = String(error.code || '');
  const message = String(error.message || '');
  if (code !== '23505' && !/duplicate key/i.test(message)) return false;
  // Only a collision on the document-number index may be retried; any other
  // unique violation (e.g. one payment per intent) is a real error.
  return /invoice_number|document_number/i.test(message) || !/uq_|_key\b/.test(message);
}

/**
 * Inserts a row that carries a freshly issued document number, retrying with a
 * NEW candidate whenever the database rejects it as a duplicate. Fails closed
 * after `maxAttempts` — an abnormal number of collisions means something is
 * wrong and must never degrade into a silent duplicate.
 */
export async function insertWithDocumentNumber<T>(
  insert: (documentNumber: string) => Promise<InsertResult<T>>,
  maxAttempts = 6,
): Promise<T> {
  let lastError: InsertResult<T>['error'] = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidate = generateDocumentNumber();
    const { data, error } = await insert(candidate);
    if (!error && data) return data;
    lastError = error;
    if (!isDocumentNumberCollision(error)) break;
  }
  throw new Error(lastError?.message || 'Failed to issue a unique document number');
}
