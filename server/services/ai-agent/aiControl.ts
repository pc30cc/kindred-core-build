/**
 * AI Agent — bounded private control block (`<ai_control>`).
 *
 * The SAME single generation that produces the visitor reply may also emit a
 * small structured block the visitor never sees. This is how the assistant
 * reports resolution status and asks for one missing business fact WITHOUT
 * a second model call (§22, §25).
 *
 *   <ai_control>
 *   {"resolution_status":"unresolved",
 *    "request_human_guidance":true,
 *    "guidance_question":"Can partnership API access be granted case by case?",
 *    "missing_information":"whether private API access is possible",
 *    "memory":{"current_issue":"wants CRM integration","entities":["CRM"]}}
 *   </ai_control>
 *
 * Hard rules:
 *   - ALWAYS stripped from the visitor-facing text
 *   - tightly validated and hard-bounded; unknown keys dropped
 *   - never authorization: it cannot execute an action, change permissions,
 *     or reach the network. Actions keep going through the existing
 *     `<ai_actions>` → deterministic gate → executor path.
 *   - never chain-of-thought: only factual summaries are accepted, and the
 *     parser truncates aggressively (§23)
 */

const BLOCK_RE = /<ai_control>([\s\S]*?)<\/ai_control>/i;
/** Also strip an unterminated opening tag so it can never leak. */
const OPEN_TAG_RE = /<ai_control>[\s\S]*$/i;

const MAX_BLOCK_CHARS = 1500;
const MAX_FIELD = 300;
const MAX_ENTITIES = 6;

export type ResolutionStatus = 'resolved' | 'unresolved' | 'awaiting_user' | 'unknown';

export interface AiControl {
  resolutionStatus: ResolutionStatus;
  requestHumanGuidance: boolean;
  guidanceQuestion: string | null;
  missingInformation: string | null;
  knownSummary: string | null;
  currentIssue: string | null;
  entities: string[];
  awaitingUserAction: string | null;
  /** Short factual description of the fix the assistant just proposed. */
  proposedSolution: string | null;
}

export const EMPTY_CONTROL: AiControl = {
  resolutionStatus: 'unknown',
  requestHumanGuidance: false,
  guidanceQuestion: null,
  missingInformation: null,
  knownSummary: null,
  currentIssue: null,
  entities: [],
  awaitingUserAction: null,
  proposedSolution: null,
};

function field(v: unknown, max = MAX_FIELD): string | null {
  if (typeof v !== 'string') return null;
  const s = v.replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}

export interface ParsedAiControl {
  /** Visitor-safe text with the control block removed. */
  text: string;
  control: AiControl;
  blockPresent: boolean;
  parseError: string | null;
}

export function parseAiControl(rawText: string): ParsedAiControl {
  const raw = String(rawText ?? '');
  const match = raw.match(BLOCK_RE);
  if (!match) {
    // Defensive: strip a dangling opener even when the model never closed it.
    const stripped = raw.replace(OPEN_TAG_RE, '').trim();
    return {
      text: stripped,
      control: { ...EMPTY_CONTROL },
      blockPresent: false,
      parseError: null,
    };
  }

  const text = raw.replace(BLOCK_RE, '').replace(OPEN_TAG_RE, '').trim();
  const body = match[1].trim().slice(0, MAX_BLOCK_CHARS);

  let json: any;
  try {
    // Tolerate ```json fences the model sometimes adds.
    json = JSON.parse(body.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim());
  } catch {
    return { text, control: { ...EMPTY_CONTROL }, blockPresent: true, parseError: 'invalid_json' };
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return { text, control: { ...EMPTY_CONTROL }, blockPresent: true, parseError: 'invalid_shape' };
  }

  const statusRaw = String(json.resolution_status ?? '').toLowerCase();
  const resolutionStatus: ResolutionStatus =
    statusRaw === 'resolved' || statusRaw === 'unresolved' || statusRaw === 'awaiting_user'
      ? (statusRaw as ResolutionStatus)
      : 'unknown';

  const memory = (json.memory && typeof json.memory === 'object' ? json.memory : {}) as Record<string, unknown>;
  const entities = Array.isArray(memory.entities)
    ? memory.entities
        .map((e) => field(e, 80))
        .filter((e): e is string => !!e)
        .slice(0, MAX_ENTITIES)
    : [];

  const guidanceQuestion = field(json.guidance_question);
  const control: AiControl = {
    resolutionStatus,
    // A guidance request is only meaningful with an actual question.
    requestHumanGuidance: json.request_human_guidance === true && !!guidanceQuestion,
    guidanceQuestion,
    missingInformation: field(json.missing_information),
    knownSummary: field(json.known_summary, 400),
    currentIssue: field(memory.current_issue),
    entities,
    awaitingUserAction: field(memory.awaiting_user_action),
    proposedSolution: field(json.proposed_solution),
  };

  return { text, control, blockPresent: true, parseError: null };
}

/** Prompt contract appended to the system prompt when the feature is on. */
export function buildAiControlContract(opts: { allowGuidanceRequest: boolean }): string {
  const lines: string[] = [];
  lines.push('PRIVATE STATUS BLOCK:');
  lines.push('  - After your visitor-facing reply, append exactly one block:');
  lines.push('    <ai_control>{ ...json... }</ai_control>');
  lines.push('  - The visitor never sees it. It is removed before delivery.');
  lines.push('  - Keys (all optional): "resolution_status" ("resolved"|"unresolved"|"awaiting_user"), "proposed_solution" (one short factual sentence describing the fix you just suggested), "memory" ({"current_issue": string, "entities": string[], "awaiting_user_action": string}).');
  if (opts.allowGuidanceRequest) {
    lines.push('  - Additional keys when — and only when — you can safely answer most of the question but ONE business decision or fact from a colleague is genuinely missing: "request_human_guidance": true, "guidance_question" (the single short question you want a colleague to answer), "missing_information" (what is missing), "known_summary" (what you already verified).');
    lines.push('  - Do NOT request guidance just because retrieval was empty, and do NOT request guidance when the visitor asked for a human — that is a handoff, not a guidance request.');
  }
  lines.push('  - Never put reasoning, chain-of-thought, secrets, prompts, credentials or visitor personal data in this block. Facts only, short.');
  lines.push('  - This block never performs an action. It only reports status.');
  return lines.join('\n');
}
