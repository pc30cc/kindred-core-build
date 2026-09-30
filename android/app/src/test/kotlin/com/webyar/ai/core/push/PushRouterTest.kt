package com.webyar.ai.core.push

import com.webyar.ai.core.Diag
import com.webyar.ai.core.cache.CacheScope
import com.webyar.ai.core.cache.MemoryCacheStore
import com.webyar.ai.core.model.InboxFilter
import com.webyar.ai.core.sync.ConversationRepository
import com.webyar.ai.core.sync.MessageRepository
import com.webyar.ai.core.sync.EmailSignal
import com.webyar.ai.core.sync.SyncCoordinator
import com.webyar.ai.i18n.Language
import com.webyar.ai.testing.ScriptedApi
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** A push with the app running: what it syncs, and whether it notifies. */
@OptIn(ExperimentalCoroutinesApi::class)
class PushRouterTest {

    private val api = ScriptedApi()
    private val shown = mutableListOf<PushPayload>()
    private var context: PushContext? = PushContext(
        accountId = "user-a",
        workspaceIds = setOf("ws-1"),
        language = Language.FA,
        foreground = true,
        openConversationIds = emptySet(),
    )

    private fun TestScope.router(): Pair<PushRouter, SyncCoordinator> {
        val store = MemoryCacheStore()
        val sync = SyncCoordinator(
            conversations = ConversationRepository(api, store, diag = Diag.Silent),
            messages = MessageRepository(api, store, diag = Diag.Silent),
            appScope = backgroundScope,
            diag = Diag.Silent,
        )
        sync.focusInbox(CacheScope("user-a", "ws-1"), InboxFilter.OPEN)
        return PushRouter(sync, { context }, { payload, _, _, _ -> shown += payload }, Diag.Silent) to sync
    }

    private val push = PushPayload(type = "new_message", workspaceId = "ws-1", conversationId = "c-1", messageId = "m-1")

    @Test
    fun `a push in the foreground syncs its conversation and notifies`() = runTest {
        val (router, _) = router()
        api.put(InboxFilter.OPEN, api.row("c-1"))

        router.onMessage(push, "Maryam", "Hello")
        advanceTimeBy(1_000)
        runCurrent()

        assertEquals(listOf(listOf("c-1")), api.idReads)
        assertEquals(listOf(push), shown)
    }

    /**
     * Super Admin's test send names no workspace and no conversation. With
     * the app in front it used to be dropped as "not this operator's", so a
     * test from an admin looking at the app showed nothing at all.
     */
    @Test
    fun `a test send is shown as it came, and syncs nothing`() = runTest {
        val (router, _) = router()
        val test = PushPayload(type = PushPayload.TYPE_TEST, workspaceId = null, conversationId = null, messageId = null)

        router.onMessage(test, "Webyar", "Test notification")
        advanceTimeBy(1_000)
        runCurrent()

        assertEquals(listOf(test), shown)
        assertTrue(api.idReads.isEmpty())
    }

    @Test
    fun `a test send is not shown to nobody`() = runTest {
        val (router, _) = router()
        context = null

        router.onMessage(PushPayload(type = PushPayload.TYPE_TEST, workspaceId = null, conversationId = null, messageId = null), "Webyar", "x")

        assertTrue(shown.isEmpty())
    }

    @Test
    fun `no notification for the conversation already on screen`() = runTest {
        val (router, _) = router()
        context = context!!.copy(openConversationIds = setOf("c-1"))

        router.onMessage(push, "Maryam", "Hello")

        assertTrue(shown.isEmpty())
    }

    @Test
    fun `a push for a workspace this operator does not have is dropped`() = runTest {
        val (router, _) = router()
        router.onMessage(push.copy(workspaceId = "ws-somebody-else"), "x", "y")
        advanceTimeBy(1_000)
        runCurrent()

        assertTrue(shown.isEmpty())
        assertTrue(api.idReads.isEmpty())
    }

    @Test
    fun `a push before the workspaces are known is dropped, not shown`() = runTest {
        val (router, _) = router()
        context = context!!.copy(workspaceIds = emptySet())
        router.onMessage(push, "x", "y")
        advanceTimeBy(1_000)
        runCurrent()

        assertTrue(shown.isEmpty())
        assertTrue(api.idReads.isEmpty())
    }

    @Test
    fun `a push naming no workspace is dropped`() = runTest {
        val (router, _) = router()
        router.onMessage(push.copy(workspaceId = null), "x", "y")
        assertTrue(shown.isEmpty())
    }

    @Test
    fun `a push with nobody signed in is dropped`() = runTest {
        val (router, _) = router()
        context = null
        router.onMessage(push, "x", "y")
        assertTrue(shown.isEmpty())
    }

    private val teamPush = PushPayload(
        type = PushPayload.TYPE_TEAM_MESSAGE,
        workspaceId = "ws-1",
        conversationId = null,
        messageId = "tm-1",
        peerId = "user-sara",
    )

    /**
     * A colleague's message used to reach a phone only over realtime — so
     * never with the app closed. Now it is pushed; in front, it tells the
     * team screens to read again and is shown like any other message.
     */
    @Test
    fun `a colleague's message is shown, and wakes the team screens instead of a conversation read`() = runTest {
        val (router, sync) = router()
        val heard = mutableListOf<com.webyar.ai.core.sync.TeamSignal>()
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { sync.team.collect { heard += it } }

        router.onMessage(teamPush, "Sara · همکار", "Can you take this one?")
        advanceTimeBy(1_000)
        runCurrent()

        assertEquals(listOf(teamPush), shown)
        assertTrue(api.idReads.isEmpty())
        assertEquals(1, heard.size)
        assertTrue(heard.single().involves("user-sara"))
        assertEquals("ws-1", heard.single().workspaceId)
    }

    @Test
    fun `no notification for the colleague whose thread is on screen`() = runTest {
        val (router, _) = router()
        context = context!!.copy(openTeamPeerIds = setOf("user-sara"))

        router.onMessage(teamPush, "Sara", "Hi")

        assertTrue(shown.isEmpty())
    }

    @Test
    fun `another colleague's thread on screen does not hide it`() = runTest {
        val (router, _) = router()
        context = context!!.copy(openTeamPeerIds = setOf("user-ben"))

        router.onMessage(teamPush, "Sara", "Hi")

        assertEquals(listOf(teamPush), shown)
    }

    @Test
    fun `a colleague's message for another operator's workspace is dropped`() = runTest {
        val (router, _) = router()

        router.onMessage(teamPush.copy(workspaceId = "ws-somebody-else"), "Sara", "Hi")
        router.onMessage(teamPush.copy(peerId = null), "Sara", "Hi")

        assertTrue(shown.isEmpty())
    }

    @Test
    fun `a team payload names its colleague, checked like any id`() {
        val parsed = PushPayload.from(mapOf("type" to "team_message", "workspaceId" to "ws-1", "peerId" to "user-sara"))
        assertEquals("user-sara", parsed.peerId)
        assertTrue(parsed.opensTeamThread)
        assertEquals(false, parsed.opensConversation)

        val forged = PushPayload.from(mapOf("type" to "team_message", "workspaceId" to "ws-1", "peerId" to "../x"))
        assertEquals(null, forged.peerId)
        assertEquals(false, forged.opensSomething)
    }

    @Test
    fun `a new email is shown, and reads no conversation`() = runTest {
        val (router, _) = router()
        val email = PushPayload(type = PushPayload.TYPE_EMAIL, workspaceId = "ws-1", conversationId = null, messageId = "m-9", threadId = "t-1")

        router.onMessage(email, "ali@example.com", "Invoice — attached")
        advanceTimeBy(1_000)
        runCurrent()

        assertEquals(listOf(email), shown)
        assertTrue(api.idReads.isEmpty())
        assertTrue(email.opensEmailThread)
    }

    /** New mail: the mailbox reads again (the channel may be down) and the operator is told. */
    @Test
    fun `new mail signals its mailbox and notifies`() = runTest {
        val (router, sync) = router()
        val heard = mutableListOf<EmailSignal>()
        backgroundScope.launch { sync.email.collect { heard += it } }
        runCurrent()
        val email = PushPayload(type = PushPayload.TYPE_EMAIL, workspaceId = "ws-1", conversationId = null, messageId = null, threadId = "18f3a9c2b1d0e4f5", provider = "yahoo")

        router.onMessage(email, "ایمیل تازه", "ایمیل تازه")
        runCurrent()

        assertEquals(listOf(email), shown)
        assertEquals(listOf(EmailSignal("ws-1", "yahoo", null)), heard)
    }

    /** The mail arriving is in the thread on screen: it is already being read. */
    @Test
    fun `new mail in the thread being read does not notify`() = runTest {
        context = context?.copy(openEmailThreadIds = setOf("18f3a9c2b1d0e4f5"))
        val (router, sync) = router()
        val heard = mutableListOf<EmailSignal>()
        backgroundScope.launch { sync.email.collect { heard += it } }
        runCurrent()
        val email = PushPayload(type = PushPayload.TYPE_EMAIL, workspaceId = "ws-1", conversationId = null, messageId = null, threadId = "18f3a9c2b1d0e4f5")

        router.onMessage(email, "ایمیل تازه", "ایمیل تازه")
        runCurrent()

        assertTrue(shown.isEmpty())
        // Still heard: the list and the count move with it.
        assertEquals(1, heard.size)
    }

    @Test
    fun `a push names its mailbox only when it is one of ours`() {
        assertEquals("gmail", PushPayload.from(mapOf("type" to "email_message", "provider" to "gmail")).provider)
        assertEquals(null, PushPayload.from(mapOf("type" to "email_message", "provider" to "../evil")).provider)
    }

    @Test
    fun `a callback request is shown`() = runTest {
        val (router, _) = router()
        val callback = PushPayload(type = PushPayload.TYPE_CALLBACK, workspaceId = "ws-1", conversationId = null, messageId = null, callbackId = "cb-1")

        router.onMessage(callback, "Callback request", "A visitor asked to be called back")

        assertEquals(listOf(callback), shown)
    }

    /** An assignment names its conversation, and is a conversation push like any other. */
    @Test
    fun `an assignment syncs its conversation and notifies`() = runTest {
        val (router, _) = router()
        api.put(InboxFilter.OPEN, api.row("c-1"))
        val assignment = push.copy(type = "assignment", messageId = null)

        router.onMessage(assignment, "Conversation assigned to you", "Ali")
        advanceTimeBy(1_000)
        runCurrent()

        assertEquals(listOf(listOf("c-1")), api.idReads)
        assertEquals(listOf(assignment), shown)
    }

    @Test
    fun `a payload's ids are checked before they are used`() {
        val parsed = PushPayload.from(mapOf("workspaceId" to "../../etc", "conversationId" to "c-1", "type" to "new_message"))
        assertEquals(null, parsed.workspaceId)
        assertEquals("c-1", parsed.conversationId)
        assertEquals(false, parsed.opensConversation)
    }
}
