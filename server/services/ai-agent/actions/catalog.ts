/**
 * AI Agent — Phase 3 canonical internal action catalog.
 *
 * ONE source of truth for every action the AI may propose. Anything not in
 * this catalog can never execute. A capability is only marked `executable`
 * when this repository already contains a real, safe implementation:
 *
 *   handoff_to_operator  → runtime/actionExecutor.ts (markNeedsHuman + ack)
 *   mark_priority        → runtime/actionExecutor.ts (conversations.priority)
 *   search_kb            → retrieval pipeline (marker only, read-only)
 *   add_tag              → runtime/workflowExecutor.ts executeAddTag()
 *   (add_internal_note is NOT executable: conversation_notes.author_id is
 *    NOT NULL and no AI/system author identity exists → planned_only)
 *   get_business_hours   → services/widget/availability.ts (read-only)
 *
 * assign_team / assign_operator / create_ticket have NO safe existing
 * service or schema contract for AI-initiated use, so they stay planned_only.
 * No new tables, no invented APIs.
 */
import { z } from 'zod';

export const ACTION_NAMES = [
  'handoff_to_operator',
  'mark_priority',
  'search_kb',
  'add_tag',
  'add_internal_note',
  'get_business_hours',
  'assign_team',
  'assign_operator',
  'create_ticket',
] as const;

export type ActionName = (typeof ACTION_NAMES)[number];

export const PRIORITY_VALUES = ['low', 'normal', 'high', 'urgent'] as const;
export type PriorityValue = (typeof PRIORITY_VALUES)[number];

/** Hard bound on model-planned actions per turn (3.2). */
export const MAX_ACTIONS_PER_TURN = 2;
export const MAX_TAG_LENGTH = 32;
export const MAX_TAGS_PER_CONVERSATION = 20;
export const MAX_NOTE_LENGTH = 500;

export interface ActionDefinition {
  name: ActionName;
  description: string;
  schema: z.ZodTypeAny;
  /** Read-only actions never mutate state. */
  readOnly: boolean;
  /** Side-effect actions mutate conversation state / notify humans. */
  sideEffect: boolean;
  /** A real safe implementation exists in this repository. */
  executable: boolean;
  /** Must be deduplicated via a stable idempotency identity. */
  idempotent: boolean;
  /** Requires deterministic evidence of visitor intent in the visitor text. */
  requiresVisitorIntent: boolean;
  /**
   * Model-planned side effects that need an explicit deterministic runtime /
   * workspace-configuration authorization (never model output, never text
   * coming from retrieved sources).
   */
  requiresDeterministicAuthorization?: boolean;
  /** Human takeover blocks it entirely. */
  blockedByHumanTakeover: boolean;
  /** May execute automatically in suggest-only mode. */
  allowedInSuggestOnly: boolean;
}

const emptyArgs = z.object({}).strict().optional().default({});

export const ACTION_CATALOG: Record<ActionName, ActionDefinition> = {
  handoff_to_operator: {
    name: 'handoff_to_operator',
    description: 'Escalate the conversation to a human operator.',
    schema: emptyArgs,
    readOnly: false,
    sideEffect: true,
    executable: true,
    idempotent: true,
    requiresVisitorIntent: true,
    blockedByHumanTakeover: true,
    allowedInSuggestOnly: false,
  },
  mark_priority: {
    name: 'mark_priority',
    description: 'Set the conversation priority.',
    schema: z.object({ priority: z.enum(PRIORITY_VALUES) }).strict(),
    readOnly: false,
    sideEffect: true,
    executable: true,
    idempotent: true,
    requiresVisitorIntent: true,
    blockedByHumanTakeover: true,
    allowedInSuggestOnly: false,
  },
  search_kb: {
    name: 'search_kb',
    description: 'Marker for knowledge-base retrieval (already performed upstream).',
    schema: z.object({ query: z.string().max(300).optional() }).strict().optional().default({}),
    readOnly: true,
    sideEffect: false,
    executable: true,
    idempotent: false,
    requiresVisitorIntent: false,
    blockedByHumanTakeover: false,
    allowedInSuggestOnly: true,
  },
  get_business_hours: {
    name: 'get_business_hours',
    description: 'Read current operator availability / business-hours state.',
    schema: emptyArgs,
    readOnly: true,
    sideEffect: false,
    executable: true,
    idempotent: false,
    requiresVisitorIntent: false,
    blockedByHumanTakeover: false,
    allowedInSuggestOnly: true,
  },
  add_tag: {
    name: 'add_tag',
    description: 'Add one short tag to the conversation.',
    schema: z.object({ tag: z.string().min(1).max(80) }).strict(),
    readOnly: false,
    sideEffect: true,
    executable: true,
    idempotent: true,
    requiresVisitorIntent: false,
    requiresDeterministicAuthorization: true,
    blockedByHumanTakeover: true,
    allowedInSuggestOnly: false,
  },
  add_internal_note: {
    name: 'add_internal_note',
    description: 'Add an operator-only note to the conversation (planned only — conversation_notes.author_id is NOT NULL and no AI/system author identity exists).',
    schema: z.object({ body: z.string().min(1).max(2000) }).strict(),
    readOnly: false,
    sideEffect: true,
    executable: false,
    idempotent: true,
    requiresVisitorIntent: false,
    blockedByHumanTakeover: true,
    allowedInSuggestOnly: false,
  },
  assign_team: {
    name: 'assign_team',
    description: 'Assign the conversation to a team (planned only).',
    schema: z.object({ team: z.string().min(1).max(80) }).strict(),
    readOnly: false,
    sideEffect: true,
    executable: false,
    idempotent: true,
    requiresVisitorIntent: false,
    blockedByHumanTakeover: true,
    allowedInSuggestOnly: false,
  },
  assign_operator: {
    name: 'assign_operator',
    description: 'Assign the conversation to an operator (planned only).',
    schema: z.object({ operator: z.string().min(1).max(80) }).strict(),
    readOnly: false,
    sideEffect: true,
    executable: false,
    idempotent: true,
    requiresVisitorIntent: false,
    blockedByHumanTakeover: true,
    allowedInSuggestOnly: false,
  },
  create_ticket: {
    name: 'create_ticket',
    description: 'Create a support ticket (planned only — no ticket service exists).',
    schema: z.object({ subject: z.string().min(1).max(200).optional() }).strict().optional().default({}),
    readOnly: false,
    sideEffect: true,
    executable: false,
    idempotent: true,
    requiresVisitorIntent: false,
    blockedByHumanTakeover: true,
    allowedInSuggestOnly: false,
  },
};

export function getActionDefinition(name: string): ActionDefinition | null {
  if (!name) return null;
  return (ACTION_CATALOG as Record<string, ActionDefinition>)[name] || null;
}

/** Names the model is ever told about (executable subset). */
export function executableActionNames(): ActionName[] {
  return ACTION_NAMES.filter((n) => ACTION_CATALOG[n].executable);
}

/**
 * Normalize arguments AFTER schema validation. Pure; never throws.
 * Returns null when the value cannot be made safe.
 */
export function normalizeArguments(
  name: ActionName,
  args: Record<string, unknown>,
): Record<string, unknown> | null {
  if (name === 'mark_priority') {
    const raw = String((args as any)?.priority ?? '').trim().toLowerCase();
    if (!(PRIORITY_VALUES as readonly string[]).includes(raw)) return null;
    return { priority: raw };
  }
  if (name === 'add_tag') {
    const tag = String((args as any)?.tag ?? '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '-')
      .slice(0, MAX_TAG_LENGTH);
    if (!tag) return null;
    return { tag };
  }
  if (name === 'add_internal_note') {
    const body = String((args as any)?.body ?? '').trim().slice(0, MAX_NOTE_LENGTH);
    if (!body) return null;
    return { body };
  }
  if (name === 'search_kb') {
    const q = String((args as any)?.query ?? '').trim().slice(0, 300);
    return q ? { query: q } : {};
  }
  return {};
}
