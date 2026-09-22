package com.webyar.operator.core.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Which slice of the inbox is on screen.
 *
 * `queue` and `status` are two separate axes the server reads, not one —
 * `needsHuman` and `open` are the same queue narrowed differently. The
 * titles live in `Strings`, not here, so this stays free of UI.
 */
enum class InboxFilter(val wire: String) {
    OPEN("open"),
    NEEDS_HUMAN("needsHuman"),
    PENDING("pending"),
    AI("ai"),
    RESOLVED("resolved"),
    SPAM("spam");

    val queue: String
        get() = when (this) {
            OPEN, NEEDS_HUMAN, PENDING, RESOLVED -> "main"
            AI -> "automated"
            SPAM -> "spam"
        }

    val status: String?
        get() = when (this) {
            OPEN, NEEDS_HUMAN -> "open"
            // The main queue narrowed to threads the customer owes us a reply
            // on — the same `status=pending` the console's tab sends.
            PENDING -> "pending"
            RESOLVED -> "resolved"
            AI, SPAM -> null
        }

    /** Narrows Main Inbox to threads the AI has handed back. */
    val needsHumanOnly: Boolean get() = this == NEEDS_HUMAN

    companion object {
        /**
         * The queues this plan includes, in the order they should appear.
         *
         * A queue that leads to a permanently empty list because the plan
         * excludes it reads as a broken app, not as an upsell — so it is left
         * out entirely rather than shown and refused.
         */
        fun available(entitlements: Entitlements?): List<InboxFilter> = buildList {
            add(OPEN)
            if (entitlements?.featureEnabled("inbox_needs_human") == true) add(NEEDS_HUMAN)
            // Every plan can put a thread on hold for the customer, so this
            // one is core like Open and Resolved rather than an entitlement.
            add(PENDING)
            if (entitlements?.featureEnabled("inbox_ai_queue") == true) add(AI)
            add(RESOLVED)
            add(SPAM)
        }

        /**
         * The two queues that stay on the strip above the list.
         *
         * The rest move into the menu behind the screen's own title, which is
         * where the console keeps them too: its top strip carries Open and AI
         * and its sidebar carries the whole list. Four chips across a phone
         * left no room for the counts, and two of them — Resolved and the AI
         * handover queue — are places you go now and then rather than switch
         * between all day.
         */
        fun chips(entitlements: Entitlements?): List<InboxFilter> = buildList {
            add(OPEN)
            if (entitlements?.featureEnabled("inbox_ai_queue") == true) add(AI)
        }
    }
}

/** The counters behind each inbox filter. `GET /api/conversations/inbox-tab-counts`. */
@Serializable
data class InboxCounts(
    val open: Int? = null,
    val pending: Int? = null,
    val resolved: Int? = null,
    val all: Int? = null,
    @SerialName("needs_human") val needsHuman: Int? = null,
    val automated: Int? = null,
) {
    fun count(filter: InboxFilter): Int? = when (filter) {
        InboxFilter.OPEN -> open
        InboxFilter.AI -> automated
        InboxFilter.NEEDS_HUMAN -> needsHuman
        InboxFilter.PENDING -> pending
        InboxFilter.RESOLVED -> resolved
        // `inbox-tab-counts` does not count the spam queue, and a queue you
        // visit to empty it does not need a badge anyway.
        InboxFilter.SPAM -> null
    }
}

/**
 * Who is answering a thread.
 *
 * Mirrors `AIState` in `Features/Chat/ComposerCapabilities.swift`.
 */
enum class AiState(val wire: String) {
    /** The AI owns the thread and is replying on its own. */
    AI_MANAGED("ai_managed"),
    /** The AI has handed back and is waiting for a person. */
    NEEDS_HUMAN("needs_human"),
    /** A person has taken over. */
    HUMAN_ACTIVE("human_active");

    companion object {
        fun resolve(conversation: Conversation): AiState? {
            val raw = conversation.aiStateValue?.takeIf { it.isNotEmpty() } ?: return null
            return entries.firstOrNull { it.wire == raw }
        }
    }
}
