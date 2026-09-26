package com.webyar.operator.core.sync

import com.webyar.operator.core.Diag
import com.webyar.operator.core.cache.CacheScope
import com.webyar.operator.core.cache.MemoryCacheStore
import com.webyar.operator.core.model.ConversationStatus
import com.webyar.operator.core.model.InboxCounts
import com.webyar.operator.core.model.InboxFilter
import com.webyar.operator.testing.ScriptedApi
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The inbox's cache: which rows a queue holds, how a row learns it moved,
 * and how little of the queue that takes to find out.
 */
class ConversationRepositoryTest {

    private val scope = CacheScope("user-a", "ws-1")
    private val api = ScriptedApi()
    private val store = MemoryCacheStore()
    private val repo = ConversationRepository(api, store, clock = { api.now }, diag = Diag.Silent)

    private suspend fun ids(filter: InboxFilter = InboxFilter.OPEN, scope: CacheScope = this.scope) =
        repo.observeInbox(scope, filter).first().map { it.id }

    @Test
    fun `an empty cache shows nothing, and the first read fills it`() = runTest {
        assertTrue(ids().isEmpty())
        api.put(InboxFilter.OPEN, api.row("c-1"), api.row("c-2"))

        assertEquals(InboxRefresh.Replaced(2), repo.refreshInbox(scope, InboxFilter.OPEN, force = false, reason = "open"))
        assertEquals(listOf("c-2", "c-1"), ids())
        assertTrue(repo.hasList(scope, InboxFilter.OPEN))
    }

    @Test
    fun `a queue that has not changed costs a 304 and no rewrite`() = runTest {
        api.put(InboxFilter.OPEN, api.row("c-1"))
        repo.refreshInbox(scope, InboxFilter.OPEN, force = false, reason = "open")

        assertEquals(InboxRefresh.Unchanged, repo.refreshInbox(scope, InboxFilter.OPEN, force = false, reason = "poll"))
        assertNotNull("the second read carried the ETag", api.listReads.last().second)
    }

    @Test
    fun `pull to refresh reads in full even when nothing changed`() = runTest {
        api.put(InboxFilter.OPEN, api.row("c-1"))
        repo.refreshInbox(scope, InboxFilter.OPEN, force = false, reason = "open")

        assertEquals(InboxRefresh.Replaced(1), repo.refreshInbox(scope, InboxFilter.OPEN, force = true, reason = "pull"))
        assertEquals(null, api.listReads.last().second)
    }

    @Test
    fun `a conversation that moves queue leaves one and joins the other`() = runTest {
        api.put(InboxFilter.OPEN, api.row("c-1"), api.row("c-2"))
        repo.refreshInbox(scope, InboxFilter.OPEN, force = false, reason = "open")

        // Resolved elsewhere: the server takes it out of Open.
        api.remove(InboxFilter.OPEN, "c-1")
        api.put(InboxFilter.RESOLVED, api.row("c-1", status = ConversationStatus.RESOLVED))
        repo.refreshConversations(scope, listOf("c-1"), InboxFilter.OPEN, reason = "event")

        assertEquals(listOf("c-2"), ids())
        assertEquals(listOf(listOf("c-1")), api.idReads)
        // One id asked about — not the queue read again.
        assertEquals(1, api.listReads.size)

        repo.refreshInbox(scope, InboxFilter.RESOLVED, force = false, reason = "switch")
        assertEquals(listOf("c-1"), ids(InboxFilter.RESOLVED))
        assertEquals(ConversationStatus.RESOLVED, repo.cached(scope, "c-1")?.status)
    }

    @Test
    fun `a new conversation joins the queue from a targeted read`() = runTest {
        api.put(InboxFilter.OPEN, api.row("c-1"))
        repo.refreshInbox(scope, InboxFilter.OPEN, force = false, reason = "open")
        api.put(InboxFilter.OPEN, api.row("c-new"))

        repo.refreshConversations(scope, listOf("c-new"), InboxFilter.OPEN, reason = "realtime")

        assertEquals(listOf("c-new", "c-1"), ids())
    }

    @Test
    fun `an unread count moves with the row`() = runTest {
        api.put(InboxFilter.OPEN, api.row("c-1", unread = 0))
        repo.refreshInbox(scope, InboxFilter.OPEN, force = false, reason = "open")
        api.put(InboxFilter.OPEN, api.row("c-1", unread = 3))

        repo.refreshConversations(scope, listOf("c-1"), InboxFilter.OPEN, reason = "push")
        assertEquals(3, repo.cached(scope, "c-1")?.unreadCount)

        repo.clearUnread(scope, "c-1")
        assertEquals(0, repo.cached(scope, "c-1")?.unreadCount)
    }

    @Test
    fun `an older copy of a row never replaces a newer one`() = runTest {
        val old = api.row("c-1", unread = 1)
        val newer = api.row("c-1", unread = 5)
        api.put(InboxFilter.OPEN, newer)
        repo.refreshInbox(scope, InboxFilter.OPEN, force = false, reason = "open")

        api.put(InboxFilter.OPEN, old)
        repo.refreshInbox(scope, InboxFilter.OPEN, force = true, reason = "late")

        assertEquals(5, repo.cached(scope, "c-1")?.unreadCount)
    }

    @Test
    fun `an older server's whole-queue answer is kept as the full read it was`() = runTest {
        api.idsSupported = false
        api.put(InboxFilter.OPEN, api.row("c-1"), api.row("c-2"))

        repo.refreshConversations(scope, listOf("c-1"), InboxFilter.OPEN, reason = "event")

        assertEquals(listOf("c-2", "c-1"), ids())
        assertTrue(repo.hasList(scope, InboxFilter.OPEN))
    }

    @Test
    fun `a conversation opened by id is fetched once, then read from the cache`() = runTest {
        api.put(InboxFilter.SPAM, api.row("c-9"))

        assertEquals("c-9", repo.conversation(scope, "c-9")?.id)
        assertEquals("c-9", repo.conversation(scope, "c-9")?.id)
        assertEquals(listOf("c-9"), api.byIdReads)
        // Opened by id is not the same as listed: it joins no queue.
        assertTrue(ids().isEmpty())
    }

    @Test
    fun `a conversation gone from the server is removed on its next read`() = runTest {
        api.put(InboxFilter.OPEN, api.row("c-1"))
        repo.refreshInbox(scope, InboxFilter.OPEN, force = false, reason = "open")
        api.remove(InboxFilter.OPEN, "c-1")

        repo.refreshConversations(scope, listOf("c-1"), filter = null, reason = "push")

        assertEquals(null, repo.cached(scope, "c-1"))
        assertTrue(ids().isEmpty())
    }

    @Test
    fun `counts are shown from the cache and refreshed`() = runTest {
        api.counts = InboxCounts(open = 7)
        repo.refreshCounts(scope, "main")

        assertEquals(7, repo.cachedCounts(scope, "main")?.open)
        assertEquals(null, repo.cachedCounts(CacheScope("user-b", "ws-1"), "main"))
    }

    @Test
    fun `two workspaces and two accounts keep their own queues`() = runTest {
        api.put(InboxFilter.OPEN, api.row("c-1", workspaceId = "ws-1"), api.row("c-2", workspaceId = "ws-2"))
        repo.refreshInbox(scope, InboxFilter.OPEN, force = false, reason = "open")
        val other = CacheScope("user-a", "ws-2")
        repo.refreshInbox(other, InboxFilter.OPEN, force = false, reason = "open")

        assertEquals(listOf("c-1"), ids())
        assertEquals(listOf("c-2"), ids(scope = other))
        assertTrue(ids(scope = CacheScope("user-b", "ws-1")).isEmpty())
    }
}
