package com.webyar.operator.feature.call

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.webyar.operator.core.model.CallChannel
import com.webyar.operator.core.model.CallInvitation
import com.webyar.operator.core.model.VisitorProfile
import com.webyar.operator.core.net.WebyarApi
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
    private val room: CallRoom,
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
    var contactName: String = ""
        private set
    var contactAvatarUrl: String? = null
        private set
    var visitor: VisitorProfile? = null
        private set

    private var invitationId: String? = null
    private var callSessionId: String? = null
    private var started = false

    fun begin(
        invitation: CallInvitation,
        contactName: String,
        contactAvatarUrl: String?,
        visitor: VisitorProfile?,
    ) {
        if (started) return
        started = true
        this.invitationId = invitation.id
        this.channel = invitation.kind
        this.contactName = contactName
        this.contactAvatarUrl = contactAvatarUrl
        this.visitor = visitor
        _cameraOn.value = invitation.kind == CallChannel.VIDEO

        viewModelScope.launch { waitForVisitor() }
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
            runCatching { api.invitation(id) }.onSuccess { invitation ->
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

        val credentials = runCatching { api.callToken(callSessionId, displayName = null) }
            .getOrElse {
                _phase.value = CallPhase.Ended(CallOutcome.Failed(it.message ?: "token"))
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
            if (sessionId != null) runCatching { api.hangUp(sessionId) }
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
