package com.webyar.operator.core.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import java.time.Instant

// Operator-to-operator messages — the console calls this the internal inbox,
// and its Colleagues tab. Mirrors `/api/team-chat` and `src/hooks/useTeamChat.ts`.

@Serializable
data class Colleague(
    @SerialName("user_id") val userId: String,
    val role: String? = null,
    @SerialName("full_name") val fullName: String? = null,
    val email: String? = null,
    @SerialName("avatar_url") val avatarUrl: String? = null,
    val unread: Int? = null,
    @SerialName("last_message") val lastMessage: LastTeamMessage? = null,
) {
    val id: String get() = userId

    val displayName: String
        get() = fullName?.takeIf { it.isNotBlank() }
            ?: email?.takeIf { it.isNotEmpty() }
            ?: "—"

    @Serializable
    data class LastTeamMessage(
        val body: String? = null,
        @SerialName("created_at") @Serializable(InstantSerializer::class) val createdAt: Instant? = null,
        val outgoing: Boolean? = null,
        @SerialName("attachment_kind") val attachmentKind: String? = null,
    )
}

@Serializable
data class ColleaguesResponse(
    val colleagues: List<Colleague> = emptyList(),
    @SerialName("total_unread") val totalUnread: Int? = null,
    val me: String? = null,
)

@Serializable
data class TeamMessage(
    val id: String,
    @SerialName("sender_id") val senderId: String,
    @SerialName("recipient_id") val recipientId: String? = null,
    val body: String? = null,
    val attachment: MessageAttachment? = null,
    @SerialName("read_at") @Serializable(InstantSerializer::class) val readAt: Instant? = null,
    @SerialName("created_at") @Serializable(InstantSerializer::class) val createdAt: Instant? = null,
)

@Serializable
data class TeamThreadResponse(
    val messages: List<TeamMessage> = emptyList(),
    val me: String? = null,
)
