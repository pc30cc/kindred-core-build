package com.webyar.operator.core.cache

import androidx.room.ColumnInfo
import androidx.room.Dao
import androidx.room.Query
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

// Every query names an account, and every query that returns user content
// names a workspace too. There is deliberately no "SELECT * FROM messages"
// anywhere in this file: a query that could return another account's rows is
// a query that eventually will.
//
// `IN (:ids)` lists are chunked by the callers (see [SQL_CHUNK]): API 24's
// SQLite allows 999 bound variables per statement.

internal const val SQL_CHUNK = 500

@Dao
interface ConversationDao {

    /**
     * One queue, in the order the server sorts it: `updated_at`, newest first.
     * The server's own order, reproduced, so a row a realtime event touched
     * moves to where the next full read would put it.
     */
    @Query(
        """
        SELECT c.* FROM conversations AS c
        INNER JOIN inbox_entries AS e
            ON e.account_id = c.account_id
            AND e.workspace_id = c.workspace_id
            AND e.conversation_id = c.conversation_id
        WHERE e.account_id = :accountId AND e.workspace_id = :workspaceId AND e.list_key = :listKey
        ORDER BY c.updated_at DESC, c.conversation_id ASC
        """
    )
    fun observeList(accountId: String, workspaceId: String, listKey: String): Flow<List<ConversationEntity>>

    @Query(
        """
        SELECT * FROM conversations
        WHERE account_id = :accountId AND workspace_id = :workspaceId AND conversation_id = :conversationId
        """
    )
    fun observe(accountId: String, workspaceId: String, conversationId: String): Flow<ConversationEntity?>

    @Query(
        """
        SELECT * FROM conversations
        WHERE account_id = :accountId AND workspace_id = :workspaceId AND conversation_id = :conversationId
        """
    )
    suspend fun get(accountId: String, workspaceId: String, conversationId: String): ConversationEntity?

    @Query(
        """
        SELECT * FROM conversations
        WHERE account_id = :accountId AND workspace_id = :workspaceId AND conversation_id IN (:ids)
        """
    )
    suspend fun getAll(accountId: String, workspaceId: String, ids: List<String>): List<ConversationEntity>

    @Upsert
    suspend fun upsert(rows: List<ConversationEntity>)

    @Query(
        """
        SELECT conversation_id FROM inbox_entries
        WHERE account_id = :accountId AND workspace_id = :workspaceId AND list_key = :listKey
        """
    )
    suspend fun listIds(accountId: String, workspaceId: String, listKey: String): List<String>

    @Upsert
    suspend fun upsertEntries(rows: List<InboxEntryEntity>)

    @Query(
        """
        DELETE FROM inbox_entries
        WHERE account_id = :accountId AND workspace_id = :workspaceId AND list_key = :listKey
            AND conversation_id IN (:ids)
        """
    )
    suspend fun removeEntries(accountId: String, workspaceId: String, listKey: String, ids: List<String>)

    @Query(
        """
        DELETE FROM inbox_entries
        WHERE account_id = :accountId AND workspace_id = :workspaceId AND conversation_id = :conversationId
        """
    )
    suspend fun removeFromAllLists(accountId: String, workspaceId: String, conversationId: String)

    @Query(
        """
        DELETE FROM conversations
        WHERE account_id = :accountId AND workspace_id = :workspaceId AND conversation_id = :conversationId
        """
    )
    suspend fun delete(accountId: String, workspaceId: String, conversationId: String)

    @Query(
        """
        SELECT conversation_id FROM conversations
        WHERE account_id = :accountId AND workspace_id = :workspaceId AND contact_id = :contactId
        """
    )
    suspend fun idsForContact(accountId: String, workspaceId: String, contactId: String): List<String>

    @Query(
        """
        UPDATE conversations SET opened_at = :at
        WHERE account_id = :accountId AND workspace_id = :workspaceId AND conversation_id = :conversationId
        """
    )
    suspend fun markOpened(accountId: String, workspaceId: String, conversationId: String, at: Long)

    @Query(
        """
        UPDATE conversations SET unread_count = 0
        WHERE account_id = :accountId AND workspace_id = :workspaceId AND conversation_id = :conversationId
        """
    )
    suspend fun clearUnread(accountId: String, workspaceId: String, conversationId: String)
}

/** The columns a full re-read needs to decide what the server dropped. */
data class MessageKeyRow(
    @ColumnInfo(name = "local_id") val localId: String,
    @ColumnInfo(name = "server_id") val serverId: String?,
    @ColumnInfo(name = "send_state") val sendState: Int,
    @ColumnInfo(name = "cached_at") val cachedAt: Long,
)

@Dao
interface MessageDao {

    /**
     * The transcript: oldest first, the server's order (`created_at`, then
     * id). A pending message sorts by when it was written, which puts it at
     * the bottom where the operator just typed it.
     */
    @Query(
        """
        SELECT * FROM messages
        WHERE account_id = :accountId AND workspace_id = :workspaceId AND conversation_id = :conversationId
        ORDER BY sort_at ASC, server_id ASC, local_id ASC
        """
    )
    fun observeThread(accountId: String, workspaceId: String, conversationId: String): Flow<List<MessageEntity>>

    @Query(
        """
        SELECT * FROM messages
        WHERE account_id = :accountId AND workspace_id = :workspaceId AND conversation_id = :conversationId
            AND server_id IN (:serverIds)
        """
    )
    suspend fun byServerIds(
        accountId: String,
        workspaceId: String,
        conversationId: String,
        serverIds: List<String>,
    ): List<MessageEntity>

    @Query(
        """
        SELECT * FROM messages
        WHERE account_id = :accountId AND workspace_id = :workspaceId AND conversation_id = :conversationId
            AND client_message_id IN (:clientIds)
        """
    )
    suspend fun byClientIds(
        accountId: String,
        workspaceId: String,
        conversationId: String,
        clientIds: List<String>,
    ): List<MessageEntity>

    @Query(
        """
        SELECT local_id, server_id, send_state, cached_at FROM messages
        WHERE account_id = :accountId AND workspace_id = :workspaceId AND conversation_id = :conversationId
        """
    )
    suspend fun keys(accountId: String, workspaceId: String, conversationId: String): List<MessageKeyRow>

    @Query("SELECT * FROM messages WHERE account_id = :accountId AND local_id = :localId")
    suspend fun get(accountId: String, localId: String): MessageEntity?

    @Upsert
    suspend fun upsert(rows: List<MessageEntity>)

    @Query("DELETE FROM messages WHERE account_id = :accountId AND local_id IN (:localIds)")
    suspend fun delete(accountId: String, localIds: List<String>)

    /** Everything the server confirmed; the outbox is never evicted. */
    @Query(
        """
        DELETE FROM messages
        WHERE account_id = :accountId AND workspace_id = :workspaceId AND conversation_id = :conversationId
            AND send_state = 0
        """
    )
    suspend fun deleteConfirmed(accountId: String, workspaceId: String, conversationId: String)

    @Query(
        """
        DELETE FROM messages
        WHERE account_id = :accountId AND workspace_id = :workspaceId AND conversation_id = :conversationId
        """
    )
    suspend fun deleteThread(accountId: String, workspaceId: String, conversationId: String)

    @Query(
        """
        SELECT * FROM messages
        WHERE account_id = :accountId AND workspace_id = :workspaceId AND send_state != 0
        ORDER BY sort_at ASC
        """
    )
    suspend fun outbox(accountId: String, workspaceId: String): List<MessageEntity>
}

@Dao
interface SyncStateDao {
    @Query(
        """
        SELECT * FROM sync_state
        WHERE account_id = :accountId AND workspace_id = :workspaceId AND sync_key = :key
        """
    )
    suspend fun get(accountId: String, workspaceId: String, key: String): SyncStateEntity?

    @Upsert
    suspend fun upsert(row: SyncStateEntity)

    @Query(
        """
        DELETE FROM sync_state
        WHERE account_id = :accountId AND workspace_id = :workspaceId AND sync_key = :key
        """
    )
    suspend fun delete(accountId: String, workspaceId: String, key: String)
}

/** One cached transcript, for retention to weigh. */
data class ThreadWeight(
    @ColumnInfo(name = "account_id") val accountId: String,
    @ColumnInfo(name = "workspace_id") val workspaceId: String,
    @ColumnInfo(name = "conversation_id") val conversationId: String,
    @ColumnInfo(name = "message_count") val messageCount: Int,
    @ColumnInfo(name = "opened_at") val openedAt: Long?,
)

/** A queue some scope holds, and when it was last read. */
data class ListRef(
    @ColumnInfo(name = "account_id") val accountId: String,
    @ColumnInfo(name = "workspace_id") val workspaceId: String,
    @ColumnInfo(name = "sync_key") val key: String,
    @ColumnInfo(name = "updated_at") val updatedAt: Long,
)

/**
 * The housekeeping queries: retention, sign-out, Clear Cache, the numbers
 * the Storage screen shows. The only DAO allowed to span accounts, and only
 * to count or to delete.
 */
@Dao
interface MaintenanceDao {

    @Query("SELECT COUNT(*) FROM messages")
    suspend fun messageCount(): Int

    @Query("SELECT COUNT(*) FROM conversations")
    suspend fun conversationCount(): Int

    /**
     * Every cached transcript, least recently opened first — which is the
     * order retention gives them up in. A thread never opened sorts first
     * (SQLite puts NULL before any value in ascending order).
     */
    @Query(
        """
        SELECT m.account_id AS account_id, m.workspace_id AS workspace_id,
            m.conversation_id AS conversation_id, COUNT(*) AS message_count,
            c.opened_at AS opened_at
        FROM messages AS m
        LEFT JOIN conversations AS c
            ON c.account_id = m.account_id
            AND c.workspace_id = m.workspace_id
            AND c.conversation_id = m.conversation_id
        WHERE m.send_state = 0
        GROUP BY m.account_id, m.workspace_id, m.conversation_id
        ORDER BY c.opened_at ASC
        """
    )
    suspend fun threadWeights(): List<ThreadWeight>

    @Query("SELECT account_id, workspace_id, sync_key, updated_at FROM sync_state WHERE sync_key LIKE 'list:%'")
    suspend fun lists(): List<ListRef>

    @Query(
        """
        DELETE FROM inbox_entries
        WHERE account_id = :accountId AND workspace_id = :workspaceId AND list_key = :listKey
        """
    )
    suspend fun dropList(accountId: String, workspaceId: String, listKey: String)

    /**
     * Conversations nothing needs any more: in no queue, no cached
     * transcript, not opened since [before].
     */
    @Query(
        """
        DELETE FROM conversations
        WHERE (opened_at IS NULL OR opened_at < :before) AND cached_at < :before
            AND NOT EXISTS (
                SELECT 1 FROM inbox_entries AS e
                WHERE e.account_id = conversations.account_id
                    AND e.workspace_id = conversations.workspace_id
                    AND e.conversation_id = conversations.conversation_id
            )
            AND NOT EXISTS (
                SELECT 1 FROM messages AS m
                WHERE m.account_id = conversations.account_id
                    AND m.workspace_id = conversations.workspace_id
                    AND m.conversation_id = conversations.conversation_id
            )
        """
    )
    suspend fun dropOrphanConversations(before: Long): Int

    @Query("DELETE FROM sync_state WHERE account_id = :accountId AND workspace_id = :workspaceId AND sync_key = :key")
    suspend fun dropSyncState(accountId: String, workspaceId: String, key: String)

    // Sign-out: everything that account ever cached, and nothing else.
    @Query("DELETE FROM messages WHERE account_id = :accountId")
    suspend fun purgeMessages(accountId: String)

    @Query("DELETE FROM inbox_entries WHERE account_id = :accountId")
    suspend fun purgeEntries(accountId: String)

    @Query("DELETE FROM conversations WHERE account_id = :accountId")
    suspend fun purgeConversations(accountId: String)

    @Query("DELETE FROM sync_state WHERE account_id = :accountId")
    suspend fun purgeSyncState(accountId: String)

    /** Clear Cache keeps the outbox: a message the operator wrote is not cache. */
    @Query("DELETE FROM messages WHERE send_state = 0")
    suspend fun clearConfirmedMessages()

    @Query("DELETE FROM inbox_entries")
    suspend fun clearEntries()

    @Query(
        """
        DELETE FROM conversations
        WHERE NOT EXISTS (
            SELECT 1 FROM messages AS m
            WHERE m.account_id = conversations.account_id
                AND m.workspace_id = conversations.workspace_id
                AND m.conversation_id = conversations.conversation_id
        )
        """
    )
    suspend fun clearConversationsWithoutOutbox()

    @Query("DELETE FROM sync_state")
    suspend fun clearSyncState()
}
