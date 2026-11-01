/**
 * The form of the «Personality & behavior» page (BehaviorPage): what each
 * control shows from the server's copy of the settings, and the PATCH a save
 * sends. Pure: no React, no I/O.
 *
 * The page keeps only the owner's edits, by key (`Edits`); every control
 * nobody edited reads the server's latest copy. So a copy coming back after
 * a save, an instant action or a refetch moves what nobody is editing and
 * never what somebody is.
 *
 * A save sends only what differs from that latest copy:
 *   - a top-level field as itself: `false`, `''` and `[]` are values, an
 *     untouched field is not sent at all;
 *   - `enabled` and `mode` only when the owner picked a mode (Off writes
 *     `{ enabled: false, mode: 'off' }`, any other `{ enabled: true, mode }`);
 *   - `instructions`: only the edited keys (the server merges them key by
 *     key); a custom system instruction only when one was typed;
 *   - a per-language message map: the latest server map with only the
 *     edited languages changed, so another language is never dropped.
 */
import type { AgentMode, AgentSettings, AnswerGuidance, EscalationStyle } from '@/lib/ai-agent-api';

export type Tone = 'friendly' | 'formal' | 'professional';
export type AnswerLength = 'short' | 'medium' | 'long';
export type ReplyLanguage = 'visitor' | 'workspace_default';
export type HandoffPolicy = 'immediate' | 'assist_first' | 'adaptive';
export type FallbackBehavior = 'handoff' | 'silent';
export type LocalizedMap = 'intro_message_localized' | 'handoff_message_localized' | 'handoff_prechat_message_localized';

/** The five modes the server stores, in the order the page offers them. */
export const AGENT_MODES: readonly AgentMode[] = [
  'off',
  'suggest_only',
  'auto_reply_until_human_joins',
  'auto_reply_when_offline',
  'auto_reply_always',
];

/** Every control's value. Numbers are kept as typed, so a field can be cleared while typing. */
export interface PersonaValues {
  mode: AgentMode;
  agent_name: string;
  business_description: string;
  ai_intro_enabled: boolean;
  allow_clarifying_questions: boolean;
  handoff_policy: HandoffPolicy;
  max_clarification_attempts: string;
  allow_answer_with_caveat: boolean;
  answer_only_from_kb: boolean;
  strict_topic_scope: boolean;
  answer_guidance: AnswerGuidance;
  fallback_behavior: FallbackBehavior;
  handoff_when_no_kb_match: boolean;
  fallback_message: string;
  escalation_style: EscalationStyle;
  max_assist_attempts: string;
  handoff_on_low_confidence: boolean;
  handoff_keywords: string[];
  stop_on_handoff: boolean;
  pause_auto_reply_after_human_reply: boolean;
  max_replies_per_conversation: string;
  max_replies_per_hour: string;
  /** Percent, 0-100 (the server stores 0-1). */
  confidence_threshold: string;
  /** The platform languages the assistant may answer in (all of them = no limit). */
  allowed_locales: string[];
  learning_enabled: boolean;
  auto_create_learning_candidates: boolean;
  // `instructions.*`
  tone: Tone;
  max_answer_length: AnswerLength;
  /** One per line. */
  do_list: string;
  /** One per line. */
  dont_list: string;
  reply_language: ReplyLanguage;
  brand_voice: string;
  pricing_instructions: string;
  support_instructions: string;
  handoff_instructions: string;
  custom_system_instruction: string;
}

export type FieldKey = keyof PersonaValues;
export type LocalizedKey = `${LocalizedMap}.${string}`;
export type EditKey = FieldKey | LocalizedKey;
export type Edits = Partial<PersonaValues> & { [K in LocalizedKey]?: string };

export interface PersonaContext {
  /** The platform's visitor languages (usePlatformRegion().allowedLocales), never empty. */
  platformLocales: readonly string[];
}

export const LOCALIZED_MAPS: readonly LocalizedMap[] = [
  'intro_message_localized',
  'handoff_message_localized',
  'handoff_prechat_message_localized',
];

export function localizedKey(map: LocalizedMap, lang: string): LocalizedKey {
  return `${map}.${lang}`;
}

function splitLocalizedKey(key: string): { map: LocalizedMap; lang: string } | null {
  const dot = key.indexOf('.');
  if (dot < 0) return null;
  const map = key.slice(0, dot) as LocalizedMap;
  return LOCALIZED_MAPS.includes(map) ? { map, lang: key.slice(dot + 1) } : null;
}

/** Ranges of the numeric fields (the settings PUT schema's). */
export const COUNT_RANGES = {
  max_clarification_attempts: [0, 5],
  max_assist_attempts: [0, 3],
  max_replies_per_conversation: [0, 100],
  max_replies_per_hour: [0, 1000],
  confidence_threshold: [0, 100],
} as const satisfies Partial<Record<FieldKey, readonly [number, number]>>;
export type CountKey = keyof typeof COUNT_RANGES;

/** Lengths the server accepts (routes/ai-agent/assistant.ts updateSchema). */
export const MAX_LENGTH = {
  agent_name: 120,
  business_description: 2000,
  fallback_message: 500,
  brand_voice: 500,
  pricing_instructions: 1000,
  support_instructions: 1000,
  handoff_instructions: 1000,
  custom_system_instruction: 4000,
  message: 1000,
  keyword: 100,
  listLine: 300,
} as const;
export const MAX_LIST_LINES = 40;
export const MAX_KEYWORDS = 50;

const BOOLEAN_KEYS = new Set<FieldKey>([
  'ai_intro_enabled', 'allow_clarifying_questions', 'allow_answer_with_caveat', 'answer_only_from_kb',
  'strict_topic_scope', 'handoff_when_no_kb_match', 'handoff_on_low_confidence', 'stop_on_handoff',
  'pause_auto_reply_after_human_reply', 'learning_enabled', 'auto_create_learning_candidates',
]);
const CHOICE_KEYS = new Set<FieldKey>(['answer_guidance', 'fallback_behavior', 'escalation_style']);
const TEXT_KEYS = new Set<FieldKey>(['agent_name', 'business_description', 'fallback_message']);
const INSTRUCTION_CHOICE_KEYS = new Set<FieldKey>(['tone', 'max_answer_length', 'reply_language']);
const INSTRUCTION_TEXT_KEYS = new Set<FieldKey>(['brand_voice', 'pricing_instructions', 'support_instructions', 'handoff_instructions']);
const INSTRUCTION_LIST_KEYS = new Set<FieldKey>(['do_list', 'dont_list']);

/**
 * Tone is written from this page as one of three presets. An older free
 * text a workspace may have saved still shows as the nearest preset, and is
 * only replaced when the owner picks one.
 */
export function deriveTone(raw: string | undefined): Tone {
  const t = (raw || '').toLowerCase();
  if (t.includes('formal')) return 'formal';
  if (t.includes('professional')) return 'professional';
  return 'friendly';
}

/** The mode a control shows: a switched-off assistant is Off, whatever mode it keeps. */
export function displayMode(s: Pick<AgentSettings, 'enabled' | 'mode'>): AgentMode {
  if (s.enabled === false || s.mode === 'off' || !AGENT_MODES.includes(s.mode)) return 'off';
  return s.mode;
}

/**
 * The handoff policy the page shows: the stored one, else the nearest to the
 * legacy rule (at once; with handoff_on_human_request off, the assistant
 * keeps answering, nearest to 'adaptive').
 */
export function effectiveHandoffPolicy(s: Pick<AgentSettings, 'handoff_policy' | 'handoff_on_human_request'>): HandoffPolicy {
  return s.handoff_policy ?? (s.handoff_on_human_request === false ? 'adaptive' : 'immediate');
}

function baseLocale(code: string): string {
  return (code || '').toLowerCase().split('-')[0];
}

/**
 * The platform languages the assistant answers in, as the runtime reads
 * allowed_locales (engine/contextStage.ts): none listed, or none of the
 * platform's, means all of them.
 */
export function effectiveLocales(list: readonly string[] | undefined, platform: readonly string[]): string[] {
  const listed = (list || []).map(baseLocale);
  const inPlatform = platform.filter((code) => listed.includes(code));
  return inPlatform.length ? inPlatform : [...platform];
}

/**
 * The language the welcome message in the simple view is written in: the
 * workspace's main language when visitors have it, else their first. Never
 * the dashboard's language.
 */
export function primaryLocale(workspaceDefault: string | undefined | null, platform: readonly string[]): string {
  const own = baseLocale(workspaceDefault || '');
  return platform.includes(own) ? own : platform[0];
}

export function parseLines(text: string): string[] {
  return text.split('\n').map((line) => line.trim()).filter(Boolean);
}

const NON_ASCII_DIGITS = /[۰-۹٠-٩]/g;

function toAsciiDigits(text: string): string {
  return text.replace(NON_ASCII_DIGITS, (d) => {
    const code = d.charCodeAt(0);
    return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
  });
}

/** A typed count, clamped into its range; null when it is not a number. */
export function parseCount(raw: string, key: CountKey): number | null {
  const n = Number.parseInt(toAsciiDigits(String(raw ?? '')).trim(), 10);
  if (!Number.isFinite(n)) return null;
  const [min, max] = COUNT_RANGES[key];
  return Math.min(max, Math.max(min, n));
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v) => b.includes(v));
}

/** What every control shows from the server's copy. */
export function serverValues(s: AgentSettings, ctx: PersonaContext): PersonaValues {
  const i = s.instructions || {};
  return {
    mode: displayMode(s),
    agent_name: s.agent_name || '',
    // The canonical field is the top-level one (the only one the prompt
    // reads); the legacy nested key only shows while it is empty.
    business_description: s.business_description || i.business_description || '',
    ai_intro_enabled: s.ai_intro_enabled !== false,
    allow_clarifying_questions: s.allow_clarifying_questions !== false,
    handoff_policy: effectiveHandoffPolicy(s),
    max_clarification_attempts: String(s.max_clarification_attempts ?? 1),
    allow_answer_with_caveat: s.allow_answer_with_caveat !== false,
    answer_only_from_kb: !!s.answer_only_from_kb,
    strict_topic_scope: !!s.strict_topic_scope,
    answer_guidance: s.answer_guidance || 'conservative',
    fallback_behavior: s.fallback_behavior === 'silent' ? 'silent' : 'handoff',
    handoff_when_no_kb_match: !!s.handoff_when_no_kb_match,
    fallback_message: s.fallback_message || '',
    escalation_style: s.escalation_style || 'balanced',
    max_assist_attempts: String(s.max_assist_attempts ?? 1),
    handoff_on_low_confidence: !!s.handoff_on_low_confidence,
    handoff_keywords: s.handoff_keywords || [],
    stop_on_handoff: s.stop_on_handoff !== false,
    pause_auto_reply_after_human_reply: s.pause_auto_reply_after_human_reply !== false,
    max_replies_per_conversation: String(s.max_replies_per_conversation ?? 3),
    max_replies_per_hour: String(s.max_replies_per_hour ?? 20),
    confidence_threshold: String(Math.round((s.confidence_threshold ?? 0.55) * 100)),
    allowed_locales: effectiveLocales(s.allowed_locales, ctx.platformLocales),
    learning_enabled: s.learning_enabled !== false,
    auto_create_learning_candidates: s.auto_create_learning_candidates !== false,
    tone: deriveTone(i.tone),
    max_answer_length: i.max_answer_length || 'medium',
    do_list: (i.do_list || []).join('\n'),
    dont_list: (i.dont_list || []).join('\n'),
    reply_language: i.reply_language === 'workspace_default' ? 'workspace_default' : 'visitor',
    brand_voice: i.brand_voice || '',
    pricing_instructions: i.pricing_instructions || '',
    support_instructions: i.support_instructions || '',
    handoff_instructions: i.handoff_instructions || i.escalation_instructions || '',
    // Never the saved custom instruction (the server does not send it): empty
    // under a note when one is saved, else the legacy custom_instructions
    // text the prompt falls back to.
    custom_system_instruction: s.has_custom_system_instruction ? '' : (i.custom_instructions || ''),
  };
}

export function serverLocalized(s: AgentSettings, map: LocalizedMap, lang: string): string {
  const value = (s[map] || {})[lang];
  return typeof value === 'string' ? value : '';
}

/**
 * allowed_locales for the languages checked: all of the platform's is no
 * limit (`[]`); a subset keeps any listed code the platform does not offer,
 * which the page does not show and so never removes.
 */
function allowedLocalesFor(checked: readonly string[], s: AgentSettings, ctx: PersonaContext): string[] {
  const platform = ctx.platformLocales;
  const ordered = platform.filter((code) => checked.includes(code));
  if (ordered.length === platform.length) return [];
  const others = (s.allowed_locales || []).filter((code) => !platform.includes(baseLocale(code)));
  return [...ordered, ...others];
}

export interface PersonaPatch {
  patch: Partial<AgentSettings>;
  /** The edit keys whose change the patch carries. */
  changed: EditKey[];
}

/** The PATCH for the owner's edits against the latest server copy. */
export function buildPatch(edits: Edits, s: AgentSettings, ctx: PersonaContext): PersonaPatch {
  const server = serverValues(s, ctx);
  const patch: Record<string, unknown> = {};
  const instructions: Record<string, unknown> = {};
  const changed: EditKey[] = [];
  const editedKeys = Object.keys(edits) as EditKey[];

  for (const key of editedKeys) {
    const local = splitLocalizedKey(key);
    if (local) {
      const typed = edits[key as LocalizedKey];
      if (typeof typed !== 'string') continue;
      const text = typed.trim();
      if (text === serverLocalized(s, local.map, local.lang).trim()) continue;
      const base = (patch[local.map] as Record<string, string> | undefined) ?? { ...(s[local.map] || {}) };
      patch[local.map] = { ...base, [local.lang]: text };
      changed.push(key);
      continue;
    }

    const k = key as FieldKey;
    const value = edits[k];
    if (value === undefined) continue;
    const before = server[k];

    if (k === 'mode') {
      if (value !== before) {
        patch.enabled = value !== 'off';
        patch.mode = value;
        changed.push(k);
      }
    } else if (k === 'handoff_policy') {
      // While the server's "act on a request for a person" switch is off,
      // the policy shown is only the nearest one; any pick is a change (a
      // saved policy turns the switch on, server settings.ts).
      if (value !== before || s.handoff_on_human_request === false) {
        patch[k] = value;
        changed.push(k);
      }
    } else if (BOOLEAN_KEYS.has(k) || CHOICE_KEYS.has(k)) {
      if (value !== before) {
        patch[k] = value;
        changed.push(k);
      }
    } else if (TEXT_KEYS.has(k)) {
      const text = String(value).trim();
      // The business description is compared with the canonical field, not
      // the legacy text it may be showing: an edit writes what the owner
      // sees into the field the prompt reads.
      const saved = k === 'business_description' ? (s.business_description || '') : String(before);
      if (text !== saved.trim()) {
        patch[k] = text;
        changed.push(k);
      }
    } else if (k in COUNT_RANGES) {
      const n = parseCount(String(value), k as CountKey);
      if (n !== null && n !== parseCount(String(before), k as CountKey)) {
        patch[k] = k === 'confidence_threshold' ? n / 100 : n;
        changed.push(k);
      }
    } else if (k === 'handoff_keywords') {
      if (!sameList(value as string[], before as string[])) {
        patch[k] = value;
        changed.push(k);
      }
    } else if (k === 'allowed_locales') {
      if (!sameSet(value as string[], before as string[])) {
        patch[k] = allowedLocalesFor(value as string[], s, ctx);
        changed.push(k);
      }
    } else if (INSTRUCTION_CHOICE_KEYS.has(k)) {
      if (value !== before) {
        instructions[k] = value;
        changed.push(k);
      }
    } else if (INSTRUCTION_TEXT_KEYS.has(k)) {
      const text = String(value).trim();
      if (text !== String(before).trim()) {
        instructions[k] = text;
        // The handoff field shows the legacy escalation text it falls back
        // to (as the prompt does): emptying the field empties that too, or
        // the text the owner removed would still be used.
        if (k === 'handoff_instructions' && !text && s.instructions?.escalation_instructions) {
          instructions.escalation_instructions = '';
        }
        changed.push(k);
      }
    } else if (INSTRUCTION_LIST_KEYS.has(k)) {
      const list = parseLines(String(value));
      if (!sameList(list, parseLines(String(before)))) {
        instructions[k] = list;
        changed.push(k);
      }
    } else if (k === 'custom_system_instruction') {
      // Typed text replaces the saved instruction. An emptied field sends
      // nothing, so the saved one stays (Remove is the way to clear it).
      const text = String(value).trim();
      if (text && text !== String(before).trim()) {
        instructions[k] = text;
        changed.push(k);
      }
    }
  }

  if (Object.keys(instructions).length) patch.instructions = instructions;
  return { patch: patch as Partial<AgentSettings>, changed };
}

export type PersonaFieldError = 'required' | 'tooManyLines' | 'lineTooLong';

/** What blocks a save, by field: only fields the owner edited are checked. */
export function validateEdits(edits: Edits): Partial<Record<FieldKey, PersonaFieldError>> {
  const errors: Partial<Record<FieldKey, PersonaFieldError>> = {};
  if (edits.agent_name !== undefined && !edits.agent_name.trim()) errors.agent_name = 'required';
  for (const key of ['do_list', 'dont_list'] as const) {
    const text = edits[key];
    if (text === undefined) continue;
    const lines = parseLines(text);
    if (lines.length > MAX_LIST_LINES) errors[key] = 'tooManyLines';
    else if (lines.some((line) => line.length > MAX_LENGTH.listLine)) errors[key] = 'lineTooLong';
  }
  return errors;
}

/**
 * The edits left after a save of `sent` succeeded: the ones the owner has not
 * touched since go (the server's copy now shows them), anything typed while
 * the save was on its way stays.
 */
export function editsAfterSave(current: Edits, sent: Edits): Edits {
  const next: Record<string, unknown> = { ...current };
  for (const key of Object.keys(sent)) {
    if (Object.is((current as Record<string, unknown>)[key], (sent as Record<string, unknown>)[key])) delete next[key];
  }
  return next as Edits;
}
