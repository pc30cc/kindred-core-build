/**
 * The "expires at" field of Super Admin's assign-plan dialog (UsersPage).
 *
 * The field is a date input (YYYY-MM-DD), but a subscription ends at a
 * moment. Pre-filling it with the running period's end and sending the
 * field back as that day's 00:00 UTC would shorten the period by up to a
 * day, and an end later today would become a moment already past, which the
 * assign route refuses (INVALID_EXPIRES_AT). So the pre-fill keeps the exact
 * end, and an untouched field sends it back unchanged.
 */
export interface ExpiryPrefill {
  /** What the date input shows. */
  date: string;
  /** The period's exact end, sent when the field is left as shown. */
  iso: string;
}

/** The pre-fill for a period ending at `periodEnd`: none when it is not in the future. */
export function assignExpiryPrefill(periodEnd: string | null | undefined, now: number = Date.now()): ExpiryPrefill | null {
  if (!periodEnd) return null;
  const end = new Date(periodEnd);
  if (Number.isNaN(end.getTime()) || end.getTime() <= now) return null;
  return { date: end.toISOString().slice(0, 10), iso: end.toISOString() };
}

/**
 * The `expiresAt` the dialog sends: the exact end when the field still shows
 * the pre-fill, else the chosen day (00:00 UTC), else nothing (the route
 * then assigns one interval from now).
 */
export function assignExpiresAt(field: string, prefill: ExpiryPrefill | null): string | undefined {
  if (!field) return undefined;
  if (prefill && field === prefill.date) return prefill.iso;
  const chosen = new Date(field);
  return Number.isNaN(chosen.getTime()) ? undefined : chosen.toISOString();
}
