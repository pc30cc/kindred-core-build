package com.webyar.operator.core.sync

import com.webyar.operator.core.Diag
import com.webyar.operator.core.cache.CacheScope
import com.webyar.operator.core.cache.CacheStore
import com.webyar.operator.core.cache.SyncKeys
import com.webyar.operator.core.cache.SyncStateEntity
import com.webyar.operator.core.model.Conversation
import com.webyar.operator.core.model.InboxCounts
import com.webyar.operator.core.model.InboxFilter
import com.webyar.operator.core.model.InboxPage
import com.webyar.operator.core.net.ApiError
import com.webyar.operator.core.net.WebyarApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json
import java.util.concurrent.ConcurrentHashMap

/** The key a queue's membership and ETag are stored under. */
val InboxFilter.listKey: String get() = wire

/**
 * The inbox, local-first.
 *
 * Screens read [observeInbox] — Room, immediately, whatever the network is
 * doing — and nothing here ever hands a network answer to a screen directly.
 * The server's answers go into the cache and the cache's flow carries them
 * on. One writer, one reader, and a slow response cannot race a fast one to
 * the screen because neither of them goes to the screen.
 *
 * Three ways the cache learns something, cheapest first:
 *
 *  - [refreshConversations]: the handful of ids a realtime event or a push
 *    named, asked about in the queue on screen. The server answers with the
 *    rows still in the queue, which updates both the rows and the membership
 *    without the rest of the list.
 *  - [refreshInbox] with an ETag: "has anything changed?", answered with a
 *    `304` and no body when nothing has. What a reconnect, a return to the
 *    foreground and the fallback poll use.
 *  - [refreshInbox] forced: the whole queue. Pull-to-refresh, and the first
 *    read of a queue.
 *
 * Every write for one scope's inbox goes through one lock, so a targeted
 * read and a full read never interleave — the later one to start is the
 * later one to land.
 */
class ConversationRepository(
    private val api: WebyarApi,
    private val store: CacheStore,
    private val clock: () -> Long = System::currentTimeMillis,
    private val diag: Diag = Diag.Android,
) {
    /**
     * One lock per scope: within a workspace a targeted read and a full read
     * never interleave, while a slow answer for the workspace the operator
     * just left does not hold up the one they switched to.
     */
    private val locks = ConcurrentHashMap<CacheScope, Mutex>()

    private fun lockFor(scope: CacheScope): Mutex = locks.getOrPut(scope) { Mutex() }
    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }

    fun observeInbox(scope: CacheScope, filter: InboxFilter): Flow<List<Conversation>> =
        store.observeList(scope, filter.listKey)

    fun observeConversation(scope: CacheScope, conversationId: String): Flow<Conversation?> =
        store.observeConversation(scope, conversationId)

    suspend fun cached(scope: CacheScope, conversationId: String): Conversation? =
        runCatching { store.conversation(scope, conversationId) }.getOrNull()

    /** Whether this queue has ever been read in this scope — i.e. whether an empty list means empty. */
    suspend fun hasList(scope: CacheScope, filter: InboxFilter): Boolean =
        runCatching { store.syncState(scope, SyncKeys.list(filter.listKey)) != null }.getOrDefault(false)

    /**
     * Reads one queue in full, unless the server says it has not changed.
     *
     * [force] skips the ETag: pull-to-refresh means "show me what is there",
     * and an operator who pulls expects a request to be made.
     */
    suspend fun refreshInbox(scope: CacheScope, filter: InboxFilter, force: Boolean, reason: String): InboxRefresh =
        lockFor(scope).withLock {
            val key = SyncKeys.list(filter.listKey)
            val meta = store.syncState(scope, key)
            val etag = meta?.etag?.takeUnless { force }
            val started = clock()
            when (val page = api.inboxPage(scope.workspaceId, filter, etag)) {
                InboxPage.NotModified -> {
                    store.putSyncState(scope, (meta ?: blank(scope, key)).copy(updatedAt = clock()))
                    diag.info(AREA, "inbox ${filter.listKey} unchanged (304, $reason) in ${clock() - started}ms")
                    InboxRefresh.Unchanged
                }
                is InboxPage.Changed -> {
                    val now = clock()
                    store.writeConversations(
                        scope,
                        page.conversations,
                        listKey = filter.listKey,
                        replaceList = true,
                        now = now,
                    )
                    store.putSyncState(
                        scope,
                        (meta ?: blank(scope, key)).copy(etag = page.etag, fullReadAt = now, updatedAt = now),
                    )
                    diag.info(
                        AREA,
                        "inbox ${filter.listKey} read in full: ${page.conversations.size} rows ($reason) " +
                            "in ${now - started}ms",
                    )
                    InboxRefresh.Replaced(page.conversations.size)
                }
            }
        }

    /**
     * What these conversations look like now, and whether each is still in
     * [filter]'s queue.
     *
     * With no [filter], the rows are refreshed wherever they are listed and
     * membership is left alone — for a conversation opened from a
     * notification, which may not be in any queue this phone has read.
     */
    suspend fun refreshConversations(
        scope: CacheScope,
        ids: Collection<String>,
        filter: InboxFilter?,
        reason: String,
    ) {
        val wanted = ids.filter { it.isNotBlank() }.distinct()
        if (wanted.isEmpty()) return
        lockFor(scope).withLock {
            val now = clock()
            if (filter == null) {
                for (id in wanted) {
                    val row = api.conversation(scope.workspaceId, id)
                    if (row == null) {
                        store.removeConversation(scope, id)
                        diag.info(AREA, "conversation ${Diag.id(id)} gone; removed ($reason)")
                    } else {
                        store.writeConversations(scope, listOf(row), now = now)
                    }
                }
                return@withLock
            }
            // A hundred at a time, the endpoint's own limit: ids beyond it used to
            // be sent, silently not asked about, and marked absent from the list.
            for (chunk in wanted.chunked(MAX_IDS_PER_READ)) {
                val slice = api.conversationsByIds(scope.workspaceId, chunk, filter)
                val whole = slice.wholeList
                if (whole != null) {
                    // An older server ignored the narrowing and sent the whole
                    // queue: that IS a full read, so it is stored as one. The
                    // ETag is dropped because this response did not carry one.
                    store.writeConversations(scope, whole, listKey = filter.listKey, replaceList = true, now = now)
                    val key = SyncKeys.list(filter.listKey)
                    store.putSyncState(
                        scope,
                        (store.syncState(scope, key) ?: blank(scope, key)).copy(etag = null, fullReadAt = now, updatedAt = now),
                    )
                    diag.info(AREA, "targeted read unsupported by server; stored ${whole.size} rows as a full read")
                } else {
                    val present = slice.rows.map { it.id }.toSet()
                    store.writeConversations(
                        scope,
                        slice.rows,
                        listKey = filter.listKey,
                        absent = chunk.filter { it !in present },
                        now = now,
                    )
                    diag.info(
                        AREA,
                        "targeted read of ${chunk.size} (${slice.rows.size} in ${filter.listKey}, $reason)",
                    )
                }
                if (whole != null) break
            }
        }
    }

    /**
     * One conversation by id, from the cache or else the server — a
     * notification tap, or a chat restored after process death. The whole
     * inbox is never read to find one row.
     */
    suspend fun conversation(scope: CacheScope, conversationId: String): Conversation? {
        cached(scope, conversationId)?.let { return it }
        return lockFor(scope).withLock {
            val row = api.conversation(scope.workspaceId, conversationId) ?: return@withLock null
            store.writeConversations(scope, listOf(row), now = clock())
            diag.info(AREA, "conversation ${Diag.id(conversationId)} fetched by id")
            row
        }
    }

    /**
     * Keeps a row the caller already holds, without claiming anything about
     * which queue it is in. An older copy than the cache's is ignored.
     */
    suspend fun remember(scope: CacheScope, conversation: Conversation) {
        runCatching { store.writeConversations(scope, listOf(conversation), now = clock()) }
    }

    suspend fun idsForContact(scope: CacheScope, contactId: String): List<String> =
        runCatching { store.conversationIdsForContact(scope, contactId) }.getOrDefault(emptyList())

    suspend fun markOpened(scope: CacheScope, conversationId: String) {
        runCatching { store.markOpened(scope, conversationId, clock()) }
    }

    /**
     * Optimistic: the badge goes the moment the thread is marked seen. The
     * next read of the row carries the server's own count either way.
     */
    suspend fun clearUnread(scope: CacheScope, conversationId: String) {
        runCatching { store.clearUnread(scope, conversationId) }
    }

    // MARK: - Counters

    suspend fun cachedCounts(scope: CacheScope, queue: String): InboxCounts? =
        runCatching {
            store.syncState(scope, SyncKeys.counts(queue))?.payload
                ?.let { json.decodeFromString(InboxCounts.serializer(), it) }
        }.getOrNull()

    /** Advisory, like the badge it feeds: a failure keeps the last number. */
    suspend fun refreshCounts(scope: CacheScope, queue: String): InboxCounts? {
        val fresh = try {
            api.inboxCounts(scope.workspaceId, queue)
        } catch (e: ApiError) {
            return null
        }
        val key = SyncKeys.counts(queue)
        runCatching {
            store.putSyncState(
                scope,
                blank(scope, key).copy(payload = json.encodeToString(InboxCounts.serializer(), fresh), updatedAt = clock()),
            )
        }
        return fresh
    }

    private fun blank(scope: CacheScope, key: String) = SyncStateEntity(
        accountId = scope.accountId,
        workspaceId = scope.workspaceId,
        key = key,
        cursor = null,
        etag = null,
        fullReadAt = null,
        payload = null,
        updatedAt = clock(),
    )

    private companion object {
        const val AREA = "Sync"
    }
}

/** What a queue read found. */
sealed interface InboxRefresh {
    data object Unchanged : InboxRefresh
    data class Replaced(val count: Int) : InboxRefresh
}

/** `GET /api/conversations?ids=` answers for at most this many at once. */
private const val MAX_IDS_PER_READ = 100
