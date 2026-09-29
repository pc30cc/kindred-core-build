package com.webyar.ai.core.realtime

import com.webyar.ai.core.Diag
import com.webyar.ai.core.cache.CacheScope
import com.webyar.ai.core.cache.MemoryCacheStore
import com.webyar.ai.core.model.InboxFilter
import com.webyar.ai.core.model.RealtimeConnect
import com.webyar.ai.core.model.RealtimeSubscribe
import com.webyar.ai.core.net.ApiError
import com.webyar.ai.core.sync.ConversationRepository
import com.webyar.ai.core.sync.MessageRepository
import com.webyar.ai.core.sync.RealtimeHealth
import com.webyar.ai.core.sync.SyncCoordinator
import com.webyar.ai.testing.FakeCentrifugo
import com.webyar.ai.testing.ScriptedApi
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

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

    /**
     * The socket's first subscribe recovers nothing: a message published
     * while it was being negotiated is found only by a read, so the queue on
     * screen is asked about once the socket is up — conditionally.
     */
    @Test
    fun `a socket coming up reads the queue on screen once`() = runTest {
        val (realtime, sync) = coordinator()
        sync.focusInbox(CacheScope("user-a", "ws-1"), InboxFilter.OPEN)
        runCurrent()
        val before = api.listReads.size

        realtime.setWorkspace("ws-1")
        realtime.setForeground(true)
        runCurrent()

        assertEquals(RealtimeHealth.CONNECTED, sync.realtime.value)
        assertEquals(before + 1, api.listReads.size)
    }

    /** Where no socket is coming back, the network returning pays what is owed. */
    @Test
    fun `the network coming back makes the read the sync layer owes`() = runTest {
        api.connectAnswer = RealtimeConnect(vendor = "polling_builtin")
        api.failLists = ApiError.Transport(IOException("offline"))
        val (realtime, sync) = coordinator()
        sync.focusInbox(CacheScope("user-a", "ws-1"), InboxFilter.OPEN)
        realtime.setWorkspace("ws-1")
        realtime.setForeground(true)
        // The return to the front reads, fails, and so owes that read.
        sync.setForeground(true)
        runCurrent()
        api.failLists = null
        val before = api.listReads.size

        realtime.onNetworkAvailable()
        runCurrent()

        assertEquals(before + 1, api.listReads.size)
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
