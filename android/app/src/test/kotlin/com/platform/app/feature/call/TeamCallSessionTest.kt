package com.platform.app.feature.call

import android.media.AudioDeviceInfo
import com.platform.app.core.model.CallChannel
import com.platform.app.core.model.CallToken
import com.platform.app.core.model.EffectiveBool
import com.platform.app.core.model.Entitlements
import com.platform.app.core.model.TeamCall
import com.platform.app.core.model.TeamCallAcceptance
import com.platform.app.core.model.TeamCallOutcome
import com.platform.app.core.model.TeamCallResponse
import com.platform.app.core.model.TeamCallRole
import com.platform.app.core.model.TeamCallState
import com.platform.app.core.model.allowsTeamCall
import com.platform.app.core.net.ApiError
import com.platform.app.core.net.SampleApi
import com.platform.app.core.net.ServerApi
import com.platform.app.core.push.TeamCallCancel
import com.platform.app.i18n.Language
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.Json
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.time.Instant

/**
 * A colleague call on this phone, before any media is involved
 * (docs/operations/TEAM_CALLS.md): placing one and the ringback, answering
 * one and the race to answer, every way it ends, and what the server is —
 * and is not — told. [CallRoom], [Ringback] and [CallForeground] are doubles,
 * so none of it needs WebRTC, a tone or a service.
 *
 * The session's watcher asks the server for as long as a call lasts, so these
 * tests move the clock by hand (`advanceTimeBy`, `runCurrent`) rather than
 * running it until idle, which a call in progress never is.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class TeamCallSessionTest {

    private val dispatcher = StandardTestDispatcher()

    @Before fun setUp() = Dispatchers.setMain(dispatcher)
    @After fun tearDown() = Dispatchers.resetMain()

    // MARK: - Doubles

    private class FakeRoom : CallRoom {
        val emitted = MutableSharedFlow<CallRoom.Event>(extraBufferCapacity = 8)
        override val events: Flow<CallRoom.Event> = emitted.asSharedFlow()
        var connected = false; private set
        var disconnected = false; private set
        /** Where the sound was asked to go when the room was joined. */
        var speakerAtConnect: Boolean? = null; private set
        var speaker: Boolean? = null; private set
        /** The colleague is already in the room when this phone joins. */
        var remote = false
        /** Whether a switch of lens ends on the lens asked for. */
        var lensMoves = true

        /** The microphone as the room has it: on from the join, as LiveKit does. */
        var micEnabled: Boolean? = null; private set
        /** Whether the camera starts when asked (no permission, another app has it). */
        var cameraStarts = true
        /** Whether the microphone starts when asked. */
        var micStarts = true

        override suspend fun connect(url: String, credentials: CallToken, wantsVideo: Boolean): CallRoom.Result {
            connected = true
            speakerAtConnect = speaker
            micEnabled = true
            return CallRoom.Result.Joined(microphone = true, camera = true)
        }
        override suspend fun setMicrophone(enabled: Boolean): Boolean { micEnabled = enabled; return !enabled || micStarts }
        override suspend fun setCamera(enabled: Boolean) = !enabled || cameraStarts
        override fun setSpeaker(on: Boolean) { speaker = on }
        override suspend fun switchCamera(front: Boolean) = lensMoves
        override val hasRemoteParticipant: Boolean get() = remote
        override suspend fun disconnect() { disconnected = true }
        override fun release() {}
    }

    private class FakeRingback : Ringback {
        var playing = false; private set
        var starts = 0; private set
        /** Where the tone was last told to play. */
        var output: RingbackOutput? = null; private set
        override fun start() { playing = true; starts++ }
        override fun stop() { playing = false }
        override fun route(output: RingbackOutput) { this.output = output }
    }

    private class FakeForeground : CallForeground {
        val shown = mutableListOf<OngoingCall>()
        var stopped = 0; private set
        override fun show(call: OngoingCall) { shown += call }
        override fun stop() { stopped++ }
    }

    /** The sample backend, with `/api/team-calls` answered by a script. */
    private class TeamApi(
        var created: TeamCall,
        private val createFailure: Throwable? = null,
        /** How long the server takes to ring. */
        private val createMillis: Long = 0,
        private val real: SampleApi = SampleApi(),
    ) : ServerApi by real {
        /** The next answers to `GET /api/team-calls/:id`; the last one repeats. */
        val reads = ArrayDeque<TeamCall>()
        private var last: TeamCall? = null
        var readCount = 0; private set
        var acceptance: TeamCallAcceptance? = null
        /** How long the server takes to answer an accept. */
        var acceptMillis = 0L
        /** What an accept fails with once it has been sent: no reply, or a refusal. */
        var acceptFailure: Throwable? = null
        var cancelAnswer: TeamCall? = null
        var creates = 0; private set
        val accepted = mutableListOf<Pair<String, String?>>()
        val declined = mutableListOf<String>()
        val cancelled = mutableListOf<String>()
        val hungUp = mutableListOf<String>()

        override suspend fun createTeamCall(workspaceId: String, calleeId: String, channel: CallChannel): TeamCall {
            creates++
            if (createMillis > 0) delay(createMillis)
            createFailure?.let { throw it }
            return created
        }

        override suspend fun teamCall(callId: String): TeamCall {
            readCount++
            return (reads.removeFirstOrNull() ?: last ?: created).also { last = it }
        }

        override suspend fun acceptTeamCall(callId: String, deviceId: String?): TeamCallAcceptance {
            accepted += callId to deviceId
            if (acceptMillis > 0) delay(acceptMillis)
            acceptFailure?.let { throw it }
            return acceptance ?: TeamCallAcceptance.Accepted(
                created.copy(state = TeamCallState.CONNECTING, answeredDeviceId = deviceId),
            )
        }

        override suspend fun declineTeamCall(callId: String) { declined += callId }

        override suspend fun cancelTeamCall(callId: String): TeamCall {
            cancelled += callId
            return cancelAnswer ?: created.copy(state = TeamCallState.CANCELLED, outcome = TeamCallOutcome.CANCELLED)
        }

        override suspend fun hangUpTeamCall(callId: String) { hungUp += callId }

        override suspend fun teamCallToken(callId: String): CallToken = CallToken(token = "t", wsUrl = "wss://example.invalid")
    }

    private var now: Instant = START
    private val room = FakeRoom()
    private val ringback = FakeRingback()
    private val foreground = FakeForeground()
    private val nudges = MutableSharedFlow<TeamCallNudge>(extraBufferCapacity = 8)

    private fun session(api: ServerApi) = TeamCallSession(
        api = api,
        room = room,
        deviceId = { DEVICE },
        nudges = nudges,
        ringback = ringback,
        foreground = foreground,
        rang = { rangs += it },
        clock = { now },
    )

    private val rangs = mutableListOf<String>()

    private fun serverCall(
        state: TeamCallState,
        role: TeamCallRole = TeamCallRole.CALLER,
        outcome: TeamCallOutcome? = null,
        answeredDeviceId: String? = null,
        channel: CallChannel = CallChannel.AUDIO,
        /** A phone of the colleague's said it rings; most tests start past that. */
        rangAt: Instant? = START,
    ) = TeamCall(
        id = CALL,
        workspaceId = "ws-1",
        channel = channel,
        state = state,
        outcome = outcome,
        role = role,
        peer = TeamCall.Peer(userId = "u-2", name = "Daniel Carter"),
        answeredDeviceId = answeredDeviceId,
        expiresAt = START.plusSeconds(45),
        rangAt = rangAt,
    )

    private val colleague = TeamCall.Peer(userId = "u-2", name = "Daniel Carter")

    private fun TeamCallSession.placing(channel: CallChannel = CallChannel.AUDIO) =
        place(workspaceId = "ws-1", peer = colleague, channel = channel, language = Language.EN)

    private fun TeamCallSession.ringing(channel: CallChannel = CallChannel.AUDIO) =
        ring(callId = CALL, peer = colleague, channel = channel, language = Language.EN)

    /** One tick of the watcher while it rings. */
    private fun TestScope.poll() {
        advanceTimeBy(2_000)
        runCurrent()
    }

    private fun ended(call: TeamCallSession): TeamCallEnd? = (call.phase.value as? TeamCallPhase.Ended)?.end

    // MARK: - Placing a call

    @Test
    fun `placing a call rings the colleague, with the ringback until they answer`() = runTest(dispatcher) {
        val api = TeamApi(created = serverCall(TeamCallState.RINGING))
        val call = session(api)

        call.placing()
        call.placing() // One session is one call.
        assertEquals(TeamCallPhase.Calling, call.phase.value)
        runCurrent()

        assertEquals(1, api.creates)
        assertEquals(TeamCallPhase.Ringing, call.phase.value)
        assertTrue(ringback.playing)
        assertEquals(CALL, foreground.shown.single().callId)

        // They answer: the tone stops and the room is joined.
        api.reads += serverCall(TeamCallState.CONNECTING)
        poll()
        assertFalse(ringback.playing)
        assertTrue(room.connected)
        assertEquals(TeamCallPhase.Connecting, call.phase.value)

        // Anybody in the room but this phone is the colleague.
        room.emitted.tryEmit(CallRoom.Event.VisitorPresenceChanged(present = true))
        runCurrent()
        val live = call.phase.value as TeamCallPhase.Live
        assertEquals(now, live.since)
        assertEquals(live.since, foreground.shown.last().since)

        call.hangUp()
        runCurrent()
        assertEquals(listOf(CALL), api.hungUp)
        assertTrue(api.cancelled.isEmpty())
        assertTrue(room.disconnected)
        assertEquals(1, foreground.stopped)
    }

    /** "Calling…" with no ringback until a phone of the colleague's says it rings. */
    @Test
    fun `the caller stays on Calling, silent, until the colleague's phone rang`() = runTest(dispatcher) {
        val api = TeamApi(created = serverCall(TeamCallState.RINGING, rangAt = null))
        val call = session(api)

        call.placing()
        runCurrent()
        assertEquals(TeamCallPhase.Calling, call.phase.value)
        assertEquals(0, ringback.starts)

        api.reads += serverCall(TeamCallState.RINGING, rangAt = null)
        poll()
        assertEquals(TeamCallPhase.Calling, call.phase.value)
        assertFalse(ringback.playing)

        api.reads += serverCall(TeamCallState.RINGING, rangAt = START.plusSeconds(3))
        poll()
        assertEquals(TeamCallPhase.Ringing, call.phase.value)
        assertTrue(ringback.playing)

        call.hangUp()
        runCurrent()
        assertFalse(ringback.playing)
        assertEquals(listOf(CALL), api.cancelled)
    }

    @Test
    fun `an answer straight from Calling joins without a ringback`() = runTest(dispatcher) {
        val api = TeamApi(created = serverCall(TeamCallState.RINGING, rangAt = null))
        val call = session(api)
        call.placing()
        runCurrent()

        api.reads += serverCall(TeamCallState.CONNECTING, rangAt = null)
        poll()
        assertEquals(TeamCallPhase.Connecting, call.phase.value)
        assertEquals(0, ringback.starts)
        call.hangUp()
        runCurrent()
    }

    /** Muted on "Calling…" (from the small window): still muted once the room is joined. */
    @Test
    fun `a mute chosen while it rings holds once the call connects`() = runTest(dispatcher) {
        val api = TeamApi(created = serverCall(TeamCallState.RINGING))
        val call = session(api)
        call.placing()
        runCurrent()
        call.toggleMute()
        runCurrent()

        api.reads += serverCall(TeamCallState.CONNECTING)
        poll()
        assertTrue(room.connected)
        assertTrue(call.muted.value)
        assertEquals(false, room.micEnabled)
        call.hangUp()
        runCurrent()
    }

    /** A video call answered "Audio only": a camera that then will not start is shown off. */
    @Test
    fun `audio only, then a camera that would not start, is shown off`() = runTest(dispatcher) {
        val api = TeamApi(created = serverCall(TeamCallState.RINGING, role = TeamCallRole.CALLEE, channel = CallChannel.VIDEO))
        val call = session(api)
        room.cameraStarts = false
        call.ringing(CallChannel.VIDEO)
        runCurrent()
        call.answer(withVideo = false)
        runCurrent()
        assertFalse(call.cameraOn.value)

        room.emitted.tryEmit(CallRoom.Event.VisitorPresenceChanged(present = true))
        runCurrent()
        call.toggleCamera()
        // Shown on at once (the press), then off once the room says it would not start.
        assertTrue(call.cameraOn.value)
        runCurrent()
        assertFalse(call.cameraOn.value)
        assertTrue(foreground.shown.last().video.not())

        // It starts after all: on, and it stays on.
        room.cameraStarts = true
        call.toggleCamera()
        runCurrent()
        assertTrue(call.cameraOn.value)
        assertTrue(foreground.shown.last().video)
        call.hangUp()
        runCurrent()
    }

    /** Unmuting a microphone that will not start: shown muted, never live and silent. */
    @Test
    fun `an unmute the microphone refuses stays muted`() = runTest(dispatcher) {
        val api = TeamApi(created = serverCall(TeamCallState.RINGING, role = TeamCallRole.CALLEE))
        val call = session(api)
        call.ringing()
        runCurrent()
        call.answer()
        runCurrent()
        room.emitted.tryEmit(CallRoom.Event.VisitorPresenceChanged(present = true))
        runCurrent()

        call.toggleMute()
        runCurrent()
        assertTrue(call.muted.value)
        assertEquals(false, room.micEnabled)

        room.micStarts = false
        call.toggleMute()
        assertFalse(call.muted.value) // the press
        runCurrent()
        assertTrue(call.muted.value) // the room's answer

        room.micStarts = true
        call.toggleMute()
        runCurrent()
        assertFalse(call.muted.value)
        assertEquals(true, room.micEnabled)

        // Over: a late press changes nothing.
        call.hangUp()
        runCurrent()
        call.toggleMute()
        runCurrent()
        assertFalse(call.muted.value)
    }

    /** No event announces a participant who was there first. */
    @Test
    fun `a colleague already in the room is found on joining`() = runTest(dispatcher) {
        val api = TeamApi(created = serverCall(TeamCallState.RINGING))
        val call = session(api)
        room.remote = true

        call.placing()
        runCurrent()
        api.reads += serverCall(TeamCallState.ACTIVE)
        poll()

        assertTrue(call.phase.value is TeamCallPhase.Live)
        call.hangUp()
        runCurrent()
    }

    @Test
    fun `a voice call starts on the earpiece, a video call on the loudspeaker`() = runTest(dispatcher) {
        val voice = session(TeamApi(created = serverCall(TeamCallState.CONNECTING)))
        voice.placing()
        runCurrent()
        assertFalse(voice.speakerOn.value)
        assertEquals(false, room.speakerAtConnect)
        voice.hangUp()
        runCurrent()

        val video = TeamCallSession(
            api = TeamApi(created = serverCall(TeamCallState.RINGING, channel = CallChannel.VIDEO)),
            room = FakeRoom(),
            deviceId = { DEVICE },
            nudges = nudges,
            ringback = FakeRingback(),
            foreground = FakeForeground(),
            clock = { now },
        )
        video.placing(CallChannel.VIDEO)
        assertTrue(video.speakerOn.value)
        assertTrue(video.cameraOn.value)
        video.hangUp()
        runCurrent()
    }

    @Test
    fun `a refusal says why, and rings nothing`() = runTest(dispatcher) {
        val refusals = listOf(
            ApiError.Server(409, "callee_busy") to TeamCallEnd.BUSY,
            ApiError.Server(409, "caller_busy") to TeamCallEnd.BUSY,
            ApiError.Server(403, "upgrade_required") to TeamCallEnd.NOT_IN_PLAN,
            ApiError.Server(422, "limit_reached") to TeamCallEnd.LIMIT_REACHED,
            ApiError.Server(429, "too_many_calls") to TeamCallEnd.FAILED,
            ApiError.Transport() to TeamCallEnd.FAILED,
        )
        for ((error, expected) in refusals) {
            val call = TeamCallSession(
                api = TeamApi(created = serverCall(TeamCallState.RINGING), createFailure = error),
                room = FakeRoom(),
                deviceId = { DEVICE },
                nudges = nudges,
                ringback = ringback,
                foreground = foreground,
                clock = { now },
            )
            call.placing()
            runCurrent()
            assertEquals("$error", expected, ended(call))
        }
        assertEquals(0, ringback.starts)
        assertTrue(foreground.shown.isEmpty())
    }

    /** "Call failed" over a refusal this build has no sentence for says nothing; the server's own words go under it. */
    @Test
    fun `a failure carries the server's own words`() = runTest(dispatcher) {
        val call = session(TeamApi(created = serverCall(TeamCallState.RINGING), createFailure = ApiError.Server(429, "too_many_calls")))
        call.placing()
        runCurrent()
        val phase = call.phase.value as TeamCallPhase.Ended
        assertEquals(TeamCallEnd.FAILED, phase.end)
        assertTrue(!phase.detail.isNullOrBlank())
    }

    @Test
    fun `hanging up while it rings cancels the call`() = runTest(dispatcher) {
        val api = TeamApi(created = serverCall(TeamCallState.RINGING))
        val call = session(api)
        call.placing()
        runCurrent()

        call.hangUp()
        runCurrent()

        assertEquals(TeamCallEnd.HUNG_UP, ended(call))
        assertEquals(listOf(CALL), api.cancelled)
        assertTrue(api.hungUp.isEmpty())
        assertFalse(ringback.playing)
        assertEquals(1, foreground.stopped)
    }

    /**
     * The red button before the server has even named the call. The request
     * to ring lands afterwards — and is withdrawn, rather than left ringing
     * the colleague with nobody on this end.
     */
    @Test
    fun `hanging up before the call exists still withdraws it`() = runTest(dispatcher) {
        val api = TeamApi(created = serverCall(TeamCallState.RINGING), createMillis = 1_000)
        val call = session(api)
        call.placing()
        runCurrent()
        assertEquals(TeamCallPhase.Calling, call.phase.value)

        call.hangUp()
        runCurrent()
        assertTrue(api.cancelled.isEmpty())

        advanceTimeBy(1_000)
        runCurrent()
        assertEquals(listOf(CALL), api.cancelled)
        assertEquals(TeamCallEnd.HUNG_UP, ended(call))
        assertEquals(0, ringback.starts)
    }

    /** A cancel that crossed the colleague's answer must not leave them alone in a room. */
    @Test
    fun `a cancel that crossed the answer hangs up`() = runTest(dispatcher) {
        val api = TeamApi(created = serverCall(TeamCallState.RINGING))
        api.cancelAnswer = serverCall(TeamCallState.CONNECTING)
        val call = session(api)
        call.placing()
        runCurrent()

        call.hangUp()
        runCurrent()

        assertEquals(listOf(CALL), api.cancelled)
        assertEquals(listOf(CALL), api.hungUp)
    }

    @Test
    fun `the colleague declining ends the call at once, and tells the server nothing`() = runTest(dispatcher) {
        val api = TeamApi(created = serverCall(TeamCallState.RINGING))
        val call = session(api)
        call.placing()
        runCurrent()

        api.reads += serverCall(TeamCallState.ENDED, outcome = TeamCallOutcome.DECLINED)
        poll()

        assertEquals(TeamCallEnd.DECLINED, ended(call))
        assertTrue(api.cancelled.isEmpty())
        assertTrue(api.hungUp.isEmpty())
        assertFalse(ringback.playing)
    }

    @Test
    fun `a ring nobody answered ends as no answer`() = runTest(dispatcher) {
        val api = TeamApi(created = serverCall(TeamCallState.RINGING))
        val call = session(api)
        call.placing()
        runCurrent()

        api.reads += serverCall(TeamCallState.MISSED, outcome = TeamCallOutcome.MISSED)
        poll()

        assertEquals(TeamCallEnd.NO_ANSWER, ended(call))
        assertTrue(api.cancelled.isEmpty())
    }

    /**
     * A phone that cannot hear the server still stops ringing: at the ring's
     * expiry, with some room for the clocks, and the call is withdrawn.
     */
    @Test
    fun `with the server out of reach the ring still runs out`() = runTest(dispatcher) {
        val api = TeamApi(created = serverCall(TeamCallState.RINGING))
        val call = session(api)
        call.placing()
        runCurrent()

        now = START.plusSeconds(45 + 14)
        poll()
        assertEquals(TeamCallPhase.Ringing, call.phase.value)

        now = START.plusSeconds(45 + 16)
        poll()
        assertEquals(TeamCallEnd.NO_ANSWER, ended(call))
        assertEquals(listOf(CALL), api.cancelled)
    }

    @Test
    fun `a late answer saying ringing never takes an answered call back`() = runTest(dispatcher) {
        val api = TeamApi(created = serverCall(TeamCallState.RINGING))
        val call = session(api)
        call.placing()
        runCurrent()
        api.reads += serverCall(TeamCallState.CONNECTING)
        poll()
        assertEquals(TeamCallPhase.Connecting, call.phase.value)

        api.reads += serverCall(TeamCallState.RINGING)
        advanceTimeBy(10_000)
        runCurrent()

        assertEquals(TeamCallPhase.Connecting, call.phase.value)
        call.hangUp()
        runCurrent()
        assertEquals(listOf(CALL), api.hungUp)
    }

    @Test
    fun `the colleague leaving the room ends a live call`() = runTest(dispatcher) {
        val api = TeamApi(created = serverCall(TeamCallState.RINGING))
        val call = session(api)
        room.remote = true
        call.placing()
        runCurrent()
        api.reads += serverCall(TeamCallState.ACTIVE)
        poll()
        assertTrue(call.phase.value is TeamCallPhase.Live)

        room.emitted.tryEmit(CallRoom.Event.VisitorPresenceChanged(present = false))
        runCurrent()

        assertEquals(TeamCallEnd.REMOTE_ENDED, ended(call))
        assertEquals(listOf(CALL), api.hungUp)
    }

    /** Microphone refused: a call would ring the colleague into silence, so none is placed. */
    @Test
    fun `without the microphone nobody is rung`() = runTest(dispatcher) {
        val api = TeamApi(created = serverCall(TeamCallState.RINGING))
        val call = session(api)

        call.refuseWithoutMicrophone(colleague, CallChannel.AUDIO, Language.EN)
        call.placing()
        runCurrent()

        assertEquals(TeamCallEnd.NO_MICROPHONE, ended(call))
        assertEquals(0, api.creates)
    }

    // MARK: - A call ringing this phone

    @Test
    fun `a ring asks nothing of the server until it is answered, but where it stands`() = runTest(dispatcher) {
        val api = TeamApi(created = serverCall(TeamCallState.RINGING, role = TeamCallRole.CALLEE))
        val call = session(api)

        call.ringing()
        runCurrent()

        assertEquals(TeamCallPhase.Ringing, call.phase.value)
        assertEquals(1, api.readCount)
        assertTrue(api.accepted.isEmpty())
        assertTrue(foreground.shown.isEmpty())
        assertEquals(0, ringback.starts) // The ring is the notification's; no tone here.
        // The in-app ring screen says this phone rings (the reporter sends it once).
        assertEquals(listOf(CALL), rangs)
        call.hangUp()
        runCurrent()
    }

    @Test
    fun `answering takes the call as this phone, then joins its room`() = runTest(dispatcher) {
        val api = TeamApi(created = serverCall(TeamCallState.RINGING, role = TeamCallRole.CALLEE))
        val call = session(api)
        call.ringing()
        runCurrent()

        call.answer()
        call.answer() // A second press is not a second accept.
        runCurrent()

        assertEquals(listOf(CALL to DEVICE), api.accepted)
        assertTrue(room.connected)
        assertEquals(1, foreground.shown.size)
        room.emitted.tryEmit(CallRoom.Event.VisitorPresenceChanged(present = true))
        runCurrent()
        assertTrue(call.phase.value is TeamCallPhase.Live)

        call.hangUp()
        runCurrent()
        assertEquals(listOf(CALL), api.hungUp)
        assertTrue(api.declined.isEmpty())
    }

    @Test
    fun `another phone that answered first is said to have`() = runTest(dispatcher) {
        val api = TeamApi(created = serverCall(TeamCallState.RINGING, role = TeamCallRole.CALLEE))
        api.acceptance = TeamCallAcceptance.NotRinging(
            serverCall(TeamCallState.CONNECTING, role = TeamCallRole.CALLEE, answeredDeviceId = "android-other"),
        )
        val call = session(api)
        call.ringing()
        runCurrent()

        call.answer()
        runCurrent()

        assertEquals(TeamCallEnd.ANSWERED_ELSEWHERE, ended(call))
        assertFalse(room.connected)
        assertTrue(api.declined.isEmpty())
        assertTrue(api.hungUp.isEmpty())
    }

    /** This phone's own answer, heard back by a second accept, is still this phone's call. */
    @Test
    fun `an answer that already reached the server joins`() = runTest(dispatcher) {
        val api = TeamApi(created = serverCall(TeamCallState.RINGING, role = TeamCallRole.CALLEE))
        api.acceptance = TeamCallAcceptance.NotRinging(
            serverCall(TeamCallState.CONNECTING, role = TeamCallRole.CALLEE, answeredDeviceId = DEVICE),
        )
        val call = session(api)
        call.ringing()
        runCurrent()

        call.answer()
        runCurrent()

        assertTrue(room.connected)
        call.hangUp()
        runCurrent()
    }

    /**
     * The red button while the accept is on its way. The accept may already
     * have made the call `connecting`, which a decline no longer moves: it is
     * waited for, and the call it won is hung up, rather than left for the
     * colleague to wait on in the room alone.
     */
    @Test
    fun `hanging up while the answer is on its way hangs up the call it won`() = runTest(dispatcher) {
        val api = TeamApi(created = serverCall(TeamCallState.RINGING, role = TeamCallRole.CALLEE))
        api.acceptMillis = 1_000
        val call = session(api)
        call.ringing()
        runCurrent()

        call.answer()
        runCurrent()
        assertEquals(TeamCallPhase.Connecting, call.phase.value)
        call.hangUp()
        runCurrent()
        assertEquals(TeamCallEnd.HUNG_UP, ended(call))
        assertTrue(api.hungUp.isEmpty())

        advanceTimeBy(1_000)
        runCurrent()
        assertEquals(listOf(CALL to DEVICE), api.accepted)
        assertEquals(listOf(CALL), api.hungUp)
        assertTrue(api.declined.isEmpty())
        assertFalse(room.connected)
    }

    /** An answer that lost to another of this member's phones leaves that phone's call alone. */
    @Test
    fun `hanging up while a losing answer is on its way tells the server nothing`() = runTest(dispatcher) {
        val api = TeamApi(created = serverCall(TeamCallState.RINGING, role = TeamCallRole.CALLEE))
        api.acceptMillis = 1_000
        api.acceptance = TeamCallAcceptance.NotRinging(
            serverCall(TeamCallState.CONNECTING, role = TeamCallRole.CALLEE, answeredDeviceId = "android-other"),
        )
        val call = session(api)
        call.ringing()
        runCurrent()

        call.answer()
        runCurrent()
        call.hangUp()
        advanceTimeBy(1_000)
        runCurrent()

        assertEquals(TeamCallEnd.HUNG_UP, ended(call))
        assertTrue(api.hungUp.isEmpty())
        assertTrue(api.declined.isEmpty())
    }

    /** An accept that got no reply is settled by the call as the server now has it. */
    @Test
    fun `an answer that got no reply is settled by the server's record`() = runTest(dispatcher) {
        val api = TeamApi(created = serverCall(TeamCallState.RINGING, role = TeamCallRole.CALLEE))
        api.acceptMillis = 1_000
        api.acceptFailure = ApiError.Transport()
        val call = session(api)
        call.ringing()
        runCurrent()

        call.answer()
        runCurrent()
        call.hangUp()
        runCurrent()
        // It reached the server after all, and this phone's answer won.
        api.reads += serverCall(TeamCallState.CONNECTING, role = TeamCallRole.CALLEE, answeredDeviceId = DEVICE)
        advanceTimeBy(1_000)
        runCurrent()

        assertEquals(listOf(CALL), api.hungUp)
        assertTrue(api.declined.isEmpty())
    }

    @Test
    fun `declining tells the server, which ends the call for the caller`() = runTest(dispatcher) {
        val api = TeamApi(created = serverCall(TeamCallState.RINGING, role = TeamCallRole.CALLEE))
        val call = session(api)
        call.ringing()
        runCurrent()

        call.hangUp()
        runCurrent()

        assertEquals(listOf(CALL), api.declined)
        assertTrue(api.cancelled.isEmpty())
        assertTrue(api.hungUp.isEmpty())
    }

    @Test
    fun `answered on another phone, the ring here ends with it`() = runTest(dispatcher) {
        val api = TeamApi(created = serverCall(TeamCallState.RINGING, role = TeamCallRole.CALLEE))
        val call = session(api)
        call.ringing()
        runCurrent()

        api.reads += serverCall(TeamCallState.CONNECTING, role = TeamCallRole.CALLEE, answeredDeviceId = "ios-1")
        poll()

        assertEquals(TeamCallEnd.ANSWERED_ELSEWHERE, ended(call))
        assertTrue(api.declined.isEmpty())
    }

    @Test
    fun `the server stopping the ring ends the ring screen, and is told nothing back`() = runTest(dispatcher) {
        val api = TeamApi(created = serverCall(TeamCallState.RINGING, role = TeamCallRole.CALLEE))
        val call = session(api)
        call.ringing()
        runCurrent()

        nudges.tryEmit(TeamCallNudge.RingStopped("another-call", TeamCallCancel.Reason.CANCELLED))
        runCurrent()
        assertEquals(TeamCallPhase.Ringing, call.phase.value)

        nudges.tryEmit(TeamCallNudge.RingStopped(CALL, TeamCallCancel.Reason.CANCELLED))
        runCurrent()

        assertEquals(TeamCallEnd.CANCELLED, ended(call))
        assertTrue(api.declined.isEmpty())
    }

    @Test
    fun `declined from the notification, the ring screen closes without a second decline`() = runTest(dispatcher) {
        val api = TeamApi(created = serverCall(TeamCallState.RINGING, role = TeamCallRole.CALLEE))
        val call = session(api)
        call.ringing()
        runCurrent()

        nudges.tryEmit(TeamCallNudge.DeclinedHere(CALL))
        runCurrent()

        assertEquals(TeamCallEnd.HUNG_UP, ended(call))
        assertTrue(api.declined.isEmpty())
    }

    // MARK: - Where the ringback plays (owner, 2026-11-05: "I don't hear it ring")

    @Test
    fun `the ringback plays on the loudspeaker in front of the face, the earpiece at the ear`() = runTest(dispatcher) {
        val api = TeamApi(created = serverCall(TeamCallState.RINGING))
        val call = session(api)
        call.placing()
        // Placed with the phone in front of the face: heard there.
        assertEquals(RingbackOutput.LOUDSPEAKER, ringback.output)
        runCurrent()
        assertTrue(ringback.playing)
        assertEquals(RingbackOutput.LOUDSPEAKER, ringback.output)

        call.setAtEar(true)
        assertEquals(RingbackOutput.EARPIECE, ringback.output)
        call.setAtEar(false)
        assertEquals(RingbackOutput.LOUDSPEAKER, ringback.output)
        call.hangUp() // Ended, so its watcher stops and the test ends.
        runCurrent()
    }

    @Test
    fun `Speaker moves the ringback while it rings, before there is a room`() = runTest(dispatcher) {
        val api = TeamApi(created = serverCall(TeamCallState.RINGING))
        val call = session(api)
        call.placing()
        runCurrent()
        call.setAtEar(true)
        assertEquals(RingbackOutput.EARPIECE, ringback.output)

        call.toggleSpeaker()
        assertEquals(RingbackOutput.LOUDSPEAKER, ringback.output)
        assertFalse(room.connected)
        call.toggleSpeaker()
        assertEquals(RingbackOutput.EARPIECE, ringback.output)
        call.hangUp() // Ended, so its watcher stops and the test ends.
        runCurrent()
    }

    @Test
    fun `Speaker chosen while calling, before the ring, is where the tone starts`() = runTest(dispatcher) {
        val api = TeamApi(created = serverCall(TeamCallState.RINGING, rangAt = null))
        val call = session(api)
        call.placing()
        call.setAtEar(true)
        call.toggleSpeaker()
        runCurrent()
        assertEquals(TeamCallPhase.Calling, call.phase.value)
        assertEquals(RingbackOutput.LOUDSPEAKER, ringback.output)
        call.hangUp() // Ended, so its watcher stops and the test ends.
        runCurrent()
    }

    @Test
    fun `a video call's ringback stays on the loudspeaker, even at the ear`() = runTest(dispatcher) {
        val api = TeamApi(created = serverCall(TeamCallState.RINGING, channel = CallChannel.VIDEO))
        val call = session(api)
        call.placing(CallChannel.VIDEO)
        runCurrent()
        call.setAtEar(true)
        assertEquals(RingbackOutput.LOUDSPEAKER, ringback.output)
        call.hangUp() // Ended, so its watcher stops and the test ends.
        runCurrent()
    }

    @Test
    fun `where the ringback plays, and on which stream`() {
        assertEquals(RingbackOutput.EARPIECE, RingbackOutput.of(video = false, speakerOn = false, atEar = true))
        assertEquals(RingbackOutput.LOUDSPEAKER, RingbackOutput.of(video = false, speakerOn = false, atEar = false))
        assertEquals(RingbackOutput.LOUDSPEAKER, RingbackOutput.of(video = false, speakerOn = true, atEar = true))
        assertEquals(RingbackOutput.LOUDSPEAKER, RingbackOutput.of(video = true, speakerOn = false, atEar = true))
        assertEquals(RingbackOutput.LOUDSPEAKER, RingbackOutput.of(video = true, speakerOn = true, atEar = false))
        // AudioManager's constants: the voice-call stream (0) is the
        // earpiece, the media stream (3) the loudspeaker or what is connected.
        val earpiece = RingbackOutput.sound(RingbackOutput.EARPIECE, external = false)
        val loudspeaker = RingbackOutput.sound(RingbackOutput.LOUDSPEAKER, external = false)
        assertEquals(RingbackOutput.Sound(stream = 0, volume = RingbackOutput.QUIET), earpiece)
        assertEquals(3, loudspeaker.stream)
        assertTrue("much quieter at the ear", loudspeaker.volume - earpiece.volume >= 15)
        assertEquals(70, RingbackOutput.QUIET) // The old ringback's level.
        // A headset, Bluetooth or a car: the media stream, which goes there,
        // at the ear's level, never the loudspeaker over it.
        for (output in RingbackOutput.entries) {
            assertEquals(RingbackOutput.Sound(stream = 3, volume = RingbackOutput.QUIET), RingbackOutput.sound(output, external = true))
        }
    }

    @Test
    fun `only the phone's own earpiece and loudspeaker are built in`() {
        assertFalse(RingbackOutput.isExternal(AudioDeviceInfo.TYPE_BUILTIN_EARPIECE))
        assertFalse(RingbackOutput.isExternal(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER))
        val connected = listOf(
            AudioDeviceInfo.TYPE_WIRED_HEADSET,
            AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
            AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
            AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
            AudioDeviceInfo.TYPE_BLE_HEADSET,
            AudioDeviceInfo.TYPE_USB_HEADSET,
            AudioDeviceInfo.TYPE_HEARING_AID,
        )
        for (type in connected) {
            assertTrue("type $type", RingbackOutput.isExternal(type))
        }
        // Outputs some phones list at all times keep the loudspeaker.
        for (type in listOf(AudioDeviceInfo.TYPE_TELEPHONY, AudioDeviceInfo.TYPE_BUS, AudioDeviceInfo.TYPE_IP, AudioDeviceInfo.TYPE_REMOTE_SUBMIX)) {
            assertFalse("type $type", RingbackOutput.isExternal(type))
        }
    }

    @Test
    fun `a proximity reading is near only close to the glass`() {
        // Binary sensors: 0 near, their maximum range far.
        assertTrue(isNear(0f, 1f))
        assertFalse(isNear(1f, 1f))
        assertTrue(isNear(0f, 5f))
        assertFalse(isNear(5f, 5f))
        // Centimetre sensors.
        assertTrue(isNear(3f, 10f))
        assertFalse(isNear(8f, 10f))
    }

    // MARK: - One end signal (owner, 2026-11-05: "two end screens")

    @Test
    fun `a ring cancelled under its screen ends silently, for the missed call to say`() = runTest(dispatcher) {
        val api = TeamApi(created = serverCall(TeamCallState.RINGING, role = TeamCallRole.CALLEE))
        val call = session(api)
        call.ringing()
        runCurrent()

        nudges.tryEmit(TeamCallNudge.RingStopped(CALL, TeamCallCancel.Reason.CANCELLED))
        runCurrent()

        val end = call.phase.value as TeamCallPhase.Ended
        assertEquals(TeamCallEnd.CANCELLED, end.end)
        assertTrue(end.silent)
        assertEquals(0L, end.closesAfterMs)
    }

    @Test
    fun `a ring missed under its screen ends silently`() = runTest(dispatcher) {
        val api = TeamApi(created = serverCall(TeamCallState.RINGING, role = TeamCallRole.CALLEE))
        val call = session(api)
        call.ringing()
        runCurrent()

        api.reads += serverCall(TeamCallState.MISSED, role = TeamCallRole.CALLEE, outcome = TeamCallOutcome.MISSED)
        poll()

        val end = call.phase.value as TeamCallPhase.Ended
        assertEquals(TeamCallEnd.MISSED, end.end)
        assertTrue(end.silent)
    }

    @Test
    fun `a ring that runs out with no word from the server ends silently as missed`() = runTest(dispatcher) {
        val api = TeamApi(created = serverCall(TeamCallState.RINGING, role = TeamCallRole.CALLEE))
        val call = session(api)
        call.ringing()
        runCurrent()

        now = START.plusSeconds(61)
        poll()

        val end = call.phase.value as TeamCallPhase.Ended
        assertEquals(TeamCallEnd.MISSED, end.end)
        assertTrue(end.silent)
    }

    @Test
    fun `declined from the notification with its screen open, the screen closes at once`() = runTest(dispatcher) {
        val api = TeamApi(created = serverCall(TeamCallState.RINGING, role = TeamCallRole.CALLEE))
        val call = session(api)
        call.ringing()
        runCurrent()

        nudges.tryEmit(TeamCallNudge.DeclinedHere(CALL))
        runCurrent()

        assertEquals(0L, call.phase.value.closesAfterMs)
    }

    @Test
    fun `what only the screen can say stays a moment, then closes on its own`() = runTest(dispatcher) {
        val api = TeamApi(created = serverCall(TeamCallState.RINGING, role = TeamCallRole.CALLEE))
        val call = session(api)
        call.ringing()
        runCurrent()

        api.reads += serverCall(TeamCallState.CONNECTING, role = TeamCallRole.CALLEE, answeredDeviceId = "ios-1")
        poll()

        val end = call.phase.value as TeamCallPhase.Ended
        assertEquals(TeamCallEnd.ANSWERED_ELSEWHERE, end.end)
        assertFalse(end.silent)
        assertEquals(TeamCallPhase.ENDED_LINGER_MS, end.closesAfterMs)
        assertEquals(2_000L, TeamCallPhase.ENDED_LINGER_MS)
    }

    @Test
    fun `an answered call that ends is said, then closes on its own, on either side`() = runTest(dispatcher) {
        val api = TeamApi(created = serverCall(TeamCallState.RINGING, role = TeamCallRole.CALLEE))
        val call = session(api)
        call.ringing()
        runCurrent()
        call.answer()
        runCurrent()
        assertNull(call.phase.value.closesAfterMs)

        call.hangUp()
        runCurrent()
        val end = call.phase.value as TeamCallPhase.Ended
        assertEquals(TeamCallEnd.HUNG_UP, end.end)
        assertFalse("hung up after the answer: not a ring", end.silent)
        assertEquals(TeamCallPhase.ENDED_LINGER_MS, end.closesAfterMs)

        // The caller's own cancel: a call placed here is never silent.
        val placed = session(TeamApi(created = serverCall(TeamCallState.RINGING)))
        placed.placing()
        runCurrent()
        placed.hangUp()
        runCurrent()
        assertFalse((placed.phase.value as TeamCallPhase.Ended).silent)
    }

    @Test
    fun `which unanswered ends close the ring screen at once`() {
        val atOnce = TeamCallEnd.entries.filter { TeamCallEnd.closesRingAtOnce(it) }.toSet()
        assertEquals(setOf(TeamCallEnd.CANCELLED, TeamCallEnd.MISSED, TeamCallEnd.HUNG_UP), atOnce)
    }

    /** The member's own channel says the call moved: it is read at once, not at the next tick. */
    @Test
    fun `word that the call moved is read at once`() = runTest(dispatcher) {
        val api = TeamApi(created = serverCall(TeamCallState.RINGING, role = TeamCallRole.CALLEE))
        val call = session(api)
        call.ringing()
        runCurrent()
        val before = api.readCount

        api.reads += serverCall(TeamCallState.CANCELLED, role = TeamCallRole.CALLEE, outcome = TeamCallOutcome.CANCELLED)
        nudges.tryEmit(TeamCallNudge.Changed(CALL))
        runCurrent()

        assertEquals(before + 1, api.readCount)
        assertEquals(TeamCallEnd.CANCELLED, ended(call))
    }

    @Test
    fun `End on the ongoing call's notification hangs up`() = runTest(dispatcher) {
        val api = TeamApi(created = serverCall(TeamCallState.RINGING, role = TeamCallRole.CALLEE))
        val call = session(api)
        room.remote = true
        call.ringing()
        runCurrent()
        call.answer()
        runCurrent()
        assertTrue(call.phase.value is TeamCallPhase.Live)

        nudges.tryEmit(TeamCallNudge.HangUp(CALL))
        runCurrent()

        assertEquals(TeamCallEnd.HUNG_UP, ended(call))
        assertEquals(listOf(CALL), api.hungUp)
    }

    // MARK: - Controls

    /** A phone with one camera, or one that would not move: the picture keeps the mirror it has. */
    @Test
    fun `the lens shown follows the camera the room says is in use`() = runTest(dispatcher) {
        val api = TeamApi(created = serverCall(TeamCallState.RINGING, role = TeamCallRole.CALLEE, channel = CallChannel.VIDEO))
        val call = session(api)
        room.remote = true
        call.ringing(CallChannel.VIDEO)
        runCurrent()
        call.answer()
        runCurrent()
        assertTrue(call.frontCamera.value)

        room.lensMoves = false
        call.switchCamera()
        runCurrent()
        assertTrue(call.frontCamera.value)

        room.lensMoves = true
        call.switchCamera()
        runCurrent()
        assertFalse(call.frontCamera.value)

        call.hangUp()
        runCurrent()
    }

    // MARK: - What the server's answers mean

    @Test
    fun `every state the server reports reads as the doc says, from each side`() {
        fun end(state: TeamCallState, role: TeamCallRole, outcome: TeamCallOutcome? = null, device: String? = null) =
            TeamCallEnd.resolve(serverCall(state, role, outcome, answeredDeviceId = device), DEVICE)

        assertNull(end(TeamCallState.RINGING, TeamCallRole.CALLER))
        assertNull(end(TeamCallState.RINGING, TeamCallRole.CALLEE))
        assertNull(end(TeamCallState.CONNECTING, TeamCallRole.CALLER, device = "ios-1"))
        assertNull(end(TeamCallState.ACTIVE, TeamCallRole.CALLEE, device = DEVICE))
        assertEquals(TeamCallEnd.ANSWERED_ELSEWHERE, end(TeamCallState.CONNECTING, TeamCallRole.CALLEE, device = "ios-1"))
        assertEquals(TeamCallEnd.NO_ANSWER, end(TeamCallState.MISSED, TeamCallRole.CALLER))
        assertEquals(TeamCallEnd.MISSED, end(TeamCallState.MISSED, TeamCallRole.CALLEE))
        assertEquals(TeamCallEnd.CANCELLED, end(TeamCallState.CANCELLED, TeamCallRole.CALLEE))
        assertEquals(TeamCallEnd.DECLINED, end(TeamCallState.ENDED, TeamCallRole.CALLER, TeamCallOutcome.DECLINED))
        assertEquals(TeamCallEnd.DECLINED_ELSEWHERE, end(TeamCallState.ENDED, TeamCallRole.CALLEE, TeamCallOutcome.DECLINED))
        assertEquals(TeamCallEnd.REMOTE_ENDED, end(TeamCallState.ENDED, TeamCallRole.CALLER, TeamCallOutcome.COMPLETED))
        assertEquals(TeamCallEnd.REMOTE_ENDED, end(TeamCallState.ENDED, TeamCallRole.CALLEE))
        assertEquals(TeamCallEnd.FAILED, end(TeamCallState.ENDED, TeamCallRole.CALLER, TeamCallOutcome.FAILED))
    }

    /** The doc's `TeamCall`, read with the client's own settings; what this build does not know reads as over. */
    @Test
    fun `a TeamCall is read as the doc spells it`() {
        val json = Json { ignoreUnknownKeys = true; explicitNulls = false; coerceInputValues = true }
        val body = """
            {"call":{"id":"9d6c1f0e-5a43-4c51-9b55-1a1b2c3d4e5f","workspace_id":"ws-1","channel":"video",
             "state":"connecting","outcome":null,"role":"callee",
             "peer":{"user_id":"u-2","name":"Daniel Carter","avatar_url":null},
             "answered_device_id":"android-device","created_at":"2026-11-01T10:00:00.123456+00:00",
             "answered_at":"2026-11-01T10:00:05Z","ended_at":null,"expires_at":"2026-11-01T10:00:45.000Z"}}
        """.trimIndent()
        val call = json.decodeFromString(TeamCallResponse.serializer(), body).call

        assertEquals(CallChannel.VIDEO, call.channel)
        assertEquals(TeamCallState.CONNECTING, call.state)
        assertNull(call.outcome)
        assertEquals(TeamCallRole.CALLEE, call.role)
        assertEquals("Daniel Carter", call.peer.name)
        assertEquals("android-device", call.answeredDeviceId)
        assertEquals(Instant.parse("2026-11-01T10:00:45Z"), call.expiresAt)

        val unknown = json.decodeFromString(
            TeamCallResponse.serializer(),
            body.replace("\"connecting\"", "\"on_hold\"").replace("\"video\"", "\"hologram\""),
        ).call
        assertEquals(TeamCallState.ENDED, unknown.state)
        assertEquals(CallChannel.AUDIO, unknown.channel)
    }

    /** `team_calls`, the Voice & Video module and the call's own channel, each exactly true. */
    @Test
    fun `a colleague call is offered only when the plan has all of it`() {
        fun plan(teamCalls: Boolean = true, module: Boolean = true, voice: Boolean = true, video: Boolean = false) = Entitlements(
            features = mapOf("team_calls" to EffectiveBool(teamCalls)),
            modules = mapOf("voice_video" to EffectiveBool(module)),
            channels = mapOf("voice" to EffectiveBool(voice), "video" to EffectiveBool(video)),
        )
        assertTrue(plan().allowsTeamCall(CallChannel.AUDIO))
        assertFalse(plan().allowsTeamCall(CallChannel.VIDEO))
        assertTrue(plan(video = true).allowsTeamCall(CallChannel.VIDEO))
        assertFalse(plan(teamCalls = false).allowsTeamCall(CallChannel.AUDIO))
        assertFalse(plan(module = false).allowsTeamCall(CallChannel.AUDIO))
        assertFalse(plan(voice = false).allowsTeamCall(CallChannel.AUDIO))
        assertFalse(Entitlements().allowsTeamCall(CallChannel.AUDIO))
    }

    private companion object {
        const val CALL = "9d6c1f0e-5a43-4c51-9b55-1a1b2c3d4e5f"
        const val DEVICE = "android-device"
        val START: Instant = Instant.parse("2026-11-01T10:00:00Z")
    }
}
