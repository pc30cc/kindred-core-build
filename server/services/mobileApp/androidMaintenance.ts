/**
 * WHAT SUPER ADMIN ACCEPTS FOR THE ANDROID APP'S LANGUAGE AND MAINTENANCE.
 *
 * Set in Super Admin → Mobile App → Android → In-app settings (migration
 * 237), served to the app before sign-in by
 * GET /api/mobile-app/public-config?platform=android and, once signed in, by
 * GET /api/mobile-app/config — see toAndroidPublicConfig in ./settings.ts.
 *
 * Spread into the PUT schema in server/routes/adminMobileApp.ts, as the
 * Firebase client fields are, so the rules can be tested without the route.
 */
import { z } from 'zod';
import { ANDROID_LANGUAGES } from './settings.js';

/** Per language, as Play caps "What's new" — long enough for a notice, short enough for a phone. */
export const ANDROID_MAINTENANCE_MESSAGE_MAX = 500;

/**
 * `2026-09-29T10:00Z`, with optional seconds and fraction — what toISOString
 * writes, and what Postgres hands back (which may use a space for the `T`).
 * The offset is required: without one the server would read the time in its
 * own zone, which is nobody's.
 */
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?)$/;

/** Trimmed; a blank language is dropped rather than stored as "". */
const messageText = z.preprocess(
  (v) => (v == null ? undefined : v),
  z.string().trim().max(ANDROID_MAINTENANCE_MESSAGE_MAX).optional(),
);

export const androidLanguageMaintenanceFields = {
  android_default_language: z.enum(ANDROID_LANGUAGES).optional(),
  android_maintenance_enabled: z.boolean().optional(),
  // A notice switched on with no message is allowed: the app has its own
  // wording for it in every language.
  android_maintenance_message: z
    .object({ fa: messageText, en: messageText, tr: messageText })
    .transform((m) =>
      Object.fromEntries(Object.entries(m).filter(([, v]) => v)) as Partial<
        Record<(typeof ANDROID_LANGUAGES)[number], string>
      >,
    )
    .optional(),
  // An ISO date and time, or null (or "") for a notice with no end.
  android_maintenance_until: z
    .string()
    .trim()
    .refine((v) => v === '' || (ISO_DATE_TIME.test(v) && !Number.isNaN(Date.parse(v))), 'must be an ISO date and time')
    .transform((v) => (v === '' ? null : new Date(v).toISOString()))
    .nullable()
    .optional(),
};
