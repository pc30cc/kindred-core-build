package com.webyar.operator.core.sync

import com.webyar.operator.core.Diag
import com.webyar.operator.core.cache.CacheScope
import com.webyar.operator.core.cache.MemoryCacheStore
import com.webyar.operator.core.model.InboxFilter
import com.webyar.operator.core.model.RealtimeEventPayload
import com.webyar.operator.testing.ScriptedApi
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The one door: what each kind of news costs, and when nothing runs at all.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class SyncCoordinatorTest {

    private val scope = CacheScope("user-a", "ws-1")
    private val api = ScriptedApi()
    private val store = MemoryCacheStore()

    private fun TestScope.coordinator(appScope: CoroutineScope = backgroundScope): SyncCoordinator = SyncCoordinator(
        conversations = ConversationRepository(api, store, clock = { api.now }, diag = Diag.Silent),
        messages = MessageRepository(api, store, clock = { api.now }, diag = Diag.Silent),
        appScope = appScope,
        diag = Diag.Silent,
    )

    private fun event(kind: String, conversationId: String) =
        RealtimeEventPayload(kind = kind, conversationId = conversationId, workspaceId = "ws-1")

    // MARK: - Events

    @Test
    fun `a burst of events is one targeted read of the ids they named`() = runTest {
        val sync = coordinator()
        sync.focusInbox(scope, InboxFilter.OPEN)

        sync.onRealtimeEvent("ws-1", event("conversation_updated", "c-1"))
        sync.onRealtimeEvent("ws-1", event("conversation_updated", "c-2"))
        sync.onRealtimeEvent("ws-1", event("spam_changed", "c-1"))
        sync.onRealtimeEvent("ws-1", event("ai_human_takeover", "c-3"))
        advanceTimeBy(1_000)
        runCurrent()

        assertEquals(listOf(listOf("c-1", "c-2", "c-3")), api.idReads)
        // Never the queue: a realtime event is not a reason to read it all.
        assertTrue(api.listReads.isEmpty())
    }

    @Test
    fun `a realtime message lands in the open thread with no thread request`() = runTest {
        val sync = coordinator()
        api.seed("c-1", 2)
        sync.messages.sync(scope, "c-1", "open")
        sync.focusInbox(scope, InboxFilter.OPEN)
        sync.openThread("c-1")
        val reads = api.threadReads.size

        sync.onRealtimeMessage("ws-1", api.message("c-1", "live"))
        advanceTimeBy(1_000)
        runCurrent()

        assertEquals(3, sync.messages.observeThread(scope, "c-1").first().size)
        assertEquals("the payload was complete; no thread read", reads, api.threadReads.size)
        assertEquals(listOf(listOf("c-1")), api.idReads)
    }

    @Test
    fun `switching workspace drops the old one's queued work and ignores its late events`() = runTest {
        val sync = coordinator()
        sync.focusInbox(scope, InboxFilter.OPEN)
        sync.onRealtimeEvent("ws-1", event("conversation_updated", "c-1"))

        sync.focusInbox(CacheScope("user-a", "ws-2"), InboxFilter.OPEN)
        sync.onRealtimeEvent("ws-1", event("conversation_updated", "c-2"))
        advanceTimeBy(1_000)
        runCurrent()

        assertTrue(api.idReads.isEmpty())
    }

    @Test
    fun `a push for a thread this phone holds brings its delta`() = runTest {
        val sync = coordinator()
        api.seed("c-1", 2)
        sync.messages.sync(scope, "c-1", "open")
        sync.focusInbox(scope, InboxFilter.OPEN)

        api.post("c-1", "from the push")
        sync.onPush("ws-1", "c-1")
        advanceTimeBy(1_000)
        runCurrent()

        assertTrue("a delta, with a cursor", api.threadReads.last() != null)
        assertEquals(3, sync.messages.observeThread(scope, "c-1").first().size)
        assertEquals(listOf(listOf("c-1")), api.idReads)
    }

    @Test
    fun `the same message by realtime and by push is one row`() = runTest {
        val sync = coordinator()
        api.seed("c-1", 1)
        sync.messages.sync(scope, "c-1", "open")
        sync.focusInbox(scope, InboxFilter.OPEN)
        sync.openThread("c-1")

        val message = api.post("c-1", "twice")
        sync.onRealtimeMessage("ws-1", message.copy(updatedAt = null))
        sync.onPush("ws-1", "c-1")
        advanceTimeBy(1_000)
        runCurrent()

        val rows = sync.messages.observeThread(scope, "c-1").first()
        assertEquals(2, rows.size)
        assertEquals(1, rows.count { it.id == message.id })
    }

    @Test
    fun `a push for another workspace touches nothing here`() = runTest {
        val sync = coordinator()
        sync.focusInbox(scope, InboxFilter.OPEN)
        sync.onPush("ws-other", "c-1")
        advanceTimeBy(1_000)
        runCurrent()
        assertTrue(api.idReads.isEmpty())
    }

    // MARK: - Reconnect

    @Test
    fun `a reconnect that recovered everything reads nothing`() = runTest {
        val sync = coordinator()
        sync.focusInbox(scope, InboxFilter.OPEN)
        sync.onRealtimeReconnected(recovered = true)
        runCurrent()
        assertTrue(api.listReads.isEmpty())
    }

    @Test
    fun `a reconnect that missed something reconciles from the cursors`() = runTest {
        val sync = coordinator()
        api.seed("c-1", 2)
        api.put(InboxFilter.OPEN, api.row("c-1"))
        sync.focusInbox(scope, InboxFilter.OPEN)
        sync.refreshInbox(scope, InboxFilter.OPEN, force = false, reason = "open")
        sync.messages.sync(scope, "c-1", "open")
        sync.openThread("c-1")

        sync.onRealtimeReconnected(recovered = false)
        runCurrent()

        assertEquals("conditional: with the ETag", true, api.listReads.last().second != null)
        assertTrue("the open thread by delta", api.threadReads.last() != null)
    }

    // MARK: - Polling

    @Test
    fun `without realtime the foreground polls, and stretches while nothing changes`() = runTest {
        val sync = coordinator()
        api.put(InboxFilter.OPEN, api.row("c-1"))
        sync.focusInbox(scope, InboxFilter.OPEN)
        sync.setRealtime(RealtimeHealth.DEGRADED)
        sync.setForeground(true)
        runCurrent()
        val afterForeground = api.listReads.size

        advanceTimeBy(30_001)
        assertEquals(afterForeground + 1, api.listReads.size)
        // Unchanged: the next one is further off.
        advanceTimeBy(30_000)
        assertEquals(afterForeground + 1, api.listReads.size)
        advanceTimeBy(15_001)
        assertEquals(afterForeground + 2, api.listReads.size)
        // And every poll was conditional.
        assertTrue(api.listReads.drop(afterForeground).all { it.second != null })
    }

    @Test
    fun `a change brings the poll back to its shortest interval`() = runTest {
        val sync = coordinator()
        api.put(InboxFilter.OPEN, api.row("c-1"))
        sync.focusInbox(scope, InboxFilter.OPEN)
        sync.setRealtime(RealtimeHealth.DEGRADED)
        sync.setForeground(true)
        runCurrent()
        advanceTimeBy(30_001)
        advanceTimeBy(45_001)
        val before = api.listReads.size

        api.put(InboxFilter.OPEN, api.row("c-2"))
        advanceTimeBy(67_501)
        assertEquals(before + 1, api.listReads.size)
        advanceTimeBy(30_001)
        assertEquals(before + 2, api.listReads.size)
    }

    @Test
    fun `in the background nothing runs at all`() = runTest {
        val sync = coordinator()
        sync.focusInbox(scope, InboxFilter.OPEN)
        sync.setRealtime(RealtimeHealth.DEGRADED)
        sync.setForeground(true)
        runCurrent()
        sync.setForeground(false)
        runCurrent()
        val before = api.listReads.size

        advanceTimeBy(60 * 60 * 1000L)

        assertEquals(before, api.listReads.size)
    }

    @Test
    fun `with realtime connected only the ten-minute safety check runs`() = runTest {
        val sync = coordinator()
        api.put(InboxFilter.OPEN, api.row("c-1"))
        sync.focusInbox(scope, InboxFilter.OPEN)
        sync.setRealtime(RealtimeHealth.CONNECTED)
        sync.setForeground(true)
        runCurrent()
        val before = api.listReads.size

        advanceTimeBy(9 * 60 * 1000L)
        assertEquals(before, api.listReads.size)
        advanceTimeBy(60 * 1000L + 1)
        assertEquals(before + 1, api.listReads.size)
    }

    @Test
    fun `coming to the foreground re-sends what was in flight`() = runTest {
        val sync = coordinator()
        api.threads["c-1"] = mutableListOf()
        sync.focusInbox(scope, InboxFilter.OPEN)
        sync.messages.enqueue(scope, "c-1", "was in flight", sender = null)

        sync.setRealtime(RealtimeHealth.CONNECTED)
        sync.setForeground(true)
        runCurrent()

        assertEquals(1, api.agentMessages("c-1").size)
    }
}
