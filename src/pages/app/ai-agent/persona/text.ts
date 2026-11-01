/**
 * Words the page builds from codes: language names, why a save failed, why
 * a field blocks a save. Every key is literal, so the translation check sees
 * it (src/test/i18n/translationKeysExist.test.ts).
 */
import type { TranslationKey } from '@/i18n';
import { MAX_LENGTH, MAX_LIST_LINES, type PersonaFieldError } from './personaForm';

export type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string;

/** A visitor language's name, in the dashboard's language. */
export function languageName(t: Translate, code: string): string {
  switch ((code || '').toLowerCase().split('-')[0]) {
    case 'fa': return t('aiAgent.persona.languageNames.fa');
    case 'en': return t('aiAgent.persona.languageNames.en');
    case 'tr': return t('aiAgent.persona.languageNames.tr');
    default: return (code || '').toUpperCase();
  }
}

/** The server's error code (AiAgentApiError.code, else its message). */
export function errorCode(e: unknown): string {
  if (!e || typeof e !== 'object') return '';
  const { code, message } = e as { code?: unknown; message?: unknown };
  if (typeof code === 'string' && code) return code;
  return typeof message === 'string' ? message : '';
}

/** Why a settings save failed, in plain words. */
export function saveErrorText(t: Translate, e: unknown): string {
  switch (errorCode(e)) {
    case 'ai_provider_not_configured': return t('aiAgent.persona.errors.providerMissing');
    case 'no_published_knowledge': return t('aiAgent.persona.errors.noKnowledge');
    case 'module_ai_assistant_not_enabled': return t('aiAgent.persona.errors.moduleOff');
    case 'invalid_params': return t('aiAgent.persona.errors.invalid');
    case 'owner_or_admin_required': return t('aiAgent.persona.errors.notAllowed');
    case 'network_error': return t('aiAgent.persona.errors.network');
    default: return t('aiAgent.persona.errors.generic');
  }
}

export function fieldErrorText(t: Translate, error: PersonaFieldError | undefined): string | null {
  switch (error) {
    case 'required': return t('aiAgent.persona.identity.nameRequired');
    case 'tooManyLines': return t('aiAgent.persona.style.tooManyLines', { max: MAX_LIST_LINES });
    case 'lineTooLong': return t('aiAgent.persona.style.lineTooLong', { max: MAX_LENGTH.listLine });
    default: return null;
  }
}
