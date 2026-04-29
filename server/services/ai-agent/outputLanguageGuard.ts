/**
 * AI Agent — output language guard.
 *
 * Detects the language of the AI's reply and, if it doesn't match the
 * required response language, attempts a single best-effort translation
 * call. Falls back to a safe localized template when translation fails.
 *
 * Hard rules:
 *   - Never invents new facts. Translation prompt must preserve meaning.
 *   - Never throws — engine continues with original text on any error.
 *   - Skips work entirely when the original text is empty.
 */
import type { ServerConfig } from '../../config.js';
import { detectInputLanguageDetailed, type SupportedLanguage, languageDisplayName } from './language.js';
import { executeAICompletion, type AIConfig } from '../ai/index.js';

export interface OutputGuardResult {
  text: string;
  outputLanguageDetected: SupportedLanguage;
  mismatch: boolean;
  repaired: boolean;
  repairReason?: string;
  detectionConfidence: number;
}

function baseLang(loc: string): string {
  return (loc || 'en').toLowerCase().split(/[-_]/)[0];
}

/**
 * Map a workspace locale (en/fa/tr/ar) to the matching SupportedLanguage.
 * Anything else → 'unknown' so we don't false-trigger repairs.
 */
function expectedLang(loc: string): SupportedLanguage {
  const b = baseLang(loc);
  if (b === 'fa' || b === 'tr' || b === 'en' || b === 'ar') return b as SupportedLanguage;
  return 'unknown';
}

function safeFallbackTemplate(loc: string): string {
  const b = baseLang(loc);
  if (b === 'fa') {
    return 'متاسفم، نمی‌توانم به این سؤال در منابع موجود پاسخ دقیقی پیدا کنم. می‌خواهید شما را به یک کارشناس انسانی وصل کنم؟';
  }
  if (b === 'tr') {
    return 'Üzgünüm, bu konuda mevcut kaynaklarımda kesin bir yanıt bulamadım. Sizi bir temsilciye bağlamamı ister misiniz?';
  }
  return "I'm sorry, I couldn't find a precise answer in my current sources. Would you like me to connect you with a human agent?";
}

export interface ValidateOutputInput {
  outputText: string;
  responseLanguage: string;
  /** When true, callers (handoff/limit-handoff template paths) skip repair. */
  skipRepair?: boolean;
  /** When provided, repair will use this AI provider config. */
  aiConfig?: AIConfig | null;
  /** Server config (needed for the repair LLM call). */
  config?: ServerConfig;
  workspaceId?: string;
}

/**
 * Validate output language and (best-effort) repair when mismatched.
 * Never throws.
 */
export async function validateAndRepairOutputLanguage(
  input: ValidateOutputInput,
): Promise<OutputGuardResult> {
  const text = (input.outputText || '').trim();
  const expected = expectedLang(input.responseLanguage);
  if (!text || expected === 'unknown') {
    return {
      text: input.outputText || '',
      outputLanguageDetected: 'unknown',
      mismatch: false,
      repaired: false,
      detectionConfidence: 0,
    };
  }

  const detected = detectInputLanguageDetailed(text);
  const same = detected.language === expected;
  // Treat low-confidence detection as a match — avoid false-positive repairs
  // for very short answers like "Tamam." that are valid in multiple langs.
  if (same || detected.language === 'unknown' || detected.confidence < 0.4) {
    return {
      text: input.outputText,
      outputLanguageDetected: detected.language,
      mismatch: !same && detected.confidence >= 0.4,
      repaired: false,
      detectionConfidence: detected.confidence,
    };
  }

  // Mismatch path.
  if (input.skipRepair || !input.aiConfig || !input.config || !input.workspaceId) {
    return {
      text: input.outputText,
      outputLanguageDetected: detected.language,
      mismatch: true,
      repaired: false,
      repairReason: 'repair_skipped',
      detectionConfidence: detected.confidence,
    };
  }

  try {
    const targetName = languageDisplayName(expected);
    const sys = `You are a careful translator. Translate the user's text into ${targetName}. ` +
      `Preserve the original meaning. Do NOT add any new facts, prices, names, or recommendations. ` +
      `Do NOT include the source text. Output ONLY the translated message in ${targetName}, plain text.`;
    const repair = await executeAICompletion(input.config, {
      workspaceId: input.workspaceId,
      prompt: input.outputText,
      systemPrompt: sys,
      maxTokens: 600,
      temperature: 0.1,
    });
    const repaired = (repair.text || '').trim();
    if (!repaired) {
      return {
        text: safeFallbackTemplate(input.responseLanguage),
        outputLanguageDetected: detected.language,
        mismatch: true,
        repaired: true,
        repairReason: 'empty_translation_fallback_template',
        detectionConfidence: detected.confidence,
      };
    }
    // Verify the repair actually landed in the right language.
    const verify = detectInputLanguageDetailed(repaired);
    if (verify.language !== expected && verify.confidence >= 0.4) {
      return {
        text: safeFallbackTemplate(input.responseLanguage),
        outputLanguageDetected: detected.language,
        mismatch: true,
        repaired: true,
        repairReason: 'translation_still_wrong_lang',
        detectionConfidence: detected.confidence,
      };
    }
    return {
      text: repaired,
      outputLanguageDetected: detected.language,
      mismatch: true,
      repaired: true,
      detectionConfidence: detected.confidence,
    };
  } catch (err: any) {
    return {
      text: safeFallbackTemplate(input.responseLanguage),
      outputLanguageDetected: detected.language,
      mismatch: true,
      repaired: true,
      repairReason: `repair_failed:${err?.message || 'unknown'}`,
      detectionConfidence: detected.confidence,
    };
  }
}