/**
 * Which billing engine the product exposes.
 *
 * Billing v2 (invoices, dunning, the 5-minute scheduler) is being replaced by
 * the simple prepaid-account billing in docs/billing/SIMPLE_BILLING.md. Until
 * that ships, v2 is hidden: its workspace page and Super Admin finance tabs
 * are not shown and its scheduler does not run, so it issues no invoices and
 * sends no notices. Its code, routes and data stay untouched, and every
 * workspace keeps the plan it has. Callbacks of payments already started still
 * land, because the routes stay mounted.
 */
export const LEGACY_BILLING_ENABLED = false;
