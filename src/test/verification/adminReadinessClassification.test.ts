/**
 * Generic Verification Core Super Admin readiness — provider classification.
 * Pure-function unit tests for classifyEmailProviderConfig/
 * classifySmsProviderInfo (server/services/verification/readiness.ts):
 * readiness must distinguish unconfigured/configured/invalid/unavailable
 * using only safe booleans, never a provider credential's actual value.
 * 'unavailable' (the DB query itself failing) is exercised in the real-
 * Postgres integration suite, not here, since it needs a genuine
 * connection failure to trigger.
 */
import { describe, it, expect } from 'vitest';
import { classifyEmailProviderConfig, classifySmsProviderInfo } from '../../../server/services/verification/readiness';
import type { SmsProviderInfo } from '../../../server/services/sms/types';

describe('Generic Verification Core admin readiness — email provider classification', () => {
  it('no stored row is unconfigured', () => {
    expect(classifyEmailProviderConfig(null)).toBe('unconfigured');
    expect(classifyEmailProviderConfig(undefined)).toBe('unconfigured');
  });

  it('an explicit disabled provider_name is unconfigured', () => {
    expect(classifyEmailProviderConfig({ provider_name: 'disabled' })).toBe('unconfigured');
  });

  /** Every provider needs a sender; the cases below are about the rest. */
  const FROM = { from_email: 'noreply@example.com' };

  it('resend without an api_key (config, secrets, or env) is invalid', () => {
    expect(classifyEmailProviderConfig({ provider_name: 'resend', config: { ...FROM } }, {})).toBe('invalid');
  });

  it('resend with an api_key in config is configured', () => {
    expect(classifyEmailProviderConfig({ provider_name: 'resend', config: { ...FROM, api_key: 're_123' } }, {})).toBe('configured');
  });

  it('resend with the api_key only in secrets is configured, encrypted or (older rows) not', () => {
    expect(classifyEmailProviderConfig({ provider_name: 'resend', config: { ...FROM }, secrets: { api_key: 're_123' } }, {})).toBe('configured');
    const envelope = { algorithm: 'aes-256-gcm', key_version: 1, nonce: 'n', ciphertext: 'c', auth_tag: 't' };
    expect(classifyEmailProviderConfig({ provider_name: 'resend', config: { ...FROM }, secrets: { api_key: envelope } }, {})).toBe('configured');
  });

  it('resend with only the env var set is configured: the variable fills a blank', () => {
    expect(classifyEmailProviderConfig({ provider_name: 'resend', config: { ...FROM } }, { RESEND_API_KEY: 're_env' })).toBe('configured');
  });

  it('sendgrid without an api_key is invalid; with one, configured', () => {
    expect(classifyEmailProviderConfig({ provider_name: 'sendgrid', config: { ...FROM } }, {})).toBe('invalid');
    expect(classifyEmailProviderConfig({ provider_name: 'sendgrid', config: { ...FROM, api_key: 'sg_1' } }, {})).toBe('configured');
  });

  it('smtp without a host is invalid; with one, configured', () => {
    expect(classifyEmailProviderConfig({ provider_name: 'smtp', config: { ...FROM } }, {})).toBe('invalid');
    expect(classifyEmailProviderConfig({ provider_name: 'smtp', config: { ...FROM, smtp_host: 'smtp.example.com' } }, {})).toBe('configured');
  });

  it('the production relay row as stored on 2026-10-29 is configured', () => {
    expect(classifyEmailProviderConfig({
      provider_name: 'smtp',
      config: { smtp_host: 'mail-relay', smtp_port: '587', smtp_user: 'noreply@webyar.ai', smtp_pass: 'x-secret', from_email: 'noreply@webyar.ai', from_name: 'Webyar' },
    }, {})).toBe('configured');
  });

  it('no provider is configured without a valid sender address', () => {
    for (const config of [{ api_key: 're_1' }, { api_key: 're_1', from_email: 'not an address' }, { api_key: 're_1', from_email: 'a@b.com, c@d.com' }]) {
      expect(classifyEmailProviderConfig({ provider_name: 'resend', config }, {}), JSON.stringify(config)).toBe('invalid');
    }
  });

  it('an smtp user without its password is invalid (a wiped password cannot sign in)', () => {
    expect(classifyEmailProviderConfig({ provider_name: 'smtp', config: { ...FROM, smtp_host: 'mail-relay', smtp_user: 'u' } }, {})).toBe('invalid');
    expect(classifyEmailProviderConfig({ provider_name: 'smtp', config: { ...FROM, smtp_host: 'mail-relay', smtp_user: 'u' } }, { SMTP_PASS: 'p' })).toBe('configured');
  });

  it('an smtp port or encryption that cannot work is invalid', () => {
    expect(classifyEmailProviderConfig({ provider_name: 'smtp', config: { ...FROM, smtp_host: 'h', smtp_port: '99999' } }, {})).toBe('invalid');
    expect(classifyEmailProviderConfig({ provider_name: 'smtp', config: { ...FROM, smtp_host: 'h', encryption: 'tls13' } }, {})).toBe('invalid');
    expect(classifyEmailProviderConfig({ provider_name: 'smtp', config: { ...FROM, smtp_host: 'h', encryption: 'starttls' } }, {})).toBe('configured');
  });

  it('an unrecognized provider_name is invalid, not configured', () => {
    expect(classifyEmailProviderConfig({ provider_name: 'carrier-pigeon', config: { ...FROM, api_key: 'x' } }, {})).toBe('invalid');
    // the old form's vendors without a server adapter
    for (const name of ['mailgun', 'ses', 'postmark', 'sparkpost', 'mailtrap', 'brevo', 'stub']) {
      expect(classifyEmailProviderConfig({ provider_name: name, config: { ...FROM, api_key: 'x' } }, {}), name).toBe('invalid');
    }
  });

  it('never returns configured for an empty-string credential', () => {
    expect(classifyEmailProviderConfig({ provider_name: 'resend', config: { ...FROM, api_key: '   ' } }, {})).toBe('invalid');
  });
});

function smsInfo(overrides: Partial<SmsProviderInfo>): SmsProviderInfo {
  return {
    providerName: 'disabled',
    configured: false,
    enabled: false,
    hasApiKey: false,
    sender: null,
    verifyTemplate: null,
    lineNumber: null,
    verifyTemplateId: null,
    verifyParameterName: null,
    verifyProfileId: null,
    channel: null,
    voiceFallback: null,
    updatedAt: null,
    ...overrides,
  };
}

describe('Generic Verification Core admin readiness — SMS provider classification', () => {
  it('no provider selected (disabled/absent) is unconfigured', () => {
    expect(classifySmsProviderInfo(smsInfo({ providerName: 'disabled' }))).toBe('unconfigured');
  });

  it('a provider selected but missing its api key is invalid, not unconfigured', () => {
    expect(classifySmsProviderInfo(smsInfo({ providerName: 'kavenegar', hasApiKey: false }))).toBe('invalid');
    expect(classifySmsProviderInfo(smsInfo({ providerName: 'smsir', hasApiKey: false }))).toBe('invalid');
  });

  // OTPs are sent through the vendor's VERIFICATION template, so readiness
  // must gate on the template fields `resolveProvider` really requires --
  // NOT on kavenegar's `sender`, which that send path treats as an optional
  // bulk-send override.
  it('kavenegar with an api key but no verify template is invalid', () => {
    expect(classifySmsProviderInfo(smsInfo({ providerName: 'kavenegar', hasApiKey: true, verifyTemplate: null }))).toBe('invalid');
  });

  it('kavenegar with an api key AND a verify template is configured, with or without a sender', () => {
    expect(classifySmsProviderInfo(smsInfo({ providerName: 'kavenegar', hasApiKey: true, verifyTemplate: 'otp' }))).toBe('configured');
    expect(classifySmsProviderInfo(smsInfo({ providerName: 'kavenegar', hasApiKey: true, verifyTemplate: 'otp', sender: '3000...' }))).toBe('configured');
  });

  it('kavenegar with a sender but no verify template is still invalid', () => {
    expect(classifySmsProviderInfo(smsInfo({ providerName: 'kavenegar', hasApiKey: true, sender: '3000...' }))).toBe('invalid');
  });

  it('smsir missing lineNumber, verifyTemplateId or verifyParameterName is invalid', () => {
    expect(classifySmsProviderInfo(smsInfo({ providerName: 'smsir', hasApiKey: true, lineNumber: null, verifyTemplateId: 5, verifyParameterName: 'CODE' }))).toBe('invalid');
    expect(classifySmsProviderInfo(smsInfo({ providerName: 'smsir', hasApiKey: true, lineNumber: '3000', verifyTemplateId: null, verifyParameterName: 'CODE' }))).toBe('invalid');
    // A template id with no parameter name has nowhere to put the code --
    // `resolveProvider` throws sms_template_invalid on exactly this row.
    expect(classifySmsProviderInfo(smsInfo({ providerName: 'smsir', hasApiKey: true, lineNumber: '3000', verifyTemplateId: 5, verifyParameterName: null }))).toBe('invalid');
  });

  it('smsir with lineNumber, verifyTemplateId and verifyParameterName is configured', () => {
    expect(classifySmsProviderInfo(smsInfo({ providerName: 'smsir', hasApiKey: true, lineNumber: '3000', verifyTemplateId: 5, verifyParameterName: 'CODE' }))).toBe('configured');
  });

  // Telnyx (International edition): the message text is the Verify
  // Profile's own template on Telnyx, so only the profile id is required —
  // never a template of ours.
  it('telnyx with a key but no Verify Profile id is invalid; with one, configured (no template needed)', () => {
    expect(classifySmsProviderInfo(smsInfo({ providerName: 'telnyx', hasApiKey: false, verifyProfileId: '490001a1-442d-809f-5753-c2332bd10640' }))).toBe('invalid');
    expect(classifySmsProviderInfo(smsInfo({ providerName: 'telnyx', hasApiKey: true, verifyProfileId: null }))).toBe('invalid');
    expect(classifySmsProviderInfo(smsInfo({
      providerName: 'telnyx', hasApiKey: true, verifyProfileId: '490001a1-442d-809f-5753-c2332bd10640', channel: 'sms',
      verifyTemplate: null, verifyTemplateId: null, verifyParameterName: null,
    }))).toBe('configured');
  });
});
