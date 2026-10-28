/**
 * A sentence for a refused or failed settings request, in the panel's
 * language: the codes and server messages the settings pages get back
 * (uploads, Settings → Domains, the workspace's name) never reach a toast as
 * they are ("file_too_large", "HTTP 403", "Request failed: 500").
 */
import type { TranslationKey } from '@/i18n';

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string;

const BY_CODE: Record<string, TranslationKey> = {
  file_too_large: 'settings.errors.fileTooLarge',
  'icon must be smaller than 5 mb': 'settings.errors.fileTooLarge',
  unsupported_image_type: 'settings.errors.fileType',
  invalid_data: 'settings.errors.fileType',
  empty_file: 'settings.errors.fileEmpty',
  'empty file': 'settings.errors.fileEmpty',
  plan_upgrade_required: 'settings.errors.plan',
  seat_locked: 'settings.errors.plan',
  domain_taken: 'settings.errors.domainTaken',
  // A platform host (api.<brand>, app.<brand>, …) is the platform's own.
  platform_domain: 'settings.errors.domainTaken',
  'not a member of this workspace': 'settings.errors.forbidden',
  forbidden: 'settings.errors.forbidden',
  'domain not found': 'settings.errors.notFound',
};

/** The domain checks' codes (server/utils/workspaceDomainInput.ts). */
const DOMAIN_CODES = new Set([
  'invalid_type', 'empty', 'whitespace', 'too_long', 'invalid_scheme', 'userinfo_not_allowed',
  'path_not_allowed', 'port_not_allowed', 'malformed', 'localhost_not_allowed', 'ip_not_allowed',
]);

/** A request's refusal: its `code` or `error`, and its HTTP status. */
export class SettingsRequestError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number) {
    super(code);
    this.name = 'SettingsRequestError';
    this.code = code;
    this.status = status;
  }
}

export function settingsErrorMessage(err: unknown, t: Translate): string {
  if (err instanceof TypeError) return t('settings.errors.network');
  const code = String(
    err instanceof SettingsRequestError ? err.code : err instanceof Error ? err.message : err ?? '',
  ).trim().toLowerCase();
  const status = err instanceof SettingsRequestError ? err.status : 0;
  if (BY_CODE[code]) return t(BY_CODE[code]);
  if (DOMAIN_CODES.has(code)) return t('settings.errors.domainInvalid');
  if (code.startsWith('phone_verification')) return t('settings.errors.phoneVerification');
  if (status === 401) return t('settings.errors.session');
  if (status === 403) return t('settings.errors.forbidden');
  if (status === 413) return t('settings.errors.fileTooLarge');
  return t('settings.errors.generic');
}
