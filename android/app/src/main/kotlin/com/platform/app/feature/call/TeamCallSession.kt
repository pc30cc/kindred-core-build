package com.platform.app.feature.call

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.platform.app.core.model.CallChannel
import com.platform.app.core.model.TEAM_CALL_RING_SECONDS
import com.platform.app.core.model.TeamCall
import com.platform.app.core.model.TeamCallAcceptance
import com.platform.app.core.model.TeamCallState
import com.platform.app.core.net.ApiError
import com.platform.app.core.net.ServerApi
import com.platform.app.core.runCatchingUnlessCancelled
import com.platform.app.i18n.Language
import com.platform.app.i18n.displayText
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.time.Duration
import java.time.Instant

/**
 * One colleague call on this phone, from the tap on a colleague's thread —
 * or their ring — to the room closing (docs/operations/TEAM_CALLS.md,
 * "Android").
 *
 *  - **Outgoing** ([place]): `POST /api/team-calls` rings the colleague's
 *    phones; a ringback tone plays until they answer; then this member's
 *    token, and the room.
 *  - **Incoming** ([ring], then [answer]): the ring is the notification's;
 *    answering is `POST accept` with the id this app registers its push
 *    device with — the first phone to answer wins — then the token and the
 *    room. Declining is `POST decline`, which ends the call for the caller.
 *
 * The server is the authority on where the call is. While it rings this asks
 * `GET /api/team-calls/:id` every two seconds, and every ten once answered —
 * a safety net under the room's own events, for a call the server ends by
 * itself — and asks at once whenever the member's own realtime channel says
 * the call moved, or the server stops this phone's ring ([TeamCallNudge]).
 * Whatever it hears only ever moves the call forward: a late answer saying
 * "ringing" never takes an answered call back.
 *
 * The media is [CallRoom], as for a visitor's call, so all of this — the
 * waiting, the outcomes, the races between a hang-up and an answer — is
 * tested on a JVM. Anybody in the room but this phone is the colleague.
 */
class TeamCallSession(
    private val api: ServerApi,
    /** Owned here, not by the screen: see [CallSession.room]. */
    val room: CallRoom,
    /** The id this app registers its push device with, which an answer carries. */
    private val deviceId: suspend () -> String?,
    /** What the rest of the app heard about colleague calls; each session takes its own. */
    private val nudges: Flow<TeamCallNudge>,
    private val ringback: Ringback,
    private val foreground: CallForeground,
    /**
     * Tells the server this phone is ringing for a call (`POST rang`), once
     * per call per phone however often it is asked: the in-app ring screen
     * asks as it shows ([TeamCallRangReporter][com.platform.app.core.push.TeamCallRangReporter]).
     */
    private val rang: (callId: String) -> Unit = {},
    private val clock: () -> Instant = Instant::now,
) : ViewModel() {

    enum class Direction { OUTGOING, INCOMING }

    private val _phase = MutableStateFlow<TeamCallPhase>(TeamCallPhase.Calling)
    val phase: StateFlow<TeamCallPhase> = _phase.asStateFlow()

    /**
     * The colleague, as the screen names them: what the thread or the ring
     * knew, then the server's own answer, which wins wherever it says
     * something.
     */
    private val _peer = MutableStateFlow(TeamCall.Peer(userId = ""))
    val peer: StateFlow<TeamCall.Peer> = _peer.asStateFlow()

    private val _muted = MutableStateFlow(false)
    val muted: StateFlow<Boolean> = _muted.asStateFlow()

    private val _cameraOn = MutableStateFlow(false)
    val cameraOn: StateFlow<Boolean> = _cameraOn.asStateFlow()

    private val _frontCamera = MutableStateFlow(true)
    val frontCamera: StateFlow<Boolean> = _frontCamera.asStateFlow()

    /**
     * A voice call starts on the earpiece, held to the ear like a phone call;
     * a video call on the loudspeaker, held in front of the face.
     */
    private val _speakerOn = MutableStateFlow(false)
    val speakerOn: StateFlow<Boolean> = _speakerOn.asStateFlow()

    /** The server warned that TURN is unconfigured: see [CallSession.relayWarning]. */
    private val _relayWarning = MutableStateFlow(false)
    val relayWarning: StateFlow<Boolean> = _relayWarning.asStateFlow()

    /** Connected, but without everything it was supposed to carry. */
    private val _degraded = MutableStateFlow<CallDegradation?>(null)
    val degraded: StateFlow<CallDegradation?> = _degraded.asStateFlow()

    var direction: Direction = Direction.OUTGOING
        private set

    var channel: CallChannel = CallChannel.AUDIO
        private set

    /** The server's id for the call; null while an outgoing one is being placed. */
    var callId: String? = null
        private set

    /** Whether [place] or [ring] has run: one session is one call. */
    var started: Boolean = false
        private set

    private var language: Language = Language.DEFAULT

    /** This phone's push device id, once read: what tells an answer here from one elsewhere. */
    private var myDeviceId: String? = null

    /** The call was answered — by the colleague, or by this phone. From here on, ending it is a hang-up. */
    private var answered = false

    /**
     * This phone's accept, once Answer was pressed: sent, and what the server
     * said to it. Until it has said, a call ended here is ended by what the
     * accept turns out to have done ([unanswer]).
     */
    private var accepting: Deferred<Accept>? = null

    /** In the room, ready for the colleague to be there. */
    private var joined = false

    /** The proximity sensor says the phone is at the ear ([setAtEar]); far until it says so. */
    private var atEar = false

    /** When this phone started ringing or being rung, for its own deadline. */
    private var ringStartedAt: Instant? = null
    private var expiresAt: Instant? = null

    /** When the call was answered, for the time the room has to bring the two together. */
    private var answeredAt: Instant? = null

    /** The server said both are in the room. */
    private var serverActive = false

    /**
     * What gets the call INTO the room — the create, the accept, the token
     * and the join — held so that ending the call stops it: see
     * [CallSession]'s own `callJob`.
     */
    private var callJob: Job? = null
    private var watcher: Job? = null

    /** A change of lens under way ([switchCamera]). */
    private var switching: Job? = null

    /**
     * Where the end of a call is told to the room and the server, and where
     * the create runs: not [viewModelScope], which ends with the screen. A
     * request to ring that a closing screen cancelled might still have
     * reached the server and be ringing the colleague with nobody left to
     * stop it; one that always finishes here finds the call ended and
     * cancels it.
     */
    private val teardown by lazy { CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate) }

    /**
     * Rings [peer] for a call of [channel]. Idempotent: however often the
     * screen asks, one session is one call.
     */
    fun place(workspaceId: String, peer: TeamCall.Peer, channel: CallChannel, language: Language) {
        if (!begin(Direction.OUTGOING, peer, channel, language)) return
        _phase.value = TeamCallPhase.Calling
        listen()
        // The create is the teardown's, not the screen's: its answer lands
        // even when this screen is gone, and the call is then withdrawn
        // rather than left ringing the colleague.
        val creating = teardown.async {
            runCatchingUnlessCancelled { api.createTeamCall(workspaceId, peer.userId, channel) }.onSuccess { call ->
                // On the main thread, as every end is: from this line on,
                // ending the call tells the server itself; before it, the
                // call was already over and is withdrawn here.
                callId = call.id
                if (_phase.value.isOver) {
                    runCatchingUnlessCancelled { withdraw(call.id) }
                }
            }
        }
        callJob = viewModelScope.launch {
            creating.await()
                .onFailure { error ->
                    val end = TeamCallEnd.refusal(error)
                    finish(end, detail = error.takeIf { end == TeamCallEnd.FAILED }?.displayText(language), tell = false)
                }
                .onSuccess { call ->
                    if (_phase.value.isOver) return@onSuccess
                    ringStartedAt = clock()
                    follow(call)
                    if (!_phase.value.isOver) {
                        foreground.show(ongoing())
                        watch()
                    }
                }
        }
    }

    /**
     * This phone is being rung for [callId]: shown with Answer and Decline.
     * Nothing is sent until one of them is pressed. Idempotent, like [place].
     */
    fun ring(callId: String, peer: TeamCall.Peer, channel: CallChannel, language: Language) {
        if (!begin(Direction.INCOMING, peer, channel, language)) return
        this.callId = callId
        ringStartedAt = clock()
        _phase.value = TeamCallPhase.Ringing
        rang(callId)
        listen()
        viewModelScope.launch {
            myDeviceId = deviceId()
            // At once: a ring opened late may already be over.
            refresh()
            watch()
        }
    }

    /** The microphone was refused before anybody was rung: nothing is placed. */
    fun refuseWithoutMicrophone(peer: TeamCall.Peer, channel: CallChannel, language: Language) {
        if (!begin(Direction.OUTGOING, peer, channel, language)) return
        _phase.value = TeamCallPhase.Ended(TeamCallEnd.NO_MICROPHONE)
    }

    private fun begin(direction: Direction, peer: TeamCall.Peer, channel: CallChannel, language: Language): Boolean {
        if (started) return false
        started = true
        this.direction = direction
        this.channel = channel
        this.language = language
        _peer.value = peer
        _cameraOn.value = channel == CallChannel.VIDEO
        _speakerOn.value = channel == CallChannel.VIDEO
        routeRingback()
        return true
    }

    /**
     * Answers the call ringing this phone. The first phone to answer wins;
     * a later one hears who did — or that the call is already over — and
     * says exactly that.
     */
    fun answer(withVideo: Boolean = true) {
        if (direction != Direction.INCOMING || _phase.value != TeamCallPhase.Ringing) return
        val id = callId ?: return
        // A video call answered with "Audio only": the camera stays off until
        // the member turns it on, which the call's own button still can.
        if (channel == CallChannel.VIDEO && !withVideo) _cameraOn.value = false
        _phase.value = TeamCallPhase.Connecting
        answeredAt = clock()
        foreground.show(ongoing())
        // The accept is the teardown's, not the screen's, as the create is in
        // [place]: once sent it may move the call to `connecting` whatever
        // this screen does next, so a hang-up while it is on its way waits
        // for its answer and ends what it did, rather than declining a call
        // the server no longer has ringing.
        val sending = teardown.async {
            val device = myDeviceId ?: deviceId().also { myDeviceId = it }
            Accept(device, runCatchingUnlessCancelled { api.acceptTeamCall(id, device) })
        }
        accepting = sending
        callJob = viewModelScope.launch {
            val sent = sending.await()
            val acceptance = sent.result.getOrElse { error ->
                // Gone for this member: the caller gave up and the call went
                // with them. Anything else is a failure, said in the server's
                // own words.
                if ((error as? ApiError.Server)?.status == 404) {
                    finish(TeamCallEnd.CANCELLED, tell = false)
                } else {
                    finish(TeamCallEnd.FAILED, detail = error.displayText(language), tell = false)
                }
                return@launch
            }
            when (acceptance) {
                is TeamCallAcceptance.Accepted -> {
                    answered = true
                    adoptPeer(acceptance.call)
                    join(id)
                }
                is TeamCallAcceptance.NotRinging -> {
                    val call = acceptance.call
                    // This phone's own answer, heard back: an accept that
                    // reached the server once already.
                    if (call != null && answeredWith(call, sent.device)) {
                        answered = true
                        join(id)
                    } else {
                        finish(call?.let { TeamCallEnd.resolve(it, sent.device) } ?: TeamCallEnd.ANSWERED_ELSEWHERE, tell = false)
                    }
                }
            }
        }
    }

    /** An accept this phone sent: the device id it carried, and what came of it. */
    private class Accept(val device: String?, val result: Result<TeamCallAcceptance>)

    /** [call] was answered by the phone whose accept carried [device]. */
    private fun answeredWith(call: TeamCall, device: String?): Boolean =
        call.state.isAnswered && device != null && call.answeredDeviceId == device

    /**
     * The red button, in every phase: cancels a call still ringing the
     * colleague, declines one ringing this phone, hangs up an answered one.
     */
    fun hangUp() = finish(TeamCallEnd.HUNG_UP, tell = true)

    // MARK: - What the server says

    /** A watcher that asks the server, and keeps the phone's own deadlines. */
    private fun watch() {
        if (watcher != null) return
        watcher = viewModelScope.launch {
            while (!_phase.value.isOver) {
                delay(if (_phase.value.isRinging) RINGING_POLL_MS else ANSWERED_POLL_MS)
                if (_phase.value.isOver) break
                if (overdue()) break
                refresh()
            }
        }
    }

    /**
     * The phone's own deadlines, for a phone that cannot hear the server.
     * The server is the authority — its ticker turns a ring past its expiry
     * into `missed` within five seconds, and the watcher asks it — so these
     * are deliberately later than the server's, and only the fallback.
     */
    private fun overdue(): Boolean {
        val now = clock()
        when (val phase = _phase.value) {
            TeamCallPhase.Calling, TeamCallPhase.Ringing -> {
                val started = ringStartedAt ?: return false
                // The server's expiry, but never more than one ring from
                // when it started here: a clock running behind would
                // otherwise ring for minutes.
                val ringEnd = started.plusSeconds(TEAM_CALL_RING_SECONDS)
                val end = (expiresAt?.takeIf { it.isBefore(ringEnd) } ?: ringEnd).plus(CLOCK_SKEW)
                if (now.isBefore(end)) return false
                if (phase == TeamCallPhase.Ringing && direction == Direction.INCOMING) {
                    finish(TeamCallEnd.MISSED, tell = false)
                } else {
                    finish(TeamCallEnd.NO_ANSWER, tell = true)
                }
                return true
            }
            TeamCallPhase.Connecting -> {
                // Answered, and the room has not brought the two together
                // by now: it is not going to.
                val since = answeredAt ?: return false
                if (now.isBefore(since.plus(JOIN_TIMEOUT))) return false
                finish(TeamCallEnd.FAILED, tell = true)
                return true
            }
            is TeamCallPhase.Live, is TeamCallPhase.Ended -> return false
        }
    }

    private suspend fun refresh() {
        val id = callId ?: return
        runCatchingUnlessCancelled { api.teamCall(id) }
            .onSuccess { call -> follow(call) }
            // Gone, for this member: not a call to wait on. Any other failed
            // read is a blip — the next one, or a deadline, decides.
            .onFailure { error -> if ((error as? ApiError.Server)?.status == 404) finish(TeamCallEnd.FAILED, tell = false) }
    }

    /** The call as the server now has it. Only ever forward. */
    private fun follow(call: TeamCall) {
        if (_phase.value.isOver) return
        adoptPeer(call)
        call.expiresAt?.let { expiresAt = it }
        TeamCallEnd.resolve(call, myDeviceId)?.let { end ->
            finish(end, tell = false)
            return
        }
        when {
            call.state == TeamCallState.RINGING -> {
                // "Calling…" with no ringback until one of the colleague's
                // phones says it rings (`rang_at`); "Ringing…" and the
                // ringback from then on. A server that never sets it leaves
                // the caller on "Calling…" until the answer or the end.
                if (_phase.value == TeamCallPhase.Calling && call.rangAt != null) {
                    _phase.value = TeamCallPhase.Ringing
                    ringback.start()
                }
            }
            call.state.isAnswered -> {
                if (call.state == TeamCallState.ACTIVE) serverActive = true
                if (direction == Direction.OUTGOING && !answered) {
                    // The colleague answered.
                    answered = true
                    answeredAt = clock()
                    ringback.stop()
                    _phase.value = TeamCallPhase.Connecting
                    val id = callId ?: return
                    callJob = viewModelScope.launch { join(id) }
                } else if (joined && serverActive) {
                    goLive()
                }
            }
        }
    }

    private fun adoptPeer(call: TeamCall) {
        val known = _peer.value
        _peer.value = TeamCall.Peer(
            userId = call.peer.userId,
            name = call.peer.name?.takeIf { it.isNotBlank() } ?: known.name,
            avatarUrl = call.peer.avatarUrl ?: known.avatarUrl,
        )
    }

    private fun listen() {
        viewModelScope.launch {
            nudges.collect { nudge -> if (nudge.callId == callId) onNudge(nudge) }
        }
        viewModelScope.launch {
            room.events.collect { event -> onRoomEvent(event) }
        }
    }

    private fun onNudge(nudge: TeamCallNudge) {
        val ringingHere = direction == Direction.INCOMING && _phase.value == TeamCallPhase.Ringing
        when (nudge) {
            is TeamCallNudge.Changed -> viewModelScope.launch { refresh() }
            is TeamCallNudge.RingStopped -> if (ringingHere) finish(TeamCallEnd.of(nudge.reason), tell = false)
            // The notification's Decline has told the server already.
            is TeamCallNudge.DeclinedHere -> if (ringingHere) finish(TeamCallEnd.HUNG_UP, tell = false)
            is TeamCallNudge.HangUp -> hangUp()
        }
    }

    // MARK: - The room

    private suspend fun join(id: String) {
        _phase.value = TeamCallPhase.Connecting
        val credentials = runCatchingUnlessCancelled { api.teamCallToken(id) }.getOrElse { error ->
            finish(TeamCallEnd.FAILED, detail = error.displayText(language), tell = true)
            return
        }
        _relayWarning.value = credentials.warnings?.contains("turn_missing") == true
        val url = credentials.signallingUrl
        if (url.isNullOrEmpty()) {
            finish(TeamCallEnd.FAILED, detail = "no_server_url", tell = true)
            return
        }
        // Where the sound starts, said before the room exists.
        room.setSpeaker(_speakerOn.value)
        val wantsVideo = channel == CallChannel.VIDEO && _cameraOn.value
        when (val result = room.connect(url, credentials, wantsVideo = wantsVideo)) {
            is CallRoom.Result.Failed -> finish(TeamCallEnd.FAILED, detail = result.reason, tell = true)
            is CallRoom.Result.Joined -> {
                // Best-effort, as on a visitor's call: a camera that will
                // not start is a reason to carry on as voice, not to drop
                // a call the colleague has answered.
                if (!result.microphone) {
                    _muted.value = true
                    _degraded.value = CallDegradation.NO_MICROPHONE
                } else if (_muted.value) {
                    // Muted before the call connected (from the small window):
                    // the room joins with the microphone on, so the choice
                    // made then is applied now — never shown muted and sending.
                    room.setMicrophone(enabled = false)
                }
                if (wantsVideo && !result.camera) {
                    _cameraOn.value = false
                    if (_degraded.value == null) _degraded.value = CallDegradation.NO_CAMERA
                }
                room.setSpeaker(_speakerOn.value)
                joined = true
                // Whoever joins second finds the other already there, which
                // no event will say.
                if (room.hasRemoteParticipant || serverActive) goLive()
            }
        }
    }

    private fun goLive() {
        if (_phase.value != TeamCallPhase.Connecting || !joined) return
        val since = clock()
        _phase.value = TeamCallPhase.Live(since)
        foreground.show(ongoing(since))
    }

    private fun onRoomEvent(event: CallRoom.Event) {
        when (event) {
            is CallRoom.Event.VisitorPresenceChanged -> when {
                event.present -> goLive()
                // The colleague leaving the room is the call ending — the
                // server ends it the same way, from the room's webhook.
                _phase.value is TeamCallPhase.Live -> finish(TeamCallEnd.REMOTE_ENDED, tell = true)
            }
            // Only once live: while connecting, the join itself says how it
            // went (see [CallSession]'s own handling).
            CallRoom.Event.Disconnected ->
                if (_phase.value is TeamCallPhase.Live) finish(TeamCallEnd.REMOTE_ENDED, tell = true)
        }
    }

    // MARK: - Controls

    /**
     * The latest mute and camera presses: a late answer from the room for an
     * earlier press (on, off, on in quick succession) changes nothing.
     */
    private var micPress = 0
    private var cameraPress = 0

    fun toggleMute() {
        // Over: a microphone grant that arrives after the end changes nothing.
        if (_phase.value.isOver) return
        val next = !_muted.value
        _muted.value = next
        val press = ++micPress
        viewModelScope.launch {
            val ok = room.setMicrophone(enabled = !next)
            // Before the call is live there is no microphone in a room yet:
            // the choice is applied when it joins.
            if (press != micPress || !(_phase.value is TeamCallPhase.Live) || next) return@launch
            if (!ok) {
                // A microphone that would not start: shown muted, never live
                // and silent.
                _muted.value = true
            } else {
                if (_degraded.value == CallDegradation.NO_MICROPHONE) _degraded.value = null
                // The service gains the microphone type it may not have had.
                (_phase.value as? TeamCallPhase.Live)?.let { foreground.show(ongoing(it.since)) }
            }
        }
    }

    fun toggleCamera() {
        if (channel != CallChannel.VIDEO || !(_phase.value is TeamCallPhase.Live)) return
        val next = !_cameraOn.value
        _cameraOn.value = next
        // The service holds the camera only while it is on.
        (_phase.value as? TeamCallPhase.Live)?.let { foreground.show(ongoing(it.since)) }
        val press = ++cameraPress
        viewModelScope.launch {
            val ok = room.setCamera(enabled = next)
            if (press != cameraPress || !(_phase.value is TeamCallPhase.Live) || !next) return@launch
            if (!ok) {
                // A camera that would not start (no permission, another app
                // has it): the button and the service say so, rather than
                // showing a camera on that nobody sees.
                _cameraOn.value = false
                (_phase.value as? TeamCallPhase.Live)?.let { foreground.show(ongoing(it.since)) }
            } else if (_degraded.value == CallDegradation.NO_CAMERA) {
                // Turned on after all (asked for and granted mid-call).
                _degraded.value = null
            }
        }
    }

    /**
     * The other lens. [frontCamera] follows the lens the room says is in
     * use, so a phone with one camera, or one that would not move, keeps
     * mirroring the picture it actually shows. A tap while the lens is still
     * moving is ignored: it would ask for the lens already being moved to.
     */
    fun switchCamera() {
        if (channel != CallChannel.VIDEO || !_cameraOn.value || switching?.isActive == true) return
        val front = !_frontCamera.value
        switching = viewModelScope.launch {
            if (room.switchCamera(front)) _frontCamera.value = front
        }
    }

    /**
     * Speaker, in every phase: while the call is placed or rings, before
     * there is a room, it moves the ringback; the room starts where it says.
     */
    fun toggleSpeaker() {
        val next = !_speakerOn.value
        _speakerOn.value = next
        room.setSpeaker(next)
        routeRingback()
    }

    /**
     * The proximity sensor, while the screen listens to it: [near] is the
     * phone at the ear. The ringback follows it — the earpiece at the ear,
     * the loudspeaker in front of the face.
     */
    fun setAtEar(near: Boolean) {
        if (atEar == near) return
        atEar = near
        routeRingback()
    }

    private fun routeRingback() {
        ringback.route(
            RingbackOutput.of(video = channel == CallChannel.VIDEO, speakerOn = _speakerOn.value, atEar = atEar),
        )
    }

    // MARK: - The end

    /**
     * Ends the call on this phone for [end]. When [tell], the server hears
     * it as this phone's own move — a cancel, a decline or a hang-up,
     * whichever the call is still open to; otherwise it already knows, and
     * telling it again would be noise or, for a decline seen by the caller,
     * wrong.
     */
    private fun finish(end: TeamCallEnd, detail: String? = null, tell: Boolean) {
        if (_phase.value.isOver) return
        val ringingHere = direction == Direction.INCOMING && _phase.value == TeamCallPhase.Ringing
        _phase.value = TeamCallPhase.Ended(end, detail, silent = ringingHere && TeamCallEnd.closesRingAtOnce(end))
        ringback.stop()
        foreground.stop()
        // Nothing may join the room, or say it failed, after this.
        callJob?.cancel()
        watcher?.cancel()
        val id = callId
        val wasAnswered = answered
        val outgoing = direction == Direction.OUTGOING
        val accept = accepting
        teardown.launch {
            room.disconnect()
            // An outgoing call still being placed has no id yet: the create
            // withdraws it as it lands (see [place]).
            if (!tell || id == null) return@launch
            runCatchingUnlessCancelled {
                when {
                    wasAnswered -> api.hangUpTeamCall(id)
                    outgoing -> withdraw(id)
                    // Answer was pressed here and the server has not said
                    // yet whose answer won.
                    accept != null -> unanswer(id, accept)
                    // Never answered here: a decline, which the server
                    // ignores for a call another of this member's phones
                    // answered meanwhile. A hang-up would end that call.
                    else -> api.declineTeamCall(id)
                }
            }
        }
    }

    /**
     * Ends a call this phone was answering when it ended here — the red
     * button, Back, or the time to join run out with the accept still on its
     * way. The accept is waited for, not abandoned, because it may already
     * have moved the call: an accept that won made this phone's call, and
     * only a hang-up ends that (a decline is ignored once a call is no longer
     * ringing, which would leave the colleague waiting in a room alone). One
     * that lost to another of this member's phones leaves that call alone.
     * An accept that got no answer at all is settled by the call as the
     * server now has it; with no word from the server either, a hang-up,
     * which also declines a call still ringing.
     */
    private suspend fun unanswer(id: String, accept: Deferred<Accept>) {
        val sent = accept.await()
        val call = when (val acceptance = sent.result.getOrNull()) {
            is TeamCallAcceptance.Accepted -> {
                api.hangUpTeamCall(id)
                return
            }
            is TeamCallAcceptance.NotRinging -> acceptance.call ?: return
            null -> {
                // Gone for this member: nothing left to end.
                if ((sent.result.exceptionOrNull() as? ApiError.Server)?.status == 404) return
                runCatchingUnlessCancelled { api.teamCall(id) }.getOrNull()
            }
        }
        when {
            call == null -> api.hangUpTeamCall(id)
            call.state == TeamCallState.RINGING -> api.declineTeamCall(id)
            answeredWith(call, sent.device) -> api.hangUpTeamCall(id)
        }
    }

    /**
     * Cancels a call this phone placed. A cancel that crossed the colleague's
     * answer finds the call answered, and hangs it up, so nobody is left in
     * a room alone.
     */
    private suspend fun withdraw(id: String) {
        val after = api.cancelTeamCall(id)
        if (after.state.isAnswered) api.hangUpTeamCall(id)
    }

    private fun ongoing(since: Instant? = null): OngoingCall = OngoingCall(
        callId = callId.orEmpty(),
        peerName = _peer.value.name?.takeIf { it.isNotBlank() } ?: "",
        peerAvatarUrl = _peer.value.avatarUrl,
        video = channel == CallChannel.VIDEO && _cameraOn.value,
        language = language,
        since = since,
    )

    override fun onCleared() {
        // Gone from the screen with the call still on — Back, or a sign-out
        // — is a hang-up, and the server is told so like any other.
        finish(TeamCallEnd.HUNG_UP, tell = true)
        room.release()
        super.onCleared()
    }

    private companion object {
        /** Asked every two seconds while ringing, as the contract says. */
        const val RINGING_POLL_MS = 2_000L

        /** Once answered, a safety net under the room's own events. */
        const val ANSWERED_POLL_MS = 10_000L

        /** How far this phone's clock may be from the server's before a ring is taken for over. */
        val CLOCK_SKEW: Duration = Duration.ofSeconds(15)

        /** An answered call whose room has not brought the two together by then is not going to. */
        val JOIN_TIMEOUT: Duration = Duration.ofSeconds(30)
    }
}
