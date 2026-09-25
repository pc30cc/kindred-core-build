package com.webyar.operator.core.cache

import com.webyar.operator.core.model.Conversation
import com.webyar.operator.core.model.ConversationContact
import com.webyar.operator.core.model.ConversationPriority
import com.webyar.operator.core.model.ConversationStatus
import com.webyar.operator.core.model.Message
import com.webyar.operator.core.model.MessageAttachment
import com.webyar.operator.core.model.MessagePreview
import com.webyar.operator.core.model.SenderType
import com.webyar.operator.core.model.channelKey
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import java.time.Instant

/**
 * Between the server's shapes and the cache's rows.
 *
 * Nested values go in and out through the same serializers the network uses,
 * so a row read back is the row that was written — including any key this
 * build does not model, which a hand-written column mapping would drop.
 */
internal object CacheMapping {

    val json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
        coerceInputValues = true
    }

    private val attachmentList = ListSerializer(MessageAttachment.serializer())
    private val tagList = ListSerializer(String.serializer())

    // MARK: - Conversations

    fun toEntity(scope: CacheScope, conversation: Conversation, now: Long, openedAt: Long?): ConversationEntity =
        ConversationEntity(
            accountId = scope.accountId,
            workspaceId = scope.workspaceId,
            conversationId = conversation.id,
            contactId = conversation.contactId,
            contactName = conversation.contact?.name,
            contactEmail = conversation.contact?.email,
            contactAvatarUrl = conversation.contact?.avatarUrl,
            contactVisitorCode = conversation.contact?.visitorCode,
            subject = conversation.subject,
            channel = conversation.channelKey,
            status = conversation.status.wire,
            priority = conversation.priority?.wire,
            assignedTo = conversation.assignedTo,
            tagsJson = conversation.tags?.let { json.encodeToString(tagList, it) },
            unreadCount = conversation.unreadCount,
            aiState = conversation.aiState,
            metadataJson = conversation.metadata?.toString(),
            lastMessageJson = conversation.lastMessage?.let { json.encodeToString(MessagePreview.serializer(), it) },
            lastActivityAt = conversation.lastActivity?.toEpochMilli(),
            createdAt = conversation.createdAt?.toEpochMilli(),
            updatedAt = conversation.updatedAt?.toEpochMilli(),
            cachedAt = now,
            openedAt = openedAt,
        )

    fun toConversation(row: ConversationEntity): Conversation {
        val hasContact = row.contactName != null || row.contactEmail != null ||
            row.contactAvatarUrl != null || row.contactVisitorCode != null
        return Conversation(
            id = row.conversationId,
            workspaceId = row.workspaceId,
            contactId = row.contactId,
            subject = row.subject,
            status = ConversationStatus.entries.firstOrNull { it.wire == row.status } ?: ConversationStatus.OPEN,
            assignedTo = row.assignedTo,
            priority = row.priority?.let { wire -> ConversationPriority.entries.firstOrNull { it.wire == wire } },
            tags = row.tagsJson?.let { decode { json.decodeFromString(tagList, it) } },
            createdAt = row.createdAt?.let(Instant::ofEpochMilli),
            updatedAt = row.updatedAt?.let(Instant::ofEpochMilli),
            contact = if (hasContact) {
                ConversationContact(
                    name = row.contactName,
                    email = row.contactEmail,
                    avatarUrl = row.contactAvatarUrl,
                    visitorCode = row.contactVisitorCode,
                )
            } else {
                null
            },
            lastMessage = row.lastMessageJson?.let { decode { json.decodeFromString(MessagePreview.serializer(), it) } },
            unreadCount = row.unreadCount,
            aiState = row.aiState,
            metadata = row.metadataJson?.let { decode { json.parseToJsonElement(it) } },
        )
    }

    // MARK: - Messages

    /** The row for a message the server sent. Identity fields come from [existing] when there is one. */
    fun toEntity(
        scope: CacheScope,
        message: Message,
        existing: MessageEntity?,
        now: Long,
    ): MessageEntity {
        val created = message.createdAt?.toEpochMilli()
        return MessageEntity(
            accountId = scope.accountId,
            localId = existing?.localId ?: serverLocalId(message.id),
            workspaceId = scope.workspaceId,
            conversationId = message.conversationId,
            serverId = message.id,
            clientMessageId = message.clientMessageId ?: existing?.clientMessageId,
            senderType = message.senderType.wire,
            senderId = message.senderId,
            senderName = message.senderName ?: existing?.senderName,
            senderAvatar = message.senderAvatar ?: existing?.senderAvatar,
            body = message.body,
            createdAt = created ?: existing?.createdAt,
            updatedAt = message.updatedAt?.toEpochMilli() ?: existing?.updatedAt,
            metadataJson = message.metadata?.toString() ?: existing?.metadataJson,
            // A realtime or send echo can lack the list the thread endpoint
            // carries; an absent list never erases a known one.
            attachmentsJson = message.attachments?.let { json.encodeToString(attachmentList, it) }
                ?: existing?.attachmentsJson,
            sendState = SendState.SENT.code,
            outboxAttachmentId = null,
            sortAt = created ?: existing?.sortAt ?: now,
            cachedAt = now,
        )
    }

    fun toMessage(row: MessageEntity): Message = Message(
        id = row.serverId ?: row.localId,
        conversationId = row.conversationId,
        senderType = SenderType.entries.firstOrNull { it.wire == row.senderType } ?: SenderType.SYSTEM,
        senderId = row.senderId,
        body = row.body,
        createdAt = row.createdAt?.let(Instant::ofEpochMilli),
        senderName = row.senderName,
        senderAvatar = row.senderAvatar,
        metadata = row.metadataJson?.let { decode { json.parseToJsonElement(it) } },
        attachments = row.attachmentsJson?.let { decode { json.decodeFromString(attachmentList, it) } },
        updatedAt = row.updatedAt?.let(Instant::ofEpochMilli),
        localId = row.localId,
        delivery = when (SendState.of(row.sendState)) {
            SendState.SENT -> Message.Delivery.SENT
            SendState.PENDING -> Message.Delivery.PENDING
            SendState.FAILED -> Message.Delivery.FAILED
        },
    )

    fun encodeAttachments(list: List<MessageAttachment>?): String? =
        list?.let { json.encodeToString(attachmentList, it) }

    fun encodeMetadata(element: JsonElement?): String? = element?.toString()

    /** The local id of a row only the server ever wrote. */
    fun serverLocalId(serverId: String): String = "s:$serverId"

    /**
     * A value that will not decode is dropped, not thrown: one bad row in a
     * cache must cost that one field, never the whole transcript.
     */
    private inline fun <T> decode(block: () -> T): T? = runCatching(block).getOrNull()
}
