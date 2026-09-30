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
    /** This operator may use it — not so for the support team itself. */
    val available: Boolean = false,
    /** Somebody on the team is available now: a chat, else a ticket. */
    val online: Boolean = false,
    val ticketsEnabled: Boolean = false,
    val teamName: String? = null,
) {
    /** Whether Settings shows the section at all. */
    val shown: Boolean get() = enabled && available

    /** Whether a new conversation can start now, live or as a ticket. */
    val canStart: Boolean get() = shown && (online || ticketsEnabled)
}

@Serializable
data class SupportThread(
    val id: String,
    /** `chat` or `ticket`. */
    val kind: String = KIND_CHAT,
    val number: Long = 0,
    val subject: String? = null,
    /** open, pending, resolved or closed. */
    val status: String = "open",
    @Serializable(InstantSerializer::class) val createdAt: Instant? = null,
    @Serializable(InstantSerializer::class) val updatedAt: Instant? = null,
    val unread: Int = 0,
    val lastMessage: SupportLastMessage? = null,
) {
    val isTicket: Boolean get() = kind == KIND_TICKET
    val isClosed: Boolean get() = status == "closed"
    val isAnswered: Boolean get() = lastMessage?.fromTeam == true

    companion object {
        const val KIND_CHAT = "chat"
        const val KIND_TICKET = "ticket"
    }
}

@Serializable
data class SupportLastMessage(
    val body: String = "",
    val fromTeam: Boolean = false,
    @Serializable(InstantSerializer::class) val createdAt: Instant? = null,
)

@Serializable
data class SupportMessage(
    val id: String,
    val body: String = "",
    /** `me` — the operator — or `team`. */
    val author: String = AUTHOR_ME,
    val senderName: String? = null,
    val senderAvatar: String? = null,
    @Serializable(InstantSerializer::class) val createdAt: Instant? = null,
    val clientMessageId: String? = null,
    /** An agent's file, which the operator's app shows as a placeholder. */
    val hasAttachment: Boolean = false,
) {
    val fromTeam: Boolean get() = author == AUTHOR_TEAM

    companion object {
        const val AUTHOR_ME = "me"
        const val AUTHOR_TEAM = "team"
    }
}

@Serializable
data class SupportThreadsResponse(val threads: List<SupportThread> = emptyList())

@Serializable
data class SupportThreadDetail(
    val thread: SupportThread,
    val messages: List<SupportMessage> = emptyList(),
)

@Serializable
data class SupportPostResult(
    val thread: SupportThread,
    val message: SupportMessage,
)
