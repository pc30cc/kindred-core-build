package com.webyar.ai.core.model

import kotlinx.serialization.Serializable
import java.time.Instant

/**
 * Platform support: the operator talking to the team that runs the platform
 * (docs/PLATFORM_SUPPORT.md, `/api/platform-support`).
 *
 * The team answers from its own workspace's inbox; the operator is not a
 * member of it, so nothing here belongs to a workspace of theirs. Keys are
 * camelCase, as the endpoint writes them.
 */
@Serializable
data class SupportStatus(
    /** Super Admin has turned support on and chosen who answers. */
    val enabled: Boolean = false,
    /** This operator may use it. */
    val available: Boolean = false,
    /** Somebody on the team is reachable now; otherwise the app says "leave a message". */
    val online: Boolean = false,
    val teamName: String? = null,
    /** The team's messages the operator has not read. */
    val unread: Int = 0,
    /** Null when the support workspace keeps no business hours. */
    val hours: SupportHours? = null,
    /** Set while the hours have the team closed: when it opens again. */
    @Serializable(InstantSerializer::class) val nextOpenAt: Instant? = null,
) {
    /** Whether the server offers support to this operator at all. */
    val shown: Boolean get() = enabled && available
}

/** The support workspace's week, in its own time zone. */
@Serializable
data class SupportHours(
    /** IANA, e.g. `Asia/Tehran`. */
    val timezone: String = "",
    /** Keys `sat`…`fri`; a day that is absent or empty is closed. */
    val weekly: Map<String, List<SupportInterval>> = emptyMap(),
)

/** One opening on one day, as `HH:mm` wall-clock times. */
@Serializable
data class SupportInterval(val from: String = "", val to: String = "")

/**
 * Everything the operator has said to the team and heard back: the last
 * conversations, oldest first, and their items across them.
 */
@Serializable
data class SupportHistory(
    val conversations: List<SupportConversation> = emptyList(),
    val items: List<SupportItem> = emptyList(),
    /** The newest `open` or `pending` conversation, which a message goes to. */
    val activeConversationId: String? = null,
)

@Serializable
data class SupportConversation(
    val id: String,
    /** open, pending, resolved or closed. */
    val status: String = STATUS_OPEN,
    @Serializable(InstantSerializer::class) val createdAt: Instant? = null,
    /** When it was resolved or closed. */
    @Serializable(InstantSerializer::class) val endedAt: Instant? = null,
    val rating: SupportRating? = null,
    /** Ended, answered by the team, and not rated yet. */
    val canRate: Boolean = false,
) {
    /** Resolved or closed: the operator's next message starts a new one. */
    val ended: Boolean get() = status == STATUS_RESOLVED || status == STATUS_CLOSED

    companion object {
        const val STATUS_OPEN = "open"
        const val STATUS_PENDING = "pending"
        const val STATUS_RESOLVED = "resolved"
        const val STATUS_CLOSED = "closed"
    }
}

@Serializable
data class SupportRating(
    /** 1 to 5. */
    val score: Int = 0,
    val comment: String? = null,
    @Serializable(InstantSerializer::class) val ratedAt: Instant? = null,
)

/** A message in the chat, or a line saying who joined it. */
@Serializable
data class SupportItem(
    val id: String,
    val conversationId: String = "",
    /** `message` or `joined`. */
    val kind: String = KIND_MESSAGE,
    /** `me` — the operator — or `team`; a join is the team's. */
    val author: String = AUTHOR_ME,
    /** Empty for a join. */
    val body: String = "",
    /** The agent who wrote it; for a join, who joined. */
    val senderName: String? = null,
    val senderAvatar: String? = null,
    @Serializable(InstantSerializer::class) val createdAt: Instant? = null,
    val clientMessageId: String? = null,
    val attachments: List<SupportAttachment> = emptyList(),
) {
    val fromTeam: Boolean get() = author == AUTHOR_TEAM
    val isJoin: Boolean get() = kind == KIND_JOINED

    companion object {
        const val KIND_MESSAGE = "message"
        const val KIND_JOINED = "joined"
        const val AUTHOR_ME = "me"
        const val AUTHOR_TEAM = "team"
    }
}

/** A file on a support message, fetched by id through `GET /attachments/:id`. */
@Serializable
data class SupportAttachment(
    val id: String,
    val fileName: String = "",
    val mimeType: String = "",
    val sizeBytes: Long = 0,
    /** image, audio, video or file. */
    val kind: String = "file",
) {
    /** The shape the chat's own attachment views draw. */
    fun toMessageAttachment(): MessageAttachment = MessageAttachment(
        id = id,
        fileName = fileName.ifBlank { null },
        mimeType = mimeType.ifBlank { null },
        sizeBytes = sizeBytes.takeIf { it > 0 }?.coerceAtMost(Int.MAX_VALUE.toLong())?.toInt(),
        kind = kind.ifBlank { null },
    )
}

/** What `POST /messages` and `POST /attachments` answer with. */
@Serializable
data class SupportPostResult(
    val conversation: SupportConversation,
    val item: SupportItem,
)

/** What `POST /conversations/:id/rating` answers with. */
@Serializable
data class SupportRatingResult(val conversation: SupportConversation)
