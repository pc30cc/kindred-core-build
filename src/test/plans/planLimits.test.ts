/**
 * shared/planLimits.ts — the plan values every surface reads the same way
 * (migration 271): storage in MB with storage_gb × 1024 as the fallback, and
 * the monthly AI credit as billing_plan_ai_allowance reads a plan.
 */
import { describe, expect, it } from 'vitest';
import {
  gbToMb,
  planAiAllowance,
  storageLimitMb,
  storageLimitsForSave,
  withLegacyStorageGb,
  withStorageMb,
} from '../../../shared/planLimits';
import { formatBytesAsMb, formatMb } from '@/lib/storageUnits';

describe('storage in MB', () => {
  it('reads storage_mb, else storage_gb × 1024; -1 stays unlimited', () => {
    expect(storageLimitMb({ storage_mb: 512 })).toBe(512);
    expect(storageLimitMb({ storage_mb: 512, storage_gb: 50 })).toBe(512);
    expect(storageLimitMb({ storage_gb: 50 })).toBe(51200);
    expect(storageLimitMb({ storage_gb: 2.5 })).toBe(2560);
    expect(storageLimitMb({ storage_gb: 0 })).toBe(0);
    expect(storageLimitMb({ storage_gb: -1 })).toBe(-1);
    expect(storageLimitMb({ storage_mb: -5 })).toBe(-1);
    expect(storageLimitMb({ storage_gb: '3' })).toBe(3072);
    expect(storageLimitMb({})).toBeNull();
    expect(storageLimitMb(null)).toBeNull();
    expect(gbToMb(-3)).toBe(-1);
  });

  it('fills storage_mb in without touching anything else', () => {
    const plain = { max_agents: 2 };
    expect(withStorageMb(plain)).toBe(plain);
    expect(withStorageMb({ storage_gb: 1, max_agents: 2 })).toEqual({ storage_gb: 1, storage_mb: 1024, max_agents: 2 });
    expect(withStorageMb({ storage_gb: 1, storage_mb: 10 })).toEqual({ storage_gb: 1, storage_mb: 10 });
  });

  it('derives storage_gb for public readers that still read GB, never overriding a stored one', () => {
    expect(withLegacyStorageGb({ storage_mb: 512 })).toEqual({ storage_mb: 512, storage_gb: 0.5 });
    expect(withLegacyStorageGb({ storage_mb: -1 })).toEqual({ storage_mb: -1, storage_gb: -1 });
    expect(withLegacyStorageGb({ storage_mb: 2048, storage_gb: 9 })).toEqual({ storage_mb: 2048, storage_gb: 9 });
    expect(withLegacyStorageGb({ max_agents: 1 })).toEqual({ max_agents: 1 });
  });

  it('saves storage_mb only', () => {
    expect(storageLimitsForSave({ storage_gb: 2, max_agents: 1 })).toEqual({ storage_mb: 2048, max_agents: 1 });
    expect(storageLimitsForSave({ storage_gb: 2, storage_mb: 100 })).toEqual({ storage_mb: 100 });
    expect(storageLimitsForSave({ max_agents: 1 })).toEqual({ max_agents: 1 });
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
