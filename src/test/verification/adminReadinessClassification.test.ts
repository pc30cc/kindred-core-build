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

  it('resend without an api_key (config, secrets, or env) is invalid', () => {
    expect(classifyEmailProviderConfig({ provider_name: 'resend', config: {} }, {})).toBe('invalid');
  });

  it('resend with an api_key in config is configured', () => {
    expect(classifyEmailProviderConfig({ provider_name: 'resend', config: { api_key: 're_123' } }, {})).toBe('configured');
  });

  it('resend with the api_key only in secrets is configured', () => {
    expect(classifyEmailProviderConfig({ provider_name: 'resend', secrets: { api_key: 're_123' } }, {})).toBe('configured');
  });

  it('resend with only the env var set is configured', () => {
    expect(classifyEmailProviderConfig({ provider_name: 'resend', config: {} }, { RESEND_API_KEY: 're_env' })).toBe('configured');
  });

  it('sendgrid without an api_key is invalid; with one, configured', () => {
    expect(classifyEmailProviderConfig({ provider_name: 'sendgrid', config: {} }, {})).toBe('invalid');
    expect(classifyEmailProviderConfig({ provider_name: 'sendgrid', config: { api_key: 'sg_1' } }, {})).toBe('configured');
  });

  it('smtp without a host is invalid; with one, configured', () => {
    expect(classifyEmailProviderConfig({ provider_name: 'smtp', config: {} }, {})).toBe('invalid');
    expect(classifyEmailProviderConfig({ provider_name: 'smtp', config: { smtp_host: 'smtp.example.com' } }, {})).toBe('configured');
  });

  it('an unrecognized provider_name is invalid, not configured', () => {
    expect(classifyEmailProviderConfig({ provider_name: 'carrier-pigeon', config: { api_key: 'x' } }, {})).toBe('invalid');
  });

  it('never returns configured for an empty-string credential', () => {
    expect(classifyEmailProviderConfig({ provider_name: 'resend', config: { api_key: '   ' } }, {})).toBe('invalid');
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
});
