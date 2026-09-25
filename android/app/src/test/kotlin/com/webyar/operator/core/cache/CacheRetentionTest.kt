package com.webyar.operator.core.cache

import com.webyar.operator.core.Diag
import com.webyar.operator.core.model.Conversation
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

/** How much the cache keeps, and what it gives up first. */
class CacheRetentionTest {

    private val day = 24 * 60 * 60 * 1000L
    private val now = 400 * day
    private val scope = CacheScope("user-a", "ws-1")
    private val store = MemoryCacheStore()

    private suspend fun thread(id: String, messages: Int, openedDaysAgo: Int?) {
        store.writeConversations(
            scope,
            listOf(Conversation(id = id, workspaceId = "ws-1", updatedAt = Instant.ofEpochMilli(now))),
            listKey = "open",
            now = now,
        )
        openedDaysAgo?.let { store.markOpened(scope, id, now - it * day) }
        store.thread(scope, id) {
            upsert(
                (1..messages).map { n ->
                    MessageEntity(
                        accountId = scope.accountId, localId = "s:$id-$n", workspaceId = scope.workspaceId,
                        conversationId = id, serverId = "$id-$n", clientMessageId = null, senderType = "contact",
                        senderId = null, senderName = null, senderAvatar = null, body = "b", createdAt = n.toLong(),
                        updatedAt = n.toLong(), metadataJson = null, attachmentsJson = null,
                        sendState = SendState.SENT.code, outboxAttachmentId = null, sortAt = n.toLong(), cachedAt = now,
                    )
                },
            )
        }
    }

    private fun retention(policy: RetentionPolicy = RetentionPolicy()) =
        CacheRetention(store, clock = { now }, diag = Diag.Silent, policy = policy)

    @Test
    fun `a transcript not opened in a month is dropped whole`() = runBlocking {
        thread("c-recent", 10, openedDaysAgo = 1)
        thread("c-stale", 10, openedDaysAgo = 45)

        val report = retention().run()

        assertEquals(1, report.threadsEvicted)
        assertTrue(store.observeThread(scope, "c-stale").first().isEmpty())
        assertEquals(10, store.observeThread(scope, "c-recent").first().size)
    }

    @Test
    fun `past the cap, the least recently opened go first`() = runBlocking {
        thread("c-1", 30, openedDaysAgo = 1)
        thread("c-2", 30, openedDaysAgo = 5)
        thread("c-3", 30, openedDaysAgo = 3)

        retention(RetentionPolicy(maxMessages = 80, targetMessages = 60)).run()

        assertTrue(store.observeThread(scope, "c-2").first().isEmpty())
        assertEquals(30, store.observeThread(scope, "c-1").first().size)
        assertEquals(30, store.observeThread(scope, "c-3").first().size)
    }

    @Test
    fun `a queue unread for a month lets its rows go`() = runBlocking {
        store.writeConversations(
            scope,
            listOf(Conversation(id = "c-old", workspaceId = "ws-1", updatedAt = Instant.ofEpochMilli(1))),
            listKey = "open",
            replaceList = true,
            now = 1,
        )
        store.putSyncState(scope, SyncStateEntity(scope.accountId, scope.workspaceId, "list:open", null, "etag", 1, null, 1))

        retention().run()

        assertTrue(store.observeList(scope, "open").first().isEmpty())
        assertNull(store.conversation(scope, "c-old"))
    }
}
