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

export interface AutomationMessageRegistry {
  /**
   * Attempts to claim `body` for this run. Returns true the first time a
   * given normalized body is claimed (caller should proceed with the real
   * insert), false on every subsequent claim of the same normalized body
   * this run (caller should suppress the physical insert).
   */
  claim(body: string): boolean;
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
  const seen = new Set<string>();
  return {
    claim(body: string): boolean {
      const key = normalizeAutomationMessageBody(body);
      // An empty body never reaches insertAiMessage (both executors already
      // reject it before this point) -- never let it consume a dedup slot.
      if (!key) return true;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    },
  };
}
