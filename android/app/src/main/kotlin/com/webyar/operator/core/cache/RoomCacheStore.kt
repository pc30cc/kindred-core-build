package com.webyar.operator.core.cache

import android.content.Context
import androidx.room.withTransaction
import com.webyar.operator.core.Diag
import com.webyar.operator.core.model.Conversation
import com.webyar.operator.core.model.Message
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.retryWhen
import java.io.File

/**
 * The cache the app runs on.
 *
 * Every call goes through [io], which is where damage is noticed: a query
 * that finds the file corrupt resets the database (the server resyncs it)
 * and the failure is still reported to the caller, which treats a failed
 * cache write the way it treats a failed request — the screen keeps what it
 * has and the next sync tries again.
 *
 * Flows re-subscribe whenever [CacheDatabaseHolder.generation] moves, so a
 * reset mid-session is seen by every open screen as the list going empty for
 * a moment and then refilling — not as a screen that stopped updating.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class RoomCacheStore(
    private val context: Context,
    private val holder: CacheDatabaseHolder,
    private val log: Diag = Diag.Android,
) : CacheStore {

    private suspend fun <T> io(block: suspend (CacheDatabase) -> T): T {
        val db = holder.get()
        return try {
            block(db)
        } catch (e: Throwable) {
            if (e.isCacheCorruption()) holder.reset("corruption: ${e.javaClass.simpleName}")
            throw e
        }
    }

    /** A Room flow that survives a database reset and a corrupt read. */
    private fun <R, T> observe(query: (CacheDatabase) -> Flow<R>, transform: (R) -> T, empty: T): Flow<T> =
        holder.generation.flatMapLatest {
            val db = holder.get()
            query(db)
                .map(transform)
                // Busy, locked, a moment of I/O trouble: the rows are still
                // there, so keep what is on screen and read again shortly.
                // Only a damaged file is worth a reset.
                .retryWhen { e, attempt ->
                    if (e is CancellationException || e.isCacheCorruption()) return@retryWhen false
                    log.warn(AREA, "cache read failed, retrying: ${e.javaClass.simpleName}")
                    delay(minOf(READ_RETRY_MAX_MS, READ_RETRY_BASE_MS shl attempt.coerceAtMost(6L).toInt()))
                    true
                }
                .catch { e ->
                    log.warn(AREA, "cache read failed: ${e.javaClass.simpleName}")
                    if (e.isCacheCorruption()) holder.reset("corruption on read")
                    emit(empty)
                }
        }
            .distinctUntilChanged()
            // Mapping a thousand-row transcript is not work for the main thread.
            .flowOn(Dispatchers.Default)

    // MARK: - Conversations

    override fun observeList(scope: CacheScope, listKey: String): Flow<List<Conversation>> =
        observe(
            { it.conversations().observeList(scope.accountId, scope.workspaceId, listKey) },
            { rows -> rows.map(CacheMapping::toConversation) },
            emptyList(),
        )

    override fun observeConversation(scope: CacheScope, conversationId: String): Flow<Conversation?> =
        observe(
            { it.conversations().observe(scope.accountId, scope.workspaceId, conversationId) },
            { row -> row?.let(CacheMapping::toConversation) },
            null,
        )

    override suspend fun conversation(scope: CacheScope, conversationId: String): Conversation? = io { db ->
        db.conversations().get(scope.accountId, scope.workspaceId, conversationId)?.let(CacheMapping::toConversation)
    }

    override suspend fun writeConversations(
        scope: CacheScope,
        rows: List<Conversation>,
        listKey: String?,
        replaceList: Boolean,
        absent: Collection<String>,
        now: Long,
    ) = io { db ->
        db.withTransaction {
            val dao = db.conversations()
            val a = scope.accountId
            val w = scope.workspaceId
            val stored = rows.map { it.id }.distinct().chunked(SQL_CHUNK)
                .flatMap { dao.getAll(a, w, it) }
                .associateBy { it.conversationId }
            val fresh = rows.mapNotNull { row ->
                val old = stored[row.id]
                if (ConversationRevision.isStale(row, old)) null else CacheMapping.toEntity(scope, row, now, old?.openedAt)
            }
            if (fresh.isNotEmpty()) dao.upsert(fresh)

            if (listKey != null) {
                val incoming = rows.map { it.id }.toSet()
                if (replaceList) {
                    val gone = dao.listIds(a, w, listKey).filter { it !in incoming }
                    gone.chunked(SQL_CHUNK).forEach { dao.removeEntries(a, w, listKey, it) }
                }
                if (incoming.isNotEmpty()) dao.upsertEntries(incoming.map { InboxEntryEntity(a, w, listKey, it) })
                absent.filter { it !in incoming }.chunked(SQL_CHUNK).forEach { dao.removeEntries(a, w, listKey, it) }
            }
        }
    }

    override suspend fun removeConversation(scope: CacheScope, conversationId: String) = io { db ->
        db.withTransaction {
            db.conversations().removeFromAllLists(scope.accountId, scope.workspaceId, conversationId)
            db.conversations().delete(scope.accountId, scope.workspaceId, conversationId)
            db.messages().deleteThread(scope.accountId, scope.workspaceId, conversationId)
            db.syncState().delete(scope.accountId, scope.workspaceId, SyncKeys.thread(conversationId))
        }
    }

    override suspend fun conversationIdsForContact(scope: CacheScope, contactId: String): List<String> = io { db ->
        db.conversations().idsForContact(scope.accountId, scope.workspaceId, contactId)
    }

    override suspend fun markOpened(scope: CacheScope, conversationId: String, now: Long) = io { db ->
        db.conversations().markOpened(scope.accountId, scope.workspaceId, conversationId, now)
    }

    override suspend fun clearUnread(scope: CacheScope, conversationId: String) = io { db ->
        db.conversations().clearUnread(scope.accountId, scope.workspaceId, conversationId)
    }

    // MARK: - Sync state

    override suspend fun syncState(scope: CacheScope, key: String): SyncStateEntity? = io { db ->
        db.syncState().get(scope.accountId, scope.workspaceId, key)
    }

    override suspend fun putSyncState(scope: CacheScope, state: SyncStateEntity) = io { db ->
        require(state.accountId == scope.accountId && state.workspaceId == scope.workspaceId)
        db.syncState().upsert(state)
    }

    // MARK: - Messages

    override fun observeThread(scope: CacheScope, conversationId: String): Flow<List<Message>> =
        observe(
            { it.messages().observeThread(scope.accountId, scope.workspaceId, conversationId) },
            { rows -> rows.map(CacheMapping::toMessage) },
            emptyList(),
        )

    override suspend fun <T> thread(
        scope: CacheScope,
        conversationId: String,
        block: suspend ThreadWriter.() -> T,
    ): T = io { db ->
        db.withTransaction { RoomThreadWriter(db, scope, conversationId).block() }
    }

    override suspend fun message(scope: CacheScope, localId: String): MessageEntity? = io { db ->
        db.messages().get(scope.accountId, localId)?.takeIf { it.workspaceId == scope.workspaceId }
    }

    override suspend fun outbox(scope: CacheScope): List<MessageEntity> = io { db ->
        db.messages().outbox(scope.accountId, scope.workspaceId)
    }

    // MARK: - Housekeeping

    override suspend fun threadWeights(): List<ThreadWeight> = io { it.maintenance().threadWeights() }

    override suspend fun evictThread(accountId: String, workspaceId: String, conversationId: String) = io { db ->
        db.withTransaction {
            db.messages().deleteConfirmed(accountId, workspaceId, conversationId)
            db.maintenance().dropSyncState(accountId, workspaceId, SyncKeys.thread(conversationId))
        }
    }

    override suspend fun listRefs(): List<ListRef> = io { it.maintenance().lists() }

    override suspend fun dropList(accountId: String, workspaceId: String, listKey: String) = io { db ->
        db.withTransaction {
            db.maintenance().dropList(accountId, workspaceId, listKey)
            db.maintenance().dropSyncState(accountId, workspaceId, SyncKeys.list(listKey))
        }
    }

    override suspend fun dropOrphanConversations(before: Long): Int = io { it.maintenance().dropOrphanConversations(before) }

    override suspend fun purgeAccount(accountId: String) = io { db ->
        db.withTransaction {
            val m = db.maintenance()
            m.purgeMessages(accountId)
            m.purgeEntries(accountId)
            m.purgeConversations(accountId)
            m.purgeSyncState(accountId)
        }
    }

    override suspend fun clear() = io { db ->
        db.withTransaction {
            val m = db.maintenance()
            m.clearConfirmedMessages()
            m.clearEntries()
            m.clearConversationsWithoutOutbox()
            m.clearSyncState()
        }
    }

    override suspend fun stats(): CacheStats = io { db ->
        val m = db.maintenance()
        CacheStats(conversations = m.conversationCount(), messages = m.messageCount(), bytes = fileBytes())
    }

    private fun fileBytes(): Long {
        if (holder.isVolatile) return 0L
        val main = context.getDatabasePath(holder.fileName ?: return 0L)
        return listOf("", "-wal", "-shm", "-journal")
            .sumOf { suffix -> File(main.path + suffix).takeIf { it.exists() }?.length() ?: 0L }
    }

    private class RoomThreadWriter(
        private val db: CacheDatabase,
        override val scope: CacheScope,
        override val conversationId: String,
    ) : ThreadWriter {
        private val a get() = scope.accountId
        private val w get() = scope.workspaceId

        override suspend fun byServerIds(ids: Collection<String>): List<MessageEntity> =
            ids.distinct().chunked(SQL_CHUNK).flatMap { db.messages().byServerIds(a, w, conversationId, it) }

        override suspend fun byClientIds(ids: Collection<String>): List<MessageEntity> =
            ids.distinct().chunked(SQL_CHUNK).flatMap { db.messages().byClientIds(a, w, conversationId, it) }

        override suspend fun keys(): List<MessageKeyRow> = db.messages().keys(a, w, conversationId)

        override suspend fun upsert(rows: List<MessageEntity>) {
            if (rows.isEmpty()) return
            require(rows.all { it.accountId == a && it.workspaceId == w && it.conversationId == conversationId })
            db.messages().upsert(rows)
        }

        override suspend fun delete(localIds: Collection<String>) {
            localIds.distinct().chunked(SQL_CHUNK).forEach { db.messages().delete(a, it) }
        }

        override suspend fun state(): SyncStateEntity? = db.syncState().get(a, w, SyncKeys.thread(conversationId))

        override suspend fun putState(state: SyncStateEntity) {
            require(state.accountId == a && state.workspaceId == w && state.key == SyncKeys.thread(conversationId))
            db.syncState().upsert(state)
        }

        override suspend fun clearState() = db.syncState().delete(a, w, SyncKeys.thread(conversationId))
    }
}

/** A read that failed for a reason other than damage is tried again, backing off to this. */
private const val READ_RETRY_BASE_MS = 500L
private const val READ_RETRY_MAX_MS = 30_000L
