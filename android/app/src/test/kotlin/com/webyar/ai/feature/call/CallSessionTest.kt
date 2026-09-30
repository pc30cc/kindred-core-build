package com.webyar.ai.feature.call

import com.webyar.ai.core.model.CallChannel
import com.webyar.ai.core.model.CallInvitation
import com.webyar.ai.core.model.CallToken
import com.webyar.ai.core.net.ApiError
import com.webyar.ai.core.net.SampleApi
import com.webyar.ai.core.net.WebyarApi
import com.webyar.ai.i18n.Language
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
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
 * What a call does before any media is involved.
 *
 * All of it: the waiting, the four ways it can end, and what happens when a
 * microphone or a camera refuses to start. None of these need WebRTC — which
 * is the whole reason [CallRoom] is an interface, because WebRTC's native
 * libraries cannot load on a JVM and a session that named them would be one
 * no test could construct.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class CallSessionTest {

    private val dispatcher = StandardTestDispatcher()

    @Before fun setUp() = Dispatchers.setMain(dispatcher)
    @After fun tearDown() = Dispatchers.resetMain()

    // MARK: - Doubles

    /** A room that joins with whatever was asked of it, and says so. */
    private class FakeRoom(
        private val result: CallRoom.Result =
            CallRoom.Result.Joined(microphone = true, camera = true),
    ) : CallRoom {
        val emitted = MutableSharedFlow<CallRoom.Event>(extraBufferCapacity = 8)
        override val events: Flow<CallRoom.Event> = emitted.asSharedFlow()

        var connected = false; private set
        var disconnected = false; private set
        var released = false; private set
        var micEnabled: Boolean? = null; private set
        var cameraEnabled: Boolean? = null; private set
        var speaker: Boolean? = null; private set

        override suspend fun connect(
            url: String,
            credentials: CallToken,
            wantsVideo: Boolean,
        ): CallRoom.Result {
            connected = true
            return result
        }

        override suspend fun setMicrophone(enabled: Boolean): Boolean { micEnabled = enabled; return true }
        override suspend fun setCamera(enabled: Boolean): Boolean { cameraEnabled = enabled; return true }
        override fun setSpeaker(on: Boolean) { speaker = on }
        override suspend fun disconnect() { disconnected = true }
        override fun release() { released = true }
    }

    /**
     * The sample backend, with the invitation answered by a script.
     *
     * A list rather than a single value, because the whole point of the wait
     * is that the answer CHANGES — the first poll says pending and a later
     * one says joined, and a session that only ever saw one answer would
     * never be seen to wait at all.
     */
    private class ScriptedApi(
        private val answers: List<CallInvitation>,
        private val token: CallToken? = SAMPLE_TOKEN,
        private val inviteFailure: Throwable? = null,
        /** How long the room's token takes to arrive. */
        private val tokenMillis: Long = 0,
        private val real: SampleApi = SampleApi(),
    ) : WebyarApi by real {
        var polls = 0; private set
        var invites = 0; private set
        var hungUp: String? = null; private set
        var cancelled: String? = null; private set

        /** Counted, because one call must mean exactly one invitation. */
        override suspend fun inviteToCall(
            workspaceId: String,
            conversationId: String,
            channel: CallChannel,
        ): CallInvitation {
            invites++
            inviteFailure?.let { throw it }
            return CallInvitation(
                id = "inv-1",
                status = "pending",
                channel = channel.wire,
                conversationId = conversationId,
            )
        }

        /**
         * Runs out into `expired`, which is not padding.
         *
         * The wait loops until the invitation reaches a terminal state, and a
         * fake that answered "pending" for ever would loop for ever too —
         * `runTest` drains the scheduler at the end of every test, so that is
         * a hung suite rather than a failing one. An invitation really does
         * expire; letting the script end that way is both honest and the
         * thing that makes these tests terminate.
         */
        override suspend fun invitation(id: String): CallInvitation {
            val answer = answers.getOrNull(polls) ?: EXPIRED
            polls++
            return answer
        }

        override suspend fun callToken(callSessionId: String, displayName: String?): CallToken {
            if (tokenMillis > 0) delay(tokenMillis)
            return token ?: throw IllegalStateException("no token")
        }

        override suspend fun hangUp(callSessionId: String) { hungUp = callSessionId }

        override suspend fun cancelInvitation(id: String) { cancelled = id }
    }

    private fun invitation(status: String, sessionId: String? = null) = CallInvitation(
        id = "inv-1",
        status = status,
        channel = "audio",
        conversationId = "c-1",
        callSessionId = sessionId,
    )

    private fun session(api: WebyarApi, room: CallRoom) = CallSession(api, room)

    /** A session held by [store], as a screen's is, so clearing the store is the screen going. */
    private fun owned(store: ViewModelStore, api: WebyarApi, room: CallRoom): CallSession =
        ViewModelProvider(
            store,
            object : ViewModelProvider.Factory {
                @Suppress("UNCHECKED_CAST")
                override fun <T : ViewModel> create(modelClass: Class<T>): T = session(api, room) as T
            },
        )[CallSession::class.java]

    private fun CallSession.dial(channel: CallChannel = CallChannel.AUDIO) = start(
        workspaceId = "ws-1",
        conversationId = "c-1",
        channel = channel,
        language = Language.FA,
    )

    // MARK: - Inviting

    /**
     * The screen asks for a call; it does not place one.
     *
     * It can ask more than once — a recomposition, the permission answer
     * landing, the workspace arriving — and a second invitation would go on
     * ringing the visitor's widget until it expired, so an operator could be
     * told a call had failed while the visitor's screen was still ringing.
     */
    @Test
    fun `however many times it is asked, one call is one invitation`() = runTest(dispatcher) {
        val api = ScriptedApi(listOf(invitation("pending")))
        val call = session(api, FakeRoom())

        call.dial()
        call.dial()
        call.dial()
        testScheduler.advanceUntilIdle()

        assertEquals(1, api.invites)
    }

    /**
     * A 403 that says `not_a_workspace_member`, shown as "the call could not
     * connect", sends an operator to check their signal. Whatever the server
     * says reaches the phase, and the screen has a line for it.
     */
    @Test
    fun `an invitation the server refuses ends the call with what it said`() =
        runTest(dispatcher) {
            val api = ScriptedApi(
                answers = emptyList(),
                inviteFailure = ApiError.Server(status = 403, serverMessage = "not_a_workspace_member"),
            )
            val call = session(api, FakeRoom())
            call.dial()
            testScheduler.advanceUntilIdle()

            val outcome = (call.phase.value as CallPhase.Ended).outcome
            assertTrue(outcome is CallOutcome.Failed)
            assertTrue((outcome as CallOutcome.Failed).reason.isNotBlank())
            // Nothing was ever invited, so there is nothing to wait for.
            assertEquals(0, api.polls)
        }

    /** A call that was never invited has nothing to poll for. */
    @Test
    fun `a refused invitation does not leave a poll running`() = runTest(dispatcher) {
        val api = ScriptedApi(
            answers = emptyList(),
            inviteFailure = ApiError.Transport(),
        )
        val call = session(api, FakeRoom())
        call.dial()
        testScheduler.advanceUntilIdle()

        assertFalse(call.phase.value.isLive)
        assertEquals(0, api.polls)
    }

    // MARK: - Waiting

    @Test
    fun `a call begins waiting`() = runTest(dispatcher) {
        val call = session(ScriptedApi(listOf(invitation("pending"))), FakeRoom())
        call.dial()

        assertEquals(CallPhase.Waiting, call.phase.value)
    }

    @Test
    fun `a declined invitation ends the call as declined, not as failed`() = runTest(dispatcher) {
        val call = session(ScriptedApi(listOf(invitation("declined"))), FakeRoom())
        call.dial()
        testScheduler.advanceUntilIdle()

        assertEquals(CallPhase.Ended(CallOutcome.Declined), call.phase.value)
    }

    /** "They said no" and "nobody picked up" are not the same evening. */
    @Test
    fun `an expired invitation ends as no answer`() = runTest(dispatcher) {
        val call = session(ScriptedApi(listOf(invitation("expired"))), FakeRoom())
        call.dial()
        testScheduler.advanceUntilIdle()

        assertEquals(CallPhase.Ended(CallOutcome.Expired), call.phase.value)
    }

    @Test
    fun `a cancelled invitation ends the wait too`() = runTest(dispatcher) {
        val call = session(ScriptedApi(listOf(invitation("cancelled"))), FakeRoom())
        call.dial()
        testScheduler.advanceUntilIdle()

        assertFalse(call.phase.value.isLive)
    }

    /**
     * The wait is a poll, so it has to survive an answer that has not changed
     * yet — which is what almost every poll of it will be.
     */
    @Test
    fun `it keeps waiting until the visitor answers, then joins`() = runTest(dispatcher) {
        val api = ScriptedApi(
            listOf(
                invitation("pending"),
                invitation("pending"),
                invitation("joined", sessionId = "cs-1"),
            )
        )
        val room = FakeRoom()
        val call = session(api, room)
        call.dial()

        testScheduler.advanceTimeBy(1)
        assertEquals(CallPhase.Waiting, call.phase.value)

        testScheduler.advanceUntilIdle()
        assertEquals(CallPhase.Connected, call.phase.value)
        assertTrue(room.connected)
        assertEquals(3, api.polls)
    }

    @Test
    fun `the timer starts when the two sides connect, not when the invitation went out`() =
        runTest(dispatcher) {
            val call = session(
                ScriptedApi(listOf(invitation("joined", sessionId = "cs-1"))),
                FakeRoom(),
            )
            call.dial()
            assertNull(call.connectedAt.value)

            testScheduler.advanceUntilIdle()
            assertNotNull(call.connectedAt.value)
        }

    // MARK: - Joining

    @Test
    fun `no server url is a failure with a reason, not a silent hang`() = runTest(dispatcher) {
        val api = ScriptedApi(
            answers = listOf(invitation("joined", sessionId = "cs-1")),
            token = CallToken(token = "t", wsUrl = null, rtcUrl = null),
        )
        val call = session(api, FakeRoom())
        call.dial()
        testScheduler.advanceUntilIdle()

        assertEquals(CallPhase.Ended(CallOutcome.Failed("no_server_url")), call.phase.value)
    }

    @Test
    fun `a server warning about TURN is surfaced without ending the call`() = runTest(dispatcher) {
        val api = ScriptedApi(
            answers = listOf(invitation("joined", sessionId = "cs-1")),
            token = SAMPLE_TOKEN.copy(warnings = listOf("turn_missing")),
        )
        val call = session(api, FakeRoom())
        call.dial()
        testScheduler.advanceUntilIdle()

        assertTrue(call.relayWarning.value)
        assertEquals(CallPhase.Connected, call.phase.value)
    }

    /**
     * The one that matters most.
     *
     * A camera that will not start is a reason to carry on without video, not
     * a reason to drop a call the visitor has already answered. Without this
     * rule, one throw here would take the whole call down.
     */
    @Test
    fun `a refused camera degrades the call instead of ending it`() = runTest(dispatcher) {
        val room = FakeRoom(CallRoom.Result.Joined(microphone = true, camera = false))
        val call = session(ScriptedApi(listOf(invitation("joined", sessionId = "cs-1"))), room)
        call.dial(CallChannel.VIDEO)
        testScheduler.advanceUntilIdle()

        assertEquals(CallPhase.Connected, call.phase.value)
        assertEquals(CallDegradation.NO_CAMERA, call.degraded.value)
        assertFalse(call.cameraOn.value)
    }

    @Test
    fun `a refused microphone says so and mutes, rather than pretending`() = runTest(dispatcher) {
        val room = FakeRoom(CallRoom.Result.Joined(microphone = false, camera = false))
        val call = session(ScriptedApi(listOf(invitation("joined", sessionId = "cs-1"))), room)
        call.dial()
        testScheduler.advanceUntilIdle()

        assertEquals(CallPhase.Connected, call.phase.value)
        assertEquals(CallDegradation.NO_MICROPHONE, call.degraded.value)
        assertTrue(call.muted.value)
    }

    /** The microphone is the worse loss, so it is the one named. */
    @Test
    fun `losing both reports the microphone`() = runTest(dispatcher) {
        val room = FakeRoom(CallRoom.Result.Joined(microphone = false, camera = false))
        val call = session(ScriptedApi(listOf(invitation("joined", sessionId = "cs-1"))), room)
        call.dial(CallChannel.VIDEO)
        testScheduler.advanceUntilIdle()

        assertEquals(CallDegradation.NO_MICROPHONE, call.degraded.value)
    }

    @Test
    fun `a room that will not be joined ends the call with its reason`() = runTest(dispatcher) {
        val room = FakeRoom(CallRoom.Result.Failed("ice"))
        val call = session(ScriptedApi(listOf(invitation("joined", sessionId = "cs-1"))), room)
        call.dial()
        testScheduler.advanceUntilIdle()

        assertEquals(CallPhase.Ended(CallOutcome.Failed("ice")), call.phase.value)
    }

    // MARK: - While connected

    @Test
    fun `the visitor leaving ends the call`() = runTest(dispatcher) {
        val room = FakeRoom()
        val call = session(ScriptedApi(listOf(invitation("joined", sessionId = "cs-1"))), room)
        call.dial()
        testScheduler.advanceUntilIdle()

        room.emitted.emit(CallRoom.Event.VisitorPresenceChanged(present = false))
        testScheduler.advanceUntilIdle()

        assertEquals(CallPhase.Ended(CallOutcome.VisitorLeft), call.phase.value)
    }

    @Test
    fun `hanging up tells the room and then the server`() = runTest(dispatcher) {
        val room = FakeRoom()
        val api = ScriptedApi(listOf(invitation("joined", sessionId = "cs-1")))
        val call = session(api, room)
        call.dial()
        testScheduler.advanceUntilIdle()

        call.hangUp()
        testScheduler.advanceUntilIdle()

        assertEquals(CallPhase.Ended(CallOutcome.HungUp), call.phase.value)
        assertTrue(room.disconnected)
        assertEquals("cs-1", api.hungUp)
    }

    /**
     * Giving up on a call nobody answered has to reach the server too.
     *
     * There is no session to end — only an offer to withdraw, and leaving it
     * standing is not harmless: an invitation lives five minutes, so a
     * visitor whose widget the operator has already walked away from goes on
     * being rung by it.
     */
    @Test
    fun `ending a call nobody answered withdraws the offer`() = runTest(dispatcher) {
        val api = ScriptedApi(listOf(invitation("pending")))
        val call = session(api, FakeRoom())
        call.dial()
        testScheduler.advanceTimeBy(1)

        call.hangUp()
        testScheduler.advanceUntilIdle()

        assertEquals(CallPhase.Ended(CallOutcome.HungUp), call.phase.value)
        assertEquals("inv-1", api.cancelled)
        // No session was ever created, so there is nothing to hang up.
        assertNull(api.hungUp)
    }

    /** An answered call ends as a call, not as a withdrawn offer. */
    @Test
    fun `hanging up a connected call does not also withdraw the invitation`() =
        runTest(dispatcher) {
            val api = ScriptedApi(listOf(invitation("joined", sessionId = "cs-1")))
            val call = session(api, FakeRoom())
            call.dial()
            testScheduler.advanceUntilIdle()

            call.hangUp()
            testScheduler.advanceUntilIdle()

            assertEquals("cs-1", api.hungUp)
            assertNull(api.cancelled)
        }

    /**
     * A second hang-up must not rewrite how the call ended. The operator
     * tapping twice on a slow phone is the ordinary way this happens.
     */
    @Test
    fun `hanging up twice keeps the first outcome`() = runTest(dispatcher) {
        val room = FakeRoom()
        val call = session(ScriptedApi(listOf(invitation("joined", sessionId = "cs-1"))), room)
        call.dial()
        testScheduler.advanceUntilIdle()

        room.emitted.emit(CallRoom.Event.VisitorPresenceChanged(present = false))
        testScheduler.advanceUntilIdle()
        call.hangUp()
        testScheduler.advanceUntilIdle()

        assertEquals(CallPhase.Ended(CallOutcome.VisitorLeft), call.phase.value)
    }

    /**
     * The visitor answered and the room's token was on its way when the
     * operator gave up. The call must stay ended — not be joined anyway, the
     * phase going back from "call ended" to connected with the microphone
     * live.
     */
    @Test
    fun `hanging up while the call connects never joins the room afterwards`() = runTest(dispatcher) {
        val room = FakeRoom()
        val api = ScriptedApi(listOf(invitation("joined", sessionId = "cs-1")), tokenMillis = 1_000)
        val call = session(api, room)
        call.dial()
        testScheduler.advanceTimeBy(1)
        assertEquals(CallPhase.Connecting, call.phase.value)

        call.hangUp()
        testScheduler.advanceUntilIdle()

        assertEquals(CallPhase.Ended(CallOutcome.HungUp), call.phase.value)
        assertFalse(room.connected)
        assertEquals("cs-1", api.hungUp)
    }

    /**
     * The red button becomes Done in the same place, so a hang-up is often
     * followed at once by the screen closing. The hang-up still reaches the
     * server rather than being cancelled with the screen.
     */
    @Test
    fun `closing the screen straight after hanging up still tells the server`() = runTest(dispatcher) {
        val room = FakeRoom()
        val api = ScriptedApi(listOf(invitation("joined", sessionId = "cs-1")))
        val store = ViewModelStore()
        val call = owned(store, api, room)
        call.dial()
        testScheduler.advanceUntilIdle()

        call.hangUp()
        store.clear()
        testScheduler.advanceUntilIdle()

        assertEquals("cs-1", api.hungUp)
        assertTrue(room.released)
    }

    /** Back, with the call still on, is a hang-up — not a room quietly left. */
    @Test
    fun `leaving the screen mid-call hangs up`() = runTest(dispatcher) {
        val room = FakeRoom()
        val api = ScriptedApi(listOf(invitation("joined", sessionId = "cs-1")))
        val store = ViewModelStore()
        val call = owned(store, api, room)
        call.dial()
        testScheduler.advanceUntilIdle()
        assertEquals(CallPhase.Connected, call.phase.value)

        store.clear()
        testScheduler.advanceUntilIdle()

        assertTrue(room.disconnected)
        assertTrue(room.released)
        assertEquals("cs-1", api.hungUp)
    }

    /** And leaving while it still rings the visitor withdraws the offer. */
    @Test
    fun `leaving the screen while it rings the visitor withdraws the offer`() = runTest(dispatcher) {
        val api = ScriptedApi(listOf(invitation("pending")))
        val store = ViewModelStore()
        owned(store, api, FakeRoom()).dial()
        testScheduler.advanceTimeBy(1)

        store.clear()
        testScheduler.advanceUntilIdle()

        assertEquals("inv-1", api.cancelled)
    }

    @Test
    fun `muting tells the room the opposite of the flag`() = runTest(dispatcher) {
        val room = FakeRoom()
        val call = session(ScriptedApi(listOf(invitation("joined", sessionId = "cs-1"))), room)
        call.dial()
        testScheduler.advanceUntilIdle()

        call.toggleMute()
        testScheduler.advanceUntilIdle()

        assertTrue(call.muted.value)
        // Muted means the microphone is OFF — getting this the wrong way round
        // is a call nobody can hear with a button that says it is fine.
        assertEquals(false, room.micEnabled)
    }

    /** A voice call has no camera to toggle, and the button is not drawn. */
    @Test
    fun `the camera cannot be turned on during a voice call`() = runTest(dispatcher) {
        val room = FakeRoom()
        val call = session(ScriptedApi(listOf(invitation("joined", sessionId = "cs-1"))), room)
        call.dial(CallChannel.AUDIO)
        testScheduler.advanceUntilIdle()

        call.toggleCamera()
        testScheduler.advanceUntilIdle()

        assertFalse(call.cameraOn.value)
        assertNull(room.cameraEnabled)
    }

    /** The operator is at a desk, not holding the phone to their ear. */
    @Test
    fun `a call starts on the loudspeaker`() = runTest(dispatcher) {
        val room = FakeRoom()
        val call = session(ScriptedApi(listOf(invitation("joined", sessionId = "cs-1"))), room)
        call.dial()
        testScheduler.advanceUntilIdle()

        assertTrue(call.speakerOn.value)
        assertEquals(true, room.speaker)

        call.toggleSpeaker()
        assertFalse(call.speakerOn.value)
        assertEquals(false, room.speaker)
    }

    private companion object {
        val SAMPLE_TOKEN = CallToken(token = "t", wsUrl = "wss://example.invalid")
        val EXPIRED = CallInvitation(id = "inv-1", status = "expired", channel = "audio")
    }
}
