/**
 * The Super Admin adjust rate limit is enforced twice: the backend's fast
 * read (adjustRateLimit.ts, ADJUST_RATE_LIMIT) and the booking itself
 * (billing_account_admin_adjust, migration 270). The two must agree, and the
 * SQL refusal must reach the admin as the same 429.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ADJUST_RATE_LIMIT } from '../../../../shared/simpleBillingAdmin';
import { adjustErrorOf } from '../../../../server/services/billing/account/adminReports';

const sql = readFileSync(resolve(process.cwd(), 'database/migrations/270_billing_admin_adjust_rate_limit.sql'), 'utf8');

describe('adjust rate limit in SQL (270)', () => {
  it('uses the same max and window as ADJUST_RATE_LIMIT', () => {
    const m = sql.match(/created_at >= clock_timestamp\(\) - interval '(\d+) hour'\) >= (\d+) THEN/);
    expect(m).not.toBeNull();
    expect(Number(m![1]) * 60 * 60 * 1000).toBe(ADJUST_RATE_LIMIT.windowMs);
    expect(Number(m![2])).toBe(ADJUST_RATE_LIMIT.max);
  });

  it('serializes per admin with a transaction lock', () => {
    expect(sql).toMatch(/pg_advisory_xact_lock\(hashtextextended\('billing_account_admin_adjust:' \|\| p_actor_id::text, 0\)\)/);
  });

  it('maps the SQL refusal to 429 TOO_MANY_ADJUSTMENTS', () => {
    const e = adjustErrorOf('ERROR: billing_adjust_rate_limited');
    expect(e).toMatchObject({ code: 'TOO_MANY_ADJUSTMENTS', status: 429 });
  });
});
