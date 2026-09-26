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
public class ConversationDao_Impl(
  __db: RoomDatabase,
) : ConversationDao {
  private val __db: RoomDatabase

  private val __upsertAdapterOfConversationEntity: EntityUpsertAdapter<ConversationEntity>

  private val __upsertAdapterOfInboxEntryEntity: EntityUpsertAdapter<InboxEntryEntity>
  init {
    this.__db = __db
    this.__upsertAdapterOfConversationEntity = EntityUpsertAdapter<ConversationEntity>(object : EntityInsertAdapter<ConversationEntity>() {
      protected override fun createQuery(): String = "INSERT INTO `conversations` (`account_id`,`workspace_id`,`conversation_id`,`contact_id`,`contact_name`,`contact_email`,`contact_avatar_url`,`contact_visitor_code`,`subject`,`channel`,`status`,`priority`,`assigned_to`,`tags_json`,`unread_count`,`ai_state`,`metadata_json`,`last_message_json`,`last_activity_at`,`created_at`,`updated_at`,`cached_at`,`opened_at`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"

      protected override fun bind(statement: SQLiteStatement, entity: ConversationEntity) {
        statement.bindText(1, entity.accountId)
        statement.bindText(2, entity.workspaceId)
        statement.bindText(3, entity.conversationId)
        val _tmpContactId: String? = entity.contactId
        if (_tmpContactId == null) {
          statement.bindNull(4)
        } else {
          statement.bindText(4, _tmpContactId)
        }
        val _tmpContactName: String? = entity.contactName
        if (_tmpContactName == null) {
          statement.bindNull(5)
        } else {
          statement.bindText(5, _tmpContactName)
        }
        val _tmpContactEmail: String? = entity.contactEmail
        if (_tmpContactEmail == null) {
          statement.bindNull(6)
        } else {
          statement.bindText(6, _tmpContactEmail)
        }
        val _tmpContactAvatarUrl: String? = entity.contactAvatarUrl
        if (_tmpContactAvatarUrl == null) {
          statement.bindNull(7)
        } else {
          statement.bindText(7, _tmpContactAvatarUrl)
        }
        val _tmpContactVisitorCode: String? = entity.contactVisitorCode
        if (_tmpContactVisitorCode == null) {
          statement.bindNull(8)
        } else {
          statement.bindText(8, _tmpContactVisitorCode)
        }
        val _tmpSubject: String? = entity.subject
        if (_tmpSubject == null) {
          statement.bindNull(9)
        } else {
          statement.bindText(9, _tmpSubject)
        }
        val _tmpChannel: String? = entity.channel
        if (_tmpChannel == null) {
          statement.bindNull(10)
        } else {
          statement.bindText(10, _tmpChannel)
        }
        statement.bindText(11, entity.status)
        val _tmpPriority: String? = entity.priority
        if (_tmpPriority == null) {
          statement.bindNull(12)
        } else {
          statement.bindText(12, _tmpPriority)
        }
        val _tmpAssignedTo: String? = entity.assignedTo
        if (_tmpAssignedTo == null) {
          statement.bindNull(13)
        } else {
          statement.bindText(13, _tmpAssignedTo)
        }
        val _tmpTagsJson: String? = entity.tagsJson
        if (_tmpTagsJson == null) {
          statement.bindNull(14)
        } else {
          statement.bindText(14, _tmpTagsJson)
        }
        val _tmpUnreadCount: Int? = entity.unreadCount
        if (_tmpUnreadCount == null) {
          statement.bindNull(15)
        } else {
          statement.bindLong(15, _tmpUnreadCount.toLong())
        }
        val _tmpAiState: String? = entity.aiState
        if (_tmpAiState == null) {
          statement.bindNull(16)
        } else {
          statement.bindText(16, _tmpAiState)
        }
        val _tmpMetadataJson: String? = entity.metadataJson
        if (_tmpMetadataJson == null) {
          statement.bindNull(17)
        } else {
          statement.bindText(17, _tmpMetadataJson)
        }
        val _tmpLastMessageJson: String? = entity.lastMessageJson
        if (_tmpLastMessageJson == null) {
          statement.bindNull(18)
        } else {
          statement.bindText(18, _tmpLastMessageJson)
        }
        val _tmpLastActivityAt: Long? = entity.lastActivityAt
        if (_tmpLastActivityAt == null) {
          statement.bindNull(19)
        } else {
          statement.bindLong(19, _tmpLastActivityAt)
        }
        val _tmpCreatedAt: Long? = entity.createdAt
        if (_tmpCreatedAt == null) {
          statement.bindNull(20)
        } else {
          statement.bindLong(20, _tmpCreatedAt)
        }
        val _tmpUpdatedAt: Long? = entity.updatedAt
        if (_tmpUpdatedAt == null) {
          statement.bindNull(21)
        } else {
          statement.bindLong(21, _tmpUpdatedAt)
        }
        statement.bindLong(22, entity.cachedAt)
        val _tmpOpenedAt: Long? = entity.openedAt
        if (_tmpOpenedAt == null) {
          statement.bindNull(23)
        } else {
          statement.bindLong(23, _tmpOpenedAt)
        }
      }
    }, object : EntityDeleteOrUpdateAdapter<ConversationEntity>() {
      protected override fun createQuery(): String = "UPDATE `conversations` SET `account_id` = ?,`workspace_id` = ?,`conversation_id` = ?,`contact_id` = ?,`contact_name` = ?,`contact_email` = ?,`contact_avatar_url` = ?,`contact_visitor_code` = ?,`subject` = ?,`channel` = ?,`status` = ?,`priority` = ?,`assigned_to` = ?,`tags_json` = ?,`unread_count` = ?,`ai_state` = ?,`metadata_json` = ?,`last_message_json` = ?,`last_activity_at` = ?,`created_at` = ?,`updated_at` = ?,`cached_at` = ?,`opened_at` = ? WHERE `account_id` = ? AND `workspace_id` = ? AND `conversation_id` = ?"

      protected override fun bind(statement: SQLiteStatement, entity: ConversationEntity) {
        statement.bindText(1, entity.accountId)
        statement.bindText(2, entity.workspaceId)
        statement.bindText(3, entity.conversationId)
        val _tmpContactId: String? = entity.contactId
        if (_tmpContactId == null) {
          statement.bindNull(4)
        } else {
          statement.bindText(4, _tmpContactId)
        }
        val _tmpContactName: String? = entity.contactName
        if (_tmpContactName == null) {
          statement.bindNull(5)
        } else {
          statement.bindText(5, _tmpContactName)
        }
        val _tmpContactEmail: String? = entity.contactEmail
        if (_tmpContactEmail == null) {
          statement.bindNull(6)
        } else {
          statement.bindText(6, _tmpContactEmail)
        }
        val _tmpContactAvatarUrl: String? = entity.contactAvatarUrl
        if (_tmpContactAvatarUrl == null) {
          statement.bindNull(7)
        } else {
          statement.bindText(7, _tmpContactAvatarUrl)
        }
        val _tmpContactVisitorCode: String? = entity.contactVisitorCode
        if (_tmpContactVisitorCode == null) {
          statement.bindNull(8)
        } else {
          statement.bindText(8, _tmpContactVisitorCode)
        }
        val _tmpSubject: String? = entity.subject
        if (_tmpSubject == null) {
          statement.bindNull(9)
        } else {
          statement.bindText(9, _tmpSubject)
        }
        val _tmpChannel: String? = entity.channel
        if (_tmpChannel == null) {
          statement.bindNull(10)
        } else {
          statement.bindText(10, _tmpChannel)
        }
        statement.bindText(11, entity.status)
        val _tmpPriority: String? = entity.priority
        if (_tmpPriority == null) {
          statement.bindNull(12)
        } else {
          statement.bindText(12, _tmpPriority)
        }
        val _tmpAssignedTo: String? = entity.assignedTo
        if (_tmpAssignedTo == null) {
          statement.bindNull(13)
        } else {
          statement.bindText(13, _tmpAssignedTo)
        }
        val _tmpTagsJson: String? = entity.tagsJson
        if (_tmpTagsJson == null) {
          statement.bindNull(14)
        } else {
          statement.bindText(14, _tmpTagsJson)
        }
        val _tmpUnreadCount: Int? = entity.unreadCount
        if (_tmpUnreadCount == null) {
          statement.bindNull(15)
        } else {
          statement.bindLong(15, _tmpUnreadCount.toLong())
        }
        val _tmpAiState: String? = entity.aiState
        if (_tmpAiState == null) {
          statement.bindNull(16)
        } else {
          statement.bindText(16, _tmpAiState)
        }
        val _tmpMetadataJson: String? = entity.metadataJson
        if (_tmpMetadataJson == null) {
          statement.bindNull(17)
        } else {
          statement.bindText(17, _tmpMetadataJson)
        }
        val _tmpLastMessageJson: String? = entity.lastMessageJson
        if (_tmpLastMessageJson == null) {
          statement.bindNull(18)
        } else {
          statement.bindText(18, _tmpLastMessageJson)
        }
        val _tmpLastActivityAt: Long? = entity.lastActivityAt
        if (_tmpLastActivityAt == null) {
          statement.bindNull(19)
        } else {
          statement.bindLong(19, _tmpLastActivityAt)
        }
        val _tmpCreatedAt: Long? = entity.createdAt
        if (_tmpCreatedAt == null) {
          statement.bindNull(20)
        } else {
          statement.bindLong(20, _tmpCreatedAt)
        }
        val _tmpUpdatedAt: Long? = entity.updatedAt
        if (_tmpUpdatedAt == null) {
          statement.bindNull(21)
        } else {
          statement.bindLong(21, _tmpUpdatedAt)
        }
        statement.bindLong(22, entity.cachedAt)
        val _tmpOpenedAt: Long? = entity.openedAt
        if (_tmpOpenedAt == null) {
          statement.bindNull(23)
        } else {
          statement.bindLong(23, _tmpOpenedAt)
        }
        statement.bindText(24, entity.accountId)
        statement.bindText(25, entity.workspaceId)
        statement.bindText(26, entity.conversationId)
      }
    })
    this.__upsertAdapterOfInboxEntryEntity = EntityUpsertAdapter<InboxEntryEntity>(object : EntityInsertAdapter<InboxEntryEntity>() {
      protected override fun createQuery(): String = "INSERT INTO `inbox_entries` (`account_id`,`workspace_id`,`list_key`,`conversation_id`) VALUES (?,?,?,?)"

      protected override fun bind(statement: SQLiteStatement, entity: InboxEntryEntity) {
        statement.bindText(1, entity.accountId)
        statement.bindText(2, entity.workspaceId)
        statement.bindText(3, entity.listKey)
        statement.bindText(4, entity.conversationId)
      }
    }, object : EntityDeleteOrUpdateAdapter<InboxEntryEntity>() {
      protected override fun createQuery(): String = "UPDATE `inbox_entries` SET `account_id` = ?,`workspace_id` = ?,`list_key` = ?,`conversation_id` = ? WHERE `account_id` = ? AND `workspace_id` = ? AND `list_key` = ? AND `conversation_id` = ?"

      protected override fun bind(statement: SQLiteStatement, entity: InboxEntryEntity) {
        statement.bindText(1, entity.accountId)
        statement.bindText(2, entity.workspaceId)
        statement.bindText(3, entity.listKey)
        statement.bindText(4, entity.conversationId)
        statement.bindText(5, entity.accountId)
        statement.bindText(6, entity.workspaceId)
        statement.bindText(7, entity.listKey)
        statement.bindText(8, entity.conversationId)
      }
    })
  }

  public override suspend fun upsert(rows: List<ConversationEntity>): Unit = performSuspending(__db, false, true) { _connection ->
    __upsertAdapterOfConversationEntity.upsert(_connection, rows)
  }

  public override suspend fun upsertEntries(rows: List<InboxEntryEntity>): Unit = performSuspending(__db, false, true) { _connection ->
    __upsertAdapterOfInboxEntryEntity.upsert(_connection, rows)
  }

  public override fun observeList(
    accountId: String,
    workspaceId: String,
    listKey: String,
  ): Flow<List<ConversationEntity>> {
    val _sql: String = """
        |
        |        SELECT c.* FROM conversations AS c
        |        INNER JOIN inbox_entries AS e
        |            ON e.account_id = c.account_id
        |            AND e.workspace_id = c.workspace_id
        |            AND e.conversation_id = c.conversation_id
        |        WHERE e.account_id = ? AND e.workspace_id = ? AND e.list_key = ?
        |        ORDER BY c.updated_at DESC, c.conversation_id ASC
        |        
        """.trimMargin()
    return createFlow(__db, false, arrayOf("conversations", "inbox_entries")) { _connection ->
      val _stmt: SQLiteStatement = _connection.prepare(_sql)
      try {
        var _argIndex: Int = 1
        _stmt.bindText(_argIndex, accountId)
        _argIndex = 2
        _stmt.bindText(_argIndex, workspaceId)
        _argIndex = 3
        _stmt.bindText(_argIndex, listKey)
        val _columnIndexOfAccountId: Int = getColumnIndexOrThrow(_stmt, "account_id")
        val _columnIndexOfWorkspaceId: Int = getColumnIndexOrThrow(_stmt, "workspace_id")
        val _columnIndexOfConversationId: Int = getColumnIndexOrThrow(_stmt, "conversation_id")
        val _columnIndexOfContactId: Int = getColumnIndexOrThrow(_stmt, "contact_id")
        val _columnIndexOfContactName: Int = getColumnIndexOrThrow(_stmt, "contact_name")
        val _columnIndexOfContactEmail: Int = getColumnIndexOrThrow(_stmt, "contact_email")
        val _columnIndexOfContactAvatarUrl: Int = getColumnIndexOrThrow(_stmt, "contact_avatar_url")
        val _columnIndexOfContactVisitorCode: Int = getColumnIndexOrThrow(_stmt, "contact_visitor_code")
        val _columnIndexOfSubject: Int = getColumnIndexOrThrow(_stmt, "subject")
        val _columnIndexOfChannel: Int = getColumnIndexOrThrow(_stmt, "channel")
        val _columnIndexOfStatus: Int = getColumnIndexOrThrow(_stmt, "status")
        val _columnIndexOfPriority: Int = getColumnIndexOrThrow(_stmt, "priority")
        val _columnIndexOfAssignedTo: Int = getColumnIndexOrThrow(_stmt, "assigned_to")
        val _columnIndexOfTagsJson: Int = getColumnIndexOrThrow(_stmt, "tags_json")
        val _columnIndexOfUnreadCount: Int = getColumnIndexOrThrow(_stmt, "unread_count")
        val _columnIndexOfAiState: Int = getColumnIndexOrThrow(_stmt, "ai_state")
        val _columnIndexOfMetadataJson: Int = getColumnIndexOrThrow(_stmt, "metadata_json")
        val _columnIndexOfLastMessageJson: Int = getColumnIndexOrThrow(_stmt, "last_message_json")
        val _columnIndexOfLastActivityAt: Int = getColumnIndexOrThrow(_stmt, "last_activity_at")
        val _columnIndexOfCreatedAt: Int = getColumnIndexOrThrow(_stmt, "created_at")
        val _columnIndexOfUpdatedAt: Int = getColumnIndexOrThrow(_stmt, "updated_at")
        val _columnIndexOfCachedAt: Int = getColumnIndexOrThrow(_stmt, "cached_at")
        val _columnIndexOfOpenedAt: Int = getColumnIndexOrThrow(_stmt, "opened_at")
        val _result: MutableList<ConversationEntity> = mutableListOf()
        while (_stmt.step()) {
          val _item: ConversationEntity
          val _tmpAccountId: String
          _tmpAccountId = _stmt.getText(_columnIndexOfAccountId)
          val _tmpWorkspaceId: String
          _tmpWorkspaceId = _stmt.getText(_columnIndexOfWorkspaceId)
          val _tmpConversationId: String
          _tmpConversationId = _stmt.getText(_columnIndexOfConversationId)
          val _tmpContactId: String?
          if (_stmt.isNull(_columnIndexOfContactId)) {
            _tmpContactId = null
          } else {
            _tmpContactId = _stmt.getText(_columnIndexOfContactId)
          }
          val _tmpContactName: String?
          if (_stmt.isNull(_columnIndexOfContactName)) {
            _tmpContactName = null
          } else {
            _tmpContactName = _stmt.getText(_columnIndexOfContactName)
          }
          val _tmpContactEmail: String?
          if (_stmt.isNull(_columnIndexOfContactEmail)) {
            _tmpContactEmail = null
          } else {
            _tmpContactEmail = _stmt.getText(_columnIndexOfContactEmail)
          }
          val _tmpContactAvatarUrl: String?
          if (_stmt.isNull(_columnIndexOfContactAvatarUrl)) {
            _tmpContactAvatarUrl = null
          } else {
            _tmpContactAvatarUrl = _stmt.getText(_columnIndexOfContactAvatarUrl)
          }
          val _tmpContactVisitorCode: String?
          if (_stmt.isNull(_columnIndexOfContactVisitorCode)) {
            _tmpContactVisitorCode = null
          } else {
            _tmpContactVisitorCode = _stmt.getText(_columnIndexOfContactVisitorCode)
          }
          val _tmpSubject: String?
          if (_stmt.isNull(_columnIndexOfSubject)) {
            _tmpSubject = null
          } else {
            _tmpSubject = _stmt.getText(_columnIndexOfSubject)
          }
          val _tmpChannel: String?
          if (_stmt.isNull(_columnIndexOfChannel)) {
            _tmpChannel = null
          } else {
            _tmpChannel = _stmt.getText(_columnIndexOfChannel)
          }
          val _tmpStatus: String
          _tmpStatus = _stmt.getText(_columnIndexOfStatus)
          val _tmpPriority: String?
          if (_stmt.isNull(_columnIndexOfPriority)) {
            _tmpPriority = null
          } else {
            _tmpPriority = _stmt.getText(_columnIndexOfPriority)
          }
          val _tmpAssignedTo: String?
          if (_stmt.isNull(_columnIndexOfAssignedTo)) {
            _tmpAssignedTo = null
          } else {
            _tmpAssignedTo = _stmt.getText(_columnIndexOfAssignedTo)
          }
          val _tmpTagsJson: String?
          if (_stmt.isNull(_columnIndexOfTagsJson)) {
            _tmpTagsJson = null
          } else {
            _tmpTagsJson = _stmt.getText(_columnIndexOfTagsJson)
          }
          val _tmpUnreadCount: Int?
          if (_stmt.isNull(_columnIndexOfUnreadCount)) {
            _tmpUnreadCount = null
          } else {
            _tmpUnreadCount = _stmt.getLong(_columnIndexOfUnreadCount).toInt()
          }
          val _tmpAiState: String?
          if (_stmt.isNull(_columnIndexOfAiState)) {
            _tmpAiState = null
          } else {
            _tmpAiState = _stmt.getText(_columnIndexOfAiState)
          }
          val _tmpMetadataJson: String?
          if (_stmt.isNull(_columnIndexOfMetadataJson)) {
            _tmpMetadataJson = null
          } else {
            _tmpMetadataJson = _stmt.getText(_columnIndexOfMetadataJson)
          }
          val _tmpLastMessageJson: String?
          if (_stmt.isNull(_columnIndexOfLastMessageJson)) {
            _tmpLastMessageJson = null
          } else {
            _tmpLastMessageJson = _stmt.getText(_columnIndexOfLastMessageJson)
          }
          val _tmpLastActivityAt: Long?
          if (_stmt.isNull(_columnIndexOfLastActivityAt)) {
            _tmpLastActivityAt = null
          } else {
            _tmpLastActivityAt = _stmt.getLong(_columnIndexOfLastActivityAt)
          }
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
          val _tmpCachedAt: Long
          _tmpCachedAt = _stmt.getLong(_columnIndexOfCachedAt)
          val _tmpOpenedAt: Long?
          if (_stmt.isNull(_columnIndexOfOpenedAt)) {
            _tmpOpenedAt = null
          } else {
            _tmpOpenedAt = _stmt.getLong(_columnIndexOfOpenedAt)
          }
          _item = ConversationEntity(_tmpAccountId,_tmpWorkspaceId,_tmpConversationId,_tmpContactId,_tmpContactName,_tmpContactEmail,_tmpContactAvatarUrl,_tmpContactVisitorCode,_tmpSubject,_tmpChannel,_tmpStatus,_tmpPriority,_tmpAssignedTo,_tmpTagsJson,_tmpUnreadCount,_tmpAiState,_tmpMetadataJson,_tmpLastMessageJson,_tmpLastActivityAt,_tmpCreatedAt,_tmpUpdatedAt,_tmpCachedAt,_tmpOpenedAt)
          _result.add(_item)
        }
        _result
      } finally {
        _stmt.close()
      }
    }
  }

  public override fun observe(
    accountId: String,
    workspaceId: String,
    conversationId: String,
  ): Flow<ConversationEntity?> {
    val _sql: String = """
        |
        |        SELECT * FROM conversations
        |        WHERE account_id = ? AND workspace_id = ? AND conversation_id = ?
        |        
        """.trimMargin()
    return createFlow(__db, false, arrayOf("conversations")) { _connection ->
      val _stmt: SQLiteStatement = _connection.prepare(_sql)
      try {
        var _argIndex: Int = 1
        _stmt.bindText(_argIndex, accountId)
        _argIndex = 2
        _stmt.bindText(_argIndex, workspaceId)
        _argIndex = 3
        _stmt.bindText(_argIndex, conversationId)
        val _columnIndexOfAccountId: Int = getColumnIndexOrThrow(_stmt, "account_id")
        val _columnIndexOfWorkspaceId: Int = getColumnIndexOrThrow(_stmt, "workspace_id")
        val _columnIndexOfConversationId: Int = getColumnIndexOrThrow(_stmt, "conversation_id")
        val _columnIndexOfContactId: Int = getColumnIndexOrThrow(_stmt, "contact_id")
        val _columnIndexOfContactName: Int = getColumnIndexOrThrow(_stmt, "contact_name")
        val _columnIndexOfContactEmail: Int = getColumnIndexOrThrow(_stmt, "contact_email")
        val _columnIndexOfContactAvatarUrl: Int = getColumnIndexOrThrow(_stmt, "contact_avatar_url")
        val _columnIndexOfContactVisitorCode: Int = getColumnIndexOrThrow(_stmt, "contact_visitor_code")
        val _columnIndexOfSubject: Int = getColumnIndexOrThrow(_stmt, "subject")
        val _columnIndexOfChannel: Int = getColumnIndexOrThrow(_stmt, "channel")
        val _columnIndexOfStatus: Int = getColumnIndexOrThrow(_stmt, "status")
        val _columnIndexOfPriority: Int = getColumnIndexOrThrow(_stmt, "priority")
        val _columnIndexOfAssignedTo: Int = getColumnIndexOrThrow(_stmt, "assigned_to")
        val _columnIndexOfTagsJson: Int = getColumnIndexOrThrow(_stmt, "tags_json")
        val _columnIndexOfUnreadCount: Int = getColumnIndexOrThrow(_stmt, "unread_count")
        val _columnIndexOfAiState: Int = getColumnIndexOrThrow(_stmt, "ai_state")
        val _columnIndexOfMetadataJson: Int = getColumnIndexOrThrow(_stmt, "metadata_json")
        val _columnIndexOfLastMessageJson: Int = getColumnIndexOrThrow(_stmt, "last_message_json")
        val _columnIndexOfLastActivityAt: Int = getColumnIndexOrThrow(_stmt, "last_activity_at")
        val _columnIndexOfCreatedAt: Int = getColumnIndexOrThrow(_stmt, "created_at")
        val _columnIndexOfUpdatedAt: Int = getColumnIndexOrThrow(_stmt, "updated_at")
        val _columnIndexOfCachedAt: Int = getColumnIndexOrThrow(_stmt, "cached_at")
        val _columnIndexOfOpenedAt: Int = getColumnIndexOrThrow(_stmt, "opened_at")
        val _result: ConversationEntity?
        if (_stmt.step()) {
          val _tmpAccountId: String
          _tmpAccountId = _stmt.getText(_columnIndexOfAccountId)
          val _tmpWorkspaceId: String
          _tmpWorkspaceId = _stmt.getText(_columnIndexOfWorkspaceId)
          val _tmpConversationId: String
          _tmpConversationId = _stmt.getText(_columnIndexOfConversationId)
          val _tmpContactId: String?
          if (_stmt.isNull(_columnIndexOfContactId)) {
            _tmpContactId = null
          } else {
            _tmpContactId = _stmt.getText(_columnIndexOfContactId)
          }
          val _tmpContactName: String?
          if (_stmt.isNull(_columnIndexOfContactName)) {
            _tmpContactName = null
          } else {
            _tmpContactName = _stmt.getText(_columnIndexOfContactName)
          }
          val _tmpContactEmail: String?
          if (_stmt.isNull(_columnIndexOfContactEmail)) {
            _tmpContactEmail = null
          } else {
            _tmpContactEmail = _stmt.getText(_columnIndexOfContactEmail)
          }
          val _tmpContactAvatarUrl: String?
          if (_stmt.isNull(_columnIndexOfContactAvatarUrl)) {
            _tmpContactAvatarUrl = null
          } else {
            _tmpContactAvatarUrl = _stmt.getText(_columnIndexOfContactAvatarUrl)
          }
          val _tmpContactVisitorCode: String?
          if (_stmt.isNull(_columnIndexOfContactVisitorCode)) {
            _tmpContactVisitorCode = null
          } else {
            _tmpContactVisitorCode = _stmt.getText(_columnIndexOfContactVisitorCode)
          }
          val _tmpSubject: String?
          if (_stmt.isNull(_columnIndexOfSubject)) {
            _tmpSubject = null
          } else {
            _tmpSubject = _stmt.getText(_columnIndexOfSubject)
          }
          val _tmpChannel: String?
          if (_stmt.isNull(_columnIndexOfChannel)) {
            _tmpChannel = null
          } else {
            _tmpChannel = _stmt.getText(_columnIndexOfChannel)
          }
          val _tmpStatus: String
          _tmpStatus = _stmt.getText(_columnIndexOfStatus)
          val _tmpPriority: String?
          if (_stmt.isNull(_columnIndexOfPriority)) {
            _tmpPriority = null
          } else {
            _tmpPriority = _stmt.getText(_columnIndexOfPriority)
          }
          val _tmpAssignedTo: String?
          if (_stmt.isNull(_columnIndexOfAssignedTo)) {
            _tmpAssignedTo = null
          } else {
            _tmpAssignedTo = _stmt.getText(_columnIndexOfAssignedTo)
          }
          val _tmpTagsJson: String?
          if (_stmt.isNull(_columnIndexOfTagsJson)) {
            _tmpTagsJson = null
          } else {
            _tmpTagsJson = _stmt.getText(_columnIndexOfTagsJson)
          }
          val _tmpUnreadCount: Int?
          if (_stmt.isNull(_columnIndexOfUnreadCount)) {
            _tmpUnreadCount = null
          } else {
            _tmpUnreadCount = _stmt.getLong(_columnIndexOfUnreadCount).toInt()
          }
          val _tmpAiState: String?
          if (_stmt.isNull(_columnIndexOfAiState)) {
            _tmpAiState = null
          } else {
            _tmpAiState = _stmt.getText(_columnIndexOfAiState)
          }
          val _tmpMetadataJson: String?
          if (_stmt.isNull(_columnIndexOfMetadataJson)) {
            _tmpMetadataJson = null
          } else {
            _tmpMetadataJson = _stmt.getText(_columnIndexOfMetadataJson)
          }
          val _tmpLastMessageJson: String?
          if (_stmt.isNull(_columnIndexOfLastMessageJson)) {
            _tmpLastMessageJson = null
          } else {
            _tmpLastMessageJson = _stmt.getText(_columnIndexOfLastMessageJson)
          }
          val _tmpLastActivityAt: Long?
          if (_stmt.isNull(_columnIndexOfLastActivityAt)) {
            _tmpLastActivityAt = null
          } else {
            _tmpLastActivityAt = _stmt.getLong(_columnIndexOfLastActivityAt)
          }
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
          val _tmpCachedAt: Long
          _tmpCachedAt = _stmt.getLong(_columnIndexOfCachedAt)
          val _tmpOpenedAt: Long?
          if (_stmt.isNull(_columnIndexOfOpenedAt)) {
            _tmpOpenedAt = null
          } else {
            _tmpOpenedAt = _stmt.getLong(_columnIndexOfOpenedAt)
          }
          _result = ConversationEntity(_tmpAccountId,_tmpWorkspaceId,_tmpConversationId,_tmpContactId,_tmpContactName,_tmpContactEmail,_tmpContactAvatarUrl,_tmpContactVisitorCode,_tmpSubject,_tmpChannel,_tmpStatus,_tmpPriority,_tmpAssignedTo,_tmpTagsJson,_tmpUnreadCount,_tmpAiState,_tmpMetadataJson,_tmpLastMessageJson,_tmpLastActivityAt,_tmpCreatedAt,_tmpUpdatedAt,_tmpCachedAt,_tmpOpenedAt)
        } else {
          _result = null
        }
        _result
      } finally {
        _stmt.close()
      }
    }
  }

  public override suspend fun `get`(
    accountId: String,
    workspaceId: String,
    conversationId: String,
  ): ConversationEntity? {
    val _sql: String = """
        |
        |        SELECT * FROM conversations
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
        val _columnIndexOfAccountId: Int = getColumnIndexOrThrow(_stmt, "account_id")
        val _columnIndexOfWorkspaceId: Int = getColumnIndexOrThrow(_stmt, "workspace_id")
        val _columnIndexOfConversationId: Int = getColumnIndexOrThrow(_stmt, "conversation_id")
        val _columnIndexOfContactId: Int = getColumnIndexOrThrow(_stmt, "contact_id")
        val _columnIndexOfContactName: Int = getColumnIndexOrThrow(_stmt, "contact_name")
        val _columnIndexOfContactEmail: Int = getColumnIndexOrThrow(_stmt, "contact_email")
        val _columnIndexOfContactAvatarUrl: Int = getColumnIndexOrThrow(_stmt, "contact_avatar_url")
        val _columnIndexOfContactVisitorCode: Int = getColumnIndexOrThrow(_stmt, "contact_visitor_code")
        val _columnIndexOfSubject: Int = getColumnIndexOrThrow(_stmt, "subject")
        val _columnIndexOfChannel: Int = getColumnIndexOrThrow(_stmt, "channel")
        val _columnIndexOfStatus: Int = getColumnIndexOrThrow(_stmt, "status")
        val _columnIndexOfPriority: Int = getColumnIndexOrThrow(_stmt, "priority")
        val _columnIndexOfAssignedTo: Int = getColumnIndexOrThrow(_stmt, "assigned_to")
        val _columnIndexOfTagsJson: Int = getColumnIndexOrThrow(_stmt, "tags_json")
        val _columnIndexOfUnreadCount: Int = getColumnIndexOrThrow(_stmt, "unread_count")
        val _columnIndexOfAiState: Int = getColumnIndexOrThrow(_stmt, "ai_state")
        val _columnIndexOfMetadataJson: Int = getColumnIndexOrThrow(_stmt, "metadata_json")
        val _columnIndexOfLastMessageJson: Int = getColumnIndexOrThrow(_stmt, "last_message_json")
        val _columnIndexOfLastActivityAt: Int = getColumnIndexOrThrow(_stmt, "last_activity_at")
        val _columnIndexOfCreatedAt: Int = getColumnIndexOrThrow(_stmt, "created_at")
        val _columnIndexOfUpdatedAt: Int = getColumnIndexOrThrow(_stmt, "updated_at")
        val _columnIndexOfCachedAt: Int = getColumnIndexOrThrow(_stmt, "cached_at")
        val _columnIndexOfOpenedAt: Int = getColumnIndexOrThrow(_stmt, "opened_at")
        val _result: ConversationEntity?
        if (_stmt.step()) {
          val _tmpAccountId: String
          _tmpAccountId = _stmt.getText(_columnIndexOfAccountId)
          val _tmpWorkspaceId: String
          _tmpWorkspaceId = _stmt.getText(_columnIndexOfWorkspaceId)
          val _tmpConversationId: String
          _tmpConversationId = _stmt.getText(_columnIndexOfConversationId)
          val _tmpContactId: String?
          if (_stmt.isNull(_columnIndexOfContactId)) {
            _tmpContactId = null
          } else {
            _tmpContactId = _stmt.getText(_columnIndexOfContactId)
          }
          val _tmpContactName: String?
          if (_stmt.isNull(_columnIndexOfContactName)) {
            _tmpContactName = null
          } else {
            _tmpContactName = _stmt.getText(_columnIndexOfContactName)
          }
          val _tmpContactEmail: String?
          if (_stmt.isNull(_columnIndexOfContactEmail)) {
            _tmpContactEmail = null
          } else {
            _tmpContactEmail = _stmt.getText(_columnIndexOfContactEmail)
          }
          val _tmpContactAvatarUrl: String?
          if (_stmt.isNull(_columnIndexOfContactAvatarUrl)) {
            _tmpContactAvatarUrl = null
          } else {
            _tmpContactAvatarUrl = _stmt.getText(_columnIndexOfContactAvatarUrl)
          }
          val _tmpContactVisitorCode: String?
          if (_stmt.isNull(_columnIndexOfContactVisitorCode)) {
            _tmpContactVisitorCode = null
          } else {
            _tmpContactVisitorCode = _stmt.getText(_columnIndexOfContactVisitorCode)
          }
          val _tmpSubject: String?
          if (_stmt.isNull(_columnIndexOfSubject)) {
            _tmpSubject = null
          } else {
            _tmpSubject = _stmt.getText(_columnIndexOfSubject)
          }
          val _tmpChannel: String?
          if (_stmt.isNull(_columnIndexOfChannel)) {
            _tmpChannel = null
          } else {
            _tmpChannel = _stmt.getText(_columnIndexOfChannel)
          }
          val _tmpStatus: String
          _tmpStatus = _stmt.getText(_columnIndexOfStatus)
          val _tmpPriority: String?
          if (_stmt.isNull(_columnIndexOfPriority)) {
            _tmpPriority = null
          } else {
            _tmpPriority = _stmt.getText(_columnIndexOfPriority)
          }
          val _tmpAssignedTo: String?
          if (_stmt.isNull(_columnIndexOfAssignedTo)) {
            _tmpAssignedTo = null
          } else {
            _tmpAssignedTo = _stmt.getText(_columnIndexOfAssignedTo)
          }
          val _tmpTagsJson: String?
          if (_stmt.isNull(_columnIndexOfTagsJson)) {
            _tmpTagsJson = null
          } else {
            _tmpTagsJson = _stmt.getText(_columnIndexOfTagsJson)
          }
          val _tmpUnreadCount: Int?
          if (_stmt.isNull(_columnIndexOfUnreadCount)) {
            _tmpUnreadCount = null
          } else {
            _tmpUnreadCount = _stmt.getLong(_columnIndexOfUnreadCount).toInt()
          }
          val _tmpAiState: String?
          if (_stmt.isNull(_columnIndexOfAiState)) {
            _tmpAiState = null
          } else {
            _tmpAiState = _stmt.getText(_columnIndexOfAiState)
          }
          val _tmpMetadataJson: String?
          if (_stmt.isNull(_columnIndexOfMetadataJson)) {
            _tmpMetadataJson = null
          } else {
            _tmpMetadataJson = _stmt.getText(_columnIndexOfMetadataJson)
          }
          val _tmpLastMessageJson: String?
          if (_stmt.isNull(_columnIndexOfLastMessageJson)) {
            _tmpLastMessageJson = null
          } else {
            _tmpLastMessageJson = _stmt.getText(_columnIndexOfLastMessageJson)
          }
          val _tmpLastActivityAt: Long?
          if (_stmt.isNull(_columnIndexOfLastActivityAt)) {
            _tmpLastActivityAt = null
          } else {
            _tmpLastActivityAt = _stmt.getLong(_columnIndexOfLastActivityAt)
          }
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
          val _tmpCachedAt: Long
          _tmpCachedAt = _stmt.getLong(_columnIndexOfCachedAt)
          val _tmpOpenedAt: Long?
          if (_stmt.isNull(_columnIndexOfOpenedAt)) {
            _tmpOpenedAt = null
          } else {
            _tmpOpenedAt = _stmt.getLong(_columnIndexOfOpenedAt)
          }
          _result = ConversationEntity(_tmpAccountId,_tmpWorkspaceId,_tmpConversationId,_tmpContactId,_tmpContactName,_tmpContactEmail,_tmpContactAvatarUrl,_tmpContactVisitorCode,_tmpSubject,_tmpChannel,_tmpStatus,_tmpPriority,_tmpAssignedTo,_tmpTagsJson,_tmpUnreadCount,_tmpAiState,_tmpMetadataJson,_tmpLastMessageJson,_tmpLastActivityAt,_tmpCreatedAt,_tmpUpdatedAt,_tmpCachedAt,_tmpOpenedAt)
        } else {
          _result = null
        }
        _result
      } finally {
        _stmt.close()
      }
    }
  }

  public override suspend fun getAll(
    accountId: String,
    workspaceId: String,
    ids: List<String>,
  ): List<ConversationEntity> {
    val _stringBuilder: StringBuilder = StringBuilder()
    _stringBuilder.append("""
        |
        |""".trimMargin())
    _stringBuilder.append("        SELECT * FROM conversations")
    _stringBuilder.append("""
        |
        |""".trimMargin())
    _stringBuilder.append("        WHERE account_id = ")
    _stringBuilder.append("?")
    _stringBuilder.append(" AND workspace_id = ")
    _stringBuilder.append("?")
    _stringBuilder.append(" AND conversation_id IN (")
    val _inputSize: Int = ids.size
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
        for (_item: String in ids) {
          _stmt.bindText(_argIndex, _item)
          _argIndex++
        }
        val _columnIndexOfAccountId: Int = getColumnIndexOrThrow(_stmt, "account_id")
        val _columnIndexOfWorkspaceId: Int = getColumnIndexOrThrow(_stmt, "workspace_id")
        val _columnIndexOfConversationId: Int = getColumnIndexOrThrow(_stmt, "conversation_id")
        val _columnIndexOfContactId: Int = getColumnIndexOrThrow(_stmt, "contact_id")
        val _columnIndexOfContactName: Int = getColumnIndexOrThrow(_stmt, "contact_name")
        val _columnIndexOfContactEmail: Int = getColumnIndexOrThrow(_stmt, "contact_email")
        val _columnIndexOfContactAvatarUrl: Int = getColumnIndexOrThrow(_stmt, "contact_avatar_url")
        val _columnIndexOfContactVisitorCode: Int = getColumnIndexOrThrow(_stmt, "contact_visitor_code")
        val _columnIndexOfSubject: Int = getColumnIndexOrThrow(_stmt, "subject")
        val _columnIndexOfChannel: Int = getColumnIndexOrThrow(_stmt, "channel")
        val _columnIndexOfStatus: Int = getColumnIndexOrThrow(_stmt, "status")
        val _columnIndexOfPriority: Int = getColumnIndexOrThrow(_stmt, "priority")
        val _columnIndexOfAssignedTo: Int = getColumnIndexOrThrow(_stmt, "assigned_to")
        val _columnIndexOfTagsJson: Int = getColumnIndexOrThrow(_stmt, "tags_json")
        val _columnIndexOfUnreadCount: Int = getColumnIndexOrThrow(_stmt, "unread_count")
        val _columnIndexOfAiState: Int = getColumnIndexOrThrow(_stmt, "ai_state")
        val _columnIndexOfMetadataJson: Int = getColumnIndexOrThrow(_stmt, "metadata_json")
        val _columnIndexOfLastMessageJson: Int = getColumnIndexOrThrow(_stmt, "last_message_json")
        val _columnIndexOfLastActivityAt: Int = getColumnIndexOrThrow(_stmt, "last_activity_at")
        val _columnIndexOfCreatedAt: Int = getColumnIndexOrThrow(_stmt, "created_at")
        val _columnIndexOfUpdatedAt: Int = getColumnIndexOrThrow(_stmt, "updated_at")
        val _columnIndexOfCachedAt: Int = getColumnIndexOrThrow(_stmt, "cached_at")
        val _columnIndexOfOpenedAt: Int = getColumnIndexOrThrow(_stmt, "opened_at")
        val _result: MutableList<ConversationEntity> = mutableListOf()
        while (_stmt.step()) {
          val _item_1: ConversationEntity
          val _tmpAccountId: String
          _tmpAccountId = _stmt.getText(_columnIndexOfAccountId)
          val _tmpWorkspaceId: String
          _tmpWorkspaceId = _stmt.getText(_columnIndexOfWorkspaceId)
          val _tmpConversationId: String
          _tmpConversationId = _stmt.getText(_columnIndexOfConversationId)
          val _tmpContactId: String?
          if (_stmt.isNull(_columnIndexOfContactId)) {
            _tmpContactId = null
          } else {
            _tmpContactId = _stmt.getText(_columnIndexOfContactId)
          }
          val _tmpContactName: String?
          if (_stmt.isNull(_columnIndexOfContactName)) {
            _tmpContactName = null
          } else {
            _tmpContactName = _stmt.getText(_columnIndexOfContactName)
          }
          val _tmpContactEmail: String?
          if (_stmt.isNull(_columnIndexOfContactEmail)) {
            _tmpContactEmail = null
          } else {
            _tmpContactEmail = _stmt.getText(_columnIndexOfContactEmail)
          }
          val _tmpContactAvatarUrl: String?
          if (_stmt.isNull(_columnIndexOfContactAvatarUrl)) {
            _tmpContactAvatarUrl = null
          } else {
            _tmpContactAvatarUrl = _stmt.getText(_columnIndexOfContactAvatarUrl)
          }
          val _tmpContactVisitorCode: String?
          if (_stmt.isNull(_columnIndexOfContactVisitorCode)) {
            _tmpContactVisitorCode = null
          } else {
            _tmpContactVisitorCode = _stmt.getText(_columnIndexOfContactVisitorCode)
          }
          val _tmpSubject: String?
          if (_stmt.isNull(_columnIndexOfSubject)) {
            _tmpSubject = null
          } else {
            _tmpSubject = _stmt.getText(_columnIndexOfSubject)
          }
          val _tmpChannel: String?
          if (_stmt.isNull(_columnIndexOfChannel)) {
            _tmpChannel = null
          } else {
            _tmpChannel = _stmt.getText(_columnIndexOfChannel)
          }
          val _tmpStatus: String
          _tmpStatus = _stmt.getText(_columnIndexOfStatus)
          val _tmpPriority: String?
          if (_stmt.isNull(_columnIndexOfPriority)) {
            _tmpPriority = null
          } else {
            _tmpPriority = _stmt.getText(_columnIndexOfPriority)
          }
          val _tmpAssignedTo: String?
          if (_stmt.isNull(_columnIndexOfAssignedTo)) {
            _tmpAssignedTo = null
          } else {
            _tmpAssignedTo = _stmt.getText(_columnIndexOfAssignedTo)
          }
          val _tmpTagsJson: String?
          if (_stmt.isNull(_columnIndexOfTagsJson)) {
            _tmpTagsJson = null
          } else {
            _tmpTagsJson = _stmt.getText(_columnIndexOfTagsJson)
          }
          val _tmpUnreadCount: Int?
          if (_stmt.isNull(_columnIndexOfUnreadCount)) {
            _tmpUnreadCount = null
          } else {
            _tmpUnreadCount = _stmt.getLong(_columnIndexOfUnreadCount).toInt()
          }
          val _tmpAiState: String?
          if (_stmt.isNull(_columnIndexOfAiState)) {
            _tmpAiState = null
          } else {
            _tmpAiState = _stmt.getText(_columnIndexOfAiState)
          }
          val _tmpMetadataJson: String?
          if (_stmt.isNull(_columnIndexOfMetadataJson)) {
            _tmpMetadataJson = null
          } else {
            _tmpMetadataJson = _stmt.getText(_columnIndexOfMetadataJson)
          }
          val _tmpLastMessageJson: String?
          if (_stmt.isNull(_columnIndexOfLastMessageJson)) {
            _tmpLastMessageJson = null
          } else {
            _tmpLastMessageJson = _stmt.getText(_columnIndexOfLastMessageJson)
          }
          val _tmpLastActivityAt: Long?
          if (_stmt.isNull(_columnIndexOfLastActivityAt)) {
            _tmpLastActivityAt = null
          } else {
            _tmpLastActivityAt = _stmt.getLong(_columnIndexOfLastActivityAt)
          }
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
          val _tmpCachedAt: Long
          _tmpCachedAt = _stmt.getLong(_columnIndexOfCachedAt)
          val _tmpOpenedAt: Long?
          if (_stmt.isNull(_columnIndexOfOpenedAt)) {
            _tmpOpenedAt = null
          } else {
            _tmpOpenedAt = _stmt.getLong(_columnIndexOfOpenedAt)
          }
          _item_1 = ConversationEntity(_tmpAccountId,_tmpWorkspaceId,_tmpConversationId,_tmpContactId,_tmpContactName,_tmpContactEmail,_tmpContactAvatarUrl,_tmpContactVisitorCode,_tmpSubject,_tmpChannel,_tmpStatus,_tmpPriority,_tmpAssignedTo,_tmpTagsJson,_tmpUnreadCount,_tmpAiState,_tmpMetadataJson,_tmpLastMessageJson,_tmpLastActivityAt,_tmpCreatedAt,_tmpUpdatedAt,_tmpCachedAt,_tmpOpenedAt)
          _result.add(_item_1)
        }
        _result
      } finally {
        _stmt.close()
      }
    }
  }

  public override suspend fun listIds(
    accountId: String,
    workspaceId: String,
    listKey: String,
  ): List<String> {
    val _sql: String = """
        |
        |        SELECT conversation_id FROM inbox_entries
        |        WHERE account_id = ? AND workspace_id = ? AND list_key = ?
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
        _stmt.bindText(_argIndex, listKey)
        val _result: MutableList<String> = mutableListOf()
        while (_stmt.step()) {
          val _item: String
          _item = _stmt.getText(0)
          _result.add(_item)
        }
        _result
      } finally {
        _stmt.close()
      }
    }
  }

  public override suspend fun idsForContact(
    accountId: String,
    workspaceId: String,
    contactId: String,
  ): List<String> {
    val _sql: String = """
        |
        |        SELECT conversation_id FROM conversations
        |        WHERE account_id = ? AND workspace_id = ? AND contact_id = ?
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
        _stmt.bindText(_argIndex, contactId)
        val _result: MutableList<String> = mutableListOf()
        while (_stmt.step()) {
          val _item: String
          _item = _stmt.getText(0)
          _result.add(_item)
        }
        _result
      } finally {
        _stmt.close()
      }
    }
  }

  public override suspend fun removeEntries(
    accountId: String,
    workspaceId: String,
    listKey: String,
    ids: List<String>,
  ) {
    val _stringBuilder: StringBuilder = StringBuilder()
    _stringBuilder.append("""
        |
        |""".trimMargin())
    _stringBuilder.append("        DELETE FROM inbox_entries")
    _stringBuilder.append("""
        |
        |""".trimMargin())
    _stringBuilder.append("        WHERE account_id = ")
    _stringBuilder.append("?")
    _stringBuilder.append(" AND workspace_id = ")
    _stringBuilder.append("?")
    _stringBuilder.append(" AND list_key = ")
    _stringBuilder.append("?")
    _stringBuilder.append("""
        |
        |""".trimMargin())
    _stringBuilder.append("            AND conversation_id IN (")
    val _inputSize: Int = ids.size
    appendPlaceholders(_stringBuilder, _inputSize)
    _stringBuilder.append(")")
    _stringBuilder.append("""
        |
        |""".trimMargin())
    _stringBuilder.append("        ")
    val _sql: String = _stringBuilder.toString()
    return performSuspending(__db, false, true) { _connection ->
      val _stmt: SQLiteStatement = _connection.prepare(_sql)
      try {
        var _argIndex: Int = 1
        _stmt.bindText(_argIndex, accountId)
        _argIndex = 2
        _stmt.bindText(_argIndex, workspaceId)
        _argIndex = 3
        _stmt.bindText(_argIndex, listKey)
        _argIndex = 4
        for (_item: String in ids) {
          _stmt.bindText(_argIndex, _item)
          _argIndex++
        }
        _stmt.step()
      } finally {
        _stmt.close()
      }
    }
  }

  public override suspend fun removeFromAllLists(
    accountId: String,
    workspaceId: String,
    conversationId: String,
  ) {
    val _sql: String = """
        |
        |        DELETE FROM inbox_entries
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

  public override suspend fun delete(
    accountId: String,
    workspaceId: String,
    conversationId: String,
  ) {
    val _sql: String = """
        |
        |        DELETE FROM conversations
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

  public override suspend fun markOpened(
    accountId: String,
    workspaceId: String,
    conversationId: String,
    at: Long,
  ) {
    val _sql: String = """
        |
        |        UPDATE conversations SET opened_at = ?
        |        WHERE account_id = ? AND workspace_id = ? AND conversation_id = ?
        |        
        """.trimMargin()
    return performSuspending(__db, false, true) { _connection ->
      val _stmt: SQLiteStatement = _connection.prepare(_sql)
      try {
        var _argIndex: Int = 1
        _stmt.bindLong(_argIndex, at)
        _argIndex = 2
        _stmt.bindText(_argIndex, accountId)
        _argIndex = 3
        _stmt.bindText(_argIndex, workspaceId)
        _argIndex = 4
        _stmt.bindText(_argIndex, conversationId)
        _stmt.step()
      } finally {
        _stmt.close()
      }
    }
  }

  public override suspend fun clearUnread(
    accountId: String,
    workspaceId: String,
    conversationId: String,
  ) {
    val _sql: String = """
        |
        |        UPDATE conversations SET unread_count = 0
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
