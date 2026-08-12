/**
 * AI Agent — knowledge-retrieval decision (architecture cleanup).
 *
 * Replaces the old shape-based heuristic
 *   `hasQuestionMark || containsDigit || containsUrl || wordCount > 3`
 * which treated "اسمت چیه؟" and "چه کارهایی می‌تونی انجام بدی؟" as business
 * questions purely because of punctuation / length.
 *
 * This module answers ONE conceptual question:
 *
 *   "Does answering this message plausibly require trusted,
 *    business-specific information?"
 *
 * It owns NO phrase list, NO greeting list, NO identity patterns and NO
 * intent taxonomy. It only REUSES signals the pipeline already produced
 * before this point:
 *
 *   - domainTopics        — query-expansion topic groups (existing signal)
 *   - addedTerms          — synonym expansion actually fired (existing)
 *   - workspaceTopicSlugs — OWNER-configured ai_agent_topics detections
 *   - pageContextPresent  — visitor is asking in the context of a real page
 *   - follow-up signals   — queryBuilder's deterministic referential /
 *                           clarification detection, combined with whether
 *                           the PREVIOUS turn was itself business-grounded
 *
 * Everything else (greetings, thanks, identity, capability questions,
 * conversational follow-ups) produces none of these signals and therefore
 * skips retrieval entirely — the LLM answers from assistant config + history.
 *
 * This is a COST gate, never an answer gate: skipping retrieval never
 * changes WHETHER the model answers.
 */

export interface RetrievalDecisionSignals {
  /** Query-expansion topic groups matched on the current message. */
  domainTopics: string[];
  /** Synonym terms the expansion added (non-empty ⇒ domain vocabulary hit). */
  addedTerms: string[];
  /** Owner-configured topics detected for this message. */
  workspaceTopicSlugs: string[];
  /**
   * We merely KNOW which page the visitor is viewing. This is ambient
   * context, never evidence that the message needs business knowledge:
   * standing on /pricing and saying "سلام" is still a greeting.
   */
  pageContextAvailable: boolean;
  /**
   * The visitor's message explicitly REFERS to the page they are on
   * ("این صفحه چیه؟"), detected upstream by detectPageIntent(). Only this
   * — not mere availability — makes page context a business signal.
   */
  pageContextReferenced: boolean;
  /** queryBuilder detected a referential / clarification follow-up. */
  followUp: boolean;
  /** Topic groups of the visitor turn this follow-up refers back to. */
  priorIntentDomainTopics: string[];
  /** The previous assistant turn actually used business knowledge. */
  priorTurnUsedBusinessKnowledge: boolean;
}

export type RetrievalDecisionReason =
  | 'page_context_referenced'
  | 'workspace_topic_match'
  | 'domain_vocabulary_match'
  | 'business_follow_up'
  | 'no_business_signal';

/**
 * Reasons that constitute SEMANTIC evidence the turn is about the business.
 * `no_business_signal` is obviously excluded; note that "retrieval ran" is
 * NOT a member of this set by construction — only the reason is.
 */
export const BUSINESS_EVIDENCE_REASONS: RetrievalDecisionReason[] = [
  'page_context_referenced',
  'workspace_topic_match',
  'domain_vocabulary_match',
  'business_follow_up',
];

export function isBusinessEvidenceReason(reason: RetrievalDecisionReason): boolean {
  return BUSINESS_EVIDENCE_REASONS.includes(reason);
}

export interface RetrievalDecision {
  retrieve: boolean;
  reason: RetrievalDecisionReason;
  signals: RetrievalDecisionSignals;
}

export function decideKnowledgeRetrieval(
  signals: RetrievalDecisionSignals,
): RetrievalDecision {
  const done = (retrieve: boolean, reason: RetrievalDecisionReason): RetrievalDecision =>
    ({ retrieve, reason, signals });

  // 1. Page context is only a business signal when the visitor ACTUALLY
  //    referred to the page. Availability alone (widget embedded on
  //    /pricing) never turns a greeting into a business question.
  if (signals.pageContextReferenced) return done(true, 'page_context_referenced');

  // 2. Owner-configured topic matched → owner data says this is their domain.
  if ((signals.workspaceTopicSlugs || []).filter(Boolean).length > 0) {
    return done(true, 'workspace_topic_match');
  }

  // 3. Domain vocabulary of the current message (pricing/billing/features/…).
  if ((signals.domainTopics || []).filter(Boolean).length > 0
      || (signals.addedTerms || []).length > 0) {
    return done(true, 'domain_vocabulary_match');
  }

  // 4. Follow-ups are classified from CONVERSATION CONTEXT, not from the
  //    text of the last message: "اون آخری رو بیشتر توضیح بده" retrieves only
  //    when the turn it refers back to was itself business knowledge.
  if (signals.followUp
      && (signals.priorTurnUsedBusinessKnowledge
        || (signals.priorIntentDomainTopics || []).filter(Boolean).length > 0)) {
    return done(true, 'business_follow_up');
  }

  // 5. No business signal anywhere → conversational turn, no vector search.
  return done(false, 'no_business_signal');
}
