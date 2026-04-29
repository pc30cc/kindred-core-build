/**
 * AI Agent — prompt builder. Plain text, no markdown by default.
 */
import type { AgentSettings, AnswerGuidance } from './settings.js';
import type { RetrievedSource } from './retrieval.js';
import type { StrategyDecision } from './answerStrategy.js';

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

export function buildSystemPrompt(s: AgentSettings, locale: string): string {
  const lines: string[] = [];
  lines.push(`You are "${s.agent_name}", the AI support agent for this workspace.`);
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
  lines.push(`Reply in this language: ${locale}.`);
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
  strategy?: Pick<StrategyDecision, 'decisionType' | 'clarificationHint'>,
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
    }
  }
  lines.push(`Visitor question: ${question}`);
  lines.push('Answer:');
  return lines.join('\n');
}