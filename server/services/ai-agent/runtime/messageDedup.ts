/**
 * AI Agent — cross-system automation message dedup, single run scope.
 *
 * Routing, Message Triggers, and Workflows are evaluated and executed
 * independently (see routingRuntime.ts / triggerRuntime.ts / workflowRuntime.ts
 * and their executors actionExecutor.ts / workflowExecutor.ts). A Message
 * Trigger and a Workflow can both be configured to send the same
 * visitor-facing message for the same event; neither executor shares any
 * dedup key with the other, so without this registry both could insert the
 * identical message in one turn.
 *
 * This registry owns EXACTLY ONE thing: suppressing a physical insert when
 * the OPPOSITE source has already successfully inserted the identical body
 * this run. It deliberately does NOT dedupe within one source -- two
 * different Message Triggers (or two Workflows, or two same-body steps in
 * one Workflow) with the same body are pre-existing, legitimate same-system
 * behavior this primitive must never touch; that domain belongs to
 * run_once_per_conversation (Message Triggers) and dedupKey (Workflows).
 *
 * Recording only happens after a real insertAiMessage() call succeeds --
 * never on a claim/attempt -- so if the first source to try fails (DB error,
 * etc.), the second source still gets to insert its own copy rather than
 * seeing a phantom "already sent" state and silently producing zero
 * messages.
 *
 * Scope is deliberately ONE engine run (one visitor message): a fresh
 * registry is created once per call to runAutomationStage and threaded
 * through both the pre-retrieval executors and the post-answer
 * evaluateNoAnswerHooks() path, so it protects both places automation
 * messages can be inserted. It is plain in-process memory, never persisted:
 * a later visitor turn gets its own registry (no conversation-lifetime
 * suppression), and it never crosses a request boundary, so two concurrent
 * runs -- even for the same conversation -- never share one instance and
 * there is no race window to reason about.
 */

export type AutomationMessageSource = 'message_trigger' | 'workflow';

export interface AutomationMessageRegistry {
  /**
   * True if a source OTHER than `source` has already successfully inserted
   * the identical normalized body this run. The caller should suppress its
   * own physical insert when this returns true. Same-source repeats (e.g. a
   * second Message Trigger, or a second step in the same Workflow) always
   * return false here -- that is not this registry's concern.
   */
  wasInsertedByOtherSource(body: string, source: AutomationMessageSource): boolean;
  /**
   * Records a successful physical insert. Call ONLY after insertAiMessage()
   * has actually resolved -- never before attempting it, and never on
   * failure -- so a failed first attempt never blocks a legitimate second
   * attempt from the other source.
   */
  recordSuccessfulInsert(body: string, source: AutomationMessageSource): void;
}

/**
 * Conservative body identity for dedup purposes: trim outer whitespace and
 * normalize CRLF to LF. Deliberately does NOT lowercase, strip punctuation,
 * collapse internal whitespace, or touch Unicode -- two messages that merely
 * look similar must not be treated as identical.
 */
export function normalizeAutomationMessageBody(body: string | null | undefined): string {
  return String(body ?? '').replace(/\r\n/g, '\n').trim();
}

export function createAutomationMessageRegistry(): AutomationMessageRegistry {
  // normalized body -> source that successfully inserted it first.
  const insertedBy = new Map<string, AutomationMessageSource>();
  return {
    wasInsertedByOtherSource(body: string, source: AutomationMessageSource): boolean {
      const key = normalizeAutomationMessageBody(body);
      if (!key) return false;
      const existing = insertedBy.get(key);
      return existing !== undefined && existing !== source;
    },
    recordSuccessfulInsert(body: string, source: AutomationMessageSource): void {
      const key = normalizeAutomationMessageBody(body);
      // An empty body never reaches insertAiMessage (both executors already
      // reject it before this point) -- never let it consume a dedup slot.
      if (!key) return;
      if (!insertedBy.has(key)) insertedBy.set(key, source);
    },
  };
}
