package com.webyar.`operator`.core.cache

import androidx.room.InvalidationTracker
import androidx.room.RoomOpenDelegate
import androidx.room.migration.AutoMigrationSpec
import androidx.room.migration.Migration
import androidx.room.util.TableInfo
import androidx.room.util.TableInfo.Companion.read
import androidx.room.util.dropFtsSyncTriggers
import androidx.sqlite.SQLiteConnection
import androidx.sqlite.execSQL
import javax.`annotation`.processing.Generated
import kotlin.Lazy
import kotlin.String
import kotlin.Suppress
import kotlin.collections.List
import kotlin.collections.Map
import kotlin.collections.MutableList
import kotlin.collections.MutableMap
import kotlin.collections.MutableSet
import kotlin.collections.Set
import kotlin.collections.mutableListOf
import kotlin.collections.mutableMapOf
import kotlin.collections.mutableSetOf
import kotlin.reflect.KClass

@Generated(value = ["androidx.room.RoomProcessor"])
@Suppress(names = ["UNCHECKED_CAST", "DEPRECATION", "REDUNDANT_PROJECTION", "REMOVAL"])
public class CacheDatabase_Impl : CacheDatabase() {
  private val _conversationDao: Lazy<ConversationDao> = lazy {
    ConversationDao_Impl(this)
  }

  private val _messageDao: Lazy<MessageDao> = lazy {
    MessageDao_Impl(this)
  }

  private val _syncStateDao: Lazy<SyncStateDao> = lazy {
    SyncStateDao_Impl(this)
  }

  private val _maintenanceDao: Lazy<MaintenanceDao> = lazy {
    MaintenanceDao_Impl(this)
  }

  protected override fun createOpenDelegate(): RoomOpenDelegate {
    val _openDelegate: RoomOpenDelegate = object : RoomOpenDelegate(1, "b1fb89dbc1a0a1c245611c6904840a28", "39df28453bdb7bffdcfbcdb9f4c1334b") {
      public override fun createAllTables(connection: SQLiteConnection) {
        connection.execSQL("CREATE TABLE IF NOT EXISTS `conversations` (`account_id` TEXT NOT NULL, `workspace_id` TEXT NOT NULL, `conversation_id` TEXT NOT NULL, `contact_id` TEXT, `contact_name` TEXT, `contact_email` TEXT, `contact_avatar_url` TEXT, `contact_visitor_code` TEXT, `subject` TEXT, `channel` TEXT, `status` TEXT NOT NULL, `priority` TEXT, `assigned_to` TEXT, `tags_json` TEXT, `unread_count` INTEGER, `ai_state` TEXT, `metadata_json` TEXT, `last_message_json` TEXT, `last_activity_at` INTEGER, `created_at` INTEGER, `updated_at` INTEGER, `cached_at` INTEGER NOT NULL, `opened_at` INTEGER, PRIMARY KEY(`account_id`, `workspace_id`, `conversation_id`))")
        connection.execSQL("CREATE INDEX IF NOT EXISTS `index_conversations_account_id_workspace_id_updated_at` ON `conversations` (`account_id`, `workspace_id`, `updated_at`)")
        connection.execSQL("CREATE INDEX IF NOT EXISTS `index_conversations_account_id_workspace_id_contact_id` ON `conversations` (`account_id`, `workspace_id`, `contact_id`)")
        connection.execSQL("CREATE INDEX IF NOT EXISTS `index_conversations_account_id_opened_at` ON `conversations` (`account_id`, `opened_at`)")
        connection.execSQL("CREATE TABLE IF NOT EXISTS `inbox_entries` (`account_id` TEXT NOT NULL, `workspace_id` TEXT NOT NULL, `list_key` TEXT NOT NULL, `conversation_id` TEXT NOT NULL, PRIMARY KEY(`account_id`, `workspace_id`, `list_key`, `conversation_id`))")
        connection.execSQL("CREATE INDEX IF NOT EXISTS `index_inbox_entries_account_id_workspace_id_conversation_id` ON `inbox_entries` (`account_id`, `workspace_id`, `conversation_id`)")
        connection.execSQL("CREATE TABLE IF NOT EXISTS `messages` (`account_id` TEXT NOT NULL, `local_id` TEXT NOT NULL, `workspace_id` TEXT NOT NULL, `conversation_id` TEXT NOT NULL, `server_id` TEXT, `client_message_id` TEXT, `sender_type` TEXT NOT NULL, `sender_id` TEXT, `sender_name` TEXT, `sender_avatar` TEXT, `body` TEXT NOT NULL, `created_at` INTEGER, `updated_at` INTEGER, `metadata_json` TEXT, `attachments_json` TEXT, `send_state` INTEGER NOT NULL, `outbox_attachment_id` TEXT, `sort_at` INTEGER NOT NULL, `cached_at` INTEGER NOT NULL, PRIMARY KEY(`account_id`, `local_id`))")
        connection.execSQL("CREATE INDEX IF NOT EXISTS `index_messages_account_id_workspace_id_conversation_id_sort_at` ON `messages` (`account_id`, `workspace_id`, `conversation_id`, `sort_at`)")
        connection.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS `index_messages_account_id_workspace_id_conversation_id_server_id` ON `messages` (`account_id`, `workspace_id`, `conversation_id`, `server_id`)")
        connection.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS `index_messages_account_id_workspace_id_conversation_id_client_message_id` ON `messages` (`account_id`, `workspace_id`, `conversation_id`, `client_message_id`)")
        connection.execSQL("CREATE INDEX IF NOT EXISTS `index_messages_account_id_send_state` ON `messages` (`account_id`, `send_state`)")
        connection.execSQL("CREATE TABLE IF NOT EXISTS `sync_state` (`account_id` TEXT NOT NULL, `workspace_id` TEXT NOT NULL, `sync_key` TEXT NOT NULL, `cursor` TEXT, `etag` TEXT, `full_read_at` INTEGER, `payload` TEXT, `updated_at` INTEGER NOT NULL, PRIMARY KEY(`account_id`, `workspace_id`, `sync_key`))")
        connection.execSQL("CREATE TABLE IF NOT EXISTS room_master_table (id INTEGER PRIMARY KEY,identity_hash TEXT)")
        connection.execSQL("INSERT OR REPLACE INTO room_master_table (id,identity_hash) VALUES(42, 'b1fb89dbc1a0a1c245611c6904840a28')")
      }

      public override fun dropAllTables(connection: SQLiteConnection) {
        connection.execSQL("DROP TABLE IF EXISTS `conversations`")
        connection.execSQL("DROP TABLE IF EXISTS `inbox_entries`")
        connection.execSQL("DROP TABLE IF EXISTS `messages`")
        connection.execSQL("DROP TABLE IF EXISTS `sync_state`")
      }

      public override fun onCreate(connection: SQLiteConnection) {
      }

      public override fun onOpen(connection: SQLiteConnection) {
        internalInitInvalidationTracker(connection)
      }

      public override fun onPreMigrate(connection: SQLiteConnection) {
        dropFtsSyncTriggers(connection)
      }

      public override fun onPostMigrate(connection: SQLiteConnection) {
      }

      public override fun onValidateSchema(connection: SQLiteConnection): RoomOpenDelegate.ValidationResult {
        val _columnsConversations: MutableMap<String, TableInfo.Column> = mutableMapOf()
        _columnsConversations.put("account_id", TableInfo.Column("account_id", "TEXT", true, 1, null, TableInfo.CREATED_FROM_ENTITY))
        _columnsConversations.put("workspace_id", TableInfo.Column("workspace_id", "TEXT", true, 2, null, TableInfo.CREATED_FROM_ENTITY))
        _columnsConversations.put("conversation_id", TableInfo.Column("conversation_id", "TEXT", true, 3, null, TableInfo.CREATED_FROM_ENTITY))
        _columnsConversations.put("contact_id", TableInfo.Column("contact_id", "TEXT", false, 0, null, TableInfo.CREATED_FROM_ENTITY))
        _columnsConversations.put("contact_name", TableInfo.Column("contact_name", "TEXT", false, 0, null, TableInfo.CREATED_FROM_ENTITY))
        _columnsConversations.put("contact_email", TableInfo.Column("contact_email", "TEXT", false, 0, null, TableInfo.CREATED_FROM_ENTITY))
        _columnsConversations.put("contact_avatar_url", TableInfo.Column("contact_avatar_url", "TEXT", false, 0, null, TableInfo.CREATED_FROM_ENTITY))
        _columnsConversations.put("contact_visitor_code", TableInfo.Column("contact_visitor_code", "TEXT", false, 0, null, TableInfo.CREATED_FROM_ENTITY))
        _columnsConversations.put("subject", TableInfo.Column("subject", "TEXT", false, 0, null, TableInfo.CREATED_FROM_ENTITY))
        _columnsConversations.put("channel", TableInfo.Column("channel", "TEXT", false, 0, null, TableInfo.CREATED_FROM_ENTITY))
        _columnsConversations.put("status", TableInfo.Column("status", "TEXT", true, 0, null, TableInfo.CREATED_FROM_ENTITY))
        _columnsConversations.put("priority", TableInfo.Column("priority", "TEXT", false, 0, null, TableInfo.CREATED_FROM_ENTITY))
        _columnsConversations.put("assigned_to", TableInfo.Column("assigned_to", "TEXT", false, 0, null, TableInfo.CREATED_FROM_ENTITY))
        _columnsConversations.put("tags_json", TableInfo.Column("tags_json", "TEXT", false, 0, null, TableInfo.CREATED_FROM_ENTITY))
        _columnsConversations.put("unread_count", TableInfo.Column("unread_count", "INTEGER", false, 0, null, TableInfo.CREATED_FROM_ENTITY))
        _columnsConversations.put("ai_state", TableInfo.Column("ai_state", "TEXT", false, 0, null, TableInfo.CREATED_FROM_ENTITY))
        _columnsConversations.put("metadata_json", TableInfo.Column("metadata_json", "TEXT", false, 0, null, TableInfo.CREATED_FROM_ENTITY))
        _columnsConversations.put("last_message_json", TableInfo.Column("last_message_json", "TEXT", false, 0, null, TableInfo.CREATED_FROM_ENTITY))
        _columnsConversations.put("last_activity_at", TableInfo.Column("last_activity_at", "INTEGER", false, 0, null, TableInfo.CREATED_FROM_ENTITY))
        _columnsConversations.put("created_at", TableInfo.Column("created_at", "INTEGER", false, 0, null, TableInfo.CREATED_FROM_ENTITY))
        _columnsConversations.put("updated_at", TableInfo.Column("updated_at", "INTEGER", false, 0, null, TableInfo.CREATED_FROM_ENTITY))
        _columnsConversations.put("cached_at", TableInfo.Column("cached_at", "INTEGER", true, 0, null, TableInfo.CREATED_FROM_ENTITY))
        _columnsConversations.put("opened_at", TableInfo.Column("opened_at", "INTEGER", false, 0, null, TableInfo.CREATED_FROM_ENTITY))
        val _foreignKeysConversations: MutableSet<TableInfo.ForeignKey> = mutableSetOf()
        val _indicesConversations: MutableSet<TableInfo.Index> = mutableSetOf()
        _indicesConversations.add(TableInfo.Index("index_conversations_account_id_workspace_id_updated_at", false, listOf("account_id", "workspace_id", "updated_at"), listOf("ASC", "ASC", "ASC")))
        _indicesConversations.add(TableInfo.Index("index_conversations_account_id_workspace_id_contact_id", false, listOf("account_id", "workspace_id", "contact_id"), listOf("ASC", "ASC", "ASC")))
        _indicesConversations.add(TableInfo.Index("index_conversations_account_id_opened_at", false, listOf("account_id", "opened_at"), listOf("ASC", "ASC")))
        val _infoConversations: TableInfo = TableInfo("conversations", _columnsConversations, _foreignKeysConversations, _indicesConversations)
        val _existingConversations: TableInfo = read(connection, "conversations")
        if (!_infoConversations.equals(_existingConversations)) {
          return RoomOpenDelegate.ValidationResult(false, """
              |conversations(com.webyar.operator.core.cache.ConversationEntity).
              | Expected:
              |""".trimMargin() + _infoConversations + """
              |
              | Found:
              |""".trimMargin() + _existingConversations)
        }
        val _columnsInboxEntries: MutableMap<String, TableInfo.Column> = mutableMapOf()
        _columnsInboxEntries.put("account_id", TableInfo.Column("account_id", "TEXT", true, 1, null, TableInfo.CREATED_FROM_ENTITY))
        _columnsInboxEntries.put("workspace_id", TableInfo.Column("workspace_id", "TEXT", true, 2, null, TableInfo.CREATED_FROM_ENTITY))
        _columnsInboxEntries.put("list_key", TableInfo.Column("list_key", "TEXT", true, 3, null, TableInfo.CREATED_FROM_ENTITY))
        _columnsInboxEntries.put("conversation_id", TableInfo.Column("conversation_id", "TEXT", true, 4, null, TableInfo.CREATED_FROM_ENTITY))
        val _foreignKeysInboxEntries: MutableSet<TableInfo.ForeignKey> = mutableSetOf()
        val _indicesInboxEntries: MutableSet<TableInfo.Index> = mutableSetOf()
        _indicesInboxEntries.add(TableInfo.Index("index_inbox_entries_account_id_workspace_id_conversation_id", false, listOf("account_id", "workspace_id", "conversation_id"), listOf("ASC", "ASC", "ASC")))
        val _infoInboxEntries: TableInfo = TableInfo("inbox_entries", _columnsInboxEntries, _foreignKeysInboxEntries, _indicesInboxEntries)
        val _existingInboxEntries: TableInfo = read(connection, "inbox_entries")
        if (!_infoInboxEntries.equals(_existingInboxEntries)) {
          return RoomOpenDelegate.ValidationResult(false, """
              |inbox_entries(com.webyar.operator.core.cache.InboxEntryEntity).
              | Expected:
              |""".trimMargin() + _infoInboxEntries + """
              |
              | Found:
              |""".trimMargin() + _existingInboxEntries)
        }
        val _columnsMessages: MutableMap<String, TableInfo.Column> = mutableMapOf()
        _columnsMessages.put("account_id", TableInfo.Column("account_id", "TEXT", true, 1, null, TableInfo.CREATED_FROM_ENTITY))
        _columnsMessages.put("local_id", TableInfo.Column("local_id", "TEXT", true, 2, null, TableInfo.CREATED_FROM_ENTITY))
        _columnsMessages.put("workspace_id", TableInfo.Column("workspace_id", "TEXT", true, 0, null, TableInfo.CREATED_FROM_ENTITY))
        _columnsMessages.put("conversation_id", TableInfo.Column("conversation_id", "TEXT", true, 0, null, TableInfo.CREATED_FROM_ENTITY))
        _columnsMessages.put("server_id", TableInfo.Column("server_id", "TEXT", false, 0, null, TableInfo.CREATED_FROM_ENTITY))
        _columnsMessages.put("client_message_id", TableInfo.Column("client_message_id", "TEXT", false, 0, null, TableInfo.CREATED_FROM_ENTITY))
        _columnsMessages.put("sender_type", TableInfo.Column("sender_type", "TEXT", true, 0, null, TableInfo.CREATED_FROM_ENTITY))
        _columnsMessages.put("sender_id", TableInfo.Column("sender_id", "TEXT", false, 0, null, TableInfo.CREATED_FROM_ENTITY))
        _columnsMessages.put("sender_name", TableInfo.Column("sender_name", "TEXT", false, 0, null, TableInfo.CREATED_FROM_ENTITY))
        _columnsMessages.put("sender_avatar", TableInfo.Column("sender_avatar", "TEXT", false, 0, null, TableInfo.CREATED_FROM_ENTITY))
        _columnsMessages.put("body", TableInfo.Column("body", "TEXT", true, 0, null, TableInfo.CREATED_FROM_ENTITY))
        _columnsMessages.put("created_at", TableInfo.Column("created_at", "INTEGER", false, 0, null, TableInfo.CREATED_FROM_ENTITY))
        _columnsMessages.put("updated_at", TableInfo.Column("updated_at", "INTEGER", false, 0, null, TableInfo.CREATED_FROM_ENTITY))
        _columnsMessages.put("metadata_json", TableInfo.Column("metadata_json", "TEXT", false, 0, null, TableInfo.CREATED_FROM_ENTITY))
        _columnsMessages.put("attachments_json", TableInfo.Column("attachments_json", "TEXT", false, 0, null, TableInfo.CREATED_FROM_ENTITY))
        _columnsMessages.put("send_state", TableInfo.Column("send_state", "INTEGER", true, 0, null, TableInfo.CREATED_FROM_ENTITY))
        _columnsMessages.put("outbox_attachment_id", TableInfo.Column("outbox_attachment_id", "TEXT", false, 0, null, TableInfo.CREATED_FROM_ENTITY))
        _columnsMessages.put("sort_at", TableInfo.Column("sort_at", "INTEGER", true, 0, null, TableInfo.CREATED_FROM_ENTITY))
        _columnsMessages.put("cached_at", TableInfo.Column("cached_at", "INTEGER", true, 0, null, TableInfo.CREATED_FROM_ENTITY))
        val _foreignKeysMessages: MutableSet<TableInfo.ForeignKey> = mutableSetOf()
        val _indicesMessages: MutableSet<TableInfo.Index> = mutableSetOf()
        _indicesMessages.add(TableInfo.Index("index_messages_account_id_workspace_id_conversation_id_sort_at", false, listOf("account_id", "workspace_id", "conversation_id", "sort_at"), listOf("ASC", "ASC", "ASC", "ASC")))
        _indicesMessages.add(TableInfo.Index("index_messages_account_id_workspace_id_conversation_id_server_id", true, listOf("account_id", "workspace_id", "conversation_id", "server_id"), listOf("ASC", "ASC", "ASC", "ASC")))
        _indicesMessages.add(TableInfo.Index("index_messages_account_id_workspace_id_conversation_id_client_message_id", true, listOf("account_id", "workspace_id", "conversation_id", "client_message_id"), listOf("ASC", "ASC", "ASC", "ASC")))
        _indicesMessages.add(TableInfo.Index("index_messages_account_id_send_state", false, listOf("account_id", "send_state"), listOf("ASC", "ASC")))
        val _infoMessages: TableInfo = TableInfo("messages", _columnsMessages, _foreignKeysMessages, _indicesMessages)
        val _existingMessages: TableInfo = read(connection, "messages")
        if (!_infoMessages.equals(_existingMessages)) {
          return RoomOpenDelegate.ValidationResult(false, """
              |messages(com.webyar.operator.core.cache.MessageEntity).
              | Expected:
              |""".trimMargin() + _infoMessages + """
              |
              | Found:
              |""".trimMargin() + _existingMessages)
        }
        val _columnsSyncState: MutableMap<String, TableInfo.Column> = mutableMapOf()
        _columnsSyncState.put("account_id", TableInfo.Column("account_id", "TEXT", true, 1, null, TableInfo.CREATED_FROM_ENTITY))
        _columnsSyncState.put("workspace_id", TableInfo.Column("workspace_id", "TEXT", true, 2, null, TableInfo.CREATED_FROM_ENTITY))
        _columnsSyncState.put("sync_key", TableInfo.Column("sync_key", "TEXT", true, 3, null, TableInfo.CREATED_FROM_ENTITY))
        _columnsSyncState.put("cursor", TableInfo.Column("cursor", "TEXT", false, 0, null, TableInfo.CREATED_FROM_ENTITY))
        _columnsSyncState.put("etag", TableInfo.Column("etag", "TEXT", false, 0, null, TableInfo.CREATED_FROM_ENTITY))
        _columnsSyncState.put("full_read_at", TableInfo.Column("full_read_at", "INTEGER", false, 0, null, TableInfo.CREATED_FROM_ENTITY))
        _columnsSyncState.put("payload", TableInfo.Column("payload", "TEXT", false, 0, null, TableInfo.CREATED_FROM_ENTITY))
        _columnsSyncState.put("updated_at", TableInfo.Column("updated_at", "INTEGER", true, 0, null, TableInfo.CREATED_FROM_ENTITY))
        val _foreignKeysSyncState: MutableSet<TableInfo.ForeignKey> = mutableSetOf()
        val _indicesSyncState: MutableSet<TableInfo.Index> = mutableSetOf()
        val _infoSyncState: TableInfo = TableInfo("sync_state", _columnsSyncState, _foreignKeysSyncState, _indicesSyncState)
        val _existingSyncState: TableInfo = read(connection, "sync_state")
        if (!_infoSyncState.equals(_existingSyncState)) {
          return RoomOpenDelegate.ValidationResult(false, """
              |sync_state(com.webyar.operator.core.cache.SyncStateEntity).
              | Expected:
              |""".trimMargin() + _infoSyncState + """
              |
              | Found:
              |""".trimMargin() + _existingSyncState)
        }
        return RoomOpenDelegate.ValidationResult(true, null)
      }
    }
    return _openDelegate
  }

  protected override fun createInvalidationTracker(): InvalidationTracker {
    val _shadowTablesMap: MutableMap<String, String> = mutableMapOf()
    val _viewTables: MutableMap<String, Set<String>> = mutableMapOf()
    return InvalidationTracker(this, _shadowTablesMap, _viewTables, "conversations", "inbox_entries", "messages", "sync_state")
  }

  public override fun clearAllTables() {
    super.performClear(false, "conversations", "inbox_entries", "messages", "sync_state")
  }

  protected override fun getRequiredTypeConverterClasses(): Map<KClass<*>, List<KClass<*>>> {
    val _typeConvertersMap: MutableMap<KClass<*>, List<KClass<*>>> = mutableMapOf()
    _typeConvertersMap.put(ConversationDao::class, ConversationDao_Impl.getRequiredConverters())
    _typeConvertersMap.put(MessageDao::class, MessageDao_Impl.getRequiredConverters())
    _typeConvertersMap.put(SyncStateDao::class, SyncStateDao_Impl.getRequiredConverters())
    _typeConvertersMap.put(MaintenanceDao::class, MaintenanceDao_Impl.getRequiredConverters())
    return _typeConvertersMap
  }

  public override fun getRequiredAutoMigrationSpecClasses(): Set<KClass<out AutoMigrationSpec>> {
    val _autoMigrationSpecsSet: MutableSet<KClass<out AutoMigrationSpec>> = mutableSetOf()
    return _autoMigrationSpecsSet
  }

  public override fun createAutoMigrations(autoMigrationSpecs: Map<KClass<out AutoMigrationSpec>, AutoMigrationSpec>): List<Migration> {
    val _autoMigrations: MutableList<Migration> = mutableListOf()
    return _autoMigrations
  }

  public override fun conversations(): ConversationDao = _conversationDao.value

  public override fun messages(): MessageDao = _messageDao.value

  public override fun syncState(): SyncStateDao = _syncStateDao.value

  public override fun maintenance(): MaintenanceDao = _maintenanceDao.value
}
