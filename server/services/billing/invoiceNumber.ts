// ============================================================
// INVOICE NUMBERS — human-facing identifier for every invoice.
//
// Format: two random uppercase letters + eight random digits (e.g. "KP48302917").
// The letter prefix varies per invoice (it is NOT a fixed series), the digits
// are cryptographically random, and uniqueness is guaranteed by the unique
// index `uq_billing_payment_intents_invoice_number`. This module only avoids
// obvious collisions up-front so the insert practically never fails.
// ============================================================

import { randomInt } from 'node:crypto';
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

// Visually unambiguous alphabet (no I/O to avoid 1/0 confusion on receipts).
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

export function generateInvoiceNumber(): string {
  const a = LETTERS[randomInt(0, LETTERS.length)];
  const b = LETTERS[randomInt(0, LETTERS.length)];
  let digits = '';
  for (let i = 0; i < 8; i += 1) digits += String(randomInt(0, 10));
  return `${a}${b}${digits}`;
}

/** Returns a number that is not already used by another invoice. */
export async function issueInvoiceNumber(config: ServerConfig): Promise<string> {
  const supabase = getServiceClient(config);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = generateInvoiceNumber();
    const { data, error } = await supabase
      .from('billing_payment_intents')
      .select('id')
      .eq('invoice_number', candidate)
      .maybeSingle();
    if (error) break; // fall through: the unique index is the real guarantee
    if (!data) return candidate;
  }
  return generateInvoiceNumber();
}
