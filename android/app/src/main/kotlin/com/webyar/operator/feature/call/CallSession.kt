package com.webyar.operator.feature.call

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.webyar.operator.core.model.CallChannel
import com.webyar.operator.core.net.WebyarApi
import com.webyar.operator.core.runCatchingUnlessCancelled
import com.webyar.operator.i18n.Language
import com.webyar.operator.i18n.displayText
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.time.Instant

/**
 * One call, from the invitation going out to the room closing.
 *
 * The shape of this mirrors what the operator console does, because the two
 * have to agree: the same invitation is polled, the same
 * `POST /api/calls/:id/token` is minted, and the same room is joined. A phone
 * that took a shortcut here would be a phone whose calls behave subtly
 * differently from the desktop's, and nobody would be able to say how.
 *
 * The media is behind [CallRoom] rather than reached for directly. That is not
 * an abstraction for its own sake: WebRTC's native libraries cannot load on a
 * JVM, so a session that named them would be a session no test could
 * construct — and the parts most worth testing here are the waiting, the
 * outcomes and the degradation, none of which are about media at all.
 */
class CallSession(
    private val api: WebyarApi,
    /**
     * Owned here, not remembered by the screen.
     *
     * A view model survives a rotation and a `remember` does not, so a room
     * held by the composable would be rebuilt on every turn of the phone
     * while the session went on holding the original — and the screen would
     * then render an empty room nobody had connected. On a video call that
     * looks exactly like the visitor turning their camera off.
     */
    val room: CallRoom,
) : ViewModel() {

    private val _phase = MutableStateFlow<CallPhase>(CallPhase.Waiting)
    val phase: StateFlow<CallPhase> = _phase.asStateFlow()

    /** The visitor, once they are actually in the room. */
    private val _visitorPresent = MutableStateFlow(false)
    val visitorPresent: StateFlow<Boolean> = _visitorPresent.asStateFlow()

    private val _muted = MutableStateFlow(false)
    val muted: StateFlow<Boolean> = _muted.asStateFlow()

    private val _cameraOn = MutableStateFlow(false)
    val cameraOn: StateFlow<Boolean> = _cameraOn.asStateFlow()

    /**
     * Loudspeaker by default, even for a voice call.
     *
     * The operator is at a desk, not holding the phone to their ear.
     */
    private val _speakerOn = MutableStateFlow(true)
    val speakerOn: StateFlow<Boolean> = _speakerOn.asStateFlow()

    /**
     * When the two sides actually connected, which is what the timer counts
     * from — not when the invitation was sent.
     */
    private val _connectedAt = MutableStateFlow<Instant?>(null)
    val connectedAt: StateFlow<Instant?> = _connectedAt.asStateFlow()

    /**
     * The server warned that TURN is unconfigured.
     *
     * Not fatal, and the first thing to look at when a call fails on a mobile
     * network.
     */
    private val _relayWarning = MutableStateFlow(false)
    val relayWarning: StateFlow<Boolean> = _relayWarning.asStateFlow()

    /** Connected, but without everything it was supposed to carry. */
    private val _degraded = MutableStateFlow<CallDegradation?>(null)
    val degraded: StateFlow<CallDegradation?> = _degraded.asStateFlow()

    var channel: CallChannel = CallChannel.AUDIO
        private set

    private var invitationId: String? = null
    private var callSessionId: String? = null
    private var started = false
    private var language: Language = Language.EN

    /**
     * Invites the visitor, then waits for them.
     *
     * The invitation is created HERE, on the session's own scope, and not by
     * the screen that shows the call. A composition is a fragile place to put
     * a request: an effect is cancelled whenever one of its keys changes, and
     * the screen's own permission flag is one of those keys. The invitation
     * POST really was cancelled mid-flight by that, the cancellation really
     * was reported as a failed call, and the retry's invitation really did go
     * on to ring, be answered and connect — behind a screen that had latched
     * on "the call could not connect" and would never let go. A view model's
     * scope outlives every recomposition, so there is nothing left to cancel
     * it but the call ending.
     *
     * Idempotent, which matters for the same reason: however many times the
     * screen recomposes and asks again, one call means one invitation. The
     * version that asked from a composition sent two of them per call, and
     * left the spare ringing on the visitor's widget until it expired.
     */
    fun start(
        workspaceId: String,
        conversationId: String,
        channel: CallChannel,
        language: Language,
    ) {
        if (started) return
        started = true
        this.channel = channel
        this.language = language
        _cameraOn.value = channel == CallChannel.VIDEO

        viewModelScope.launch {
            val invitation = runCatchingUnlessCancelled {
                // Named, because the two ids are both UUID strings and
                // transposing them is exactly the mistake that made every
                // call fail with a 403 nobody ever saw.
                api.inviteToCall(
                    workspaceId = workspaceId,
                    conversationId = conversationId,
                    channel = channel,
                )
            }.getOrElse { error ->
                // The reason, not a shrug. "Could not connect" over a 403
                // sent the operator looking at their network while the
                // server was telling them something specific.
                _phase.value = CallPhase.Ended(CallOutcome.Failed(error.displayText(language)))
                return@launch
            }
            invitationId = invitation.id
            waitForVisitor()
        }
        viewModelScope.launch {
            room.events.collect { event -> onRoomEvent(event) }
        }
    }

    /**
     * Polling rather than realtime, on purpose.
     *
     * The app has no realtime transport, an invitation lives for five minutes,
     * and a request every two seconds for at most that long is cheaper to
     * build and to reason about than a socket that exists for this one screen.
     */
    private suspend fun waitForVisitor() {
        val id = invitationId ?: return
        while (_phase.value == CallPhase.Waiting) {
            runCatchingUnlessCancelled { api.invitation(id) }.onSuccess { invitation ->
                val sessionId = invitation.callSessionId
                if (sessionId != null && invitation.isJoined) {
                    callSessionId = sessionId
                    join(sessionId)
                    return
                }
                if (invitation.isTerminal) {
                    _phase.value = CallPhase.Ended(
                        if (invitation.status == "declined") {
                            CallOutcome.Declined
                        } else {
                            CallOutcome.Expired
                        }
                    )
                    return
                }
            }
            // A single failed poll is a blip, not an answer. Only a terminal
            // invitation or the operator ends the wait.
            delay(POLL_MILLIS)
        }
    }

    private suspend fun join(callSessionId: String) {
        _phase.value = CallPhase.Connecting

        val credentials = runCatchingUnlessCancelled {
            api.callToken(callSessionId, displayName = null)
        }.getOrElse { error ->
            _phase.value = CallPhase.Ended(CallOutcome.Failed(error.displayText(language)))
            return
        }
        _relayWarning.value = credentials.warnings?.contains("turn_missing") == true

        val url = credentials.signallingUrl
        if (url.isNullOrEmpty()) {
            _phase.value = CallPhase.Ended(CallOutcome.Failed("no_server_url"))
            return
        }

        val result = room.connect(url, credentials, wantsVideo = channel == CallChannel.VIDEO)
        when (result) {
            is CallRoom.Result.Failed -> {
                _phase.value = CallPhase.Ended(CallOutcome.Failed(result.reason))
                return
            }
            is CallRoom.Result.Joined -> {
                // Publishing is best-effort, deliberately. A camera that will
                // not start — none at all on an emulator, permission refused,
                // another app holding it — is a reason to carry on without
                // video, not a reason to drop a call the visitor has already
                // answered.
                if (!result.microphone) {
                    _muted.value = true
                    _degraded.value = CallDegradation.NO_MICROPHONE
                }
                if (channel == CallChannel.VIDEO && !result.camera) {
                    _cameraOn.value = false
                    if (_degraded.value == null) _degraded.value = CallDegradation.NO_CAMERA
                }
                room.setSpeaker(_speakerOn.value)
                _phase.value = CallPhase.Connected
                _connectedAt.value = Instant.now()
            }
        }
    }

    private fun onRoomEvent(event: CallRoom.Event) {
        when (event) {
            is CallRoom.Event.VisitorPresenceChanged -> {
                _visitorPresent.value = event.present
                // The visitor leaving the room IS the call ending. Waiting for
                // the server to notice would leave the operator looking at a
                // live-looking screen with nobody on the other end.
                if (!event.present && _phase.value == CallPhase.Connected) {
                    finish(CallOutcome.VisitorLeft)
                }
            }
            is CallRoom.Event.Disconnected -> {
                if (_phase.value.isLive) finish(CallOutcome.VisitorLeft)
            }
        }
    }

    // MARK: - Controls

    fun toggleMute() {
        val next = !_muted.value
        _muted.value = next
        viewModelScope.launch { room.setMicrophone(enabled = !next) }
    }

    fun toggleCamera() {
        if (channel != CallChannel.VIDEO) return
        val next = !_cameraOn.value
        _cameraOn.value = next
        viewModelScope.launch { room.setCamera(enabled = next) }
    }

    fun toggleSpeaker() {
        val next = !_speakerOn.value
        _speakerOn.value = next
        room.setSpeaker(next)
    }

    /** Ends the call for both sides. */
    fun hangUp() = finish(CallOutcome.HungUp)

    private fun finish(outcome: CallOutcome) {
        if (!_phase.value.isLive) return
        _phase.value = CallPhase.Ended(outcome)
        val sessionId = callSessionId
        viewModelScope.launch {
            room.disconnect()
            // Told to the server last and best-effort: the local side is
            // already over, and a failed hang-up request must not leave the
            // operator staring at a call they have finished with.
            if (sessionId != null) runCatchingUnlessCancelled { api.hangUp(sessionId) }
        }
    }

    override fun onCleared() {
        // Whatever happened, the microphone and camera go back. A room left
        // open is a device the next app to ask for it is told no about.
        room.release()
        super.onCleared()
    }

    private companion object {
        const val POLL_MILLIS = 2_000L
    }
}
