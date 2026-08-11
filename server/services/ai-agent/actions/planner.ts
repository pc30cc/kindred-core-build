/**
 * AI Agent — Phase 3 structured action planning (3.2).
 *
 * The model NEVER executes anything. It may only append a single strictly
 * formatted block to its answer:
 *
 *   <ai_actions>{"actions":[{"name":"handoff_to_operator","arguments":{},"reason":"..."}]}</ai_actions>
 *
 * This module parses that block, strips it from the visitor-facing text and
 * returns at most MAX_ACTIONS_PER_TURN candidate proposals. Malformed output
 * yields ZERO actions — never a partial guess. No dynamic tool names, no
 * URLs, no code: everything is validated against the canonical catalog later
 * by the deterministic policy gate.
 */
import { z } from 'zod';
import { MAX_ACTIONS_PER_TURN } from './catalog.js';

export interface ProposedAction {
  name: string;
  arguments: Record<string, unknown>;
  reason: string | null;
}

export interface PlanParseResult {
  /** Visitor-facing text with every action block removed. */
  text: string;
  actions: ProposedAction[];
  /** True when a block existed. */
  blockPresent: boolean;
  parseError: string | null;
  /** Number of proposals dropped by the per-turn bound. */
  droppedForBound: number;
}

const BLOCK_RE = /<ai_actions>([\s\S]*?)<\/ai_actions>/gi;

const proposalSchema = z.object({
  name: z.string().min(1).max(64),
  arguments: z.record(z.unknown()).optional(),
  reason: z.string().max(300).optional(),
});
const planSchema = z.object({ actions: z.array(proposalSchema).max(20) }).strict();

export function parseActionPlan(rawText: string): PlanParseResult {
  const text = String(rawText || '');
  const out: PlanParseResult = {
    text: text.replace(BLOCK_RE, '').replace(/\n{3,}/g, '\n\n').trim(),
    actions: [],
    blockPresent: false,
    parseError: null,
    droppedForBound: 0,
  };
  BLOCK_RE.lastIndex = 0;
  const match = BLOCK_RE.exec(text);
  BLOCK_RE.lastIndex = 0;
  if (!match) return out;
  out.blockPresent = true;

  let parsed: unknown;
  try {
    parsed = JSON.parse((match[1] || '').trim());
  } catch {
    out.parseError = 'malformed_json';
    return out;
  }
  const res = planSchema.safeParse(parsed);
  if (!res.success) {
    out.parseError = 'schema_invalid';
    return out;
  }
  const all = res.data.actions;
  const bounded = all.slice(0, MAX_ACTIONS_PER_TURN);
  out.droppedForBound = Math.max(0, all.length - bounded.length);
  out.actions = bounded.map((a) => ({
    name: String(a.name).trim(),
    arguments: (a.arguments && typeof a.arguments === 'object' ? a.arguments : {}) as Record<string, unknown>,
    reason: a.reason ? String(a.reason).slice(0, 300) : null,
  }));
  return out;
}
