package com.platform.app.feature.call

import com.platform.app.core.model.CallChannel
import com.platform.app.core.model.TeamCall
import com.platform.app.core.model.TeamCallOutcome
import com.platform.app.core.model.TeamCallRole
import com.platform.app.core.model.TeamCallState
import com.platform.app.core.net.ApiError
import com.platform.app.core.push.TeamCallCancel
import com.platform.app.i18n.Language
import com.platform.app.i18n.Str
import java.time.Instant

/**
 * Where a colleague call is on this phone, from the tap on a colleague's
 * thread (or their ring) to "Call ended".
 *
 * One value, as [CallPhase] is for a visitor's call, for the same reason:
 * "ringing and also live" cannot be said.
 */
sealed interface TeamCallPhase {
    /** Outgoing: the request to ring is on its way. */
    data object Calling : TeamCallPhase

    /** The colleague's phones are ringing (outgoing), or this one is (incoming). */
    data object Ringing : TeamCallPhase

    /** Answered: the room is being joined, or the colleague is not in it yet. */
    data object Connecting : TeamCallPhase

    /** Both in the room, since [since] — what the timer counts from. */
    data class Live(val since: Instant) : TeamCallPhase

    /**
     * Over, for [end]. [detail] is the server's own words for a call that
     * failed, which the screen puts under the title: "Call failed" over a
     * refusal this build has no sentence for says nothing anyone can act on.
     *
     * [silent]: a ring on this phone that stopped before it was answered
     * here, with nothing for its screen to say ([TeamCallEnd.closesRingAtOnce]).
     * The screen closes at once rather than saying it and waiting.
     */
    data class Ended(val end: TeamCallEnd, val detail: String? = null, val silent: Boolean = false) : TeamCallPhase

    val isOver: Boolean get() = this is Ended

    /** Not answered yet, on either side. */
    val isRinging: Boolean get() = this == Calling || this == Ringing

    /**
     * How long the screen of a call that is over stays before it closes on
     * its own, in milliseconds; null while the call is on. A silent end
     * ([Ended.silent]) closes at once; any other stays [ENDED_LINGER_MS],
     * long enough to read how it ended — as the iOS app (2 s) and the web
     * panel (2.5 s) do. Done closes it sooner.
     */
    val closesAfterMs: Long?
        get() = (this as? Ended)?.let { if (it.silent) 0L else ENDED_LINGER_MS }

    companion object {
        const val ENDED_LINGER_MS = 2_000L
    }
}

/**
 * Why a colleague call ended, in the terms the call screen says it.
 *
 * One value for every way a call can stop, on either side. Most of them come
 * from the server ([resolve]); [HUNG_UP] is this phone's own End, Decline or
 * Cancel; the refusals come from `POST /api/team-calls` ([refusal]). The same
 * cases as the iOS app's `TeamCallEnd`.
 */
enum class TeamCallEnd {
    /** Ended on this phone: End after an answer, Decline, or Cancel. */
    HUNG_UP,

    /** The colleague hung up, or the room closed under the call. */
    REMOTE_ENDED,

    /** The colleague declined (seen by the caller). */
    DECLINED,

    /** Declined on another phone of this member's (seen by the callee). */
    DECLINED_ELSEWHERE,

    /** The caller gave up before an answer (seen by the callee). */
    CANCELLED,

    /** Nobody answered in time, seen by the caller. */
    NO_ANSWER,

    /** Nobody answered in time, seen by the callee: a missed call. */
    MISSED,

    /** Another phone of this member's answered first. */
    ANSWERED_ELSEWHERE,

    /** `409 callee_busy` / `409 caller_busy`: one of the two is in a call. */
    BUSY,

    /** `403 upgrade_required`: the plan has no colleague calls. */
    NOT_IN_PLAN,

    /** `422 limit_reached`: the plan's concurrent calls or monthly minutes. */
    LIMIT_REACHED,

    /** The microphone was refused, so nobody was rung. */
    NO_MICROPHONE,

    /** Anything else: no network, no room, a refusal this build cannot place. */
    FAILED;

    /** The line under the colleague's name. */
    fun title(language: Language, channel: CallChannel): String = when (this) {
        HUNG_UP, REMOTE_ENDED -> Str.teamCallEnded(language)
        DECLINED, DECLINED_ELSEWHERE -> Str.teamCallDeclined(language)
        CANCELLED -> Str.teamCallCancelled(language)
        NO_ANSWER -> Str.teamCallNoAnswer(language)
        MISSED -> if (channel == CallChannel.VIDEO) Str.teamCallMissedVideo(language) else Str.teamCallMissedVoice(language)
        ANSWERED_ELSEWHERE -> Str.teamCallAnsweredElsewhere(language)
        BUSY -> Str.teamCallBusy(language)
        NOT_IN_PLAN -> Str.teamCallNotInPlan(language)
        LIMIT_REACHED -> Str.teamCallLimitReached(language)
        NO_MICROPHONE -> Str.teamCallNeedsMicrophone(language)
        FAILED -> Str.teamCallFailed(language)
    }

    companion object {
        /**
         * Whether a ring on this phone that ended with [end] before it was
         * answered here closes its screen at once: one visible signal for
         * the member, never the screen and a notification saying the same
         * (owner, 2026-11-05: "two end screens"). Cancelled and missed are
         * said by the missed-call notification; a decline — on the screen,
         * or on the ring's notification while the screen was open — was the
         * member's own move, with nothing to tell them. Anything else
         * (answered or declined on another phone) is said on the screen,
         * which closes on its own a moment later. The same rule as the iOS
         * app's `TeamCallEnd.closesRingAtOnce`.
         */
        fun closesRingAtOnce(end: TeamCallEnd): Boolean = end == CANCELLED || end == MISSED || end == HUNG_UP

        /**
         * What a call the server reports means for this phone, or null while
         * it is still ringing — or answered here, and so going on.
         *
         * [deviceId] is the id this phone registers with and answers with: a
         * call answered with any other was answered by another phone of the
         * callee's.
         */
        fun resolve(call: TeamCall, deviceId: String?): TeamCallEnd? = when (call.state) {
            TeamCallState.RINGING -> null
            TeamCallState.CONNECTING, TeamCallState.ACTIVE ->
                if (call.role == TeamCallRole.CALLEE && call.answeredDeviceId != deviceId) ANSWERED_ELSEWHERE else null
            TeamCallState.MISSED -> if (call.role == TeamCallRole.CALLER) NO_ANSWER else MISSED
            TeamCallState.CANCELLED -> CANCELLED
            TeamCallState.ENDED -> when (call.outcome) {
                TeamCallOutcome.DECLINED -> if (call.role == TeamCallRole.CALLER) DECLINED else DECLINED_ELSEWHERE
                TeamCallOutcome.MISSED -> if (call.role == TeamCallRole.CALLER) NO_ANSWER else MISSED
                TeamCallOutcome.CANCELLED -> CANCELLED
                TeamCallOutcome.FAILED -> FAILED
                TeamCallOutcome.COMPLETED, null -> REMOTE_ENDED
            }
        }

        /**
         * Why `POST /api/team-calls` refused to ring, from its status and the
         * `error` code in its body.
         */
        fun refusal(error: Throwable): TeamCallEnd {
            val server = error as? ApiError.Server ?: return FAILED
            val code = server.serverMessage
            return when {
                server.status == 409 && (code == "callee_busy" || code == "caller_busy") -> BUSY
                server.status == 403 && code == "upgrade_required" -> NOT_IN_PLAN
                server.status == 422 -> LIMIT_REACHED
                else -> FAILED
            }
        }

        /** What a ring the server stopped on this phone means for the ring on screen. */
        fun of(reason: TeamCallCancel.Reason): TeamCallEnd = when (reason) {
            TeamCallCancel.Reason.ANSWERED_ELSEWHERE -> ANSWERED_ELSEWHERE
            TeamCallCancel.Reason.DECLINED -> DECLINED_ELSEWHERE
            TeamCallCancel.Reason.CANCELLED -> CANCELLED
            TeamCallCancel.Reason.MISSED -> MISSED
            TeamCallCancel.Reason.ENDED -> REMOTE_ENDED
        }
    }
}

/**
 * What the rest of the app heard about a colleague call, for the call on
 * screen to act on. Each names its call; a session acts only on its own.
 */
sealed interface TeamCallNudge {
    val callId: String

    /** The server's realtime word that the call changed: read it again. */
    data class Changed(override val callId: String) : TeamCallNudge

    /** The server stopped this phone's ring (`team_call_cancel`), for [reason]. */
    data class RingStopped(override val callId: String, val reason: TeamCallCancel.Reason) : TeamCallNudge

    /** Declined from the ring's own notification, which has already told the server. */
    data class DeclinedHere(override val callId: String) : TeamCallNudge

    /** End, pressed on the notification of the call in progress. */
    data class HangUp(override val callId: String) : TeamCallNudge
}
