package com.platform.app.core.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import java.time.Instant

// Colleague calls: a voice or video call between two members of one
// workspace, rung like a phone call. The contract is
// docs/operations/TEAM_CALLS.md; these are its `TeamCall`, read exactly as the
// doc spells it, and the plan's rule for offering one.

/**
 * Where a colleague call is, as the server keeps it (`call_sessions.state`).
 *
 * The default is [ENDED], and it is what a state this build does not know
 * reads as (the client's JSON coerces an unknown enum value to its default).
 * Every state the doc names is here; one added later is something this phone
 * cannot act on, and a call it cannot act on is one it must stop ringing for.
 */
@Serializable
enum class TeamCallState {
    @SerialName("ringing") RINGING,
    @SerialName("connecting") CONNECTING,
    @SerialName("active") ACTIVE,
    @SerialName("ended") ENDED,
    @SerialName("missed") MISSED,
    @SerialName("cancelled") CANCELLED;

    /** Answered, on whichever phone: the room is being joined, or is in use. */
    val isAnswered: Boolean get() = this == CONNECTING || this == ACTIVE

    /** Over, for good: nothing more will happen to this call. */
    val isOver: Boolean get() = this == ENDED || this == MISSED || this == CANCELLED
}

/**
 * How a call finished (`metadata.team_call.outcome`). An outcome this build
 * does not know reads as none, and the call as simply ended.
 */
@Serializable
enum class TeamCallOutcome {
    @SerialName("completed") COMPLETED,
    @SerialName("declined") DECLINED,
    @SerialName("cancelled") CANCELLED,
    @SerialName("missed") MISSED,
    @SerialName("failed") FAILED,
}

/** Which side of the call the signed-in member is on. */
@Serializable
enum class TeamCallRole {
    @SerialName("caller") CALLER,
    @SerialName("callee") CALLEE,
}

/**
 * One colleague call, as every `/api/team-calls` answer carries it.
 *
 * The peer is always the OTHER member, seen from whoever asked: the same call
 * reads `role: caller, peer: <callee>` on one phone and the reverse on the
 * other. Nothing here is an identity anyone outside the workspace could see;
 * the room's identity is the server's (`internal:<opaque ref>`).
 */
@Serializable
data class TeamCall(
    val id: String,
    @SerialName("workspace_id") val workspaceId: String,
    /** The server's own spelling; anything else is a voice call, the narrower of the two. */
    val channel: CallChannel = CallChannel.AUDIO,
    val state: TeamCallState = TeamCallState.ENDED,
    val outcome: TeamCallOutcome? = null,
    val role: TeamCallRole,
    val peer: Peer,
    /**
     * The phone that answered (the `device_id` its accept carried): how the
     * callee's other phones know the call went elsewhere.
     */
    @SerialName("answered_device_id") val answeredDeviceId: String? = null,
    @SerialName("created_at") @Serializable(InstantSerializer::class) val createdAt: Instant? = null,
    @SerialName("answered_at") @Serializable(InstantSerializer::class) val answeredAt: Instant? = null,
    @SerialName("ended_at") @Serializable(InstantSerializer::class) val endedAt: Instant? = null,
    /** When the ring stops (`TEAM_CALL_RING_SECONDS` after it started). */
    @SerialName("expires_at") @Serializable(InstantSerializer::class) val expiresAt: Instant? = null,
) {
    @Serializable
    data class Peer(
        @SerialName("user_id") val userId: String,
        /** The profile name only; never an e-mail. Empty or absent for a member who set none. */
        val name: String? = null,
        @SerialName("avatar_url") val avatarUrl: String? = null,
    )
}

/** `{ "call": TeamCall }`: how every `/api/team-calls` route answers, a `409 not_ringing` included. */
@Serializable
data class TeamCallResponse(val call: TeamCall)

/** What answering came to (`POST /api/team-calls/:id/accept`). */
sealed interface TeamCallAcceptance {
    /** This phone won: the call is `connecting` and the room is ours to join. */
    data class Accepted(val call: TeamCall) : TeamCallAcceptance

    /**
     * `409 not_ringing`: another phone answered first, or the call ended
     * while the answer was on its way. The call as it now stands, when the
     * server sent it.
     */
    data class NotRinging(val call: TeamCall?) : TeamCallAcceptance
}

/**
 * Whether the plan allows a colleague call of this kind: `team_calls` on, the
 * Voice & Video module on, and the call's own channel on — `voice` for a voice
 * call, `video` for a video one — each exactly `true`, the web's one rule
 * (`planAccess.ts`), as the iOS app reads it. Deny on create, allow on
 * continuity: this only ever decides whether a call is offered, and a call
 * already on is never cut by a plan read afterwards. The platform's and the
 * workspace's own voice and video switches are the server's to apply when the
 * call is placed.
 */
fun Entitlements.allowsTeamCall(channel: CallChannel): Boolean =
    featureEnabled(TEAM_CALLS_FEATURE) &&
        moduleEnabled("voice_video") &&
        channelEnabled(if (channel == CallChannel.VIDEO) "video" else "voice")

/** The plan registry's key for colleague calls (`capabilityRegistry.ts`). */
const val TEAM_CALLS_FEATURE = "team_calls"

/** How long a colleague call rings (`TEAM_CALL_RING_SECONDS`). */
const val TEAM_CALL_RING_SECONDS = 45L
