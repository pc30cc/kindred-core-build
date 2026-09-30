package com.webyar.ai.core.sync

import com.webyar.ai.core.Diag
import com.webyar.ai.core.cache.CacheScope
import com.webyar.ai.core.cache.MemoryCacheStore
import com.webyar.ai.core.model.InboxFilter
import com.webyar.ai.core.model.RealtimeEventPayload
import com.webyar.ai.testing.ScriptedApi
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
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

    /**
     * A mailbox changed: the email screens hear it whatever queue is in
     * focus — or none — and the chat inbox reads nothing for it.
     */
    @Test
    fun `a mailbox change goes to the email screens and costs the inbox nothing`() = runTest {
        val sync = coordinator()
        val heard = mutableListOf<EmailSignal>()
        backgroundScope.launch { sync.email.collect { heard += it } }
        runCurrent()

        sync.onRealtimeEvent(
            "ws-1",
            RealtimeEventPayload(kind = "email_mailbox_changed", workspaceId = "ws-1", conversationId = "", provider = "gmail", historyId = "124100"),
        )
        sync.onEmailPush("ws-1", "yahoo")
        advanceTimeBy(1_000)
        runCurrent()

        assertEquals(listOf(EmailSignal("ws-1", "gmail", "124100"), EmailSignal("ws-1", "yahoo", null)), heard)
        assertTrue(api.idReads.isEmpty())
        assertTrue(api.listReads.isEmpty())
    }

    @Test
    fun `team chat news goes to the team screens and costs the inbox nothing`() = runTest {
        val sync = coordinator()
        sync.focusInbox(scope, InboxFilter.OPEN)
        val heard = mutableListOf<TeamSignal>()
        backgroundScope.launch { sync.team.collect { heard += it } }
        runCurrent()

        sync.onRealtimeEvent(
            "ws-1",
            RealtimeEventPayload(kind = "team_message", workspaceId = "ws-1", senderId = "u-2", recipientId = "user-a", messageId = "tm-1"),
        )
        sync.onRealtimeEvent("ws-1", RealtimeEventPayload(kind = "team_read", workspaceId = "ws-1", peerId = "u-3"))
        advanceTimeBy(1_000)
        runCurrent()

        assertEquals(listOf("team_message", "team_read"), heard.map { it.kind })
        assertTrue(heard[0].involves("u-2"))
        assertTrue(heard[1].involves("u-3"))
        assertTrue(!heard[1].involves("u-2"))
        // Not a conversation: nothing to re-read in the inbox.
        assertTrue(api.idReads.isEmpty())
        assertTrue(api.listReads.isEmpty())
    }

    /**
     * The platform's team answered, on the operator's own channel: the
     * support screens hear it, focus or none, and the inbox reads nothing.
     */
    @Test
    fun `support news goes to the support screens and costs the inbox nothing`() = runTest {
        val sync = coordinator()
        sync.focusInbox(scope, InboxFilter.OPEN)
        val heard = mutableListOf<SupportSignal>()
        backgroundScope.launch { sync.support.collect { heard += it } }
        runCurrent()

        sync.onRealtimeEvent(
            "ws-1",
            RealtimeEventPayload(kind = "support_message", workspaceId = "ws-1", conversationId = "st-1", threadId = "st-1", messageId = "m-1"),
        )
        // Resolved, closed, reopened or passed on: the chat reads again too.
        sync.onRealtimeEvent(
            "ws-1",
            RealtimeEventPayload(kind = "support_update", workspaceId = "ws-1", conversationId = "st-1", threadId = "st-1"),
        )
        sync.onRealtimeEvent("ws-1", RealtimeEventPayload(kind = "support_read", workspaceId = "ws-1", threadId = "st-1"))
        sync.onSupportPush(null)
        advanceTimeBy(1_000)
        runCurrent()

        assertEquals(
            listOf(
                SupportSignal("support_message", "st-1"),
                SupportSignal("support_update", "st-1"),
                SupportSignal("support_read", "st-1"),
                SupportSignal("support_message", null),
            ),
            heard,
        )
        assertTrue(api.idReads.isEmpty())
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

    /**
     * A chat opened from the AI's queue, handed over to a person: the
     * focused queue no longer lists it, so it is read by itself too — or its
     * header and composer keep the AI's state.
     */
    @Test
    fun `an event about an open chat also reads that chat by id`() = runTest {
        val sync = coordinator()
        sync.focusInbox(scope, InboxFilter.AI)
        sync.openThread("c-1")

        sync.onRealtimeEvent("ws-1", event("ai_handoff_requested", "c-1"))
        sync.onRealtimeEvent("ws-1", event("conversation_updated", "c-2"))
        advanceTimeBy(1_000)
        runCurrent()

        // The batch in the queue on screen, and again in Open for its badge.
        assertEquals(listOf(listOf("c-1", "c-2"), listOf("c-1", "c-2")), api.idReads)
        assertEquals(listOf(InboxFilter.AI, InboxFilter.OPEN), api.idReadFilters)
        // Only the one on screen, not every id in the batch.
        assertEquals(listOf("c-1"), api.byIdReads)
    }

    /**
     * The Inbox tab's badge counts Open whatever queue is on screen, so Open
     * hears the news too: a customer writing while the operator reads the
     * AI's queue lights the badge then, not when they go back to Open.
     */
    @Test
    fun `with another queue on screen, Open hears the same news`() = runTest {
        val sync = coordinator()
        sync.focusInbox(scope, InboxFilter.AI)
        api.put(InboxFilter.OPEN, api.row("c-9", unread = 1))

        sync.onRealtimeEvent("ws-1", event("new_message", "c-9"))
        advanceTimeBy(1_000)
        runCurrent()

        val open = sync.conversations.observeInbox(scope, InboxFilter.OPEN).first()
        assertEquals(listOf("c-9"), open.map { it.id })
        assertEquals(1, open.single().unreadCount)
        // Not in the AI's queue, so not listed there.
        assertTrue(sync.conversations.observeInbox(scope, InboxFilter.AI).first().isEmpty())
    }

    /** Open on screen is read once, not a second time for the badge. */
    @Test
    fun `with Open on screen, the news is read once`() = runTest {
        val sync = coordinator()
        sync.focusInbox(scope, InboxFilter.OPEN)

        sync.onRealtimeEvent("ws-1", event("new_message", "c-1"))
        advanceTimeBy(1_000)
        runCurrent()

        assertEquals(listOf<InboxFilter?>(InboxFilter.OPEN), api.idReadFilters)
    }

    /** A reconcile with another queue on screen asks after Open too, conditionally. */
    @Test
    fun `a reconcile with another queue on screen also asks after Open`() = runTest {
        val sync = coordinator()
        sync.focusInbox(scope, InboxFilter.AI)
        api.put(InboxFilter.OPEN, api.row("c-9", unread = 1))

        sync.reconcile("foreground")
        assertEquals(listOf(InboxFilter.AI, InboxFilter.OPEN), api.listReads.map { it.first })
        assertEquals(listOf("c-9"), sync.conversations.observeInbox(scope, InboxFilter.OPEN).first().map { it.id })

        // Unchanged the second time: a conditional read, answered 304.
        sync.reconcile("poll")
        assertTrue(api.listReads.last().second != null)
    }

    /** A chat restored with no inbox behind it still hears its conversation. */
    @Test
    fun `a chat with nothing in focus focuses the Open queue`() = runTest {
        val sync = coordinator()
        sync.ensureFocus(scope)
        sync.onRealtimeEvent("ws-1", event("conversation_updated", "c-1"))
        advanceTimeBy(1_000)
        runCurrent()

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
