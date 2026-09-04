/**
 * AI Proactive Nudge — strict structured decision contract.
 *
 * The model NEVER returns free-form text that is shown to the visitor
 * as-is without validation. Every field is bounded and enum-checked here;
 * a malformed or out-of-range response fails closed (see evaluate.ts) —
 * it is treated exactly like "no AI response", never partially trusted.
 */
import { z } from 'zod';

/** Hard ceiling — the platform max_message_length (see policy.ts) clamps below this. */
export const AI_NUDGE_MESSAGE_HARD_MAX = 400;
export const AI_NUDGE_REASON_MAX = 200;
export const AI_NUDGE_CTA_LABEL_MAX = 60;
export const AI_NUDGE_TOPIC_MAX = 60;

export const aiNudgeCtaSchema = z.object({
  label: z.string().trim().min(1).max(AI_NUDGE_CTA_LABEL_MAX),
  action: z.enum(['open_chat', 'open_url', 'none']),
  /** Only meaningful for action:'open_url'; validated further (isSafeSmartUrl) before use. */
  url: z.string().max(1000).optional().nullable(),
});

export const aiNudgeDecisionSchema = z.discriminatedUnion('decision', [
  z.object({
    decision: z.literal('show'),
    intent: z.string().trim().min(1).max(60),
    confidence: z.number().min(0).max(1),
    reason: z.string().trim().max(AI_NUDGE_REASON_MAX).optional().default(''),
    message: z.string().trim().min(1).max(AI_NUDGE_MESSAGE_HARD_MAX),
    cta: aiNudgeCtaSchema.optional().nullable(),
    topic: z.string().trim().min(1).max(AI_NUDGE_TOPIC_MAX),
  }),
  z.object({
    decision: z.literal('suppress'),
    intent: z.string().trim().min(1).max(60).optional().default('low_intent'),
    confidence: z.number().min(0).max(1).optional().default(0),
    reason: z.string().trim().max(AI_NUDGE_REASON_MAX).optional().default(''),
  }),
]);

export type AiNudgeDecision = z.infer<typeof aiNudgeDecisionSchema>;

/**
 * Parse the model's raw text output. Fails closed (returns null) on any
 * JSON error, schema violation, or unexpectedly large payload — the caller
 * MUST treat null exactly like "suppress", never render partial output.
 */
export function parseAiNudgeDecision(raw: string): AiNudgeDecision | null {
  if (!raw || raw.length > 8000) return null;
  let obj: unknown;
  try {
    // Models sometimes wrap JSON in a fenced code block despite instructions.
    const cleaned = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    obj = JSON.parse(cleaned);
  } catch {
    return null;
  }
  const result = aiNudgeDecisionSchema.safeParse(obj);
  return result.success ? result.data : null;
}
