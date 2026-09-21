package com.webyar.operator.core.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import java.time.Instant

/**
 * A person in the workspace, as the transfer list needs them.
 *
 * Mirrors `GET /api/workspace-members?workspaceId=…`, the same list the web's
 * assignee picker reads.
 */
@Serializable
data class WorkspaceMember(
    val id: String,
    @SerialName("user_id") val userId: String,
    val role: String? = null,
    @SerialName("suspended_at") @Serializable(InstantSerializer::class) val suspendedAt: Instant? = null,
    val profile: MemberProfile? = null,
    @SerialName("department_names") val departmentNames: List<String>? = null,
) {
    /**
     * A suspended member can still be looked at but must never be handed a
     * conversation — the server rejects it, and offering it would be a lie.
     */
    val canReceiveWork: Boolean get() = suspendedAt == null

    val displayName: String
        get() = profile?.fullName?.takeIf { it.isNotEmpty() }
            ?: profile?.email?.takeIf { it.isNotEmpty() }
            ?: userId.take(8)
}

@Serializable
data class MemberProfile(
    val id: String? = null,
    @SerialName("full_name") val fullName: String? = null,
    val email: String? = null,
    @SerialName("avatar_url") val avatarUrl: String? = null,
)

@Serializable
data class WorkspaceMembersResponse(val members: List<WorkspaceMember> = emptyList())

/**
 * An internal note — visible to the team, never to the visitor.
 *
 * `GET`/`POST /api/conversations/:id/notes`.
 */
@Serializable
data class ConversationNote(
    val id: String,
    val body: String,
    @SerialName("author_id") val authorId: String? = null,
    val author: MemberProfile? = null,
    @SerialName("created_at") @Serializable(InstantSerializer::class) val createdAt: Instant? = null,
) {
    val authorName: String
        get() = author?.fullName?.takeIf { it.isNotEmpty() }
            ?: author?.email?.takeIf { it.isNotEmpty() }
            ?: ""
}

@Serializable
data class NotesResponse(val notes: List<ConversationNote> = emptyList())

@Serializable
data class NoteResponse(val note: ConversationNote? = null)

/**
 * An invitation asking the visitor to join a call.
 *
 * The operator never dials the visitor directly: the console invites, the
 * widget accepts, and only then does a room exist. `POST /api/call-invitations`.
 */
@Serializable
data class CallInvitation(
    val id: String,
    val status: String? = null,
    val channel: String? = null,
    @SerialName("conversation_id") val conversationId: String? = null,
    /**
     * Only set once the visitor has accepted: the invitation is the offer, the
     * session is the call. Everything after this point keys off the session,
     * not the invitation.
     */
    @SerialName("call_session_id") val callSessionId: String? = null,
    @SerialName("expires_at") @Serializable(InstantSerializer::class) val expiresAt: Instant? = null,
) {
    val isPending: Boolean get() = status == "pending"
    val isJoined: Boolean get() = status == "joined"

    /** Statuses that mean this invitation will never become a call. */
    val isTerminal: Boolean
        get() = status in setOf("expired", "cancelled", "declined")

    val kind: CallChannel get() = CallChannel.from(channel)
}

/**
 * Everything needed to join the media room, exactly as the console receives it
 * from `POST /api/calls/:id/token`.
 */
@Serializable
data class CallToken(
    val token: String,
    val provider: String? = null,
    /** The signalling URL. `rtc_url` is the fallback the web uses too. */
    @SerialName("ws_url") val wsUrl: String? = null,
    @SerialName("rtc_url") val rtcUrl: String? = null,
    val turn: TurnConfig? = null,
    @SerialName("ice_policy") val icePolicy: String? = null,
    /**
     * Non-fatal notes from the server — `turn_missing` above all, which is the
     * difference between a call that connects everywhere and one that connects
     * only on friendly networks.
     */
    val warnings: List<String>? = null,
) {
    @Serializable
    data class TurnConfig(
        val urls: List<String>? = null,
        val username: String? = null,
        val credential: String? = null,
    )

    /**
     * The URL to actually dial.
     *
     * The server sends both and the web prefers `ws_url`; falling back keeps a
     * workspace configured only with `rtc_url` working rather than failing
     * with an empty address.
     */
    val signallingUrl: String?
        get() = wsUrl?.takeIf { it.isNotEmpty() } ?: rtcUrl?.takeIf { it.isNotEmpty() }

    val relayOnly: Boolean get() = icePolicy == "relay"
}

@Serializable
data class CallInvitationResponse(val invitation: CallInvitation)

/**
 * Which call channels this workspace may actually offer.
 *
 * Mirrors `SidebarCallCard`'s gating exactly, **including its "not explicitly
 * false" reading**: a key the plan has never heard of is allowed, and only a
 * resolved `false` closes the door. The server enforces the same rule on
 * create, so the two can never drift into offering a button that 403s.
 *
 * Note this is the opposite of [Entitlements.moduleEnabled], which is
 * fail-closed. Both are right for what they gate, and getting them the wrong
 * way round is how a paid feature disappears or a forbidden one appears.
 */
data class CallChannels(val voice: Boolean, val video: Boolean) {
    val any: Boolean get() = voice || video

    companion object {
        val NONE = CallChannels(voice = false, video = false)

        fun resolve(entitlements: Entitlements?): CallChannels {
            if (entitlements == null) return NONE
            val moduleOn = entitlements.modules?.get("voice_video")?.value != false
            if (!moduleOn) return NONE
            return CallChannels(
                voice = entitlements.channels?.get("voice")?.value != false,
                video = entitlements.channels?.get("video")?.value != false,
            )
        }
    }
}

/** Which kind of call an invitation asks for. The server's own spelling. */
@Serializable
enum class CallChannel {
    @SerialName("audio") AUDIO,
    @SerialName("video") VIDEO;

    val wire: String get() = if (this == AUDIO) "audio" else "video"

    companion object {
        /** Anything unrecognised is audio: the narrower of the two. */
        fun from(value: String?): CallChannel = if (value == "video") VIDEO else AUDIO
    }
}
