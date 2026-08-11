/**
 * AI Agent — Phase 2.1: bounded multi-turn conversation context.
 *
 * Produces a compact, explicitly-labelled "RECENT CONVERSATION" block used
 * for (a) retrieval query building and (b) the generation prompt.
 *
 * Hard rules:
 *   - conversation + workspace identifiers are BOTH required; the loader
 *     verifies the conversation really belongs to the workspace before it
 *     reads a single message (tenant isolation, Phase 2.9).
 *   - bounded by turn count AND characters — never dump a whole thread.
 *   - newest turns win; older turns are dropped first.
 *   - context is DATA for the model, never an instruction channel; the
 *     current visitor message stays separately identifiable.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

export type ContextRole = 'visitor' | 'assistant' | 'operator';

export interface ContextTurn {
  role: ContextRole;
  text: string;
  id?: string;
  createdAt?: string;
  metadata?: Record<string, any> | null;
}

export interface ConversationContextBounds {
  /** Maximum number of turns kept (newest first). */
  maxTurns?: number;
  /** Maximum total characters across kept turns. */
  maxChars?: number;
  /** Maximum characters per single turn before truncation. */
  maxCharsPerTurn?: number;
}

export interface ConversationContextResult {
  turns: ContextTurn[];
  /** Rendered block, or '' when there is no usable context. */
  text: string;
  turnsUsed: number;
  charCount: number;
  used: boolean;
}

export const DEFAULT_CONTEXT_BOUNDS: Required<ConversationContextBounds> = {
  maxTurns: 6,
  maxChars: 1200,
  maxCharsPerTurn: 300,
};

export function normalizeSenderRole(senderType: string | null | undefined): ContextRole | null {
  const t = (senderType || '').toLowerCase();
  if (t === 'visitor' || t === 'contact' || t === 'user') return 'visitor';
  if (t === 'ai' || t === 'assistant' || t === 'bot') return 'assistant';
  if (t === 'agent' || t === 'operator') return 'operator';
  return null;
}

function label(role: ContextRole): string {
  if (role === 'visitor') return 'Visitor';
  if (role === 'operator') return 'Agent';
  return 'Assistant';
}

/**
 * Pure formatter. `turns` must be chronological (oldest → newest). Keeps the
 * newest turns that fit inside BOTH bounds and renders them chronologically.
 */
export function formatConversationContext(
  turns: ContextTurn[],
  bounds: ConversationContextBounds = {},
): ConversationContextResult {
  const b = { ...DEFAULT_CONTEXT_BOUNDS, ...bounds };
  const cleaned = (turns || [])
    .map((t) => ({
      ...t,
      text: String(t?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, b.maxCharsPerTurn),
    }))
    .filter((t) => t.text.length > 0 && !!t.role);

  const kept: ContextTurn[] = [];
  let charCount = 0;
  for (let i = cleaned.length - 1; i >= 0; i--) {
    if (kept.length >= b.maxTurns) break;
    const candidate = cleaned[i];
    if (charCount + candidate.text.length > b.maxChars && kept.length > 0) break;
    kept.unshift(candidate);
    charCount += candidate.text.length;
  }

  if (!kept.length) {
    return { turns: [], text: '', turnsUsed: 0, charCount: 0, used: false };
  }
  const text = ['RECENT CONVERSATION:', ...kept.map((t) => `${label(t.role)}: ${t.text}`)].join('\n');
  return { turns: kept, text, turnsUsed: kept.length, charCount, used: true };
}

export interface LoadConversationContextInput extends ConversationContextBounds {
  workspaceId: string;
  conversationId: string;
  /** Exclude the message currently being answered (it is the CURRENT message). */
  excludeMessageId?: string | null;
  /** How many raw rows to read before bounding. */
  lookback?: number;
}

export interface LoadedConversationContext extends ConversationContextResult {
  /** All rows read (chronological), before bounding — for query building. */
  allTurns: ContextTurn[];
  tenantMismatch: boolean;
}

const EMPTY: LoadedConversationContext = {
  turns: [], text: '', turnsUsed: 0, charCount: 0, used: false,
  allTurns: [], tenantMismatch: false,
};

/**
 * Loads recent turns for ONE conversation inside ONE workspace. Returns an
 * empty context (never throws) when identifiers are missing, when the
 * conversation does not belong to the workspace, or on any read error.
 */
export async function loadConversationContext(
  config: ServerConfig,
  input: LoadConversationContextInput,
): Promise<LoadedConversationContext> {
  const workspaceId = (input?.workspaceId || '').trim();
  const conversationId = (input?.conversationId || '').trim();
  if (!workspaceId || !conversationId) return { ...EMPTY };

  try {
    const sb = getServiceClient(config);
    // Tenant gate FIRST: the conversation must belong to this workspace.
    const { data: convo } = await sb
      .from('conversations')
      .select('id, workspace_id')
      .eq('id', conversationId)
      .eq('workspace_id', workspaceId)
      .maybeSingle();
    if (!convo?.id) return { ...EMPTY, tenantMismatch: true };

    const { data: rows } = await sb
      .from('conversation_messages')
      .select('id, body, sender_type, metadata, created_at')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(Math.max(2, input.lookback ?? 12));

    const allTurns: ContextTurn[] = (rows || [])
      .slice()
      .reverse()
      .filter((r: any) => !input.excludeMessageId || r.id !== input.excludeMessageId)
      .map((r: any) => ({
        id: r.id,
        role: normalizeSenderRole(r.sender_type) as ContextRole,
        text: String(r.body || ''),
        createdAt: r.created_at,
        metadata: r.metadata || null,
      }))
      .filter((t) => !!t.role);

    const formatted = formatConversationContext(allTurns, {
      maxTurns: input.maxTurns,
      maxChars: input.maxChars,
      maxCharsPerTurn: input.maxCharsPerTurn,
    });
    return { ...formatted, allTurns, tenantMismatch: false };
  } catch {
    return { ...EMPTY };
  }
}