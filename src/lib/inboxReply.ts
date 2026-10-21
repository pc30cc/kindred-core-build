/**
 * Replying to a conversation that is no longer open.
 *
 * A resolved conversation reopens by itself when the visitor writes again; a
 * closed one does not — the visitor's next message starts a new conversation,
 * without the context, possibly with another operator. So a reply typed into
 * a closed conversation reopens it first (InboxPage's "Reopen and send"), and
 * the one-click status action next to a finished conversation is "Reopen",
 * never "Resolve" (it offered "Resolve" for a closed one).
 */
export type ConversationStatus = 'open' | 'pending' | 'resolved' | 'closed' | string;

/** The one-click status action next to a conversation. */
export function quickStatusAction(status: ConversationStatus | null | undefined): 'reopen' | 'resolve' {
  return status === 'resolved' || status === 'closed' ? 'reopen' : 'resolve';
}

/** Whether a reply has to reopen the conversation before it is sent. */
export function replyNeedsReopen(status: ConversationStatus | null | undefined): boolean {
  return status === 'closed';
}
