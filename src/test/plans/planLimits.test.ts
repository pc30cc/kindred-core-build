/**
 * shared/planLimits.ts — the plan values every surface reads the same way:
 * storage in MB (storage_mb only, migration 272), and the monthly AI credit
 * as billing_plan_ai_allowance reads a plan.
 */
import { describe, expect, it } from 'vitest';
import { mbToGb, planAiAllowance, storageLimitMb } from '../../../shared/planLimits';
import { formatBytesAsMb, formatMb } from '@/lib/storageUnits';

describe('storage in MB', () => {
  it('reads storage_mb only; -1 stays unlimited', () => {
    expect(storageLimitMb({ storage_mb: 512 })).toBe(512);
    expect(storageLimitMb({ storage_mb: '3' })).toBe(3);
    expect(storageLimitMb({ storage_mb: 0 })).toBe(0);
    expect(storageLimitMb({ storage_mb: -5 })).toBe(-1);
    // The GB key is gone (272): it is not read.
    expect(storageLimitMb({ storage_gb: 50 })).toBeNull();
    expect(storageLimitMb({})).toBeNull();
    expect(storageLimitMb(null)).toBeNull();
  });

  it('computes GB from MB for outside readers only; -1 stays unlimited', () => {
    expect(mbToGb(512)).toBe(0.5);
    expect(mbToGb(51200)).toBe(50);
    expect(mbToGb(-1)).toBe(-1);
  });

  it('formats megabytes for people: "512 MB", "1,024 MB", Persian مگابایت', () => {
    expect(formatMb(512, 'en')).toBe('512 MB');
    expect(formatMb(1024, 'en')).toBe('1,024 MB');
    expect(formatMb(51200, 'tr')).toBe('51.200 MB');
    expect(formatMb(1024, 'fa')).toBe('۱٬۰۲۴ مگابایت');
    expect(formatMb(-1, 'en', 'Unlimited')).toBe('Unlimited');
    expect(formatMb(0.4, 'en')).toBe('0.4 MB');
    expect(formatMb(0.01, 'en')).toBe('< 0.1 MB');
    expect(formatBytesAsMb(5 * 1024 * 1024, 'en')).toBe('5 MB');
    expect(formatBytesAsMb(0, 'en')).toBe('0 MB');
  });
});

describe('the monthly AI credit of a plan', () => {
  it('is ai_allowance.IRR first, as the grant reads it — never the legacy count beside it', () => {
    // Startup on production: ai_credits_per_month 0, ai_allowance 300,000.
    expect(planAiAllowance({ ai_allowance: { IRR: 300_000 }, limits: { ai_credits_per_month: 0 } })).toBe(300_000);
    expect(planAiAllowance({ ai_allowance: {}, limits: { included_ai_allowance_irr: 1234, ai_credits_per_month: 9 } })).toBe(1234);
    expect(planAiAllowance({ ai_allowance: { USD: 5 }, limits: { ai_credits_per_month: 7000 } })).toBe(7000);
    expect(planAiAllowance({ limits: { ai_credits_per_month: -1 } })).toBe(0);
    expect(planAiAllowance(null)).toBe(0);
  });
});
