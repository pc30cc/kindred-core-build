package com.webyar.operator.core.cache

import com.webyar.operator.core.model.Conversation
import com.webyar.operator.core.model.Message
import kotlinx.coroutines.flow.Flow

/**
 * The cache, as the sync layer sees it: rows in, flows out.
 *
 * Deliberately a set of primitives. The DECISIONS — which copy of a message
 * wins, when a cursor may move, what a full read deletes — live once, in the
 * repositories, and are the same whichever store is underneath. There are
 * two: [RoomCacheStore], which the app runs on, and [MemoryCacheStore],
 * which the JVM tests and the sample backend run on. A store that made its
 * own merge decisions would make the tests test the wrong one.
 */
interface CacheStore {

    // MARK: - Conversations

    /** One queue as last known, newest first. */
    fun observeList(scope: CacheScope, listKey: String): Flow<List<Conversation>>

    fun observeConversation(scope: CacheScope, conversationId: String): Flow<Conversation?>

    suspend fun conversation(scope: CacheScope, conversationId: String): Conversation?

    /**
     * Rows as the server just described them.
     *
     * A row whose stored revision (`updated_at`) is NEWER than the incoming
     * one is kept: a slow response must not put back a state a realtime event
     * already moved past.
     *
     * With [listKey], the queue's membership is also set: [present] ids are
     * in it, [absent] ids are not. With [replaceList], membership becomes
     * exactly the incoming rows — a full read of the queue.
     */
    suspend fun writeConversations(
        scope: CacheScope,
        rows: List<Conversation>,
        listKey: String? = null,
        replaceList: Boolean = false,
        absent: Collection<String> = emptyList(),
        now: Long,
    )

    /** Gone from the server: the row, its queue entries, its transcript, its cursor. */
    suspend fun removeConversation(scope: CacheScope, conversationId: String)

    suspend fun conversationIdsForContact(scope: CacheScope, contactId: String): List<String>

    suspend fun markOpened(scope: CacheScope, conversationId: String, now: Long)

    suspend fun clearUnread(scope: CacheScope, conversationId: String)

    // MARK: - Sync state

    suspend fun syncState(scope: CacheScope, key: String): SyncStateEntity?

    suspend fun putSyncState(scope: CacheScope, state: SyncStateEntity)

    // MARK: - Messages

    fun observeThread(scope: CacheScope, conversationId: String): Flow<List<Message>>

    /**
     * Runs [block] as one transaction on one thread's rows and its cursor.
     * Either all of it lands or none of it does — which is what keeps the
     * cursor from ever getting ahead of the rows it claims to cover.
     */
    suspend fun <T> thread(scope: CacheScope, conversationId: String, block: suspend ThreadWriter.() -> T): T

    suspend fun message(scope: CacheScope, localId: String): MessageEntity?

    /** Pending and failed messages in this scope, oldest first. */
    suspend fun outbox(scope: CacheScope): List<MessageEntity>

    // MARK: - Housekeeping

    suspend fun threadWeights(): List<ThreadWeight>

    /** The confirmed rows and the cursor of one transcript; its outbox stays. */
    suspend fun evictThread(accountId: String, workspaceId: String, conversationId: String)

    suspend fun listRefs(): List<ListRef>

    suspend fun dropList(accountId: String, workspaceId: String, listKey: String)

    suspend fun dropOrphanConversations(before: Long): Int

    /** Sign-out: every row the account ever cached. */
    suspend fun purgeAccount(accountId: String)

    /** Clear Cache: everything but the outbox, and every cursor with it. */
    suspend fun clear()

    suspend fun stats(): CacheStats
}

/** The rows of one transcript, inside a transaction. */
interface ThreadWriter {
    val scope: CacheScope
    val conversationId: String

    suspend fun byServerIds(ids: Collection<String>): List<MessageEntity>
    suspend fun byClientIds(ids: Collection<String>): List<MessageEntity>
    suspend fun keys(): List<MessageKeyRow>
    suspend fun upsert(rows: List<MessageEntity>)
    suspend fun delete(localIds: Collection<String>)
    suspend fun state(): SyncStateEntity?
    suspend fun putState(state: SyncStateEntity)
    suspend fun clearState()
}

data class CacheStats(
    val conversations: Int,
    val messages: Int,
    /** The database file, its WAL and journal; 0 for a store in memory. */
    val bytes: Long,
)

/** The keys [SyncStateEntity] rows are stored under. */
object SyncKeys {
    fun thread(conversationId: String) = "thread:$conversationId"
    fun list(listKey: String) = "list:$listKey"
    fun counts(queue: String) = "counts:$queue"

    fun listKeyOf(syncKey: String): String? = syncKey.removePrefix("list:").takeIf { syncKey.startsWith("list:") }
}

/** Which of two copies of a conversation row is the newer. */
internal object ConversationRevision {
    /**
     * True when [incoming] is older than what is [stored]. Equal revisions
     * take the incoming copy: `unread_count` and the preview are computed on
     * every read and can move without `updated_at` moving.
     */
    fun isStale(incoming: Conversation, stored: ConversationEntity?): Boolean {
        val have = stored?.updatedAt ?: return false
        val got = incoming.updatedAt?.toEpochMilli() ?: return false
        return got < have
    }
}
