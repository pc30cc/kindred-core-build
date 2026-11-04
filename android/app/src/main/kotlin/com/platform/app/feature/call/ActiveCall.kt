package com.platform.app.feature.call

import androidx.lifecycle.ViewModel
import androidx.navigation3.runtime.NavKey
import com.platform.app.core.model.VisitorProfile
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import java.time.Instant

/**
 * Where a call on this phone stands, in the few words the small views of it
 * need — the picture-in-picture window, the bubble inside the app — whichever
 * kind of call it is.
 */
enum class ActiveCallStage {
    /** Placed from here, not answered yet: "Calling…", "Ringing…", an invitation out. */
    OUTGOING,

    /** Ringing THIS phone: only its own full screen shows it, never a small view. */
    RINGING_HERE,

    /** Answered, the room being joined. */
    CONNECTING,

    /** Both on the line. */
    LIVE,

    /** Over. */
    OVER;

    /** A call that can go on in a small window: placed or answered, and not over. */
    val minimisable: Boolean get() = this == OUTGOING || this == CONNECTING || this == LIVE
}

/** What the small views draw, as the call's session says it now. */
data class ActiveCallState(
    val stage: ActiveCallStage,
    /** When the two met: what the timer counts from. */
    val since: Instant? = null,
    val muted: Boolean = false,
    /** A video call (whatever the camera is doing now). */
    val video: Boolean = false,
)

/** Who is on the other end, as the call screen names them. */
data class ActiveCallIdentity(
    val name: String = "",
    val avatarUrl: String? = null,
    val visitor: VisitorProfile? = null,
)

/**
 * One call in progress, for the views of it that are not its own screen.
 *
 * Published by the call's screen and owned by its session ([owner], a view
 * model): it lives exactly as long as the session does — the session stays
 * while its screen is off the display (minimised, another tab) — and goes
 * with it ([ActiveCalls.publish] ties the two). Nothing in it is an identity
 * beyond what the call's own screen already shows.
 */
class ActiveCall(
    val owner: ViewModel,
    /** The call's screen on the back stack, to bring it back. */
    val screen: NavKey,
    /** A colleague (silhouette or photo) rather than a visitor (the inbox's look). */
    val colleague: Boolean,
    val state: StateFlow<ActiveCallState>,
    val room: LiveKitRoom,
    val toggleMute: () -> Unit,
    val hangUp: () -> Unit,
) {
    /** Kept up to date by the call's screen while it is composed; the last name it showed stays. */
    val identity: MutableStateFlow<ActiveCallIdentity> = MutableStateFlow(ActiveCallIdentity())
}

/** A colleague call's phase, as the small views see it. */
fun TeamCallPhase.activeStage(incoming: Boolean): ActiveCallStage = when (this) {
    TeamCallPhase.Calling -> ActiveCallStage.OUTGOING
    TeamCallPhase.Ringing -> if (incoming) ActiveCallStage.RINGING_HERE else ActiveCallStage.OUTGOING
    TeamCallPhase.Connecting -> ActiveCallStage.CONNECTING
    is TeamCallPhase.Live -> ActiveCallStage.LIVE
    is TeamCallPhase.Ended -> ActiveCallStage.OVER
}

/** A visitor's or a call-centre call's phase, as the small views see it. */
fun CallPhase.activeStage(): ActiveCallStage = when (this) {
    CallPhase.Ringing -> ActiveCallStage.RINGING_HERE
    CallPhase.Waiting -> ActiveCallStage.OUTGOING
    CallPhase.Connecting -> ActiveCallStage.CONNECTING
    CallPhase.Connected -> ActiveCallStage.LIVE
    is CallPhase.Ended -> ActiveCallStage.OVER
}

/**
 * The calls this process has on, newest last. One app-wide list
 * ([com.platform.app.AppGraph.activeCalls]): the activity reads it for
 * picture-in-picture, the shell for the bubble.
 */
class ActiveCalls {
    private val _calls = MutableStateFlow<List<ActiveCall>>(emptyList())
    val calls: StateFlow<List<ActiveCall>> = _calls.asStateFlow()

    /** The call [owner] published, if it did. */
    fun of(owner: ViewModel): ActiveCall? = _calls.value.firstOrNull { it.owner === owner }

    /**
     * Adds [call], once per session: withdrawn when its session is cleared,
     * whatever the screen is doing then.
     */
    fun publish(call: ActiveCall): ActiveCall {
        of(call.owner)?.let { return it }
        _calls.update { it + call }
        call.owner.addCloseable(AutoCloseable { withdraw(call.owner) })
        return call
    }

    fun withdraw(owner: ViewModel) {
        _calls.update { list -> list.filterNot { it.owner === owner } }
    }

    private val _showRequests = MutableSharedFlow<NavKey>(extraBufferCapacity = 4)

    /**
     * A call's screen to bring back to the front: the picture-in-picture
     * window was tapped back to full size. The shell raises it.
     */
    val showRequests: SharedFlow<NavKey> = _showRequests.asSharedFlow()

    fun requestShow(call: ActiveCall) {
        _showRequests.tryEmit(call.screen)
    }

    companion object {
        /**
         * The call a small window is for: the newest one that can be in one
         * ([ActiveCallStage.minimisable]) — never a ring, never a call over.
         */
        fun pick(calls: List<Pair<ActiveCall, ActiveCallState>>): Pair<ActiveCall, ActiveCallState>? =
            calls.lastOrNull { it.second.stage.minimisable }
    }
}
