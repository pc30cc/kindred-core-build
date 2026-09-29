package com.webyar.ai.feature.call

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.webyar.ai.core.model.CallChannel
import com.webyar.ai.core.net.ApiError
import com.webyar.ai.core.net.WebyarApi
import com.webyar.ai.core.runCatchingUnlessCancelled
import com.webyar.ai.i18n.Language
import com.webyar.ai.i18n.displayText
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
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

    /** Set for a call-centre call this phone was rung for: whose queue it is in. */
    private var centerWorkspaceId: String? = null

    /**
     * The work that gets the call INTO the room: the invitation and its wait,
     * or the answer — and, after either, the join.
     *
     * Held so that ending the call can stop it. Without that, a hang-up
     * pressed while the answer, the token or the last poll was still on its
     * way ended the call on screen and then watched it come back: the join
     * went on, set the phase to connecting over "call ended", entered the
     * room and switched the microphone on — for an operator who had pressed
     * the red button and put the phone down.
     */
    private var callJob: Job? = null

    /**
     * Where the end of a call is told to the room and the server.
     *
     * Not [viewModelScope]: that ends the moment this screen does, and the
     * red button is also the Done button — the operator's second tap on it
     * closed the screen and cancelled the hang-up request still in flight,
     * so the server never heard the call was over (and a call-centre call
     * kept this operator's line busy). One request, then nothing holds it.
     */
    private val teardown by lazy { CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate) }

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

        callJob = viewModelScope.launch {
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
     * A call-centre call ringing this phone: nothing is sent until the
     * operator answers. Idempotent, like [start].
     */
    fun ring(
        workspaceId: String,
        callSessionId: String,
        channel: CallChannel,
        language: Language,
    ) {
        if (started) return
        started = true
        this.channel = channel
        this.language = language
        this.centerWorkspaceId = workspaceId
        this.callSessionId = callSessionId
        _cameraOn.value = channel == CallChannel.VIDEO
        _phase.value = CallPhase.Ringing
        viewModelScope.launch {
            room.events.collect { event -> onRoomEvent(event) }
        }
    }

    /**
     * Answers the ringing call: the call centre gives it to this operator —
     * and stops every other phone — and then the room is joined like any
     * other. A call somebody else took first, or that the caller has given
     * up on, is said to be exactly that.
     */
    fun answer() {
        if (_phase.value != CallPhase.Ringing) return
        val workspaceId = centerWorkspaceId ?: return
        val sessionId = callSessionId ?: return
        _phase.value = CallPhase.Connecting
        callJob = viewModelScope.launch {
            runCatchingUnlessCancelled {
                api.acceptCenterCall(workspaceId = workspaceId, callSessionId = sessionId)
            }.onFailure { error ->
                _phase.value = CallPhase.Ended(
                    if ((error as? ApiError.Server)?.status in GONE_STATUSES) {
                        CallOutcome.NoLongerWaiting
                    } else {
                        CallOutcome.Failed(error.displayText(language))
                    }
                )
                return@launch
            }
            join(sessionId)
        }
    }

    /**
     * Declined here: this phone is done with the call, which stays on offer
     * to everybody else. Nothing is sent — the call centre's reject would
     * hang up on the caller for all of them.
     */
    fun decline() {
        if (_phase.value != CallPhase.Ringing) return
        _phase.value = CallPhase.Ended(CallOutcome.HungUp)
    }

    /** The server stopped the ring before this phone answered. */
    fun noLongerRinging() {
        if (_phase.value != CallPhase.Ringing) return
        _phase.value = CallPhase.Ended(CallOutcome.NoLongerWaiting)
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
                // Ended as any call ends — the room left, the server told —
                // with the reason where a hang-up would be. The server hears
                // of it here rather than from the room's own disconnect,
                // which arrives with a failed join and is not acted on while
                // connecting (see [onRoomEvent]).
                finish(CallOutcome.Failed(result.reason))
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
                // Only once in. While connecting, the join itself says how it
                // went — a room that refuses us disconnects on the way out,
                // and ending the call here would stop the join before it
                // could say why, leaving "call ended" where the reason goes.
                if (_phase.value == CallPhase.Connected) finish(CallOutcome.VisitorLeft)
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
        // Never answered: there is nothing of ours to end.
        if (_phase.value == CallPhase.Ringing) {
            _phase.value = CallPhase.Ended(outcome)
            return
        }
        _phase.value = CallPhase.Ended(outcome)
        // Whatever was still getting the call into the room stops here, so
        // nothing afterwards can join it, or say it failed. A join already
        // inside the room is cancelled with it and left by the disconnect
        // below.
        callJob?.cancel()
        val sessionId = callSessionId
        val invitation = invitationId
        val center = centerWorkspaceId
        teardown.launch {
            room.disconnect()
            // Told to the server last and best-effort: the local side is
            // already over, and a failed request must not leave the operator
            // staring at a call they have finished with.
            when {
                // A call-centre call ends through the call centre, which also
                // frees this operator's line for the next caller.
                center != null && sessionId != null ->
                    runCatchingUnlessCancelled { api.endCenterCall(workspaceId = center, callSessionId = sessionId) }
                // Idempotent server-side, which is what makes it safe to send
                // even when the visitor hung up first and the call is already
                // over as far as the server is concerned.
                sessionId != null -> runCatchingUnlessCancelled { api.hangUp(sessionId) }
                // Never answered: there is no session to end, only an offer to
                // withdraw. Leaving it standing is not harmless — the offer
                // lives five minutes, so a visitor whose widget the operator
                // has already given up on goes on being rung by it.
                invitation != null -> runCatchingUnlessCancelled { api.cancelInvitation(invitation) }
            }
        }
    }

    override fun onCleared() {
        // Gone from the screen with the call still on — Back, or a sign-out —
        // is a hang-up, and the server is told so like any other. Leaving it
        // to the room's release alone left an invitation ringing the
        // visitor's widget for its five minutes, and a call-centre call open
        // with this operator's line still busy.
        finish(CallOutcome.HungUp)
        // Whatever happened, the microphone and camera go back. A room left
        // open is a device the next app to ask for it is told no about.
        room.release()
        super.onCleared()
    }

    private companion object {
        const val POLL_MILLIS = 2_000L

        /** The call centre's "not there to answer any more": gone, or no longer active. */
        val GONE_STATUSES = setOf(404, 409)
    }
}
