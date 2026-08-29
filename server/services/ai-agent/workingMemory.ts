/**
 * AI Agent — bounded conversation working memory.
 *
 * A rolling transcript tells the model WHAT was said. It does not tell it
 * what already FAILED. Resolution-aware support needs the second one:
 *
 *   AI:      "The docs are at https://example.test/docs"
 *   Visitor: "that link doesn't open"
 *            → the link must be recorded as a failed resource and never
 *              re-offered as the primary answer.
 *
 *   AI:      "Clear your browser cache."
 *   Visitor: "did that, didn't work"
 *            → the step must be recorded as an unsuccessful attempt.
 *
 * Storage: `conversations.metadata.ai_memory`. No new table — the state is
 * small, always read together with the conversation, and already covered by
 * conversation-level tenant isolation.
 *
 * Every array is hard-bounded so metadata cannot grow forever.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

export const MEMORY_KEY = 'ai_memory';

export const MEMORY_BOUNDS = {
  maxFailedResources: 8,
  maxResolutionAttempts: 6,
  maxEntities: 10,
  maxRecommendedResources: 6,
  maxTextLen: 300,
  maxEntityLen: 80,
} as const;

export type IssueStatus = 'unknown' | 'open' | 'in_progress' | 'awaiting_user' | 'resolved';
export type AttemptStatus = 'proposed' | 'failed' | 'succeeded' | 'unknown';

export interface ResolutionAttempt {
  /** Short factual description of what was suggested. Never reasoning. */
  summary: string;
  status: AttemptStatus;
  at: string;
}

export interface WorkingMemory {
  currentIssue: string | null;
  currentGoal: string | null;
  issueStatus: IssueStatus;
  entities: string[];
  resolutionAttempts: ResolutionAttempt[];
  lastRecommendedResources: string[];
  failedResources: string[];
  awaitingUserAction: string | null;
  handoffRequestCount: number;
  assistAttemptCount: number;
  lastGroundedTopic: string | null;
  guidanceRequestStatus: 'none' | 'pending' | 'resolved';
  updatedAt: string | null;
}

export const EMPTY_MEMORY: WorkingMemory = {
  currentIssue: null,
  currentGoal: null,
  issueStatus: 'unknown',
  entities: [],
  resolutionAttempts: [],
  lastRecommendedResources: [],
  failedResources: [],
  awaitingUserAction: null,
  handoffRequestCount: 0,
  assistAttemptCount: 0,
  lastGroundedTopic: null,
  guidanceRequestStatus: 'none',
  updatedAt: null,
};

function str(v: unknown, max: number = MEMORY_BOUNDS.maxTextLen): string | null {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}

function uniqBounded(list: unknown[], max: number, maxLen: number): string[] {
  const out: string[] = [];
  for (const raw of list || []) {
    const v = str(raw, maxLen);
    if (v && !out.includes(v)) out.push(v);
    if (out.length >= max) break;
  }
  return out;
}

/** Tolerant reader — any legacy/garbage shape degrades to EMPTY_MEMORY. */
export function readWorkingMemory(metadata: unknown): WorkingMemory {
  const raw = ((metadata as any) || {})[MEMORY_KEY];
  if (!raw || typeof raw !== 'object') return { ...EMPTY_MEMORY };
  const m = raw as Record<string, unknown>;
  const attempts = Array.isArray(m.resolutionAttempts) ? m.resolutionAttempts : [];
  return {
    currentIssue: str(m.currentIssue),
    currentGoal: str(m.currentGoal),
    issueStatus: (['unknown', 'open', 'in_progress', 'awaiting_user', 'resolved'] as const).includes(
      m.issueStatus as IssueStatus,
    )
      ? (m.issueStatus as IssueStatus)
      : 'unknown',
    entities: uniqBounded(
      Array.isArray(m.entities) ? m.entities : [],
      MEMORY_BOUNDS.maxEntities,
      MEMORY_BOUNDS.maxEntityLen,
    ),
    resolutionAttempts: attempts
      .slice(-MEMORY_BOUNDS.maxResolutionAttempts)
      .map((a: any) => ({
        summary: str(a?.summary) || '',
        status: (['proposed', 'failed', 'succeeded', 'unknown'] as const).includes(a?.status)
          ? a.status
          : 'unknown',
        at: typeof a?.at === 'string' ? a.at : new Date(0).toISOString(),
      }))
      .filter((a: ResolutionAttempt) => !!a.summary),
    lastRecommendedResources: uniqBounded(
      Array.isArray(m.lastRecommendedResources) ? m.lastRecommendedResources : [],
      MEMORY_BOUNDS.maxRecommendedResources,
      MEMORY_BOUNDS.maxEntityLen * 4,
    ),
    failedResources: uniqBounded(
      Array.isArray(m.failedResources) ? m.failedResources : [],
      MEMORY_BOUNDS.maxFailedResources,
      MEMORY_BOUNDS.maxEntityLen * 4,
    ),
    awaitingUserAction: str(m.awaitingUserAction),
    handoffRequestCount: Number.isFinite(m.handoffRequestCount) ? Number(m.handoffRequestCount) : 0,
    assistAttemptCount: Number.isFinite(m.assistAttemptCount) ? Number(m.assistAttemptCount) : 0,
    lastGroundedTopic: str(m.lastGroundedTopic, MEMORY_BOUNDS.maxEntityLen),
    guidanceRequestStatus: (['none', 'pending', 'resolved'] as const).includes(
      m.guidanceRequestStatus as any,
    )
      ? (m.guidanceRequestStatus as WorkingMemory['guidanceRequestStatus'])
      : 'none',
    updatedAt: typeof m.updatedAt === 'string' ? m.updatedAt : null,
  };
}

export interface MemoryPatch {
  currentIssue?: string | null;
  currentGoal?: string | null;
  issueStatus?: IssueStatus;
  addEntities?: string[];
  addAttempt?: { summary: string; status: AttemptStatus };
  /** Mark the most recent matching attempt as failed/succeeded. */
  markLastAttempt?: AttemptStatus;
  addRecommendedResources?: string[];
  addFailedResources?: string[];
  awaitingUserAction?: string | null;
  incrementHandoffRequests?: boolean;
  incrementAssistAttempts?: boolean;
  lastGroundedTopic?: string | null;
  guidanceRequestStatus?: WorkingMemory['guidanceRequestStatus'];
}

/** Pure reducer — deterministic, no IO, fully unit-testable. */
export function applyMemoryPatch(current: WorkingMemory, patch: MemoryPatch): WorkingMemory {
  const next: WorkingMemory = {
    ...current,
    entities: [...current.entities],
    resolutionAttempts: [...current.resolutionAttempts],
    lastRecommendedResources: [...current.lastRecommendedResources],
    failedResources: [...current.failedResources],
  };

  if (patch.currentIssue !== undefined) next.currentIssue = str(patch.currentIssue);
  if (patch.currentGoal !== undefined) next.currentGoal = str(patch.currentGoal);
  if (patch.issueStatus) next.issueStatus = patch.issueStatus;
  if (patch.awaitingUserAction !== undefined) next.awaitingUserAction = str(patch.awaitingUserAction);
  if (patch.lastGroundedTopic !== undefined) {
    next.lastGroundedTopic = str(patch.lastGroundedTopic, MEMORY_BOUNDS.maxEntityLen);
  }
  if (patch.guidanceRequestStatus) next.guidanceRequestStatus = patch.guidanceRequestStatus;
  if (patch.incrementHandoffRequests) next.handoffRequestCount = current.handoffRequestCount + 1;
  if (patch.incrementAssistAttempts) next.assistAttemptCount = current.assistAttemptCount + 1;

  if (patch.addEntities?.length) {
    next.entities = uniqBounded(
      [...patch.addEntities, ...next.entities],
      MEMORY_BOUNDS.maxEntities,
      MEMORY_BOUNDS.maxEntityLen,
    );
  }
  if (patch.addRecommendedResources?.length) {
    next.lastRecommendedResources = uniqBounded(
      [...patch.addRecommendedResources, ...next.lastRecommendedResources],
      MEMORY_BOUNDS.maxRecommendedResources,
      MEMORY_BOUNDS.maxEntityLen * 4,
    );
  }
  if (patch.addFailedResources?.length) {
    next.failedResources = uniqBounded(
      [...patch.addFailedResources, ...next.failedResources],
      MEMORY_BOUNDS.maxFailedResources,
      MEMORY_BOUNDS.maxEntityLen * 4,
    );
  }
  if (patch.addAttempt?.summary) {
    const summary = str(patch.addAttempt.summary) || '';
    if (summary) {
      next.resolutionAttempts = [
        ...next.resolutionAttempts.filter((a) => a.summary !== summary),
        { summary, status: patch.addAttempt.status, at: new Date().toISOString() },
      ].slice(-MEMORY_BOUNDS.maxResolutionAttempts);
    }
  }
  if (patch.markLastAttempt && next.resolutionAttempts.length) {
    const last = next.resolutionAttempts[next.resolutionAttempts.length - 1];
    next.resolutionAttempts[next.resolutionAttempts.length - 1] = {
      ...last,
      status: patch.markLastAttempt,
    };
  }

  next.updatedAt = new Date().toISOString();
  return next;
}

// ─── Deterministic signal extraction (no LLM call) ─────────────────────

const URL_RE = /https?:\/\/[^\s<>"')]+/gi;

export function extractUrls(text: string): string[] {
  return Array.from(new Set(String(text || '').match(URL_RE) || [])).slice(
    0,
    MEMORY_BOUNDS.maxRecommendedResources,
  );
}

/** "this link doesn't open", "لینک باز نمیشه", "link açılmıyor" … */
const BROKEN_RESOURCE_PATTERNS = [
  /\blink\b.{0,24}\b(broken|dead|down|not work|doesn'?t work|won'?t open|does not open|404)\b/i,
  /\b(broken|dead|invalid)\s+link\b/i,
  /\burl\b.{0,20}\b(not work|doesn'?t work|404|error)\b/i,
  /لینک.{0,25}(باز نمی|کار نمی|خرابه|باز نمیشه|نمی‌شه|نمیشه)/,
  /(باز نمی‌شود|باز نمیشه).{0,20}لینک/,
  /link.{0,20}(açılmıyor|çalışmıyor|bozuk)/i,
];

/** "did that, didn't work", "انجام دادم نشد", "yaptım olmadı" … */
const FAILED_ATTEMPT_PATTERNS = [
  /\b(tried|did) (that|it|this)\b.{0,30}\b(didn'?t|did not|no luck|still|not work)/i,
  /\bstill (not|doesn'?t|isn'?t|hasn'?t)\b/i,
  /\bnot (fixed|resolved|solved)\b/i,
  /(انجام دادم|امتحان کردم|تست کردم).{0,25}(نشد|نمی‌شه|نمیشه|فرقی نکرد|همونه)/,
  /(هنوز|همچنان).{0,20}(حل نشده|درست نشد|کار نمی)/,
  /(yaptım|denedim).{0,25}(olmadı|çalışmadı|değişmedi)/i,
  /hâlâ .{0,20}(çalışmıyor|olmuyor)/i,
];

export interface VisitorSignals {
  reportsBrokenResource: boolean;
  reportsFailedAttempt: boolean;
  referencesPreviousResource: boolean;
}

export function detectVisitorSignals(text: string): VisitorSignals {
  const t = String(text || '');
  const reportsBrokenResource = BROKEN_RESOURCE_PATTERNS.some((r) => r.test(t));
  const reportsFailedAttempt = FAILED_ATTEMPT_PATTERNS.some((r) => r.test(t));
  return {
    reportsBrokenResource,
    reportsFailedAttempt,
    referencesPreviousResource:
      reportsBrokenResource || /\b(this|that|it)\b/i.test(t) || /\b(این|اون|آن)\b/.test(t),
  };
}

/**
 * Deterministically fold the current turn into memory. Runs BEFORE
 * generation and costs zero provider calls (requirement §25).
 */
export function deriveTurnPatch(args: {
  visitorText: string;
  previousAssistantText?: string | null;
  memory: WorkingMemory;
}): MemoryPatch {
  const signals = detectVisitorSignals(args.visitorText);
  const patch: MemoryPatch = {};

  if (signals.reportsBrokenResource) {
    // The failed resource is whatever the assistant most recently offered.
    const fromPrevious = extractUrls(args.previousAssistantText || '');
    const candidates = fromPrevious.length ? fromPrevious : args.memory.lastRecommendedResources;
    if (candidates.length) patch.addFailedResources = candidates.slice(0, 2);
    patch.issueStatus = 'in_progress';
  }
  if (signals.reportsFailedAttempt) {
    patch.markLastAttempt = 'failed';
    patch.issueStatus = 'in_progress';
  }
  if (!args.memory.currentIssue) {
    patch.currentIssue = args.visitorText;
    patch.issueStatus = patch.issueStatus || 'open';
  }
  return patch;
}

/** Prompt-ready block. Bounded, factual, no reasoning. */
export function renderMemoryBlock(m: WorkingMemory): string | null {
  const lines: string[] = [];
  if (m.currentIssue) lines.push(`- Open issue: ${m.currentIssue}`);
  if (m.issueStatus !== 'unknown') lines.push(`- Issue status: ${m.issueStatus}`);
  if (m.awaitingUserAction) lines.push(`- Waiting on the visitor to: ${m.awaitingUserAction}`);
  const failedAttempts = m.resolutionAttempts.filter((a) => a.status === 'failed');
  if (failedAttempts.length) {
    lines.push(
      `- Already tried and did NOT work (do not repeat as a new suggestion): ${failedAttempts
        .map((a) => a.summary)
        .join('; ')}`,
    );
  }
  if (m.failedResources.length) {
    lines.push(
      `- Links/resources the visitor says are broken (do not re-offer as the main answer): ${m.failedResources.join(', ')}`,
    );
  }
  if (m.entities.length) lines.push(`- Relevant details from the visitor: ${m.entities.join(', ')}`);
  if (!lines.length) return null;
  return ['BEGIN CONVERSATION MEMORY', ...lines, 'END CONVERSATION MEMORY'].join('\n');
}

// ─── Persistence ───────────────────────────────────────────────────────

export async function loadWorkingMemory(
  config: ServerConfig,
  workspaceId: string,
  conversationId: string,
): Promise<WorkingMemory> {
  if (!workspaceId || !conversationId) return { ...EMPTY_MEMORY };
  try {
    const sb = getServiceClient(config);
    const { data } = await sb
      .from('conversations')
      .select('metadata')
      .eq('id', conversationId)
      .eq('workspace_id', workspaceId)
      .maybeSingle();
    return readWorkingMemory((data as any)?.metadata);
  } catch {
    return { ...EMPTY_MEMORY };
  }
}

/**
 * Read-modify-write the memory sub-object only. Never touches unrelated
 * conversation metadata keys (handoff state, runtime flags, channel data).
 */
export async function persistWorkingMemory(
  config: ServerConfig,
  args: { workspaceId: string; conversationId: string; patch: MemoryPatch },
): Promise<WorkingMemory | null> {
  if (!args.workspaceId || !args.conversationId) return null;
  try {
    const sb = getServiceClient(config);
    const { data } = await sb
      .from('conversations')
      .select('metadata')
      .eq('id', args.conversationId)
      .eq('workspace_id', args.workspaceId)
      .maybeSingle();
    if (!data) return null;
    const meta = ((data as any).metadata || {}) as Record<string, unknown>;
    const next = applyMemoryPatch(readWorkingMemory(meta), args.patch);
    await sb
      .from('conversations')
      .update({ metadata: { ...meta, [MEMORY_KEY]: next } })
      .eq('id', args.conversationId)
      .eq('workspace_id', args.workspaceId);
    return next;
  } catch {
    return null;
  }
}

/** Bounded observability payload. */
export function memoryMeta(m: WorkingMemory): Record<string, unknown> {
  return {
    conversation_memory_used: !!(m.currentIssue || m.failedResources.length || m.resolutionAttempts.length),
    current_issue_status: m.issueStatus,
    resolution_attempt_count: m.resolutionAttempts.length,
    previous_resolution_failed: m.resolutionAttempts.some((a) => a.status === 'failed'),
    failed_resource_count: m.failedResources.length,
    handoff_request_count: m.handoffRequestCount,
    assist_attempt_count: m.assistAttemptCount,
  };
}
