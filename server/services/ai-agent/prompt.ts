/**
 * AI Agent — prompt builder. Plain text, no markdown by default.
 */
import type { AgentSettings, AnswerGuidance } from './settings.js';
import type { RetrievedSource } from './retrieval.js';

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
  if (s.business_description) lines.push(`Business context: ${s.business_description}`);
  lines.push(guidanceLine(s.answer_guidance));
  if (s.answer_only_from_kb) {
    lines.push('Answer ONLY using the provided sources. If the answer is not present in the sources, say you are not sure and offer to connect a human agent.');
  } else {
    lines.push('Prefer the provided sources when relevant. If you must go beyond them, stay general and avoid invented facts.');
  }
  lines.push('Never invent pricing, policies, promises, legal, financial, or medical claims.');
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

export function buildUserPrompt(question: string, sources: RetrievedSource[]): string {
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
  lines.push(`Visitor question: ${question}`);
  lines.push('Answer:');
  return lines.join('\n');
}