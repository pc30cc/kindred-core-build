package com.webyar.operator.core.cache

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.Index

// The cache's tables. A replica of what the server said, scoped to one
// account and one workspace per row — never a source of truth, which is why
// every table here can be dropped and rebuilt from the server without losing
// anything but time (see CacheDatabase's migration policy).
//
// No credentials, and no binary: the session token stays in the Keystore-
// encrypted DataStore, and attachment bytes live in the scoped disk cache
// (AttachmentDiskCache), never in a BLOB column.

/**
 * One inbox row, as the list endpoint last described it.
 *
 * The nested pieces the list computes server-side — the preview, the tags,
 * `metadata` — are kept as the JSON the server sent. They are read back into
 * the same types they came from, so a field the app does not know about yet
 * is never lost between a write and a read.
 */
@Entity(
    tableName = "conversations",
    primaryKeys = ["account_id", "workspace_id", "conversation_id"],
    indices = [
        // The inbox order, within one scope.
        Index(value = ["account_id", "workspace_id", "updated_at"]),
        // `contact_updated` names a contact, not a conversation.
        Index(value = ["account_id", "workspace_id", "contact_id"]),
        // Retention walks threads by when they were last looked at.
        Index(value = ["account_id", "opened_at"]),
    ],
)
data class ConversationEntity(
    @ColumnInfo(name = "account_id") val accountId: String,
    @ColumnInfo(name = "workspace_id") val workspaceId: String,
    @ColumnInfo(name = "conversation_id") val conversationId: String,
    @ColumnInfo(name = "contact_id") val contactId: String?,
    @ColumnInfo(name = "contact_name") val contactName: String?,
    @ColumnInfo(name = "contact_email") val contactEmail: String?,
    @ColumnInfo(name = "contact_avatar_url") val contactAvatarUrl: String?,
    @ColumnInfo(name = "contact_visitor_code") val contactVisitorCode: String?,
    val subject: String?,
    /** `metadata.channel` / `source` / widget — what the channel filter reads. */
    val channel: String?,
    val status: String,
    val priority: String?,
    @ColumnInfo(name = "assigned_to") val assignedTo: String?,
    @ColumnInfo(name = "tags_json") val tagsJson: String?,
    @ColumnInfo(name = "unread_count") val unreadCount: Int?,
    @ColumnInfo(name = "ai_state") val aiState: String?,
    @ColumnInfo(name = "metadata_json") val metadataJson: String?,
    @ColumnInfo(name = "last_message_json") val lastMessageJson: String?,
    /** The preview's time, else `updated_at`, else `created_at`; epoch ms. */
    @ColumnInfo(name = "last_activity_at") val lastActivityAt: Long?,
    @ColumnInfo(name = "created_at") val createdAt: Long?,
    /**
     * The server's `updated_at`, epoch ms — both the inbox order (the list
     * endpoint sorts by it) and this row's revision: an older copy never
     * replaces a newer one.
     */
    @ColumnInfo(name = "updated_at") val updatedAt: Long?,
    @ColumnInfo(name = "cached_at") val cachedAt: Long,
    /** When the operator last opened the thread; retention keeps these longest. */
    @ColumnInfo(name = "opened_at") val openedAt: Long?,
)

/**
 * Which conversations a queue held when the server was last asked.
 *
 * Membership is the server's to decide — assignment scope, the AI-intro rule,
 * who handled a resolved thread — so it is stored as the server answered it
 * rather than re-derived from a row's status on the phone.
 */
@Entity(
    tableName = "inbox_entries",
    primaryKeys = ["account_id", "workspace_id", "list_key", "conversation_id"],
    indices = [Index(value = ["account_id", "workspace_id", "conversation_id"])],
)
data class InboxEntryEntity(
    @ColumnInfo(name = "account_id") val accountId: String,
    @ColumnInfo(name = "workspace_id") val workspaceId: String,
    @ColumnInfo(name = "list_key") val listKey: String,
    @ColumnInfo(name = "conversation_id") val conversationId: String,
)

/**
 * One message of a transcript.
 *
 * [localId] is the row's identity on the phone, and it never changes: a
 * message typed here gets one before it has a server id, and keeps it after
 * the server confirms — so the transcript's list key does not change under a
 * bubble the operator is looking at. A row that only ever came from the
 * server is `s:<serverId>`.
 *
 * The merge order is [serverId], then [clientMessageId]; both are unique
 * within a conversation (SQLite lets NULLs repeat, which is what a pending
 * row's missing server id needs).
 */
@Entity(
    tableName = "messages",
    primaryKeys = ["account_id", "local_id"],
    indices = [
        // The transcript, in order.
        Index(value = ["account_id", "workspace_id", "conversation_id", "sort_at"]),
        Index(value = ["account_id", "workspace_id", "conversation_id", "server_id"], unique = true),
        Index(value = ["account_id", "workspace_id", "conversation_id", "client_message_id"], unique = true),
        // The outbox.
        Index(value = ["account_id", "send_state"]),
    ],
)
data class MessageEntity(
    @ColumnInfo(name = "account_id") val accountId: String,
    @ColumnInfo(name = "local_id") val localId: String,
    @ColumnInfo(name = "workspace_id") val workspaceId: String,
    @ColumnInfo(name = "conversation_id") val conversationId: String,
    @ColumnInfo(name = "server_id") val serverId: String?,
    @ColumnInfo(name = "client_message_id") val clientMessageId: String?,
    @ColumnInfo(name = "sender_type") val senderType: String,
    @ColumnInfo(name = "sender_id") val senderId: String?,
    @ColumnInfo(name = "sender_name") val senderName: String?,
    @ColumnInfo(name = "sender_avatar") val senderAvatar: String?,
    val body: String,
    @ColumnInfo(name = "created_at") val createdAt: Long?,
    /** The server's revision of the row; an older copy never overwrites a newer. */
    @ColumnInfo(name = "updated_at") val updatedAt: Long?,
    /** System-notice metadata and the idempotency key, as the server sent them. */
    @ColumnInfo(name = "metadata_json") val metadataJson: String?,
    @ColumnInfo(name = "attachments_json") val attachmentsJson: String?,
    /** [SendState] as its ordinal-stable code. */
    @ColumnInfo(name = "send_state") val sendState: Int,
    /** For a pending message that carries a file: the uploaded attachment's id. */
    @ColumnInfo(name = "outbox_attachment_id") val outboxAttachmentId: String?,
    /** `created_at`, or for a message not yet on the server, when it was written here. */
    @ColumnInfo(name = "sort_at") val sortAt: Long,
    @ColumnInfo(name = "cached_at") val cachedAt: Long,
)

/** Where a row is between the composer and the server. Codes are stored. */
enum class SendState(val code: Int) {
    SENT(0),
    PENDING(1),
    FAILED(2);

    companion object {
        fun of(code: Int): SendState = entries.firstOrNull { it.code == code } ?: SENT
    }
}

/**
 * How far this phone has read something, per scope.
 *
 * `thread:<id>` holds the messages cursor, `list:<queue>` the list's ETag,
 * `counts:<queue>` the last counters. The cursor is written in the SAME
 * transaction as the rows it covers — never ahead of them — so a crash
 * between the two can only make the next read repeat itself, never skip.
 */
@Entity(
    tableName = "sync_state",
    primaryKeys = ["account_id", "workspace_id", "sync_key"],
)
data class SyncStateEntity(
    @ColumnInfo(name = "account_id") val accountId: String,
    @ColumnInfo(name = "workspace_id") val workspaceId: String,
    @ColumnInfo(name = "sync_key") val key: String,
    val cursor: String?,
    val etag: String?,
    /** When the last FULL read happened; deletions only show up in those. */
    @ColumnInfo(name = "full_read_at") val fullReadAt: Long?,
    /** A small JSON value some keys carry (the counters). */
    val payload: String?,
    @ColumnInfo(name = "updated_at") val updatedAt: Long,
)
