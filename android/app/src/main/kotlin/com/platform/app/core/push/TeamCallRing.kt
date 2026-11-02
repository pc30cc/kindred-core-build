package com.platform.app.core.push

import com.platform.app.core.model.CallChannel
import com.platform.app.i18n.Language
import com.platform.app.i18n.Str

/**
 * A colleague calling this phone, as the server's ring says it.
 *
 * `server/services/push/teamCallRing.ts` rings every Android phone of the
 * member being called with a data-only, high-priority FCM message — no
 * `notification` block, so the system draws nothing and the app is handed it
 * open, in the background or not running — and stops the ones it rang with a
 * `team_call_cancel` (docs/operations/TEAM_CALLS.md, "Ring and its stop").
 * These are the two, read.
 *
 * Everything in them is a routing hint, never authority: answering asks the
 * server, as whoever is signed in here, and the server decides — it answers
 * 404 for anybody but the two members of the call.
 */
data class TeamCallRing(
    val callId: String,
    val workspaceId: String,
    val workspaceName: String?,
    val channel: CallChannel,
    /** The caller's profile name, never an e-mail; empty for a member who set none. */
    val callerName: String,
    /** The caller's photo; null without one, or when it would have crowded out the push. */
    val callerAvatarUrl: String?,
    /** The colleague calling: whose thread a missed call opens. */
    val callerUserId: String,
    /** Epoch seconds past which the ring is a missed call, not a call. */
    val expiresAt: Long,
) {
    /** The name the ring shows: theirs, or "Colleague" — never a letter, never an address. */
    fun displayName(language: Language): String = callerName.ifBlank { Str.teamCallColleague(language) }

    /** Past its time: nothing to answer any more. */
    fun expired(nowEpochSeconds: Long): Boolean = nowEpochSeconds >= expiresAt

    /** The same ring, with its expiry on this phone's clock: see [IncomingCall.onPhoneClock]. */
    fun onPhoneClock(nowEpochSeconds: Long, sentEpochSeconds: Long): TeamCallRing {
        val onPhone = expiryOnPhoneClock(expiresAt, nowEpochSeconds, sentEpochSeconds)
        return if (onPhone == expiresAt) this else copy(expiresAt = onPhone)
    }

    companion object {
        const val TYPE_INCOMING = "team_call_incoming"
        const val TYPE_CANCEL = "team_call_cancel"

        const val KEY_CALLER_NAME = "callerName"
        const val KEY_CALLER_AVATAR = "callerAvatarUrl"
        const val KEY_CALLER_USER = "callerUserId"

        /** The ring, or null when this is not one or does not hold together. */
        fun from(data: Map<String, String>): TeamCallRing? {
            if (data[PushPayload.KEY_TYPE] != TYPE_INCOMING) return null
            val callId = data[IncomingCall.KEY_CALL]?.takeIf { PushPayload.isId(it) } ?: return null
            val workspaceId = data[PushPayload.KEY_WORKSPACE]?.takeIf { PushPayload.isId(it) } ?: return null
            val callerUserId = data[KEY_CALLER_USER]?.takeIf { PushPayload.isId(it) } ?: return null
            val expiresAt = data[IncomingCall.KEY_EXPIRES]?.toLongOrNull() ?: return null
            return TeamCallRing(
                callId = callId,
                workspaceId = workspaceId,
                workspaceName = data[IncomingCall.KEY_WORKSPACE_NAME]?.trim()?.take(MAX_NAME)?.takeIf { it.isNotEmpty() },
                channel = CallChannel.from(data[IncomingCall.KEY_CHANNEL]),
                callerName = data[KEY_CALLER_NAME]?.trim()?.take(MAX_NAME).orEmpty(),
                callerAvatarUrl = avatarUrl(data[KEY_CALLER_AVATAR]),
                callerUserId = callerUserId,
                expiresAt = expiresAt,
            )
        }

        /**
         * A photo address the phone may fetch: https only. It is the server's
         * signed storage link; anything else in that key — another scheme, a
         * local path — is not a photo this app goes and reads.
         */
        internal fun avatarUrl(raw: String?): String? =
            raw?.trim()?.takeIf { it.startsWith("https://") && it.length <= MAX_AVATAR_URL }

        private const val MAX_NAME = 120

        /** The server leaves out a longer one (`teamCallRing.ts`), so a longer one is not its. */
        private const val MAX_AVATAR_URL = 1500
    }
}

/** The server stopped a colleague's ring on this phone. */
data class TeamCallCancel(
    val callId: String,
    val reason: Reason,
) {
    enum class Reason {
        /** Another phone of this member's answered first. */
        ANSWERED_ELSEWHERE,

        /** Declined, on another phone of this member's. */
        DECLINED,

        /** The caller gave up before an answer. */
        CANCELLED,

        /** Nobody answered before the ring ran out. */
        MISSED,

        /** Over for any other reason: the caller's call failed, or a reason this build does not know. */
        ENDED;

        /**
         * Whether this member missed a colleague: the caller gave up, or the
         * ring ran out. Answered or declined on another of their phones is
         * their own decision, and leaves nothing behind.
         */
        val missed: Boolean get() = this == CANCELLED || this == MISSED
    }

    companion object {
        fun from(data: Map<String, String>): TeamCallCancel? {
            if (data[PushPayload.KEY_TYPE] != TeamCallRing.TYPE_CANCEL) return null
            val callId = data[IncomingCall.KEY_CALL]?.takeIf { PushPayload.isId(it) } ?: return null
            val reason = when (data[IncomingCall.KEY_REASON]) {
                "answered_elsewhere" -> Reason.ANSWERED_ELSEWHERE
                "declined" -> Reason.DECLINED
                "cancelled" -> Reason.CANCELLED
                "missed" -> Reason.MISSED
                else -> Reason.ENDED
            }
            return TeamCallCancel(callId, reason)
        }
    }
}
