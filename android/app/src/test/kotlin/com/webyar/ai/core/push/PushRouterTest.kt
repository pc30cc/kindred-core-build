package com.webyar.ai.core.push

import com.webyar.ai.core.Diag
import com.webyar.ai.core.cache.CacheScope
import com.webyar.ai.core.cache.MemoryCacheStore
import com.webyar.ai.core.model.InboxFilter
import com.webyar.ai.core.sync.ConversationRepository
import com.webyar.ai.core.sync.MessageRepository
import com.webyar.ai.core.sync.SyncCoordinator
import com.webyar.ai.i18n.Language
import com.webyar.ai.testing.ScriptedApi
import kotlinx.coroutines.ExperimentalCoroutinesApi
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

    @Test
    fun `a payload's ids are checked before they are used`() {
        val parsed = PushPayload.from(mapOf("workspaceId" to "../../etc", "conversationId" to "c-1", "type" to "new_message"))
        assertEquals(null, parsed.workspaceId)
        assertEquals("c-1", parsed.conversationId)
        assertEquals(false, parsed.opensConversation)
    }
}
