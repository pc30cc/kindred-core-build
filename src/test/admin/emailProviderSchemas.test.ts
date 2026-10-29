/**
 * The Super Admin's email vendor forms (src/features/providers/schemas.ts)
 * are built from the lists the server sends with (shared/emailProviders.ts):
 * the same fields, the secrets as password inputs, the same required ones.
 * Only those vendors can be saved; the rest are listed as not available.
 * The email type allows no workspace override (the server never resolves
 * one), and the auth vendor has no "Auth SMTP" fields (nothing read them).
 */
import { describe, it, expect } from 'vitest';
import { PROVIDER_SCHEMAS, getVendorSchema } from '@/features/providers/schemas';
import {
  EMAIL_PROVIDER_ADAPTERS,
  EMAIL_PROVIDER_COMMON_FIELDS,
  EMAIL_PROVIDER_FIELDS,
  EMAIL_PROVIDER_REQUIRED_FIELDS,
  EMAIL_PROVIDER_SECRET_FIELDS,
  SMTP_ENCRYPTION_MODES,
} from '../../../shared/emailProviders';

describe('email vendor forms', () => {
  it.each(EMAIL_PROVIDER_ADAPTERS)('%s offers exactly the fields its adapter reads', (name) => {
    const vendor = getVendorSchema('email', name)!;
    expect(vendor.comingSoon).toBeFalsy();
    expect(vendor.fields.map((f) => f.key).sort()).toEqual([...EMAIL_PROVIDER_FIELDS[name], ...EMAIL_PROVIDER_COMMON_FIELDS].sort());
    for (const field of vendor.fields) {
      const secret = EMAIL_PROVIDER_SECRET_FIELDS[name].includes(field.key);
      expect(field.type === 'password', `${name}.${field.key} password`).toBe(secret);
      const required = field.key === 'from_email' || EMAIL_PROVIDER_REQUIRED_FIELDS[name].includes(field.key);
      expect(!!field.required, `${name}.${field.key} required`).toBe(required);
    }
  });

  it('SMTP chooses its encryption (no "Use TLS" switch) and takes its password as typed', () => {
    const smtp = getVendorSchema('email', 'smtp')!;
    expect(smtp.fields.some((f) => f.key === 'smtp_secure' || f.type === 'toggle')).toBe(false);
    const encryption = smtp.fields.find((f) => f.key === 'encryption')!;
    expect(encryption.type).toBe('select');
    expect(encryption.options!.map((o) => o.value).sort()).toEqual([...SMTP_ENCRYPTION_MODES].sort());
    expect(encryption.defaultValue).toBe('auto');
    expect(smtp.fields.find((f) => f.key === 'smtp_pass')!.verbatim).toBe(true);
  });

  it('every other vendor is listed as not available, so it can never be saved', () => {
    const others = PROVIDER_SCHEMAS.email.vendors.filter((v) => !(EMAIL_PROVIDER_ADAPTERS as readonly string[]).includes(v.name));
    expect(others.map((v) => v.name).sort()).toEqual(['brevo', 'mailgun', 'mailtrap', 'postmark', 'ses', 'sparkpost']);
    for (const vendor of others) expect(vendor.comingSoon, vendor.name).toBe(true);
  });

  it('email is platform-wide: no workspace override is offered', () => {
    expect(PROVIDER_SCHEMAS.email.allowWorkspaceOverride).toBe(false);
  });

  it('the self-hosted auth vendor has no SMTP fields', () => {
    const vendor = getVendorSchema('auth', 'supabase_self_hosted')!;
    expect(vendor.fields.filter((f) => f.key.startsWith('smtp_'))).toEqual([]);
  });
});
