/**
 * shared/emailProviders.ts: the provider list every side reads (the Super
 * Admin form, the config store, readiness and the send path), so they agree
 * on what a provider needs, which fields are secrets, and what one address
 * is. And the registry has exactly the adapters the list names.
 */
import { describe, expect, it } from 'vitest';
import {
  EMAIL_PROVIDER_ADAPTERS,
  EMAIL_PROVIDER_FIELDS,
  EMAIL_PROVIDER_SECRET_FIELDS,
  SMTP_ENCRYPTION_MODES,
  canonicalEmailProviderConfig,
  emailProviderConfigProblems,
  parseEmailAddress,
  smtpEncryptionMode,
  withEmailProviderEnvFallbacks,
} from '../../../shared/emailProviders';
import { getEmailAdapter } from '../../../server/services/email/providers/index';

describe('the provider list', () => {
  it('names the contract\'s adapters, secrets and modes', () => {
    expect(EMAIL_PROVIDER_ADAPTERS).toEqual(['resend', 'sendgrid', 'smtp']);
    expect(EMAIL_PROVIDER_SECRET_FIELDS).toEqual({ resend: ['api_key', 'webhook_secret'], sendgrid: ['api_key'], smtp: ['smtp_pass', 'events_token'] });
    expect(SMTP_ENCRYPTION_MODES).toEqual(['auto', 'none', 'starttls', 'ssl']);
    for (const name of EMAIL_PROVIDER_ADAPTERS) {
      for (const secret of EMAIL_PROVIDER_SECRET_FIELDS[name]) expect(EMAIL_PROVIDER_FIELDS[name]).toContain(secret);
    }
    expect(EMAIL_PROVIDER_FIELDS.sendgrid).toContain('webhook_public_key');
  });

  it('the registry has one adapter per name, and none for anything else', () => {
    for (const name of EMAIL_PROVIDER_ADAPTERS) expect(getEmailAdapter(name)?.name).toBe(name);
    expect(getEmailAdapter(' SMTP ')?.name).toBe('smtp');
    for (const name of ['mailgun', 'ses', 'stub', '', null, undefined]) expect(getEmailAdapter(name as string)).toBeNull();
  });
});

describe('parseEmailAddress', () => {
  it.each(['a@b.co', 'first.last+tag@sub.example.com', "o'brien@example.ie", 'x@xn--mgbh0fb.xn--mgbai9azgqp6j', 'user@وب.ایران'])('%s is one address', (value) => {
    expect(parseEmailAddress(value)).toBe(value);
  });

  it.each([
    '', ' ', 'a', 'a@', '@b.co', 'a@b', 'a@b.123', 'a@-b.co', 'a.@b.co', '.a@b.co', 'a..b@c.co',
    'a@b.co,c@d.co', 'a@b.co;c@d.co', 'A <a@b.co>', '<a@b.co>', 'a b@c.co', '"a"@b.co', 'a@b.co\r\nBcc: x@y.co',
    `${'l'.repeat(65)}@b.co`,
  ])('%j is not', (value) => {
    expect(parseEmailAddress(value)).toBeNull();
  });

  it('trims, and refuses what is not a string', () => {
    expect(parseEmailAddress('  a@b.co ')).toBe('a@b.co');
    expect(parseEmailAddress(42)).toBeNull();
    expect(parseEmailAddress(null)).toBeNull();
  });
});

describe('SMTP encryption', () => {
  it.each([
    [{}, 'auto'],
    [{ smtp_port: '465' }, 'ssl'],
    [{ encryption: 'none' }, 'none'],
    [{ encryption: 'STARTTLS' }, 'starttls'],
    [{ encryption: 'starttls', smtp_port: 465 }, 'ssl'],
    [{ smtp_secure: 'true' }, 'starttls'],
    [{ smtp_secure: true, smtp_port: '465' }, 'ssl'],
    [{ smtp_secure: 'false' }, 'auto'],
    [{ encryption: 'whatever' }, 'auto'],
  ])('%j reads as %s', (cfg, mode) => {
    expect(smtpEncryptionMode(cfg)).toBe(mode);
  });

  it('older names fold into today\'s, and only when today\'s is blank', () => {
    expect(canonicalEmailProviderConfig('smtp', { smtp_username: 'u', smtp_password: 'p', smtp_secure: 'true', smtp_port: '587' }))
      .toEqual({ smtp_user: 'u', smtp_pass: 'p', encryption: 'starttls', smtp_port: '587' });
    expect(canonicalEmailProviderConfig('smtp', { smtp_user: 'new', smtp_username: 'old', encryption: 'none', smtp_secure: true }))
      .toEqual({ smtp_user: 'new', encryption: 'none' });
    expect(canonicalEmailProviderConfig('resend', { api_key: 'k', smtp_password: 'p' })).toEqual({ api_key: 'k', smtp_password: 'p' });
  });
});

describe('the environment fills a blank, never more', () => {
  it('per provider', () => {
    expect(withEmailProviderEnvFallbacks('resend', { api_key: 'db' }, { RESEND_API_KEY: 'env' }).api_key).toBe('db');
    expect(withEmailProviderEnvFallbacks('resend', { api_key: ' ' }, { RESEND_API_KEY: 'env' }).api_key).toBe('env');
    expect(withEmailProviderEnvFallbacks('smtp', {}, { SMTP_HOST: 'relay', SMTP_PASS: 'p' })).toEqual({ smtp_host: 'relay', smtp_pass: 'p' });
    expect(withEmailProviderEnvFallbacks('sendgrid', {}, { RESEND_API_KEY: 'x' })).toEqual({});
  });

  it('problems are reported per field, presence and shape only', () => {
    expect(emailProviderConfigProblems('smtp', { smtp_host: 'mail-relay', from_email: 'noreply@webyar.ai' })).toEqual([]);
    expect(emailProviderConfigProblems('smtp', {})).toEqual([
      { field: 'from_email', problem: 'missing' },
      { field: 'smtp_host', problem: 'missing' },
    ]);
    expect(emailProviderConfigProblems('smtp', { smtp_host: 'h', from_email: 'a@b.co', from_name: 'x\r\nBcc: y' }))
      .toEqual([{ field: 'from_name', problem: 'invalid' }]);
    expect(emailProviderConfigProblems('carrier-pigeon', {})).toEqual([{ field: 'provider_name', problem: 'invalid' }]);
  });
});
