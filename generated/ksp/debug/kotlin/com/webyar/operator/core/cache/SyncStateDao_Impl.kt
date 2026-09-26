package com.webyar.`operator`.core.cache

import androidx.room.EntityDeleteOrUpdateAdapter
import androidx.room.EntityInsertAdapter
import androidx.room.EntityUpsertAdapter
import androidx.room.RoomDatabase
import androidx.room.util.getColumnIndexOrThrow
import androidx.room.util.performSuspending
import androidx.sqlite.SQLiteStatement
import javax.`annotation`.processing.Generated
import kotlin.Int
import kotlin.Long
import kotlin.String
import kotlin.Suppress
import kotlin.Unit
import kotlin.collections.List
import kotlin.reflect.KClass

@Generated(value = ["androidx.room.RoomProcessor"])
@Suppress(names = ["UNCHECKED_CAST", "DEPRECATION", "REDUNDANT_PROJECTION", "REMOVAL"])
public class SyncStateDao_Impl(
  __db: RoomDatabase,
) : SyncStateDao {
  private val __db: RoomDatabase

  private val __upsertAdapterOfSyncStateEntity: EntityUpsertAdapter<SyncStateEntity>
  init {
    this.__db = __db
    this.__upsertAdapterOfSyncStateEntity = EntityUpsertAdapter<SyncStateEntity>(object : EntityInsertAdapter<SyncStateEntity>() {
      protected override fun createQuery(): String = "INSERT INTO `sync_state` (`account_id`,`workspace_id`,`sync_key`,`cursor`,`etag`,`full_read_at`,`payload`,`updated_at`) VALUES (?,?,?,?,?,?,?,?)"

      protected override fun bind(statement: SQLiteStatement, entity: SyncStateEntity) {
        statement.bindText(1, entity.accountId)
        statement.bindText(2, entity.workspaceId)
        statement.bindText(3, entity.key)
        val _tmpCursor: String? = entity.cursor
        if (_tmpCursor == null) {
          statement.bindNull(4)
        } else {
          statement.bindText(4, _tmpCursor)
        }
        val _tmpEtag: String? = entity.etag
        if (_tmpEtag == null) {
          statement.bindNull(5)
        } else {
          statement.bindText(5, _tmpEtag)
        }
        val _tmpFullReadAt: Long? = entity.fullReadAt
        if (_tmpFullReadAt == null) {
          statement.bindNull(6)
        } else {
          statement.bindLong(6, _tmpFullReadAt)
        }
        val _tmpPayload: String? = entity.payload
        if (_tmpPayload == null) {
          statement.bindNull(7)
        } else {
          statement.bindText(7, _tmpPayload)
        }
        statement.bindLong(8, entity.updatedAt)
      }
    }, object : EntityDeleteOrUpdateAdapter<SyncStateEntity>() {
      protected override fun createQuery(): String = "UPDATE `sync_state` SET `account_id` = ?,`workspace_id` = ?,`sync_key` = ?,`cursor` = ?,`etag` = ?,`full_read_at` = ?,`payload` = ?,`updated_at` = ? WHERE `account_id` = ? AND `workspace_id` = ? AND `sync_key` = ?"

      protected override fun bind(statement: SQLiteStatement, entity: SyncStateEntity) {
        statement.bindText(1, entity.accountId)
        statement.bindText(2, entity.workspaceId)
        statement.bindText(3, entity.key)
        val _tmpCursor: String? = entity.cursor
        if (_tmpCursor == null) {
          statement.bindNull(4)
        } else {
          statement.bindText(4, _tmpCursor)
        }
        val _tmpEtag: String? = entity.etag
        if (_tmpEtag == null) {
          statement.bindNull(5)
        } else {
          statement.bindText(5, _tmpEtag)
        }
        val _tmpFullReadAt: Long? = entity.fullReadAt
        if (_tmpFullReadAt == null) {
          statement.bindNull(6)
        } else {
          statement.bindLong(6, _tmpFullReadAt)
        }
        val _tmpPayload: String? = entity.payload
        if (_tmpPayload == null) {
          statement.bindNull(7)
        } else {
          statement.bindText(7, _tmpPayload)
        }
        statement.bindLong(8, entity.updatedAt)
        statement.bindText(9, entity.accountId)
        statement.bindText(10, entity.workspaceId)
        statement.bindText(11, entity.key)
      }
    })
  }

  public override suspend fun upsert(row: SyncStateEntity): Unit = performSuspending(__db, false, true) { _connection ->
    __upsertAdapterOfSyncStateEntity.upsert(_connection, row)
  }

  public override suspend fun `get`(
    accountId: String,
    workspaceId: String,
    key: String,
  ): SyncStateEntity? {
    val _sql: String = """
        |
        |        SELECT * FROM sync_state
        |        WHERE account_id = ? AND workspace_id = ? AND sync_key = ?
        |        
        """.trimMargin()
    return performSuspending(__db, true, false) { _connection ->
      val _stmt: SQLiteStatement = _connection.prepare(_sql)
      try {
        var _argIndex: Int = 1
        _stmt.bindText(_argIndex, accountId)
        _argIndex = 2
        _stmt.bindText(_argIndex, workspaceId)
        _argIndex = 3
        _stmt.bindText(_argIndex, key)
        val _columnIndexOfAccountId: Int = getColumnIndexOrThrow(_stmt, "account_id")
        val _columnIndexOfWorkspaceId: Int = getColumnIndexOrThrow(_stmt, "workspace_id")
        val _columnIndexOfKey: Int = getColumnIndexOrThrow(_stmt, "sync_key")
        val _columnIndexOfCursor: Int = getColumnIndexOrThrow(_stmt, "cursor")
        val _columnIndexOfEtag: Int = getColumnIndexOrThrow(_stmt, "etag")
        val _columnIndexOfFullReadAt: Int = getColumnIndexOrThrow(_stmt, "full_read_at")
        val _columnIndexOfPayload: Int = getColumnIndexOrThrow(_stmt, "payload")
        val _columnIndexOfUpdatedAt: Int = getColumnIndexOrThrow(_stmt, "updated_at")
        val _result: SyncStateEntity?
        if (_stmt.step()) {
          val _tmpAccountId: String
          _tmpAccountId = _stmt.getText(_columnIndexOfAccountId)
          val _tmpWorkspaceId: String
          _tmpWorkspaceId = _stmt.getText(_columnIndexOfWorkspaceId)
          val _tmpKey: String
          _tmpKey = _stmt.getText(_columnIndexOfKey)
          val _tmpCursor: String?
          if (_stmt.isNull(_columnIndexOfCursor)) {
            _tmpCursor = null
          } else {
            _tmpCursor = _stmt.getText(_columnIndexOfCursor)
          }
          val _tmpEtag: String?
          if (_stmt.isNull(_columnIndexOfEtag)) {
            _tmpEtag = null
          } else {
            _tmpEtag = _stmt.getText(_columnIndexOfEtag)
          }
          val _tmpFullReadAt: Long?
          if (_stmt.isNull(_columnIndexOfFullReadAt)) {
            _tmpFullReadAt = null
          } else {
            _tmpFullReadAt = _stmt.getLong(_columnIndexOfFullReadAt)
          }
          val _tmpPayload: String?
          if (_stmt.isNull(_columnIndexOfPayload)) {
            _tmpPayload = null
          } else {
            _tmpPayload = _stmt.getText(_columnIndexOfPayload)
          }
          val _tmpUpdatedAt: Long
          _tmpUpdatedAt = _stmt.getLong(_columnIndexOfUpdatedAt)
          _result = SyncStateEntity(_tmpAccountId,_tmpWorkspaceId,_tmpKey,_tmpCursor,_tmpEtag,_tmpFullReadAt,_tmpPayload,_tmpUpdatedAt)
        } else {
          _result = null
        }
        _result
      } finally {
        _stmt.close()
      }
    }
  }

  public override suspend fun delete(
    accountId: String,
    workspaceId: String,
    key: String,
  ) {
    val _sql: String = """
        |
        |        DELETE FROM sync_state
        |        WHERE account_id = ? AND workspace_id = ? AND sync_key = ?
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
        _stmt.bindText(_argIndex, key)
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
