package com.platform.app.feature.call

import android.content.pm.ServiceInfo
import android.os.Build
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import com.platform.app.core.model.CallChannel
import com.platform.app.core.model.CallInvitation
import com.platform.app.core.model.CallToken
import com.platform.app.core.net.ApiError
import com.platform.app.core.net.SampleApi
import com.platform.app.core.net.ServerApi
import com.platform.app.i18n.Language
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * A visitor call and a call-centre call run under the ongoing-call service
 * ([OngoingCallService]) from the dial or the answer to their end — on
 * every way they end — and its End ends them the way the red button does.
 * Before this, only colleague calls had one, and an operator who pressed
 * Home lost the microphone with the call still looking live on both sides.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class CallForegroundTest {

    private val dispatcher = StandardTestDispatcher()

    @Before fun setUp() = Dispatchers.setMain(dispatcher)
    @After fun tearDown() = Dispatchers.resetMain()

    // MARK: - Doubles

    private class Foreground : CallForeground {
        val shown = mutableListOf<OngoingCall>()
        var stops = 0; private set
        val up: Boolean get() = shown.isNotEmpty() && stops == 0
        override fun show(call: OngoingCall) { shown += call }
        override fun stop() { stops++ }
    }

    private class Room(
        private val result: CallRoom.Result = CallRoom.Result.Joined(microphone = true, camera = true),
    ) : CallRoom {
        val emitted = MutableSharedFlow<CallRoom.Event>(extraBufferCapacity = 8)
        override val events: Flow<CallRoom.Event> = emitted.asSharedFlow()
        override suspend fun connect(url: String, credentials: CallToken, wantsVideo: Boolean) = result
        override suspend fun setMicrophone(enabled: Boolean) = true
        override suspend fun setCamera(enabled: Boolean) = true
        override fun setSpeaker(on: Boolean) {}
        override suspend fun switchCamera(front: Boolean) = true
        override val hasRemoteParticipant = false
        override suspend fun disconnect() {}
        override fun release() {}
    }

    private class Api(
        private val answer: String = "joined",
        private val inviteFailure: Throwable? = null,
        private val tokenFailure: Throwable? = null,
        private val acceptFailure: Throwable? = null,
        private val real: SampleApi = SampleApi(),
    ) : ServerApi by real {
        var hungUp: String? = null; private set
        val ended = mutableListOf<Pair<String, String>>()

        override suspend fun inviteToCall(workspaceId: String, conversationId: String, channel: CallChannel): CallInvitation {
            inviteFailure?.let { throw it }
            return CallInvitation(id = "inv-1", status = "pending", channel = channel.wire, conversationId = conversationId)
        }

        override suspend fun invitation(id: String) =
            CallInvitation(id = id, status = answer, channel = "audio", callSessionId = "cs-1")

        override suspend fun callToken(callSessionId: String, displayName: String?): CallToken {
            tokenFailure?.let { throw it }
            return CallToken(token = "t", wsUrl = "wss://example.invalid")
        }

        override suspend fun hangUp(callSessionId: String) { hungUp = callSessionId }
        override suspend fun cancelInvitation(id: String) {}
        override suspend fun acceptCenterCall(workspaceId: String, callSessionId: String) {
            acceptFailure?.let { throw it }
        }
        override suspend fun endCenterCall(workspaceId: String, callSessionId: String) {
            ended += workspaceId to callSessionId
        }
    }

    private val hangUps = MutableSharedFlow<String>(extraBufferCapacity = 8)

    private fun session(api: ServerApi, foreground: CallForeground, room: CallRoom = Room()) =
        CallSession(api, room, foreground, hangUps)

    private fun CallSession.dial(channel: CallChannel = CallChannel.AUDIO) =
        start(workspaceId = "ws-1", conversationId = "c-1", channel = channel, language = Language.FA)

    private fun CallSession.ringing(channel: CallChannel = CallChannel.AUDIO) =
        ring(workspaceId = "ws-1", callSessionId = "cs-9", channel = channel, language = Language.FA)

    // MARK: - The service's types

    @Test
    fun `a voice call holds the microphone, a video call the camera too`() {
        val q = Build.VERSION_CODES.Q
        val mic = ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        val camera = ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
        assertEquals(mic, OngoingCallTypes.of(q, video = false, microphoneGranted = true, cameraGranted = true))
        assertEquals(mic or camera, OngoingCallTypes.of(34, video = true, microphoneGranted = true, cameraGranted = true))
        // A refused camera leaves a voice-only service rather than none.
        assertEquals(mic, OngoingCallTypes.of(34, video = true, microphoneGranted = true, cameraGranted = false))
        assertEquals(camera, OngoingCallTypes.of(34, video = true, microphoneGranted = false, cameraGranted = true))
        // Nothing it may use: not a call's service at all.
        assertEquals(OngoingCallTypes.NONE, OngoingCallTypes.of(34, video = false, microphoneGranted = false, cameraGranted = true))
        // Before Android 10 a service names no type.
        assertEquals(0, OngoingCallTypes.of(Build.VERSION_CODES.P, video = true, microphoneGranted = true, cameraGranted = true))
    }

    // MARK: - Where End goes

    @Test
    fun `End goes where the call's own red button goes`() {
        assertEquals(OngoingCallEnd.Team("tc-1"), OngoingCallEnd.of(OngoingCallKind.TEAM, "tc-1", null, null))
        assertEquals(OngoingCallEnd.Visitor("cs-1"), OngoingCallEnd.of(OngoingCallKind.VISITOR, "call-x", "cs-1", null))
        assertEquals(OngoingCallEnd.Center("ws-1", "cs-1"), OngoingCallEnd.of(OngoingCallKind.CENTER, "call-x", "cs-1", "ws-1"))
        // Nothing the server could take: nothing is sent rather than the wrong request.
        assertNull(OngoingCallEnd.of(OngoingCallKind.VISITOR, "call-x", null, null))
        assertNull(OngoingCallEnd.of(OngoingCallKind.CENTER, "call-x", "cs-1", null))
        assertNull(OngoingCallEnd.of(OngoingCallKind.CENTER, "call-x", null, "ws-1"))
        OngoingCallKind.entries.forEach { assertEquals(it, OngoingCallKind.from(it.wire)) }
        assertNull(OngoingCallKind.from("other"))
    }

    // MARK: - A visitor call

    @Test
    fun `a visitor call runs under the service from the dial, then with its session and timer`() = runTest(dispatcher) {
        val fg = Foreground()
        val call = session(Api(answer = "pending"), fg)
        call.describe("Sara", avatarUrl = null)
        call.dial()

        val first = fg.shown.first()
        assertEquals(OngoingCallKind.VISITOR, first.kind)
        assertEquals(call.key, first.callId)
        assertEquals("Sara", first.peerName)
        assertNull(first.sessionId)
        assertFalse(first.video)
        call.hangUp()
        testScheduler.advanceUntilIdle()
        assertEquals(1, fg.stops)

        val joined = Foreground()
        val live = session(Api(), joined)
        live.dial()
        testScheduler.advanceUntilIdle()
        assertEquals(CallPhase.Connected, live.phase.value)
        val last = joined.shown.last()
        assertEquals("cs-1", last.sessionId)
        assertNotNull(last.since)
        assertTrue(joined.up)
    }

    @Test
    fun `the camera going off and on moves the service's camera with it`() = runTest(dispatcher) {
        val fg = Foreground()
        val call = session(Api(), fg)
        call.dial(CallChannel.VIDEO)
        testScheduler.advanceUntilIdle()
        assertTrue(fg.shown.last().video)

        call.toggleCamera()
        assertFalse(fg.shown.last().video)
        call.toggleCamera()
        assertTrue(fg.shown.last().video)
    }

    @Test
    fun `a camera that would not start leaves a voice-only service`() = runTest(dispatcher) {
        val fg = Foreground()
        val call = session(Api(), fg, Room(CallRoom.Result.Joined(microphone = true, camera = false)))
        call.dial(CallChannel.VIDEO)
        testScheduler.advanceUntilIdle()
        assertFalse(fg.shown.last().video)
    }

    /** Every way a visitor call ends takes its service and notification with it, once. */
    @Test
    fun `every end of a visitor call stops the service`() = runTest(dispatcher) {
        fun ends(name: String, api: Api, room: Room = Room(), end: (CallSession, Room) -> Unit = { _, _ -> }) {
            val fg = Foreground()
            val call = session(api, fg, room)
            call.dial()
            testScheduler.advanceUntilIdle()
            end(call, room)
            testScheduler.advanceUntilIdle()
            assertFalse("$name: ${call.phase.value}", call.phase.value.isLive)
            assertTrue("$name: shown", fg.shown.isNotEmpty())
            assertEquals("$name: stops", 1, fg.stops)
        }
        ends("hung up", Api()) { call, _ -> call.hangUp() }
        ends("visitor left", Api()) { _, room -> room.emitted.tryEmit(CallRoom.Event.VisitorPresenceChanged(present = false)) }
        ends("room lost", Api()) { _, room -> room.emitted.tryEmit(CallRoom.Event.Disconnected) }
        ends("declined", Api(answer = "declined"))
        ends("expired", Api(answer = "expired"))
        ends("invitation refused", Api(inviteFailure = ApiError.Server(status = 403, serverMessage = "no")))
        ends("no token", Api(tokenFailure = ApiError.Transport()))
        ends("join failed", Api(), Room(CallRoom.Result.Failed("ice")))
    }

    /** Back, a sign-out, a workspace switch: the screen's store is cleared. */
    @Test
    fun `the call screen going stops the service`() = runTest(dispatcher) {
        val fg = Foreground()
        val api = Api()
        val store = ViewModelStore()
        val call = ViewModelProvider(
            store,
            object : ViewModelProvider.Factory {
                @Suppress("UNCHECKED_CAST")
                override fun <T : ViewModel> create(modelClass: Class<T>): T = session(api, fg) as T
            },
        )[CallSession::class.java]
        call.dial()
        testScheduler.advanceUntilIdle()
        assertTrue(fg.up)

        store.clear()
        testScheduler.advanceUntilIdle()

        assertEquals(1, fg.stops)
        assertEquals("cs-1", api.hungUp)
    }

    @Test
    fun `End on the notification hangs up the call it is for, and tells the server`() = runTest(dispatcher) {
        val fg = Foreground()
        val api = Api()
        val call = session(api, fg)
        call.dial()
        testScheduler.advanceUntilIdle()

        hangUps.emit("call-somebody-else")
        testScheduler.advanceUntilIdle()
        assertEquals(CallPhase.Connected, call.phase.value)

        hangUps.emit(call.key)
        testScheduler.advanceUntilIdle()
        assertEquals(CallPhase.Ended(CallOutcome.HungUp), call.phase.value)
        assertEquals("cs-1", api.hungUp)
        assertEquals(1, fg.stops)
    }

    // MARK: - A call-centre call

    @Test
    fun `a ring shows no ongoing call, and declining it leaves nothing behind`() = runTest(dispatcher) {
        val fg = Foreground()
        val call = session(Api(), fg)
        call.ringing()
        testScheduler.advanceUntilIdle()
        assertTrue(fg.shown.isEmpty())

        call.decline()
        testScheduler.advanceUntilIdle()
        assertTrue(fg.shown.isEmpty())
        assertEquals(0, fg.stops)
    }

    @Test
    fun `an answered call-centre call runs under the service, and End ends it through the call centre`() = runTest(dispatcher) {
        val fg = Foreground()
        val api = Api()
        val call = session(api, fg)
        call.ringing(CallChannel.VIDEO)
        call.answer()
        // From Answer, with the app still in front.
        assertEquals(OngoingCallKind.CENTER, fg.shown.first().kind)
        testScheduler.advanceUntilIdle()

        val live = fg.shown.last()
        assertEquals("ws-1", live.workspaceId)
        assertEquals("cs-9", live.sessionId)
        assertTrue(live.video)
        assertEquals(OngoingCallEnd.Center("ws-1", "cs-9"), OngoingCallEnd.of(live.kind, live.callId, live.sessionId, live.workspaceId))

        hangUps.emit(call.key)
        testScheduler.advanceUntilIdle()
        assertEquals(listOf("ws-1" to "cs-9"), api.ended)
        assertNull(api.hungUp)
        assertEquals(1, fg.stops)
    }

    @Test
    fun `a call-centre call taken by somebody else stops the service`() = runTest(dispatcher) {
        val fg = Foreground()
        val call = session(Api(acceptFailure = ApiError.Server(status = 409, serverMessage = "taken")), fg)
        call.ringing()
        call.answer()
        testScheduler.advanceUntilIdle()

        assertEquals(CallPhase.Ended(CallOutcome.NoLongerWaiting), call.phase.value)
        assertEquals(1, fg.stops)
    }
}
