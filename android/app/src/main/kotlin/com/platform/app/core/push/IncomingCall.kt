package com.platform.app.core.push

import com.platform.app.core.model.CallChannel

/**
 * A call-centre call ringing this phone, as the server's ring says it.
 *
 * `server/services/push/callRing.ts` rings an Android phone with a data-only
 * FCM message — no `notification` block, so the system draws nothing and the
 * app is handed it whether it is open, in the background or not running —
 * and stops it with a second one. These are the two, read.
 *
 * Everything in them is a routing hint, never authority: answering asks the
 * server, as whoever is signed in here, and the server decides.
 */
data class IncomingCall(
    val callId: String,
    val workspaceId: String,
    val channel: CallChannel,
    /** The caller's own name, or their email's local part; empty for an anonymous visitor. */
    val caller: String,
    /** An anonymous visitor's code, which the inbox list names them by. */
    val callerCode: String? = null,
    val workspaceName: String?,
    /** Epoch seconds past which the ring is a missed call, not a call. */
    val expiresAt: Long,
) {
    /** What the inbox list calls this caller — the name the ring shows. */
    fun displayName(language: com.platform.app.i18n.Language): String =
        com.platform.app.i18n.Format.contactName(name = caller, email = null, visitorCode = callerCode, language = language)

    /** Past its time: nothing to answer any more. */
    fun expired(nowEpochSeconds: Long): Boolean = nowEpochSeconds >= expiresAt

    /**
     * The same ring, with its expiry on this phone's clock rather than the
     * server's.
     *
     * [expiresAt] is the server's time, and a ring lives 45 seconds of it. A
     * phone whose clock is a minute fast — set by hand, as plenty are —
     * would read every ring as long expired and drop it, so it never rings
     * at all; one set an hour slow would ring for an hour with nothing to
     * stop it but a cancel. [sentEpochSeconds] is FCM's own stamp of when the
     * ring left, on the same side of that gap as [expiresAt]. When the
     * phone's clock puts the ring's arrival inside its life the clocks agree
     * as far as anything here can tell, and nothing changes; when it does
     * not, the phone's clock is what is wrong — FCM drops a ring its life
     * outlasted (`ttl` in `server/services/push/fcm.ts`) — and the ring gets
     * its whole life from now.
     */
    fun onPhoneClock(nowEpochSeconds: Long, sentEpochSeconds: Long): IncomingCall {
        val onPhone = expiryOnPhoneClock(expiresAt, nowEpochSeconds, sentEpochSeconds)
        return if (onPhone == expiresAt) this else copy(expiresAt = onPhone)
    }

    companion object {
        const val TYPE_INCOMING = "call_incoming"
        const val TYPE_CANCEL = "call_cancel"

        /** The ring, or null when this is not one or does not hold together. */
        fun from(data: Map<String, String>): IncomingCall? {
            if (data[PushPayload.KEY_TYPE] != TYPE_INCOMING) return null
            val callId = data[KEY_CALL]?.takeIf { PushPayload.isId(it) } ?: return null
            val workspaceId = data[PushPayload.KEY_WORKSPACE]?.takeIf { PushPayload.isId(it) } ?: return null
            val expiresAt = data[KEY_EXPIRES]?.toLongOrNull() ?: return null
            return IncomingCall(
                callId = callId,
                workspaceId = workspaceId,
                channel = CallChannel.from(data[KEY_CHANNEL]),
                caller = data[KEY_CALLER]?.trim()?.take(MAX_NAME)?.takeIf { it.isNotEmpty() } ?: "",
                callerCode = data[KEY_CALLER_CODE]?.trim()?.take(MAX_CODE)?.takeIf { it.isNotEmpty() },
                workspaceName = data[KEY_WORKSPACE_NAME]?.trim()?.take(MAX_NAME)?.takeIf { it.isNotEmpty() },
                expiresAt = expiresAt,
            )
        }

        const val KEY_CALL = "callId"
        const val KEY_CHANNEL = "channel"
        const val KEY_CALLER = "caller"
        const val KEY_CALLER_CODE = "callerCode"
        const val KEY_WORKSPACE_NAME = "workspaceName"
        const val KEY_EXPIRES = "expiresAt"
        const val KEY_REASON = "reason"

        private const val MAX_NAME = 120
        private const val MAX_CODE = 32
    }
}

/**
 * A ring's expiry ([expiresAt], the server's epoch seconds) on this phone's
 * clock, read against FCM's own stamp of when the ring left
 * ([sentEpochSeconds], 0 when unknown): the reasoning is
 * [IncomingCall.onPhoneClock]'s, and a colleague's ring
 * ([TeamCallRing.onPhoneClock]) is read the same way.
 */
internal fun expiryOnPhoneClock(expiresAt: Long, nowEpochSeconds: Long, sentEpochSeconds: Long): Long {
    if (sentEpochSeconds <= 0) return expiresAt
    val life = expiresAt - sentEpochSeconds
    if (life <= 0) return expiresAt
    if (nowEpochSeconds - sentEpochSeconds in 0..life) return expiresAt
    return nowEpochSeconds + life
}

/** The server stopped a ring: somebody answered, the caller hung up, or nobody came. */
data class CallCancel(
    val callId: String,
    val workspaceId: String,
    val reason: Reason,
) {
    enum class Reason {
        ANSWERED, DECLINED, ENDED, CANCELLED, TIMEOUT;

        /**
         * Whether the operator missed a caller. Answered elsewhere, or
         * declined by this operator on another of their phones, is somebody's
         * decision; a caller who gave up or was never picked up is not.
         */
        val missed: Boolean get() = this == CANCELLED || this == TIMEOUT || this == ENDED
    }

    companion object {
        fun from(data: Map<String, String>): CallCancel? {
            if (data[PushPayload.KEY_TYPE] != IncomingCall.TYPE_CANCEL) return null
            val callId = data[IncomingCall.KEY_CALL]?.takeIf { PushPayload.isId(it) } ?: return null
            val workspaceId = data[PushPayload.KEY_WORKSPACE]?.takeIf { PushPayload.isId(it) } ?: return null
            val reason = when (data[IncomingCall.KEY_REASON]) {
                "answered" -> Reason.ANSWERED
                "declined" -> Reason.DECLINED
                "timeout" -> Reason.TIMEOUT
                "cancelled" -> Reason.CANCELLED
                else -> Reason.ENDED
            }
            return CallCancel(callId, workspaceId, reason)
        }
    }
}

/**
 * A ringing call the operator asked to see — Answer pressed, or the ring
 * itself tapped (or shown full screen over the lock screen) — until the app
 * can open it.
 */
data class IncomingCallLink(
    val callId: String,
    val workspaceId: String,
    val channel: CallChannel,
    val caller: String,
    /** Answer was pressed: answer on arrival rather than show the ring. */
    val answer: Boolean,
    /**
     * The colleague calling, for a colleague call ([TeamCallRing]); null for
     * a call-centre call. What tells the two apart on the way in.
     */
    val colleagueId: String? = null,
    /** The colleague's photo, when their ring carried one. */
    val callerAvatarUrl: String? = null,
) {
    /** A colleague's call, not a visitor's. */
    val isColleague: Boolean get() = colleagueId != null

    companion object
}
