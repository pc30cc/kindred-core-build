package com.webyar.ai.core.push

import com.webyar.ai.core.model.CallChannel

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
    /** Who is calling, as the server could best name them. */
    val caller: String,
    val workspaceName: String?,
    /** Epoch seconds past which the ring is a missed call, not a call. */
    val expiresAt: Long,
) {
    /** Past its time: nothing to answer any more. */
    fun expired(nowEpochSeconds: Long): Boolean = nowEpochSeconds >= expiresAt

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
                workspaceName = data[KEY_WORKSPACE_NAME]?.trim()?.take(MAX_NAME)?.takeIf { it.isNotEmpty() },
                expiresAt = expiresAt,
            )
        }

        const val KEY_CALL = "callId"
        const val KEY_CHANNEL = "channel"
        const val KEY_CALLER = "caller"
        const val KEY_WORKSPACE_NAME = "workspaceName"
        const val KEY_EXPIRES = "expiresAt"
        const val KEY_REASON = "reason"

        private const val MAX_NAME = 120
    }
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
) {
    companion object
}
