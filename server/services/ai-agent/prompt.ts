/**
 * AI Agent — prompt builder. Plain text, no markdown by default.
 */
import type { AgentSettings, AnswerGuidance } from './settings.js';
import type { RetrievedSource } from './retrieval.js';
import type { StrategyDecision } from './answerStrategy.js';
import { languageDisplayName } from './language.js';

/**
 * Sanitize a stored agent name. Trims whitespace, strips control chars and
 * trailing punctuation that operators sometimes paste accidentally
 * (e.g. "AI Assistantf" → "AI Assistant"). Falls back to "AI Assistant".
 */
export function sanitizeAgentName(raw: string | null | undefined): string {
  const fallback = 'AI Assistant';
  if (!raw) return fallback;
  let v = String(raw).replace(/[\u0000-\u001F]/g, '').trim();
  if (!v) return fallback;
  // Specific known glitch from past data: "AI Assistantf" → "AI Assistant".
  if (/^ai\s*assistant[a-z]$/i.test(v)) v = 'AI Assistant';
  return v;
}

function guidanceLine(g: AnswerGuidance): string {
  switch (g) {
    case 'creative':
      return 'Tone: helpful and fluent. You may rephrase information from the sources naturally.';
    case 'balanced':
      return 'Tone: clear and helpful. Prefer answers grounded in the sources.';
    case 'conservative':
    default:
      return 'Tone: precise and conservative. Only state facts that are clearly supported by the sources.';
  }
}

export interface BuildSystemPromptOptions {
  /** When provided, used in place of `locale` for the response-language line. */
  responseLanguage?: string;
  /** Detected visitor input language (informational only). */
  inputLanguage?: string;
  /** Workspace pages we can safely point the visitor to. */
  workspaceLinks?: { pricing?: string | null; contact?: string | null; help?: string | null; domain?: string | null };
}

export function buildSystemPrompt(
  s: AgentSettings,
  locale: string,
  opts: BuildSystemPromptOptions = {},
): string {
  const lines: string[] = [];
  const agentName = sanitizeAgentName(s.agent_name);
  lines.push(`You are "${agentName}", the AI support agent for this workspace.`);
  // ── CRITICAL LANGUAGE RULE — must come before everything else. ──
  const responseLangEarly = opts.responseLanguage || locale;
  const responseLangNameEarly = languageDisplayName(responseLangEarly);
  lines.push(
    `CRITICAL LANGUAGE RULE: You MUST answer ONLY in ${responseLangNameEarly} (locale code: ${responseLangEarly}). ` +
      `Even if every source below is written in another language, translate the relevant facts and answer in ${responseLangNameEarly}. ` +
      `Do NOT mix languages in your reply. Do NOT quote source text in another language unless the visitor explicitly asks you to. ` +
      `Examples: response_language=fa → answer entirely in Persian. response_language=tr → answer entirely in Turkish. response_language=en → answer entirely in English.`,
  );
  // ── Hard safety rules — same in every prompt, regardless of style. ──
  lines.push('You are an AI assistant. Never claim to be a human, and never pretend to be a specific employee.');
  lines.push('Never invent prices, discounts, refunds, policies, legal terms, medical or financial advice. If the sources do not state a fact, do not state it.');
  lines.push('Only use the workspace sources provided in this prompt. Never reference data from other companies, customers, or workspaces.');
  if (s.business_description) lines.push(`Business context: ${s.business_description}`);
  lines.push(guidanceLine(s.answer_guidance));
  if (s.answer_only_from_kb) {
    lines.push('Answer ONLY using the provided sources. If the answer is not present in the sources, say you are not sure and offer to connect a human agent.');
  } else {
    lines.push('Prefer the provided sources when relevant. If you must go beyond them, stay general and avoid invented facts.');
  }
  // Professional ladder — applies to every reply.
  lines.push('First try to help using the approved workspace sources. If the visitor question is unclear, prefer asking ONE short clarifying question before escalating. Only offer to connect a human when the answer is not available and a clarifying question will not help, or when the visitor asks for a human.');
  // ── Language policy ──
  const responseLang = opts.responseLanguage || locale;
  lines.push(
    `Response language: ${responseLang} (${languageDisplayName(responseLang)}). Always answer in this language, even if the visitor wrote in a different one. Do not switch languages unless the visitor explicitly asks.`,
  );
  if (opts.inputLanguage && opts.inputLanguage !== 'unknown' && opts.inputLanguage !== responseLang) {
    lines.push(`The visitor wrote in ${languageDisplayName(opts.inputLanguage)}. Understand their meaning, but reply in ${languageDisplayName(responseLang)}.`);
  }
  // ── Workspace navigation context (safe links only, no factual claims) ──
  const links = opts.workspaceLinks || {};
  const linkLines: string[] = [];
  if (links.pricing) linkLines.push(`Pricing page: ${links.pricing}`);
  if (links.contact) linkLines.push(`Contact page: ${links.contact}`);
  if (links.help) linkLines.push(`Help center: ${links.help}`);
  if (linkLines.length) {
    lines.push('Workspace pages you may reference if relevant:');
    for (const l of linkLines) lines.push(`  - ${l}`);
  }
  const ins = s.instructions || {};
  if (ins.tone) lines.push(`Tone preference: ${ins.tone}`);
  if (ins.custom_instructions) lines.push(`Operator instructions: ${ins.custom_instructions}`);
  if (ins.forbidden_topics?.length) lines.push(`Do not discuss: ${ins.forbidden_topics.join(', ')}`);
  if (ins.escalation_instructions) lines.push(`Escalation: ${ins.escalation_instructions}`);
  if (ins.max_answer_length === 'short') lines.push('Keep answers under 2 short sentences.');
  else if (ins.max_answer_length === 'long') lines.push('You may give a thorough multi-paragraph answer when useful.');
  else lines.push('Keep answers concise: 1–4 sentences.');
  lines.push('Output plain text. Do not use markdown headings, bullet lists, or code fences unless absolutely needed.');
  return lines.join('\n');
}

export function buildUserPrompt(
  question: string,
  sources: RetrievedSource[],
  strategy?: Pick<StrategyDecision, 'decisionType' | 'clarificationHint' | 'safeGuidanceTopic'>,
): string {
  const lines: string[] = [];
  if (sources.length === 0) {
    lines.push('No sources were retrieved.');
  } else {
    lines.push('Sources:');
    sources.forEach((s, i) => {
      const body = (s.content || s.excerpt || '').slice(0, 1200);
      lines.push(`---\n[${i + 1}] (${s.kind}) ${s.title}\n${body}`);
    });
    lines.push('---');
  }
  // Per-turn strategy directive — last so the LLM weighs it most.
  if (strategy) {
    if (strategy.decisionType === 'ask_clarifying_question') {
      lines.push(
        strategy.clarificationHint
          || 'Ask exactly ONE short, friendly clarifying question to narrow down what the visitor needs. Do not invent facts and do not promise an answer.',
      );
    } else if (strategy.decisionType === 'answer_with_caveat') {
      lines.push(
        'Answer using ONLY the sources above. The grounding is partial — start with a brief hedge such as "Based on the information I have…" and avoid stating anything the sources do not support. End by offering to connect a human if the visitor needs more certainty.',
      );
    } else if (strategy.decisionType === 'answer') {
      lines.push('Answer directly and confidently using the sources above. Be concise.');
    } else if (strategy.decisionType === 'greeting') {
      lines.push(
        'The visitor is greeting you. Reply with a SHORT, friendly greeting (one sentence) in the response language and offer to help. Do NOT mention sources, do NOT ask a clarifying question, do NOT propose escalation.',
      );
    } else if (strategy.decisionType === 'safe_guidance') {
      const topic = strategy.safeGuidanceTopic || 'this topic';
      lines.push(
        `Provide SAFE GUIDANCE about ${topic}. The sources do NOT contain precise numbers/policies, so follow these rules strictly:\n` +
          `  - Do NOT invent prices, plan names, discounts, refund rules, SLAs, legal terms, or any specific fact.\n` +
          `  - Only mention a fact (e.g. "a free plan exists", "paid plans exist") if a source explicitly says so.\n` +
          `  - If exact prices are not in the sources, openly say the exact amount is not available in your current sources.\n` +
          `  - Offer to help the visitor pick the right option by asking what they need (1 short question).\n` +
          `  - If a workspace page (pricing / contact / help) was listed in the system prompt, mention it as a next step.\n` +
          `  - End by offering to connect a human agent for exact details.\n` +
          `Keep the reply short, helpful and entirely in the response language. Never go silent.`,
      );
    }
  }
  lines.push(`Visitor question: ${question}`);
  lines.push('Answer:');
  return lines.join('\n');
}