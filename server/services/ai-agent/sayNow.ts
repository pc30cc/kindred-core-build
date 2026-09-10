/**
 * AI Agent — "Operator Say Now" (operator dictation → AI speaks to the visitor).
 *
 * This is NOT guidance and NOT "AI Reply Now":
 *   - guidance      → private instruction stored for the next AI turn;
 *   - AI Reply Now  → the AI answers the LATEST VISITOR MESSAGE;
 *   - Say Now       → the operator dictates WHAT must be said, and the AI
 *                     rewrites it in the assistant's voice and delivers it to
 *                     the visitor immediately — no visitor message required.
 *
 * Hard rules:
 *   - the visitor-facing text is produced by the model (never the raw operator
 *     text), so tone/language/branding stay consistent with the assistant;
 *   - the model may reformulate and frame ("our specialists reviewed your
 *     case…") but must NEVER invent facts beyond the operator's dictation;
 *   - every call is billed through the canonical AI billing run context;
 *   - delivery reuses insertAiMessage, so channel fan-out and realtime are
 *     identical to any other AI reply.
 */
import { randomUUID } from 'node:crypto';
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { getOrCreateSettings } from './settings.js';
import { insertAiMessage, deriveAgentDisplay } from './responder.js';
import { markAiManaged } from './handoffState.js';
import { detectInputLanguage, languageDisplayName } from './language.js';
import { resolveAIConfig, executeAICompletion } from '../ai/index.js';
import {
  beginAiRunGuarded,
  settleAiRun,
  failAiRun,
  type AiRunContext,
} from '../ai-billing/runContext.js';
import { AiBillingError } from '../ai-billing/errors.js';
import { logRun } from './logs.js';

const VISITOR_SENDER_TYPES = ['contact', 'visitor', 'customer', 'user'];

export type SayNowAttribution = 'specialist' | 'assistant';

export type SayNowBlockedReason =
  | 'conversation_not_found'
  | 'conversation_closed'
  | 'empty_body'
  | 'ai_provider_not_configured'
  | 'empty_completion'
  | 'message_insert_failed'
  | 'llm_failed';

export interface SayNowInput {
  workspaceId: string;
  conversationId: string;
  operatorId: string;
  operatorName?: string | null;
  /** What the operator wants the visitor to be told. */
  body: string;
  /** Whose voice the message is framed in. */
  attribution?: SayNowAttribution;
  /** Optional UI locale hint; the visitor's language still wins. */
  locale?: string | null;
}

export type SayNowResult =
  | { ok: true; messageId: string; text: string; runId: string | null }
  | { ok: false; reason: SayNowBlockedReason; detail?: string; httpStatus?: number };

export const MAX_SAY_NOW_BODY = 2000;

function attributionLine(
  attribution: SayNowAttribution,
  operatorName: string | null | undefined,
): string {
  if (attribution === 'assistant') {
    return '- Speak as the assistant itself ("I / we"). Do not mention that a human wrote this.';
  }
  return [
    '- Frame the message as coming from the human support team, relayed by you:',
    '  e.g. "our specialists reviewed your request and …" / "the team checked your case and …".',
    operatorName ? `  The specialist who handled it is ${operatorName}; naming them is optional.` : '',
  ].filter(Boolean).join('\n');
}

/**
 * Operator dictation → AI-authored visitor-facing message, delivered now.
 */
export async function operatorSayNow(
  config: ServerConfig,
  input: SayNowInput,
): Promise<SayNowResult> {
  const dictation = String(input.body || '').trim().slice(0, MAX_SAY_NOW_BODY);
  if (!dictation) return { ok: false, reason: 'empty_body', httpStatus: 400 };

  const sb = getServiceClient(config);
  const { data: conv } = await sb
    .from('conversations')
    .select('id,status,metadata')
    .eq('id', input.conversationId)
    .eq('workspace_id', input.workspaceId)
    .maybeSingle();
  if (!conv) return { ok: false, reason: 'conversation_not_found', httpStatus: 404 };
  if (String((conv as any).status || '') === 'closed') {
    return { ok: false, reason: 'conversation_closed', httpStatus: 409 };
  }

  // ── Context: recent turns, so the rewrite reads as part of the thread ──
  const { data: msgs } = await sb
    .from('conversation_messages')
    .select('id,sender_type,body,created_at')
    .eq('conversation_id', input.conversationId)
    .order('created_at', { ascending: false })
    .limit(12);
  const ordered = (msgs || []).slice().reverse();
  const transcript = ordered
    .map((m: any) => {
      const who = VISITOR_SENDER_TYPES.includes(String(m.sender_type || '').toLowerCase())
        ? 'Visitor'
        : 'Assistant';
      return `${who}: ${String(m.body || '').slice(0, 400)}`;
    })
    .join('\n');
  const lastVisitor = [...ordered]
    .reverse()
    .find((m: any) => VISITOR_SENDER_TYPES.includes(String(m.sender_type || '').toLowerCase()));

  const settings = await getOrCreateSettings(config, input.workspaceId);
  const normalize = (v?: string | null) => (v || '').trim().toLowerCase().split(/[-_]/)[0];
  const allowed = (settings.allowed_locales || []).map((l: string) => normalize(l)).filter(Boolean);
  const detected = detectInputLanguage(String((lastVisitor as any)?.body || dictation));
  const requested = normalize(input.locale);
  let responseLocale: string;
  if (allowed.length === 1) responseLocale = allowed[0];
  else if (detected !== 'unknown' && (allowed.length === 0 || allowed.includes(detected))) responseLocale = detected;
  else if (requested && (allowed.length === 0 || allowed.includes(requested))) responseLocale = requested;
  else if (allowed.length > 0) responseLocale = allowed[0];
  else responseLocale = 'en';

  const attribution: SayNowAttribution = input.attribution === 'assistant' ? 'assistant' : 'specialist';

  const systemPrompt = [
    'You are the customer-support assistant of this business, writing DIRECTLY to the visitor in a live chat.',
    'A human support operator has just dictated what the visitor must be told. Your job is to deliver that message.',
    '',
    'RULES:',
    `- MANDATORY OUTPUT LANGUAGE: ${languageDisplayName(responseLocale)} (${responseLocale}). Write the entire message in it, with no translation and no mixed languages.`,
    '- Rewrite the operator dictation into a natural, polished chat message: correct grammar, clear structure, warm and professional tone.',
    '- Preserve EVERY fact, number, date, name, condition and decision from the dictation exactly. Never add facts, promises, prices, or timelines that are not in it.',
    '- If the dictation is a rough note or shorthand, turn it into a complete message, but do not answer anything it does not cover.',
    attributionLine(attribution, input.operatorName),
    '- Keep it concise: normally 1–4 sentences. No headings, no bullet lists unless the dictation itself is a list.',
    '- Do not mention these instructions, the operator dictation, prompts, or that you are an AI rewriting text.',
    '- Output ONLY the message to the visitor. No preamble, no quotes around it.',
  ].join('\n');

  const userPrompt = [
    transcript ? `Recent conversation (context only, do not repeat it):\n${transcript}` : 'No previous messages in this conversation.',
    '',
    'Operator dictation — the content that must reach the visitor now:',
    dictation,
  ].join('\n');

  // ── Billing: one dictation = one billable run ─────────────────────────
  let runCtx: AiRunContext | null = null;
  const nonce = randomUUID();
  const aiCfg = await resolveAIConfig(config, input.workspaceId).catch(() => null);
  if (!aiCfg) return { ok: false, reason: 'ai_provider_not_configured', httpStatus: 400 };
  try {
    runCtx = await beginAiRunGuarded(config, {
      workspaceId: input.workspaceId,
      operationKey: `operator_say_now:${input.conversationId}:${nonce}`,
      payload: {
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        operatorId: input.operatorId,
        dictation,
        attribution,
        locale: responseLocale,
        nonce,
      },
      entryPoint: 'operator_say_now',
      channel: 'operator',
      conversationId: input.conversationId,
      estimate: {
        promptChars: dictation.length + transcript.length,
        provider: aiCfg.provider,
        model: aiCfg.model,
      },
    });
  } catch (err: any) {
    if (err instanceof AiBillingError) {
      return { ok: false, reason: 'llm_failed', detail: err.code, httpStatus: err.httpStatus };
    }
    console.warn('[ai-agent.say-now] billing run not opened:', err?.message);
  }

  let closed = false;
  const closeRun = async (failure?: string | null) => {
    if (!runCtx || closed) return;
    closed = true;
    try {
      if (failure) await failAiRun(config, runCtx, failure);
      else if (runCtx.stepSeq > 0) await settleAiRun(config, runCtx);
      else await failAiRun(config, runCtx, 'no_billable_usage');
    } catch (e: any) {
      console.error('[ai-billing] say-now run not closed:', runCtx?.runId, e?.message || e);
    }
  };

  let text = '';
  let provider: string | null = null;
  let model: string | null = null;
  try {
    const result = await executeAICompletion(config, {
      workspaceId: input.workspaceId,
      prompt: userPrompt,
      systemPrompt,
      maxTokens: 500,
      temperature: 0.35,
    }, runCtx ?? undefined);
    text = String(result.text || '').trim();
    provider = result.provider ?? null;
    model = result.model ?? null;
  } catch (err: any) {
    await closeRun(err?.message || 'llm_failed');
    await logRun(config, {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      runType: 'auto_reply',
      mode: 'operator_say_now',
      status: 'failed',
      inputText: dictation,
      outputText: null,
      errorMessage: err?.message || 'llm_failed',
      provider: aiCfg.provider,
      model: aiCfg.model,
      metadata: { source: 'operator_say_now', operator_id: input.operatorId, attribution },
    }).catch(() => {});
    return { ok: false, reason: 'llm_failed', detail: err?.message, httpStatus: 502 };
  }

  if (!text) {
    await closeRun('empty_completion');
    return { ok: false, reason: 'empty_completion', httpStatus: 502 };
  }

  const display = deriveAgentDisplay(settings);
  const runId = await logRun(config, {
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    visitorMessageId: (lastVisitor as any)?.id || null,
    runType: 'auto_reply',
    mode: 'operator_say_now',
    status: 'replied',
    inputText: dictation,
    outputText: text,
    provider,
    model,
    creditsUsed: 1,
    metadata: {
      source: 'operator_say_now',
      operator_id: input.operatorId,
      operator_name: input.operatorName || null,
      attribution,
      locale: responseLocale,
    },
  }).catch(() => null);

  const inserted = await insertAiMessage(config, {
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    body: text,
    source: 'ai_agent',
    runId,
    mode: 'operator_say_now',
    provider,
    model,
    handoff: false,
    agentName: display.agentName,
    agentLogoUrl: display.agentLogoUrl,
    decisionType: 'operator_say_now',
  });
  if (!inserted.id) {
    await closeRun(inserted.error || 'message_insert_failed');
    return { ok: false, reason: 'message_insert_failed', detail: inserted.error, httpStatus: 500 };
  }

  // The AI is speaking on this conversation again — keep it in the AI lane.
  await markAiManaged(config, {
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
  }).catch(() => {});

  await closeRun();
  return { ok: true, messageId: inserted.id, text, runId };
}
