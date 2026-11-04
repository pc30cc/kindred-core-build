package com.platform.app.core.push

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.platform.app.PlatformApp
import com.platform.app.core.Diag
import com.platform.app.core.runCatchingUnlessCancelled
import com.platform.app.feature.call.OngoingCallEnd
import com.platform.app.feature.call.OngoingCallKind
import com.platform.app.feature.call.OngoingCallService
import com.platform.app.i18n.Language
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * The buttons on a call's notifications, pressed without opening the app.
 *
 *  - **Decline on a call-centre ring**: this phone stops ringing, and that
 *    is all. Not the call centre's reject. That route takes the call out of
 *    the queue altogether — the visitor is hung up on — which is what a
 *    desk's Reject means and not what silencing a phone in a pocket should
 *    do: on a call rung to every available operator, one of them declining
 *    would end it for the others too. The call stays on offer to the console
 *    and to every other phone, and runs its course there.
 *  - **Decline on a colleague's ring**: the ring stops at once, and the
 *    server is told (`POST /api/team-calls/:id/decline`), which ends the call
 *    for the colleague calling — a colleague call rings one member, and that
 *    member's no is the answer (docs/operations/TEAM_CALLS.md).
 *  - **End on a call in progress** ([OngoingCallService]'s notification),
 *    by the call's kind ([OngoingCallEnd]): the call on screen hangs up as
 *    if its own red button were pressed; with no call screen left to do it,
 *    the server is told from here, the way that screen would have told it
 *    (a colleague call's hang-up, a visitor call's hang-up, or the call
 *    centre's end).
 *
 * A broadcast rather than an activity, so none of these opens the app. Not
 * exported: only this app's own notifications can send it.
 */
class CallActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val callId = intent.getStringExtra(CallNotifications.EXTRA_CALL)?.takeIf { PushPayload.isId(it) } ?: return
        when (intent.action) {
            CallNotifications.ACTION_DECLINE -> {
                // Declined, not missed, so no missed-call line and no language needed for one.
                CallNotifications.stop(context, callId, missed = false, language = Language.DEFAULT)
                CallNotifications.forget(callId)
            }
            CallNotifications.ACTION_TEAM_DECLINE -> {
                CallNotifications.stopTeam(context, callId, missed = false, language = Language.DEFAULT)
                CallNotifications.forget(callId)
                tellServer(context, callId, "colleague call decline") { graph ->
                    // A ring screen open for this call ends with it, without
                    // telling the server a second time.
                    graph.teamCallDeclinedFromNotification(callId)
                    graph.api.declineTeamCall(callId)
                }
            }
            OngoingCallService.ACTION_HANG_UP -> hangUp(context, intent, callId)
        }
    }

    private fun hangUp(context: Context, intent: Intent, callId: String) {
        val graph = (context.applicationContext as? PlatformApp)?.graph ?: return
        val kind = OngoingCallKind.from(intent.getStringExtra(OngoingCallService.EXTRA_KIND)) ?: OngoingCallKind.TEAM
        val workspaceId = intent.getStringExtra(OngoingCallService.EXTRA_WORKSPACE)?.takeIf { PushPayload.isId(it) }
        val sessionId = intent.getStringExtra(OngoingCallService.EXTRA_SESSION)?.takeIf { PushPayload.isId(it) }
        val end = OngoingCallEnd.of(kind, callId, sessionId, workspaceId)
        val onScreen = when (kind) {
            OngoingCallKind.TEAM -> graph.hangUpTeamCallFromNotification(callId)
            OngoingCallKind.VISITOR, OngoingCallKind.CENTER -> graph.hangUpCallFromNotification(callId)
        }
        if (onScreen) return
        // Nothing on screen holds this call any more, so nothing else will
        // end it: the notification goes, and the server hears.
        OngoingCallService.stop(context, callId)
        when (end) {
            is OngoingCallEnd.Team -> tellServer(context, callId, "colleague call hangup") { it.api.hangUpTeamCall(callId) }
            is OngoingCallEnd.Visitor -> tellServer(context, callId, "call hangup") { it.api.hangUp(end.callSessionId) }
            is OngoingCallEnd.Center -> tellServer(context, callId, "call-centre end") {
                it.api.endCenterCall(workspaceId = end.workspaceId, callSessionId = end.callSessionId)
            }
            // A visitor call still inviting: its offer runs out on its own.
            null -> graph.diag.warn(AREA, "call end with no session to end for ${Diag.id(callId)}")
        }
    }

    /**
     * [request], kept alive past this method: a receiver's process may be
     * dropped as soon as `onReceive` returns, so the broadcast is held open
     * ([goAsync]) for one short request, bounded well inside the time the
     * system gives a broadcast.
     */
    private fun tellServer(
        context: Context,
        callId: String,
        what: String,
        request: suspend (com.platform.app.AppGraph) -> Unit,
    ) {
        val graph = (context.applicationContext as? PlatformApp)?.graph ?: return
        val pending = goAsync()
        graph.appScope.launch {
            try {
                val done = withTimeoutOrNull(REQUEST_TIMEOUT_MS) {
                    runCatchingUnlessCancelled { request(graph) }
                        .onFailure { graph.diag.warn(AREA, "$what not sent for ${Diag.id(callId)}: ${it.javaClass.simpleName}") }
                }
                if (done == null) graph.diag.warn(AREA, "$what timed out for ${Diag.id(callId)}")
            } finally {
                pending.finish()
            }
        }
    }

    private companion object {
        const val AREA = "Call"

        /** Inside the ten seconds a broadcast is given, with room to spare. */
        const val REQUEST_TIMEOUT_MS = 8_000L
    }
}
