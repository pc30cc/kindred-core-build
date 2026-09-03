-- Invoice numbers for every checkout.
--
-- Every invoice the customer sees (and every settled payment) carries a
-- human-facing invoice number: two random uppercase letters + eight random
-- digits (e.g. "KP48302917"). The letter prefix varies per invoice; the number
-- is issued by the server (server/services/billing/invoiceNumber.ts) and its
-- uniqueness is enforced here, in the database.

ALTER TABLE public.billing_payment_intents ADD COLUMN IF NOT EXISTS invoice_number text;

CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_payment_intents_invoice_number
  ON public.billing_payment_intents(invoice_number)
  WHERE invoice_number IS NOT NULL;

ALTER TABLE public.billing_payments ADD COLUMN IF NOT EXISTS invoice_number text;

CREATE INDEX IF NOT EXISTS idx_billing_payments_invoice_number
  ON public.billing_payments(invoice_number)
  WHERE invoice_number IS NOT NULL;

COMMENT ON COLUMN public.billing_payment_intents.invoice_number IS
  'Human-facing invoice number (2 random letters + 8 digits), issued when the invoice preview is generated. Unique across all invoices.';
COMMENT ON COLUMN public.billing_payments.invoice_number IS
  'Invoice number snapshot copied from the payment intent at settlement time.';
