package com.webyar.`operator`.core.cache

import androidx.room.EntityDeleteOrUpdateAdapter
import androidx.room.EntityInsertAdapter
import androidx.room.EntityUpsertAdapter
import androidx.room.RoomDatabase
import androidx.room.coroutines.createFlow
import androidx.room.util.appendPlaceholders
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
import kotlin.collections.MutableList
import kotlin.collections.mutableListOf
import kotlin.reflect.KClass
import kotlin.text.StringBuilder
import kotlinx.coroutines.flow.Flow

@Generated(value = ["androidx.room.RoomProcessor"])
@Suppress(names = ["UNCHECKED_CAST", "DEPRECATION", "REDUNDANT_PROJECTION", "REMOVAL"])
public class MessageDao_Impl(
  __db: RoomDatabase,
) : MessageDao {
  private val __db: RoomDatabase

  private val __upsertAdapterOfMessageEntity: EntityUpsertAdapter<MessageEntity>
  init {
    this.__db = __db
    this.__upsertAdapterOfMessageEntity = EntityUpsertAdapter<MessageEntity>(object : EntityInsertAdapter<MessageEntity>() {
      protected override fun createQuery(): String = "INSERT INTO `messages` (`account_id`,`local_id`,`workspace_id`,`conversation_id`,`server_id`,`client_message_id`,`sender_type`,`sender_id`,`sender_name`,`sender_avatar`,`body`,`created_at`,`updated_at`,`metadata_json`,`attachments_json`,`send_state`,`outbox_attachment_id`,`sort_at`,`cached_at`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"

      protected override fun bind(statement: SQLiteStatement, entity: MessageEntity) {
        statement.bindText(1, entity.accountId)
        statement.bindText(2, entity.localId)
        statement.bindText(3, entity.workspaceId)
        statement.bindText(4, entity.conversationId)
        val _tmpServerId: String? = entity.serverId
        if (_tmpServerId == null) {
          statement.bindNull(5)
        } else {
          statement.bindText(5, _tmpServerId)
        }
        val _tmpClientMessageId: String? = entity.clientMessageId
        if (_tmpClientMessageId == null) {
          statement.bindNull(6)
        } else {
          statement.bindText(6, _tmpClientMessageId)
        }
        statement.bindText(7, entity.senderType)
        val _tmpSenderId: String? = entity.senderId
        if (_tmpSenderId == null) {
          statement.bindNull(8)
        } else {
          statement.bindText(8, _tmpSenderId)
        }
        val _tmpSenderName: String? = entity.senderName
        if (_tmpSenderName == null) {
          statement.bindNull(9)
        } else {
          statement.bindText(9, _tmpSenderName)
        }
        val _tmpSenderAvatar: String? = entity.senderAvatar
        if (_tmpSenderAvatar == null) {
          statement.bindNull(10)
        } else {
          statement.bindText(10, _tmpSenderAvatar)
        }
        statement.bindText(11, entity.body)
        val _tmpCreatedAt: Long? = entity.createdAt
        if (_tmpCreatedAt == null) {
          statement.bindNull(12)
        } else {
          statement.bindLong(12, _tmpCreatedAt)
        }
        val _tmpUpdatedAt: Long? = entity.updatedAt
        if (_tmpUpdatedAt == null) {
          statement.bindNull(13)
        } else {
          statement.bindLong(13, _tmpUpdatedAt)
        }
        val _tmpMetadataJson: String? = entity.metadataJson
        if (_tmpMetadataJson == null) {
          statement.bindNull(14)
        } else {
          statement.bindText(14, _tmpMetadataJson)
        }
        val _tmpAttachmentsJson: String? = entity.attachmentsJson
        if (_tmpAttachmentsJson == null) {
          statement.bindNull(15)
        } else {
          statement.bindText(15, _tmpAttachmentsJson)
        }
        statement.bindLong(16, entity.sendState.toLong())
        val _tmpOutboxAttachmentId: String? = entity.outboxAttachmentId
        if (_tmpOutboxAttachmentId == null) {
          statement.bindNull(17)
        } else {
          statement.bindText(17, _tmpOutboxAttachmentId)
        }
        statement.bindLong(18, entity.sortAt)
        statement.bindLong(19, entity.cachedAt)
      }
    }, object : EntityDeleteOrUpdateAdapter<MessageEntity>() {
      protected override fun createQuery(): String = "UPDATE `messages` SET `account_id` = ?,`local_id` = ?,`workspace_id` = ?,`conversation_id` = ?,`server_id` = ?,`client_message_id` = ?,`sender_type` = ?,`sender_id` = ?,`sender_name` = ?,`sender_avatar` = ?,`body` = ?,`created_at` = ?,`updated_at` = ?,`metadata_json` = ?,`attachments_json` = ?,`send_state` = ?,`outbox_attachment_id` = ?,`sort_at` = ?,`cached_at` = ? WHERE `account_id` = ? AND `local_id` = ?"

      protected override fun bind(statement: SQLiteStatement, entity: MessageEntity) {
        statement.bindText(1, entity.accountId)
        statement.bindText(2, entity.localId)
        statement.bindText(3, entity.workspaceId)
        statement.bindText(4, entity.conversationId)
        val _tmpServerId: String? = entity.serverId
        if (_tmpServerId == null) {
          statement.bindNull(5)
        } else {
          statement.bindText(5, _tmpServerId)
        }
        val _tmpClientMessageId: String? = entity.clientMessageId
        if (_tmpClientMessageId == null) {
          statement.bindNull(6)
        } else {
          statement.bindText(6, _tmpClientMessageId)
        }
        statement.bindText(7, entity.senderType)
        val _tmpSenderId: String? = entity.senderId
        if (_tmpSenderId == null) {
          statement.bindNull(8)
        } else {
          statement.bindText(8, _tmpSenderId)
        }
        val _tmpSenderName: String? = entity.senderName
        if (_tmpSenderName == null) {
          statement.bindNull(9)
        } else {
          statement.bindText(9, _tmpSenderName)
        }
        val _tmpSenderAvatar: String? = entity.senderAvatar
        if (_tmpSenderAvatar == null) {
          statement.bindNull(10)
        } else {
          statement.bindText(10, _tmpSenderAvatar)
        }
        statement.bindText(11, entity.body)
        val _tmpCreatedAt: Long? = entity.createdAt
        if (_tmpCreatedAt == null) {
          statement.bindNull(12)
        } else {
          statement.bindLong(12, _tmpCreatedAt)
        }
        val _tmpUpdatedAt: Long? = entity.updatedAt
        if (_tmpUpdatedAt == null) {
          statement.bindNull(13)
        } else {
          statement.bindLong(13, _tmpUpdatedAt)
        }
        val _tmpMetadataJson: String? = entity.metadataJson
        if (_tmpMetadataJson == null) {
          statement.bindNull(14)
        } else {
          statement.bindText(14, _tmpMetadataJson)
        }
        val _tmpAttachmentsJson: String? = entity.attachmentsJson
        if (_tmpAttachmentsJson == null) {
          statement.bindNull(15)
        } else {
          statement.bindText(15, _tmpAttachmentsJson)
        }
        statement.bindLong(16, entity.sendState.toLong())
        val _tmpOutboxAttachmentId: String? = entity.outboxAttachmentId
        if (_tmpOutboxAttachmentId == null) {
          statement.bindNull(17)
        } else {
          statement.bindText(17, _tmpOutboxAttachmentId)
        }
        statement.bindLong(18, entity.sortAt)
        statement.bindLong(19, entity.cachedAt)
        statement.bindText(20, entity.accountId)
        statement.bindText(21, entity.localId)
      }
    })
  }

  public override suspend fun upsert(rows: List<MessageEntity>): Unit = performSuspending(__db, false, true) { _connection ->
    __upsertAdapterOfMessageEntity.upsert(_connection, rows)
  }

  public override fun observeThread(
    accountId: String,
    workspaceId: String,
    conversationId: String,
  ): Flow<List<MessageEntity>> {
    val _sql: String = """
        |
        |        SELECT * FROM messages
        |        WHERE account_id = ? AND workspace_id = ? AND conversation_id = ?
        |        ORDER BY sort_at ASC, server_id ASC, local_id ASC
        |        
        """.trimMargin()
    return createFlow(__db, false, arrayOf("messages")) { _connection ->
      val _stmt: SQLiteStatement = _connection.prepare(_sql)
      try {
        var _argIndex: Int = 1
        _stmt.bindText(_argIndex, accountId)
        _argIndex = 2
        _stmt.bindText(_argIndex, workspaceId)
        _argIndex = 3
        _stmt.bindText(_argIndex, conversationId)
        val _columnIndexOfAccountId: Int = getColumnIndexOrThrow(_stmt, "account_id")
        val _columnIndexOfLocalId: Int = getColumnIndexOrThrow(_stmt, "local_id")
        val _columnIndexOfWorkspaceId: Int = getColumnIndexOrThrow(_stmt, "workspace_id")
        val _columnIndexOfConversationId: Int = getColumnIndexOrThrow(_stmt, "conversation_id")
        val _columnIndexOfServerId: Int = getColumnIndexOrThrow(_stmt, "server_id")
        val _columnIndexOfClientMessageId: Int = getColumnIndexOrThrow(_stmt, "client_message_id")
        val _columnIndexOfSenderType: Int = getColumnIndexOrThrow(_stmt, "sender_type")
        val _columnIndexOfSenderId: Int = getColumnIndexOrThrow(_stmt, "sender_id")
        val _columnIndexOfSenderName: Int = getColumnIndexOrThrow(_stmt, "sender_name")
        val _columnIndexOfSenderAvatar: Int = getColumnIndexOrThrow(_stmt, "sender_avatar")
        val _columnIndexOfBody: Int = getColumnIndexOrThrow(_stmt, "body")
        val _columnIndexOfCreatedAt: Int = getColumnIndexOrThrow(_stmt, "created_at")
        val _columnIndexOfUpdatedAt: Int = getColumnIndexOrThrow(_stmt, "updated_at")
        val _columnIndexOfMetadataJson: Int = getColumnIndexOrThrow(_stmt, "metadata_json")
        val _columnIndexOfAttachmentsJson: Int = getColumnIndexOrThrow(_stmt, "attachments_json")
        val _columnIndexOfSendState: Int = getColumnIndexOrThrow(_stmt, "send_state")
        val _columnIndexOfOutboxAttachmentId: Int = getColumnIndexOrThrow(_stmt, "outbox_attachment_id")
        val _columnIndexOfSortAt: Int = getColumnIndexOrThrow(_stmt, "sort_at")
        val _columnIndexOfCachedAt: Int = getColumnIndexOrThrow(_stmt, "cached_at")
        val _result: MutableList<MessageEntity> = mutableListOf()
        while (_stmt.step()) {
          val _item: MessageEntity
          val _tmpAccountId: String
          _tmpAccountId = _stmt.getText(_columnIndexOfAccountId)
          val _tmpLocalId: String
          _tmpLocalId = _stmt.getText(_columnIndexOfLocalId)
          val _tmpWorkspaceId: String
          _tmpWorkspaceId = _stmt.getText(_columnIndexOfWorkspaceId)
          val _tmpConversationId: String
          _tmpConversationId = _stmt.getText(_columnIndexOfConversationId)
          val _tmpServerId: String?
          if (_stmt.isNull(_columnIndexOfServerId)) {
            _tmpServerId = null
          } else {
            _tmpServerId = _stmt.getText(_columnIndexOfServerId)
          }
          val _tmpClientMessageId: String?
          if (_stmt.isNull(_columnIndexOfClientMessageId)) {
            _tmpClientMessageId = null
          } else {
            _tmpClientMessageId = _stmt.getText(_columnIndexOfClientMessageId)
          }
          val _tmpSenderType: String
          _tmpSenderType = _stmt.getText(_columnIndexOfSenderType)
          val _tmpSenderId: String?
          if (_stmt.isNull(_columnIndexOfSenderId)) {
            _tmpSenderId = null
          } else {
            _tmpSenderId = _stmt.getText(_columnIndexOfSenderId)
          }
          val _tmpSenderName: String?
          if (_stmt.isNull(_columnIndexOfSenderName)) {
            _tmpSenderName = null
          } else {
            _tmpSenderName = _stmt.getText(_columnIndexOfSenderName)
          }
          val _tmpSenderAvatar: String?
          if (_stmt.isNull(_columnIndexOfSenderAvatar)) {
            _tmpSenderAvatar = null
          } else {
            _tmpSenderAvatar = _stmt.getText(_columnIndexOfSenderAvatar)
          }
          val _tmpBody: String
          _tmpBody = _stmt.getText(_columnIndexOfBody)
          val _tmpCreatedAt: Long?
          if (_stmt.isNull(_columnIndexOfCreatedAt)) {
            _tmpCreatedAt = null
          } else {
            _tmpCreatedAt = _stmt.getLong(_columnIndexOfCreatedAt)
          }
          val _tmpUpdatedAt: Long?
          if (_stmt.isNull(_columnIndexOfUpdatedAt)) {
            _tmpUpdatedAt = null
          } else {
            _tmpUpdatedAt = _stmt.getLong(_columnIndexOfUpdatedAt)
          }
          val _tmpMetadataJson: String?
          if (_stmt.isNull(_columnIndexOfMetadataJson)) {
            _tmpMetadataJson = null
          } else {
            _tmpMetadataJson = _stmt.getText(_columnIndexOfMetadataJson)
          }
          val _tmpAttachmentsJson: String?
          if (_stmt.isNull(_columnIndexOfAttachmentsJson)) {
            _tmpAttachmentsJson = null
          } else {
            _tmpAttachmentsJson = _stmt.getText(_columnIndexOfAttachmentsJson)
          }
          val _tmpSendState: Int
          _tmpSendState = _stmt.getLong(_columnIndexOfSendState).toInt()
          val _tmpOutboxAttachmentId: String?
          if (_stmt.isNull(_columnIndexOfOutboxAttachmentId)) {
            _tmpOutboxAttachmentId = null
          } else {
            _tmpOutboxAttachmentId = _stmt.getText(_columnIndexOfOutboxAttachmentId)
          }
          val _tmpSortAt: Long
          _tmpSortAt = _stmt.getLong(_columnIndexOfSortAt)
          val _tmpCachedAt: Long
          _tmpCachedAt = _stmt.getLong(_columnIndexOfCachedAt)
          _item = MessageEntity(_tmpAccountId,_tmpLocalId,_tmpWorkspaceId,_tmpConversationId,_tmpServerId,_tmpClientMessageId,_tmpSenderType,_tmpSenderId,_tmpSenderName,_tmpSenderAvatar,_tmpBody,_tmpCreatedAt,_tmpUpdatedAt,_tmpMetadataJson,_tmpAttachmentsJson,_tmpSendState,_tmpOutboxAttachmentId,_tmpSortAt,_tmpCachedAt)
          _result.add(_item)
        }
        _result
      } finally {
        _stmt.close()
      }
    }
  }

  public override suspend fun byServerIds(
    accountId: String,
    workspaceId: String,
    conversationId: String,
    serverIds: List<String>,
  ): List<MessageEntity> {
    val _stringBuilder: StringBuilder = StringBuilder()
    _stringBuilder.append("""
        |
        |""".trimMargin())
    _stringBuilder.append("        SELECT * FROM messages")
    _stringBuilder.append("""
        |
        |""".trimMargin())
    _stringBuilder.append("        WHERE account_id = ")
    _stringBuilder.append("?")
    _stringBuilder.append(" AND workspace_id = ")
    _stringBuilder.append("?")
    _stringBuilder.append(" AND conversation_id = ")
    _stringBuilder.append("?")
    _stringBuilder.append("""
        |
        |""".trimMargin())
    _stringBuilder.append("            AND server_id IN (")
    val _inputSize: Int = serverIds.size
    appendPlaceholders(_stringBuilder, _inputSize)
    _stringBuilder.append(")")
    _stringBuilder.append("""
        |
        |""".trimMargin())
    _stringBuilder.append("        ")
    val _sql: String = _stringBuilder.toString()
    return performSuspending(__db, true, false) { _connection ->
      val _stmt: SQLiteStatement = _connection.prepare(_sql)
      try {
        var _argIndex: Int = 1
        _stmt.bindText(_argIndex, accountId)
        _argIndex = 2
        _stmt.bindText(_argIndex, workspaceId)
        _argIndex = 3
        _stmt.bindText(_argIndex, conversationId)
        _argIndex = 4
        for (_item: String in serverIds) {
          _stmt.bindText(_argIndex, _item)
          _argIndex++
        }
        val _columnIndexOfAccountId: Int = getColumnIndexOrThrow(_stmt, "account_id")
        val _columnIndexOfLocalId: Int = getColumnIndexOrThrow(_stmt, "local_id")
        val _columnIndexOfWorkspaceId: Int = getColumnIndexOrThrow(_stmt, "workspace_id")
        val _columnIndexOfConversationId: Int = getColumnIndexOrThrow(_stmt, "conversation_id")
        val _columnIndexOfServerId: Int = getColumnIndexOrThrow(_stmt, "server_id")
        val _columnIndexOfClientMessageId: Int = getColumnIndexOrThrow(_stmt, "client_message_id")
        val _columnIndexOfSenderType: Int = getColumnIndexOrThrow(_stmt, "sender_type")
        val _columnIndexOfSenderId: Int = getColumnIndexOrThrow(_stmt, "sender_id")
        val _columnIndexOfSenderName: Int = getColumnIndexOrThrow(_stmt, "sender_name")
        val _columnIndexOfSenderAvatar: Int = getColumnIndexOrThrow(_stmt, "sender_avatar")
        val _columnIndexOfBody: Int = getColumnIndexOrThrow(_stmt, "body")
        val _columnIndexOfCreatedAt: Int = getColumnIndexOrThrow(_stmt, "created_at")
        val _columnIndexOfUpdatedAt: Int = getColumnIndexOrThrow(_stmt, "updated_at")
        val _columnIndexOfMetadataJson: Int = getColumnIndexOrThrow(_stmt, "metadata_json")
        val _columnIndexOfAttachmentsJson: Int = getColumnIndexOrThrow(_stmt, "attachments_json")
        val _columnIndexOfSendState: Int = getColumnIndexOrThrow(_stmt, "send_state")
        val _columnIndexOfOutboxAttachmentId: Int = getColumnIndexOrThrow(_stmt, "outbox_attachment_id")
        val _columnIndexOfSortAt: Int = getColumnIndexOrThrow(_stmt, "sort_at")
        val _columnIndexOfCachedAt: Int = getColumnIndexOrThrow(_stmt, "cached_at")
        val _result: MutableList<MessageEntity> = mutableListOf()
        while (_stmt.step()) {
          val _item_1: MessageEntity
          val _tmpAccountId: String
          _tmpAccountId = _stmt.getText(_columnIndexOfAccountId)
          val _tmpLocalId: String
          _tmpLocalId = _stmt.getText(_columnIndexOfLocalId)
          val _tmpWorkspaceId: String
          _tmpWorkspaceId = _stmt.getText(_columnIndexOfWorkspaceId)
          val _tmpConversationId: String
          _tmpConversationId = _stmt.getText(_columnIndexOfConversationId)
          val _tmpServerId: String?
          if (_stmt.isNull(_columnIndexOfServerId)) {
            _tmpServerId = null
          } else {
            _tmpServerId = _stmt.getText(_columnIndexOfServerId)
          }
          val _tmpClientMessageId: String?
          if (_stmt.isNull(_columnIndexOfClientMessageId)) {
            _tmpClientMessageId = null
          } else {
            _tmpClientMessageId = _stmt.getText(_columnIndexOfClientMessageId)
          }
          val _tmpSenderType: String
          _tmpSenderType = _stmt.getText(_columnIndexOfSenderType)
          val _tmpSenderId: String?
          if (_stmt.isNull(_columnIndexOfSenderId)) {
            _tmpSenderId = null
          } else {
            _tmpSenderId = _stmt.getText(_columnIndexOfSenderId)
          }
          val _tmpSenderName: String?
          if (_stmt.isNull(_columnIndexOfSenderName)) {
            _tmpSenderName = null
          } else {
            _tmpSenderName = _stmt.getText(_columnIndexOfSenderName)
          }
          val _tmpSenderAvatar: String?
          if (_stmt.isNull(_columnIndexOfSenderAvatar)) {
            _tmpSenderAvatar = null
          } else {
            _tmpSenderAvatar = _stmt.getText(_columnIndexOfSenderAvatar)
          }
          val _tmpBody: String
          _tmpBody = _stmt.getText(_columnIndexOfBody)
          val _tmpCreatedAt: Long?
          if (_stmt.isNull(_columnIndexOfCreatedAt)) {
            _tmpCreatedAt = null
          } else {
            _tmpCreatedAt = _stmt.getLong(_columnIndexOfCreatedAt)
          }
          val _tmpUpdatedAt: Long?
          if (_stmt.isNull(_columnIndexOfUpdatedAt)) {
            _tmpUpdatedAt = null
          } else {
            _tmpUpdatedAt = _stmt.getLong(_columnIndexOfUpdatedAt)
          }
          val _tmpMetadataJson: String?
          if (_stmt.isNull(_columnIndexOfMetadataJson)) {
            _tmpMetadataJson = null
          } else {
            _tmpMetadataJson = _stmt.getText(_columnIndexOfMetadataJson)
          }
          val _tmpAttachmentsJson: String?
          if (_stmt.isNull(_columnIndexOfAttachmentsJson)) {
            _tmpAttachmentsJson = null
          } else {
            _tmpAttachmentsJson = _stmt.getText(_columnIndexOfAttachmentsJson)
          }
          val _tmpSendState: Int
          _tmpSendState = _stmt.getLong(_columnIndexOfSendState).toInt()
          val _tmpOutboxAttachmentId: String?
          if (_stmt.isNull(_columnIndexOfOutboxAttachmentId)) {
            _tmpOutboxAttachmentId = null
          } else {
            _tmpOutboxAttachmentId = _stmt.getText(_columnIndexOfOutboxAttachmentId)
          }
          val _tmpSortAt: Long
          _tmpSortAt = _stmt.getLong(_columnIndexOfSortAt)
          val _tmpCachedAt: Long
          _tmpCachedAt = _stmt.getLong(_columnIndexOfCachedAt)
          _item_1 = MessageEntity(_tmpAccountId,_tmpLocalId,_tmpWorkspaceId,_tmpConversationId,_tmpServerId,_tmpClientMessageId,_tmpSenderType,_tmpSenderId,_tmpSenderName,_tmpSenderAvatar,_tmpBody,_tmpCreatedAt,_tmpUpdatedAt,_tmpMetadataJson,_tmpAttachmentsJson,_tmpSendState,_tmpOutboxAttachmentId,_tmpSortAt,_tmpCachedAt)
          _result.add(_item_1)
        }
        _result
      } finally {
        _stmt.close()
      }
    }
  }

  public override suspend fun byClientIds(
    accountId: String,
    workspaceId: String,
    conversationId: String,
    clientIds: List<String>,
  ): List<MessageEntity> {
    val _stringBuilder: StringBuilder = StringBuilder()
    _stringBuilder.append("""
        |
        |""".trimMargin())
    _stringBuilder.append("        SELECT * FROM messages")
    _stringBuilder.append("""
        |
        |""".trimMargin())
    _stringBuilder.append("        WHERE account_id = ")
    _stringBuilder.append("?")
    _stringBuilder.append(" AND workspace_id = ")
    _stringBuilder.append("?")
    _stringBuilder.append(" AND conversation_id = ")
    _stringBuilder.append("?")
    _stringBuilder.append("""
        |
        |""".trimMargin())
    _stringBuilder.append("            AND client_message_id IN (")
    val _inputSize: Int = clientIds.size
    appendPlaceholders(_stringBuilder, _inputSize)
    _stringBuilder.append(")")
    _stringBuilder.append("""
        |
        |""".trimMargin())
    _stringBuilder.append("        ")
    val _sql: String = _stringBuilder.toString()
    return performSuspending(__db, true, false) { _connection ->
      val _stmt: SQLiteStatement = _connection.prepare(_sql)
      try {
        var _argIndex: Int = 1
        _stmt.bindText(_argIndex, accountId)
        _argIndex = 2
        _stmt.bindText(_argIndex, workspaceId)
        _argIndex = 3
        _stmt.bindText(_argIndex, conversationId)
        _argIndex = 4
        for (_item: String in clientIds) {
          _stmt.bindText(_argIndex, _item)
          _argIndex++
        }
        val _columnIndexOfAccountId: Int = getColumnIndexOrThrow(_stmt, "account_id")
        val _columnIndexOfLocalId: Int = getColumnIndexOrThrow(_stmt, "local_id")
        val _columnIndexOfWorkspaceId: Int = getColumnIndexOrThrow(_stmt, "workspace_id")
        val _columnIndexOfConversationId: Int = getColumnIndexOrThrow(_stmt, "conversation_id")
        val _columnIndexOfServerId: Int = getColumnIndexOrThrow(_stmt, "server_id")
        val _columnIndexOfClientMessageId: Int = getColumnIndexOrThrow(_stmt, "client_message_id")
        val _columnIndexOfSenderType: Int = getColumnIndexOrThrow(_stmt, "sender_type")
        val _columnIndexOfSenderId: Int = getColumnIndexOrThrow(_stmt, "sender_id")
        val _columnIndexOfSenderName: Int = getColumnIndexOrThrow(_stmt, "sender_name")
        val _columnIndexOfSenderAvatar: Int = getColumnIndexOrThrow(_stmt, "sender_avatar")
        val _columnIndexOfBody: Int = getColumnIndexOrThrow(_stmt, "body")
        val _columnIndexOfCreatedAt: Int = getColumnIndexOrThrow(_stmt, "created_at")
        val _columnIndexOfUpdatedAt: Int = getColumnIndexOrThrow(_stmt, "updated_at")
        val _columnIndexOfMetadataJson: Int = getColumnIndexOrThrow(_stmt, "metadata_json")
        val _columnIndexOfAttachmentsJson: Int = getColumnIndexOrThrow(_stmt, "attachments_json")
        val _columnIndexOfSendState: Int = getColumnIndexOrThrow(_stmt, "send_state")
        val _columnIndexOfOutboxAttachmentId: Int = getColumnIndexOrThrow(_stmt, "outbox_attachment_id")
        val _columnIndexOfSortAt: Int = getColumnIndexOrThrow(_stmt, "sort_at")
        val _columnIndexOfCachedAt: Int = getColumnIndexOrThrow(_stmt, "cached_at")
        val _result: MutableList<MessageEntity> = mutableListOf()
        while (_stmt.step()) {
          val _item_1: MessageEntity
          val _tmpAccountId: String
          _tmpAccountId = _stmt.getText(_columnIndexOfAccountId)
          val _tmpLocalId: String
          _tmpLocalId = _stmt.getText(_columnIndexOfLocalId)
          val _tmpWorkspaceId: String
          _tmpWorkspaceId = _stmt.getText(_columnIndexOfWorkspaceId)
          val _tmpConversationId: String
          _tmpConversationId = _stmt.getText(_columnIndexOfConversationId)
          val _tmpServerId: String?
          if (_stmt.isNull(_columnIndexOfServerId)) {
            _tmpServerId = null
          } else {
            _tmpServerId = _stmt.getText(_columnIndexOfServerId)
          }
          val _tmpClientMessageId: String?
          if (_stmt.isNull(_columnIndexOfClientMessageId)) {
            _tmpClientMessageId = null
          } else {
            _tmpClientMessageId = _stmt.getText(_columnIndexOfClientMessageId)
          }
          val _tmpSenderType: String
          _tmpSenderType = _stmt.getText(_columnIndexOfSenderType)
          val _tmpSenderId: String?
          if (_stmt.isNull(_columnIndexOfSenderId)) {
            _tmpSenderId = null
          } else {
            _tmpSenderId = _stmt.getText(_columnIndexOfSenderId)
          }
          val _tmpSenderName: String?
          if (_stmt.isNull(_columnIndexOfSenderName)) {
            _tmpSenderName = null
          } else {
            _tmpSenderName = _stmt.getText(_columnIndexOfSenderName)
          }
          val _tmpSenderAvatar: String?
          if (_stmt.isNull(_columnIndexOfSenderAvatar)) {
            _tmpSenderAvatar = null
          } else {
            _tmpSenderAvatar = _stmt.getText(_columnIndexOfSenderAvatar)
          }
          val _tmpBody: String
          _tmpBody = _stmt.getText(_columnIndexOfBody)
          val _tmpCreatedAt: Long?
          if (_stmt.isNull(_columnIndexOfCreatedAt)) {
            _tmpCreatedAt = null
          } else {
            _tmpCreatedAt = _stmt.getLong(_columnIndexOfCreatedAt)
          }
          val _tmpUpdatedAt: Long?
          if (_stmt.isNull(_columnIndexOfUpdatedAt)) {
            _tmpUpdatedAt = null
          } else {
            _tmpUpdatedAt = _stmt.getLong(_columnIndexOfUpdatedAt)
          }
          val _tmpMetadataJson: String?
          if (_stmt.isNull(_columnIndexOfMetadataJson)) {
            _tmpMetadataJson = null
          } else {
            _tmpMetadataJson = _stmt.getText(_columnIndexOfMetadataJson)
          }
          val _tmpAttachmentsJson: String?
          if (_stmt.isNull(_columnIndexOfAttachmentsJson)) {
            _tmpAttachmentsJson = null
          } else {
            _tmpAttachmentsJson = _stmt.getText(_columnIndexOfAttachmentsJson)
          }
          val _tmpSendState: Int
          _tmpSendState = _stmt.getLong(_columnIndexOfSendState).toInt()
          val _tmpOutboxAttachmentId: String?
          if (_stmt.isNull(_columnIndexOfOutboxAttachmentId)) {
            _tmpOutboxAttachmentId = null
          } else {
            _tmpOutboxAttachmentId = _stmt.getText(_columnIndexOfOutboxAttachmentId)
          }
          val _tmpSortAt: Long
          _tmpSortAt = _stmt.getLong(_columnIndexOfSortAt)
          val _tmpCachedAt: Long
          _tmpCachedAt = _stmt.getLong(_columnIndexOfCachedAt)
          _item_1 = MessageEntity(_tmpAccountId,_tmpLocalId,_tmpWorkspaceId,_tmpConversationId,_tmpServerId,_tmpClientMessageId,_tmpSenderType,_tmpSenderId,_tmpSenderName,_tmpSenderAvatar,_tmpBody,_tmpCreatedAt,_tmpUpdatedAt,_tmpMetadataJson,_tmpAttachmentsJson,_tmpSendState,_tmpOutboxAttachmentId,_tmpSortAt,_tmpCachedAt)
          _result.add(_item_1)
        }
        _result
      } finally {
        _stmt.close()
      }
    }
  }

  public override suspend fun keys(
    accountId: String,
    workspaceId: String,
    conversationId: String,
  ): List<MessageKeyRow> {
    val _sql: String = """
        |
        |        SELECT local_id, server_id, send_state, cached_at FROM messages
        |        WHERE account_id = ? AND workspace_id = ? AND conversation_id = ?
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
        _stmt.bindText(_argIndex, conversationId)
        val _columnIndexOfLocalId: Int = 0
        val _columnIndexOfServerId: Int = 1
        val _columnIndexOfSendState: Int = 2
        val _columnIndexOfCachedAt: Int = 3
        val _result: MutableList<MessageKeyRow> = mutableListOf()
        while (_stmt.step()) {
          val _item: MessageKeyRow
          val _tmpLocalId: String
          _tmpLocalId = _stmt.getText(_columnIndexOfLocalId)
          val _tmpServerId: String?
          if (_stmt.isNull(_columnIndexOfServerId)) {
            _tmpServerId = null
          } else {
            _tmpServerId = _stmt.getText(_columnIndexOfServerId)
          }
          val _tmpSendState: Int
          _tmpSendState = _stmt.getLong(_columnIndexOfSendState).toInt()
          val _tmpCachedAt: Long
          _tmpCachedAt = _stmt.getLong(_columnIndexOfCachedAt)
          _item = MessageKeyRow(_tmpLocalId,_tmpServerId,_tmpSendState,_tmpCachedAt)
          _result.add(_item)
        }
        _result
      } finally {
        _stmt.close()
      }
    }
  }

  public override suspend fun `get`(accountId: String, localId: String): MessageEntity? {
    val _sql: String = "SELECT * FROM messages WHERE account_id = ? AND local_id = ?"
    return performSuspending(__db, true, false) { _connection ->
      val _stmt: SQLiteStatement = _connection.prepare(_sql)
      try {
        var _argIndex: Int = 1
        _stmt.bindText(_argIndex, accountId)
        _argIndex = 2
        _stmt.bindText(_argIndex, localId)
        val _columnIndexOfAccountId: Int = getColumnIndexOrThrow(_stmt, "account_id")
        val _columnIndexOfLocalId: Int = getColumnIndexOrThrow(_stmt, "local_id")
        val _columnIndexOfWorkspaceId: Int = getColumnIndexOrThrow(_stmt, "workspace_id")
        val _columnIndexOfConversationId: Int = getColumnIndexOrThrow(_stmt, "conversation_id")
        val _columnIndexOfServerId: Int = getColumnIndexOrThrow(_stmt, "server_id")
        val _columnIndexOfClientMessageId: Int = getColumnIndexOrThrow(_stmt, "client_message_id")
        val _columnIndexOfSenderType: Int = getColumnIndexOrThrow(_stmt, "sender_type")
        val _columnIndexOfSenderId: Int = getColumnIndexOrThrow(_stmt, "sender_id")
        val _columnIndexOfSenderName: Int = getColumnIndexOrThrow(_stmt, "sender_name")
        val _columnIndexOfSenderAvatar: Int = getColumnIndexOrThrow(_stmt, "sender_avatar")
        val _columnIndexOfBody: Int = getColumnIndexOrThrow(_stmt, "body")
        val _columnIndexOfCreatedAt: Int = getColumnIndexOrThrow(_stmt, "created_at")
        val _columnIndexOfUpdatedAt: Int = getColumnIndexOrThrow(_stmt, "updated_at")
        val _columnIndexOfMetadataJson: Int = getColumnIndexOrThrow(_stmt, "metadata_json")
        val _columnIndexOfAttachmentsJson: Int = getColumnIndexOrThrow(_stmt, "attachments_json")
        val _columnIndexOfSendState: Int = getColumnIndexOrThrow(_stmt, "send_state")
        val _columnIndexOfOutboxAttachmentId: Int = getColumnIndexOrThrow(_stmt, "outbox_attachment_id")
        val _columnIndexOfSortAt: Int = getColumnIndexOrThrow(_stmt, "sort_at")
        val _columnIndexOfCachedAt: Int = getColumnIndexOrThrow(_stmt, "cached_at")
        val _result: MessageEntity?
        if (_stmt.step()) {
          val _tmpAccountId: String
          _tmpAccountId = _stmt.getText(_columnIndexOfAccountId)
          val _tmpLocalId: String
          _tmpLocalId = _stmt.getText(_columnIndexOfLocalId)
          val _tmpWorkspaceId: String
          _tmpWorkspaceId = _stmt.getText(_columnIndexOfWorkspaceId)
          val _tmpConversationId: String
          _tmpConversationId = _stmt.getText(_columnIndexOfConversationId)
          val _tmpServerId: String?
          if (_stmt.isNull(_columnIndexOfServerId)) {
            _tmpServerId = null
          } else {
            _tmpServerId = _stmt.getText(_columnIndexOfServerId)
          }
          val _tmpClientMessageId: String?
          if (_stmt.isNull(_columnIndexOfClientMessageId)) {
            _tmpClientMessageId = null
          } else {
            _tmpClientMessageId = _stmt.getText(_columnIndexOfClientMessageId)
          }
          val _tmpSenderType: String
          _tmpSenderType = _stmt.getText(_columnIndexOfSenderType)
          val _tmpSenderId: String?
          if (_stmt.isNull(_columnIndexOfSenderId)) {
            _tmpSenderId = null
          } else {
            _tmpSenderId = _stmt.getText(_columnIndexOfSenderId)
          }
          val _tmpSenderName: String?
          if (_stmt.isNull(_columnIndexOfSenderName)) {
            _tmpSenderName = null
          } else {
            _tmpSenderName = _stmt.getText(_columnIndexOfSenderName)
          }
          val _tmpSenderAvatar: String?
          if (_stmt.isNull(_columnIndexOfSenderAvatar)) {
            _tmpSenderAvatar = null
          } else {
            _tmpSenderAvatar = _stmt.getText(_columnIndexOfSenderAvatar)
          }
          val _tmpBody: String
          _tmpBody = _stmt.getText(_columnIndexOfBody)
          val _tmpCreatedAt: Long?
          if (_stmt.isNull(_columnIndexOfCreatedAt)) {
            _tmpCreatedAt = null
          } else {
            _tmpCreatedAt = _stmt.getLong(_columnIndexOfCreatedAt)
          }
          val _tmpUpdatedAt: Long?
          if (_stmt.isNull(_columnIndexOfUpdatedAt)) {
            _tmpUpdatedAt = null
          } else {
            _tmpUpdatedAt = _stmt.getLong(_columnIndexOfUpdatedAt)
          }
          val _tmpMetadataJson: String?
          if (_stmt.isNull(_columnIndexOfMetadataJson)) {
            _tmpMetadataJson = null
          } else {
            _tmpMetadataJson = _stmt.getText(_columnIndexOfMetadataJson)
          }
          val _tmpAttachmentsJson: String?
          if (_stmt.isNull(_columnIndexOfAttachmentsJson)) {
            _tmpAttachmentsJson = null
          } else {
            _tmpAttachmentsJson = _stmt.getText(_columnIndexOfAttachmentsJson)
          }
          val _tmpSendState: Int
          _tmpSendState = _stmt.getLong(_columnIndexOfSendState).toInt()
          val _tmpOutboxAttachmentId: String?
          if (_stmt.isNull(_columnIndexOfOutboxAttachmentId)) {
            _tmpOutboxAttachmentId = null
          } else {
            _tmpOutboxAttachmentId = _stmt.getText(_columnIndexOfOutboxAttachmentId)
          }
          val _tmpSortAt: Long
          _tmpSortAt = _stmt.getLong(_columnIndexOfSortAt)
          val _tmpCachedAt: Long
          _tmpCachedAt = _stmt.getLong(_columnIndexOfCachedAt)
          _result = MessageEntity(_tmpAccountId,_tmpLocalId,_tmpWorkspaceId,_tmpConversationId,_tmpServerId,_tmpClientMessageId,_tmpSenderType,_tmpSenderId,_tmpSenderName,_tmpSenderAvatar,_tmpBody,_tmpCreatedAt,_tmpUpdatedAt,_tmpMetadataJson,_tmpAttachmentsJson,_tmpSendState,_tmpOutboxAttachmentId,_tmpSortAt,_tmpCachedAt)
        } else {
          _result = null
        }
        _result
      } finally {
        _stmt.close()
      }
    }
  }

  public override suspend fun outbox(accountId: String, workspaceId: String): List<MessageEntity> {
    val _sql: String = """
        |
        |        SELECT * FROM messages
        |        WHERE account_id = ? AND workspace_id = ? AND send_state != 0
        |        ORDER BY sort_at ASC
        |        
        """.trimMargin()
    return performSuspending(__db, true, false) { _connection ->
      val _stmt: SQLiteStatement = _connection.prepare(_sql)
      try {
        var _argIndex: Int = 1
        _stmt.bindText(_argIndex, accountId)
        _argIndex = 2
        _stmt.bindText(_argIndex, workspaceId)
        val _columnIndexOfAccountId: Int = getColumnIndexOrThrow(_stmt, "account_id")
        val _columnIndexOfLocalId: Int = getColumnIndexOrThrow(_stmt, "local_id")
        val _columnIndexOfWorkspaceId: Int = getColumnIndexOrThrow(_stmt, "workspace_id")
        val _columnIndexOfConversationId: Int = getColumnIndexOrThrow(_stmt, "conversation_id")
        val _columnIndexOfServerId: Int = getColumnIndexOrThrow(_stmt, "server_id")
        val _columnIndexOfClientMessageId: Int = getColumnIndexOrThrow(_stmt, "client_message_id")
        val _columnIndexOfSenderType: Int = getColumnIndexOrThrow(_stmt, "sender_type")
        val _columnIndexOfSenderId: Int = getColumnIndexOrThrow(_stmt, "sender_id")
        val _columnIndexOfSenderName: Int = getColumnIndexOrThrow(_stmt, "sender_name")
        val _columnIndexOfSenderAvatar: Int = getColumnIndexOrThrow(_stmt, "sender_avatar")
        val _columnIndexOfBody: Int = getColumnIndexOrThrow(_stmt, "body")
        val _columnIndexOfCreatedAt: Int = getColumnIndexOrThrow(_stmt, "created_at")
        val _columnIndexOfUpdatedAt: Int = getColumnIndexOrThrow(_stmt, "updated_at")
        val _columnIndexOfMetadataJson: Int = getColumnIndexOrThrow(_stmt, "metadata_json")
        val _columnIndexOfAttachmentsJson: Int = getColumnIndexOrThrow(_stmt, "attachments_json")
        val _columnIndexOfSendState: Int = getColumnIndexOrThrow(_stmt, "send_state")
        val _columnIndexOfOutboxAttachmentId: Int = getColumnIndexOrThrow(_stmt, "outbox_attachment_id")
        val _columnIndexOfSortAt: Int = getColumnIndexOrThrow(_stmt, "sort_at")
        val _columnIndexOfCachedAt: Int = getColumnIndexOrThrow(_stmt, "cached_at")
        val _result: MutableList<MessageEntity> = mutableListOf()
        while (_stmt.step()) {
          val _item: MessageEntity
          val _tmpAccountId: String
          _tmpAccountId = _stmt.getText(_columnIndexOfAccountId)
          val _tmpLocalId: String
          _tmpLocalId = _stmt.getText(_columnIndexOfLocalId)
          val _tmpWorkspaceId: String
          _tmpWorkspaceId = _stmt.getText(_columnIndexOfWorkspaceId)
          val _tmpConversationId: String
          _tmpConversationId = _stmt.getText(_columnIndexOfConversationId)
          val _tmpServerId: String?
          if (_stmt.isNull(_columnIndexOfServerId)) {
            _tmpServerId = null
          } else {
            _tmpServerId = _stmt.getText(_columnIndexOfServerId)
          }
          val _tmpClientMessageId: String?
          if (_stmt.isNull(_columnIndexOfClientMessageId)) {
            _tmpClientMessageId = null
          } else {
            _tmpClientMessageId = _stmt.getText(_columnIndexOfClientMessageId)
          }
          val _tmpSenderType: String
          _tmpSenderType = _stmt.getText(_columnIndexOfSenderType)
          val _tmpSenderId: String?
          if (_stmt.isNull(_columnIndexOfSenderId)) {
            _tmpSenderId = null
          } else {
            _tmpSenderId = _stmt.getText(_columnIndexOfSenderId)
          }
          val _tmpSenderName: String?
          if (_stmt.isNull(_columnIndexOfSenderName)) {
            _tmpSenderName = null
          } else {
            _tmpSenderName = _stmt.getText(_columnIndexOfSenderName)
          }
          val _tmpSenderAvatar: String?
          if (_stmt.isNull(_columnIndexOfSenderAvatar)) {
            _tmpSenderAvatar = null
          } else {
            _tmpSenderAvatar = _stmt.getText(_columnIndexOfSenderAvatar)
          }
          val _tmpBody: String
          _tmpBody = _stmt.getText(_columnIndexOfBody)
          val _tmpCreatedAt: Long?
          if (_stmt.isNull(_columnIndexOfCreatedAt)) {
            _tmpCreatedAt = null
          } else {
            _tmpCreatedAt = _stmt.getLong(_columnIndexOfCreatedAt)
          }
          val _tmpUpdatedAt: Long?
          if (_stmt.isNull(_columnIndexOfUpdatedAt)) {
            _tmpUpdatedAt = null
          } else {
            _tmpUpdatedAt = _stmt.getLong(_columnIndexOfUpdatedAt)
          }
          val _tmpMetadataJson: String?
          if (_stmt.isNull(_columnIndexOfMetadataJson)) {
            _tmpMetadataJson = null
          } else {
            _tmpMetadataJson = _stmt.getText(_columnIndexOfMetadataJson)
          }
          val _tmpAttachmentsJson: String?
          if (_stmt.isNull(_columnIndexOfAttachmentsJson)) {
            _tmpAttachmentsJson = null
          } else {
            _tmpAttachmentsJson = _stmt.getText(_columnIndexOfAttachmentsJson)
          }
          val _tmpSendState: Int
          _tmpSendState = _stmt.getLong(_columnIndexOfSendState).toInt()
          val _tmpOutboxAttachmentId: String?
          if (_stmt.isNull(_columnIndexOfOutboxAttachmentId)) {
            _tmpOutboxAttachmentId = null
          } else {
            _tmpOutboxAttachmentId = _stmt.getText(_columnIndexOfOutboxAttachmentId)
          }
          val _tmpSortAt: Long
          _tmpSortAt = _stmt.getLong(_columnIndexOfSortAt)
          val _tmpCachedAt: Long
          _tmpCachedAt = _stmt.getLong(_columnIndexOfCachedAt)
          _item = MessageEntity(_tmpAccountId,_tmpLocalId,_tmpWorkspaceId,_tmpConversationId,_tmpServerId,_tmpClientMessageId,_tmpSenderType,_tmpSenderId,_tmpSenderName,_tmpSenderAvatar,_tmpBody,_tmpCreatedAt,_tmpUpdatedAt,_tmpMetadataJson,_tmpAttachmentsJson,_tmpSendState,_tmpOutboxAttachmentId,_tmpSortAt,_tmpCachedAt)
          _result.add(_item)
        }
        _result
      } finally {
        _stmt.close()
      }
    }
  }

  public override suspend fun delete(accountId: String, localIds: List<String>) {
    val _stringBuilder: StringBuilder = StringBuilder()
    _stringBuilder.append("DELETE FROM messages WHERE account_id = ")
    _stringBuilder.append("?")
    _stringBuilder.append(" AND local_id IN (")
    val _inputSize: Int = localIds.size
    appendPlaceholders(_stringBuilder, _inputSize)
    _stringBuilder.append(")")
    val _sql: String = _stringBuilder.toString()
    return performSuspending(__db, false, true) { _connection ->
      val _stmt: SQLiteStatement = _connection.prepare(_sql)
      try {
        var _argIndex: Int = 1
        _stmt.bindText(_argIndex, accountId)
        _argIndex = 2
        for (_item: String in localIds) {
          _stmt.bindText(_argIndex, _item)
          _argIndex++
        }
        _stmt.step()
      } finally {
        _stmt.close()
      }
    }
  }

  public override suspend fun deleteConfirmed(
    accountId: String,
    workspaceId: String,
    conversationId: String,
  ) {
    val _sql: String = """
        |
        |        DELETE FROM messages
        |        WHERE account_id = ? AND workspace_id = ? AND conversation_id = ?
        |            AND send_state = 0
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
        _stmt.bindText(_argIndex, conversationId)
        _stmt.step()
      } finally {
        _stmt.close()
      }
    }
  }

  public override suspend fun deleteThread(
    accountId: String,
    workspaceId: String,
    conversationId: String,
  ) {
    val _sql: String = """
        |
        |        DELETE FROM messages
        |        WHERE account_id = ? AND workspace_id = ? AND conversation_id = ?
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
        _stmt.bindText(_argIndex, conversationId)
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
