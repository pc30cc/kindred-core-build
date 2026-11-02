package com.platform.app.core.model

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.nullable
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
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
        /** The colleague call this line stands for, or null: previewed by its icon and title, not its body. */
        @Serializable(TeamChatCallSerializer::class) val call: TeamChatCall? = null,
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
    /**
     * The colleague call this line stands for, or null for every other
     * message. Drawn as a call bubble, never as its [body] (`📞`/`📹`, for
     * builds that predate it).
     */
    @Serializable(TeamChatCallSerializer::class) val call: TeamChatCall? = null,
)

@Serializable
data class TeamThreadResponse(
    val messages: List<TeamMessage> = emptyList(),
    val me: String? = null,
)

/**
 * The call in the chat (docs/operations/TEAM_CALLS.md, "The call in the
 * chat"): every colleague call leaves one line in the two members' thread,
 * written by the server when the call ends, from the caller to the callee.
 * This is that line's `call`, as `GET /api/team-chat/thread` and the
 * colleagues' `last_message` carry it.
 *
 * Only a call this build understands is one: an id, a channel it knows, an
 * outcome it knows and a caller. Anything else reads as no call at all, and
 * the line as the ordinary message its body makes it, which is what the web
 * panel does (`teamChatCallOf`).
 */
data class TeamChatCall(
    val id: String,
    val channel: CallChannel,
    val outcome: TeamCallOutcome,
    /** ended_at − connected_at, in whole seconds, for a completed call; null otherwise. */
    val durationSeconds: Long?,
    /** Who placed the call: the line's sender. */
    val callerId: String,
) {
    /**
     * The wire's own shape, every field optional. The length is read as
     * whatever JSON came, so a length that is not a number costs only the
     * length, as on the web.
     */
    @Serializable
    internal data class Wire(
        val id: String? = null,
        val channel: String? = null,
        val outcome: String? = null,
        @SerialName("duration_seconds") val durationSeconds: JsonElement? = null,
        @SerialName("caller_id") val callerId: String? = null,
    )

    internal fun toWire(): Wire = Wire(
        id = id,
        channel = channel.wire,
        outcome = OUTCOMES.entries.first { it.value == outcome }.key,
        durationSeconds = durationSeconds?.let { JsonPrimitive(it) },
        callerId = callerId,
    )

    internal companion object {
        /** The outcomes the contract names, by their wire spelling. */
        private val OUTCOMES = mapOf(
            "completed" to TeamCallOutcome.COMPLETED,
            "missed" to TeamCallOutcome.MISSED,
            "declined" to TeamCallOutcome.DECLINED,
            "cancelled" to TeamCallOutcome.CANCELLED,
            "failed" to TeamCallOutcome.FAILED,
        )

        /** The call [wire] describes, or null when it is not one this build understands. */
        fun of(wire: Wire): TeamChatCall? {
            val id = wire.id?.takeIf { it.isNotBlank() } ?: return null
            val channel = when (wire.channel) {
                "audio" -> CallChannel.AUDIO
                "video" -> CallChannel.VIDEO
                else -> return null
            }
            val outcome = OUTCOMES[wire.outcome] ?: return null
            val callerId = wire.callerId?.takeIf { it.isNotBlank() } ?: return null
            val duration = (wire.durationSeconds as? JsonPrimitive)
                ?.takeIf { !it.isString }
                ?.doubleOrNull
                ?.takeIf { it.isFinite() && it >= 0 }
                ?.toLong()
            return TeamChatCall(id, channel, outcome, duration, callerId)
        }
    }
}

/**
 * Reads `call` without ever failing the message it is on.
 *
 * A thread is one decode: a `call` this build cannot read — a shape a later
 * server sends, a value of the wrong type — would otherwise throw away the
 * whole conversation, every ordinary message included. Here it reads as null,
 * and the line as the message its body makes it. Absent and `null` read as
 * null too.
 */
object TeamChatCallSerializer : KSerializer<TeamChatCall?> {
    private val wire = TeamChatCall.Wire.serializer().nullable

    override val descriptor: SerialDescriptor = wire.descriptor

    override fun deserialize(decoder: Decoder): TeamChatCall? {
        val read = if (decoder is JsonDecoder) {
            val element = decoder.decodeJsonElement() as? JsonObject ?: return null
            runCatching { decoder.json.decodeFromJsonElement(wire, element) }.getOrNull()
        } else {
            runCatching { decoder.decodeSerializableValue(wire) }.getOrNull()
        }
        return read?.let { TeamChatCall.of(it) }
    }

    override fun serialize(encoder: Encoder, value: TeamChatCall?) {
        encoder.encodeSerializableValue(wire, value?.toWire())
    }
}
