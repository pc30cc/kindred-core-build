package com.webyar.operator.core.realtime

import com.webyar.operator.core.Diag
import com.webyar.operator.core.cache.MemoryCacheStore
import com.webyar.operator.core.model.RealtimeSubscribe
import com.webyar.operator.core.sync.ConversationRepository
import com.webyar.operator.core.sync.MessageRepository
import com.webyar.operator.core.sync.RealtimeHealth
import com.webyar.operator.core.sync.SyncCoordinator
import com.webyar.operator.testing.FakeCentrifugo
import com.webyar.operator.testing.ScriptedApi
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * When there is a socket at all: in front, signed in, with a workspace —
 * and never otherwise.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class RealtimeCoordinatorTest {

    private val api = ScriptedApi()
    private val server = FakeCentrifugo()

    private fun TestScope.coordinator(): Pair<RealtimeCoordinator, SyncCoordinator> {
        val store = MemoryCacheStore()
        val sync = SyncCoordinator(
            conversations = ConversationRepository(api, store, diag = Diag.Silent),
            messages = MessageRepository(api, store, diag = Diag.Silent),
            appScope = backgroundScope,
            diag = Diag.Silent,
        )
        val realtime = RealtimeCoordinator(
            clientFactory = { sink ->
                RealtimeClient(api, server.transport, sink, clock = { currentTime }, diag = Diag.Silent)
            },
            sync = sync,
            appScope = backgroundScope,
            diag = Diag.Silent,
        )
        return realtime to sync
    }

    @Test
    fun `in front and signed in, there is a socket`() = runTest {
        val (realtime, sync) = coordinator()
        realtime.setWorkspace("ws-1")
        realtime.setForeground(true)
        runCurrent()

        assertEquals(1, server.sockets.size)
        assertEquals(RealtimeHealth.CONNECTED, sync.realtime.value)
    }

    @Test
    fun `in the background there is none`() = runTest {
        val (realtime, sync) = coordinator()
        realtime.setWorkspace("ws-1")
        realtime.setForeground(true)
        runCurrent()

        realtime.setForeground(false)
        runCurrent()

        assertTrue(server.latest.closed)
        assertEquals(RealtimeHealth.IDLE, sync.realtime.value)
    }

    @Test
    fun `nothing connects before the app is in front`() = runTest {
        val (realtime, _) = coordinator()
        realtime.setWorkspace("ws-1")
        runCurrent()
        assertTrue(server.sockets.isEmpty())
    }

    @Test
    fun `a workspace switch closes the old socket and subscribes the new workspace`() = runTest {
        val (realtime, _) = coordinator()
        realtime.setWorkspace("ws-1")
        realtime.setForeground(true)
        runCurrent()

        api.inboxAnswer = RealtimeSubscribe(vendor = "centrifugo", channel = "ws:ws-2:inbox", token = "t2")
        realtime.setWorkspace("ws-2")
        runCurrent()

        assertTrue(server.sockets.first().closed)
        assertEquals(2, server.sockets.size)
        assertEquals("\"ws:ws-2:inbox\"", server.latest.subscribes.first()["channel"].toString())
    }

    @Test
    fun `signing out closes the socket`() = runTest {
        val (realtime, _) = coordinator()
        realtime.setWorkspace("ws-1")
        realtime.setForeground(true)
        runCurrent()

        realtime.setWorkspace(null)
        runCurrent()

        assertTrue(server.latest.closed)
    }
}
