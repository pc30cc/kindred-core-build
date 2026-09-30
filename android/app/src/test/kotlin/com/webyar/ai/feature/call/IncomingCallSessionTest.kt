package com.webyar.ai.feature.call

import com.webyar.ai.core.model.CallChannel
import com.webyar.ai.core.model.CallToken
import com.webyar.ai.core.net.ApiError
import com.webyar.ai.core.net.SampleApi
import com.webyar.ai.core.net.WebyarApi
import com.webyar.ai.i18n.Language
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * A call-centre call that rang this phone: ringing, answered, declined, or
 * gone before anybody picked up.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class IncomingCallSessionTest {

    private val dispatcher = StandardTestDispatcher()

    @Before fun setUp() = Dispatchers.setMain(dispatcher)
    @After fun tearDown() = Dispatchers.resetMain()

    private class Room : CallRoom {
        override val events: Flow<CallRoom.Event> = emptyFlow()
        var connected = false; private set
        override suspend fun connect(url: String, credentials: CallToken, wantsVideo: Boolean): CallRoom.Result {
            connected = true
            return CallRoom.Result.Joined(microphone = true, camera = true)
        }
        override suspend fun setMicrophone(enabled: Boolean) = true
        override suspend fun setCamera(enabled: Boolean) = true
        override fun setSpeaker(on: Boolean) {}
        override suspend fun disconnect() {}
        override fun release() {}
    }

    private class CenterApi(
        private val acceptFailure: Throwable? = null,
        /** How long the call centre takes to answer the accept. */
        private val acceptMillis: Long = 0,
        private val real: SampleApi = SampleApi(),
    ) : WebyarApi by real {
        val accepted = mutableListOf<Pair<String, String>>()
        val ended = mutableListOf<Pair<String, String>>()
        var hungUp: String? = null; private set

        override suspend fun acceptCenterCall(workspaceId: String, callSessionId: String) {
            accepted += workspaceId to callSessionId
            if (acceptMillis > 0) delay(acceptMillis)
            acceptFailure?.let { throw it }
        }

        override suspend fun endCenterCall(workspaceId: String, callSessionId: String) {
            ended += workspaceId to callSessionId
        }

        override suspend fun hangUp(callSessionId: String) { hungUp = callSessionId }

        override suspend fun callToken(callSessionId: String, displayName: String?): CallToken =
            CallToken(token = "t", wsUrl = "wss://example.invalid")
    }

    private fun CallSession.ringing(channel: CallChannel = CallChannel.AUDIO) = ring(
        workspaceId = "ws-1",
        callSessionId = "call-1",
        channel = channel,
        language = Language.FA,
    )

    @Test
    fun `a ring asks nothing of the server until it is answered`() = runTest(dispatcher) {
        val api = CenterApi()
        val call = CallSession(api, Room())

        call.ringing()
        testScheduler.advanceUntilIdle()

        assertEquals(CallPhase.Ringing, call.phase.value)
        assertTrue(api.accepted.isEmpty())
    }

    @Test
    fun `answering takes the call through the call centre, then joins its room`() = runTest(dispatcher) {
        val api = CenterApi()
        val room = Room()
        val call = CallSession(api, room)

        call.ringing()
        call.answer()
        call.answer() // A second press is not a second accept.
        testScheduler.advanceUntilIdle()

        assertEquals(listOf("ws-1" to "call-1"), api.accepted)
        assertTrue(room.connected)
        assertEquals(CallPhase.Connected, call.phase.value)
    }

    @Test
    fun `hanging up an answered call ends it through the call centre`() = runTest(dispatcher) {
        val api = CenterApi()
        val call = CallSession(api, Room())
        call.ringing()
        call.answer()
        testScheduler.advanceUntilIdle()

        call.hangUp()
        testScheduler.advanceUntilIdle()

        assertEquals(listOf("ws-1" to "call-1"), api.ended)
        assertNull(api.hungUp)
    }

    /**
     * Answer, then the red button before the call centre has replied. The
     * call ended on screen stays ended: an answer that lands late must not
     * join the room and put the microphone live for somebody who hung up.
     */
    @Test
    fun `hanging up while the answer is on its way never joins the room`() = runTest(dispatcher) {
        val api = CenterApi(acceptMillis = 1_000)
        val room = Room()
        val call = CallSession(api, room)
        call.ringing()
        call.answer()
        testScheduler.advanceTimeBy(1)
        assertEquals(CallPhase.Connecting, call.phase.value)

        call.hangUp()
        testScheduler.advanceUntilIdle()

        assertEquals(CallPhase.Ended(CallOutcome.HungUp), call.phase.value)
        assertFalse(room.connected)
        // The accept may have landed; the call centre is told it is over.
        assertEquals(listOf("ws-1" to "call-1"), api.ended)
    }

    /**
     * The call centre's reject hangs up on the caller for everybody. A phone
     * declining a ring must not: the call stays on offer to the others.
     */
    @Test
    fun `declining tells the server nothing`() = runTest(dispatcher) {
        val api = CenterApi()
        val call = CallSession(api, Room())
        call.ringing()

        call.decline()
        testScheduler.advanceUntilIdle()

        assertEquals(CallPhase.Ended(CallOutcome.HungUp), call.phase.value)
        assertTrue(api.accepted.isEmpty())
        assertTrue(api.ended.isEmpty())
        assertNull(api.hungUp)
    }

    @Test
    fun `a call somebody else took first says so, not that it failed`() = runTest(dispatcher) {
        val api = CenterApi(acceptFailure = ApiError.Server(status = 409, serverMessage = "call_not_active"))
        val call = CallSession(api, Room())
        call.ringing()

        call.answer()
        testScheduler.advanceUntilIdle()

        assertEquals(CallPhase.Ended(CallOutcome.NoLongerWaiting), call.phase.value)
    }

    @Test
    fun `any other refusal is a failure with the reason`() = runTest(dispatcher) {
        val api = CenterApi(acceptFailure = ApiError.Server(status = 403, serverMessage = "call_assigned_to_another_operator"))
        val call = CallSession(api, Room())
        call.ringing()

        call.answer()
        testScheduler.advanceUntilIdle()

        assertTrue((call.phase.value as CallPhase.Ended).outcome is CallOutcome.Failed)
    }

    @Test
    fun `a ring the server stopped ends as no longer waiting, and only while it rings`() = runTest(dispatcher) {
        val call = CallSession(CenterApi(), Room())
        call.ringing()

        call.noLongerRinging()
        assertEquals(CallPhase.Ended(CallOutcome.NoLongerWaiting), call.phase.value)

        val answered = CallSession(CenterApi(), Room())
        answered.ringing()
        answered.answer()
        testScheduler.advanceUntilIdle()
        answered.noLongerRinging()
        assertEquals(CallPhase.Connected, answered.phase.value)
    }
}
