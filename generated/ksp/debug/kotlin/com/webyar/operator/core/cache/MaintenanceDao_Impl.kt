package com.webyar.`operator`.core.cache

import androidx.room.RoomDatabase
import androidx.room.util.getTotalChangedRows
import androidx.room.util.performSuspending
import androidx.sqlite.SQLiteStatement
import javax.`annotation`.processing.Generated
import kotlin.Int
import kotlin.Long
import kotlin.String
import kotlin.Suppress
import kotlin.collections.List
import kotlin.collections.MutableList
import kotlin.collections.mutableListOf
import kotlin.reflect.KClass

@Generated(value = ["androidx.room.RoomProcessor"])
@Suppress(names = ["UNCHECKED_CAST", "DEPRECATION", "REDUNDANT_PROJECTION", "REMOVAL"])
public class MaintenanceDao_Impl(
  __db: RoomDatabase,
) : MaintenanceDao {
  private val __db: RoomDatabase
  init {
    this.__db = __db
  }

  public override suspend fun messageCount(): Int {
    val _sql: String = "SELECT COUNT(*) FROM messages"
    return performSuspending(__db, true, false) { _connection ->
      val _stmt: SQLiteStatement = _connection.prepare(_sql)
      try {
        val _result: Int
        if (_stmt.step()) {
          val _tmp: Int
          _tmp = _stmt.getLong(0).toInt()
          _result = _tmp
        } else {
          _result = 0
        }
        _result
      } finally {
        _stmt.close()
      }
    }
  }

  public override suspend fun conversationCount(): Int {
    val _sql: String = "SELECT COUNT(*) FROM conversations"
    return performSuspending(__db, true, false) { _connection ->
      val _stmt: SQLiteStatement = _connection.prepare(_sql)
      try {
        val _result: Int
        if (_stmt.step()) {
          val _tmp: Int
          _tmp = _stmt.getLong(0).toInt()
          _result = _tmp
        } else {
          _result = 0
        }
        _result
      } finally {
        _stmt.close()
      }
    }
  }

  public override suspend fun threadWeights(): List<ThreadWeight> {
    val _sql: String = """
        |
        |        SELECT m.account_id AS account_id, m.workspace_id AS workspace_id,
        |            m.conversation_id AS conversation_id, COUNT(*) AS message_count,
        |            c.opened_at AS opened_at
        |        FROM messages AS m
        |        LEFT JOIN conversations AS c
        |            ON c.account_id = m.account_id
        |            AND c.workspace_id = m.workspace_id
        |            AND c.conversation_id = m.conversation_id
        |        WHERE m.send_state = 0
        |        GROUP BY m.account_id, m.workspace_id, m.conversation_id
        |        ORDER BY c.opened_at ASC
        |        
        """.trimMargin()
    return performSuspending(__db, true, false) { _connection ->
      val _stmt: SQLiteStatement = _connection.prepare(_sql)
      try {
        val _columnIndexOfAccountId: Int = 0
        val _columnIndexOfWorkspaceId: Int = 1
        val _columnIndexOfConversationId: Int = 2
        val _columnIndexOfMessageCount: Int = 3
        val _columnIndexOfOpenedAt: Int = 4
        val _result: MutableList<ThreadWeight> = mutableListOf()
        while (_stmt.step()) {
          val _item: ThreadWeight
          val _tmpAccountId: String
          _tmpAccountId = _stmt.getText(_columnIndexOfAccountId)
          val _tmpWorkspaceId: String
          _tmpWorkspaceId = _stmt.getText(_columnIndexOfWorkspaceId)
          val _tmpConversationId: String
          _tmpConversationId = _stmt.getText(_columnIndexOfConversationId)
          val _tmpMessageCount: Int
          _tmpMessageCount = _stmt.getLong(_columnIndexOfMessageCount).toInt()
          val _tmpOpenedAt: Long?
          if (_stmt.isNull(_columnIndexOfOpenedAt)) {
            _tmpOpenedAt = null
          } else {
            _tmpOpenedAt = _stmt.getLong(_columnIndexOfOpenedAt)
          }
          _item = ThreadWeight(_tmpAccountId,_tmpWorkspaceId,_tmpConversationId,_tmpMessageCount,_tmpOpenedAt)
          _result.add(_item)
        }
        _result
      } finally {
        _stmt.close()
      }
    }
  }

  public override suspend fun lists(): List<ListRef> {
    val _sql: String = "SELECT account_id, workspace_id, sync_key, updated_at FROM sync_state WHERE sync_key LIKE 'list:%'"
    return performSuspending(__db, true, false) { _connection ->
      val _stmt: SQLiteStatement = _connection.prepare(_sql)
      try {
        val _columnIndexOfAccountId: Int = 0
        val _columnIndexOfWorkspaceId: Int = 1
        val _columnIndexOfKey: Int = 2
        val _columnIndexOfUpdatedAt: Int = 3
        val _result: MutableList<ListRef> = mutableListOf()
        while (_stmt.step()) {
          val _item: ListRef
          val _tmpAccountId: String
          _tmpAccountId = _stmt.getText(_columnIndexOfAccountId)
          val _tmpWorkspaceId: String
          _tmpWorkspaceId = _stmt.getText(_columnIndexOfWorkspaceId)
          val _tmpKey: String
          _tmpKey = _stmt.getText(_columnIndexOfKey)
          val _tmpUpdatedAt: Long
          _tmpUpdatedAt = _stmt.getLong(_columnIndexOfUpdatedAt)
          _item = ListRef(_tmpAccountId,_tmpWorkspaceId,_tmpKey,_tmpUpdatedAt)
          _result.add(_item)
        }
        _result
      } finally {
        _stmt.close()
      }
    }
  }

  public override suspend fun dropList(
    accountId: String,
    workspaceId: String,
    listKey: String,
  ) {
    val _sql: String = """
        |
        |        DELETE FROM inbox_entries
        |        WHERE account_id = ? AND workspace_id = ? AND list_key = ?
        |        
        """.trimMargin()
    return performSuspending(__db, false, true) { _connection ->
      val _stmt: SQLiteStatement = _connection.prepare(_sql)
      try {
        var _argIndex: Int = 1
        _stmt.bindText(_argIndex, accountId)
        _argIndex = 2
        _stmt.bindText(_argIndex, workspaceId)
        _argIndex = 3
        _stmt.bindText(_argIndex, listKey)
        _stmt.step()
      } finally {
        _stmt.close()
      }
    }
  }

  public override suspend fun dropOrphanConversations(before: Long): Int {
    val _sql: String = """
        |
        |        DELETE FROM conversations
        |        WHERE (opened_at IS NULL OR opened_at < ?) AND cached_at < ?
        |            AND NOT EXISTS (
        |                SELECT 1 FROM inbox_entries AS e
        |                WHERE e.account_id = conversations.account_id
        |                    AND e.workspace_id = conversations.workspace_id
        |                    AND e.conversation_id = conversations.conversation_id
        |            )
        |            AND NOT EXISTS (
        |                SELECT 1 FROM messages AS m
        |                WHERE m.account_id = conversations.account_id
        |                    AND m.workspace_id = conversations.workspace_id
        |                    AND m.conversation_id = conversations.conversation_id
        |            )
        |        
        """.trimMargin()
    return performSuspending(__db, false, true) { _connection ->
      val _stmt: SQLiteStatement = _connection.prepare(_sql)
      try {
        var _argIndex: Int = 1
        _stmt.bindLong(_argIndex, before)
        _argIndex = 2
        _stmt.bindLong(_argIndex, before)
        _stmt.step()
        getTotalChangedRows(_connection)
      } finally {
        _stmt.close()
      }
    }
  }

  public override suspend fun dropSyncState(
    accountId: String,
    workspaceId: String,
    key: String,
  ) {
    val _sql: String = "DELETE FROM sync_state WHERE account_id = ? AND workspace_id = ? AND sync_key = ?"
    return performSuspending(__db, false, true) { _connection ->
      val _stmt: SQLiteStatement = _connection.prepare(_sql)
      try {
        var _argIndex: Int = 1
        _stmt.bindText(_argIndex, accountId)
        _argIndex = 2
        _stmt.bindText(_argIndex, workspaceId)
        _argIndex = 3
        _stmt.bindText(_argIndex, key)
        _stmt.step()
      } finally {
        _stmt.close()
      }
    }
  }

  public override suspend fun purgeMessages(accountId: String) {
    val _sql: String = "DELETE FROM messages WHERE account_id = ?"
    return performSuspending(__db, false, true) { _connection ->
      val _stmt: SQLiteStatement = _connection.prepare(_sql)
      try {
        var _argIndex: Int = 1
        _stmt.bindText(_argIndex, accountId)
        _stmt.step()
      } finally {
        _stmt.close()
      }
    }
  }

  public override suspend fun purgeEntries(accountId: String) {
    val _sql: String = "DELETE FROM inbox_entries WHERE account_id = ?"
    return performSuspending(__db, false, true) { _connection ->
      val _stmt: SQLiteStatement = _connection.prepare(_sql)
      try {
        var _argIndex: Int = 1
        _stmt.bindText(_argIndex, accountId)
        _stmt.step()
      } finally {
        _stmt.close()
      }
    }
  }

  public override suspend fun purgeConversations(accountId: String) {
    val _sql: String = "DELETE FROM conversations WHERE account_id = ?"
    return performSuspending(__db, false, true) { _connection ->
      val _stmt: SQLiteStatement = _connection.prepare(_sql)
      try {
        var _argIndex: Int = 1
        _stmt.bindText(_argIndex, accountId)
        _stmt.step()
      } finally {
        _stmt.close()
      }
    }
  }

  public override suspend fun purgeSyncState(accountId: String) {
    val _sql: String = "DELETE FROM sync_state WHERE account_id = ?"
    return performSuspending(__db, false, true) { _connection ->
      val _stmt: SQLiteStatement = _connection.prepare(_sql)
      try {
        var _argIndex: Int = 1
        _stmt.bindText(_argIndex, accountId)
        _stmt.step()
      } finally {
        _stmt.close()
      }
    }
  }

  public override suspend fun clearConfirmedMessages() {
    val _sql: String = "DELETE FROM messages WHERE send_state = 0"
    return performSuspending(__db, false, true) { _connection ->
      val _stmt: SQLiteStatement = _connection.prepare(_sql)
      try {
        _stmt.step()
      } finally {
        _stmt.close()
      }
    }
  }

  public override suspend fun clearEntries() {
    val _sql: String = "DELETE FROM inbox_entries"
    return performSuspending(__db, false, true) { _connection ->
      val _stmt: SQLiteStatement = _connection.prepare(_sql)
      try {
        _stmt.step()
      } finally {
        _stmt.close()
      }
    }
  }

  public override suspend fun clearConversationsWithoutOutbox() {
    val _sql: String = """
        |
        |        DELETE FROM conversations
        |        WHERE NOT EXISTS (
        |            SELECT 1 FROM messages AS m
        |            WHERE m.account_id = conversations.account_id
        |                AND m.workspace_id = conversations.workspace_id
        |                AND m.conversation_id = conversations.conversation_id
        |        )
        |        
        """.trimMargin()
    return performSuspending(__db, false, true) { _connection ->
      val _stmt: SQLiteStatement = _connection.prepare(_sql)
      try {
        _stmt.step()
      } finally {
        _stmt.close()
      }
    }
  }

  public override suspend fun clearSyncState() {
    val _sql: String = "DELETE FROM sync_state"
    return performSuspending(__db, false, true) { _connection ->
      val _stmt: SQLiteStatement = _connection.prepare(_sql)
      try {
        _stmt.step()
      } finally {
        _stmt.close()
      }
    }
  }

  public companion object {
    public fun getRequiredConverters(): List<KClass<*>> = emptyList()
  }
}
