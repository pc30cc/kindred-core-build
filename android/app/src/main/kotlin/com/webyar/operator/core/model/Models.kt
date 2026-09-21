package com.webyar.operator.core.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import java.time.Instant

// The server is the schema of record. Every type here mirrors a response the
// existing REST API already returns to the web client, so the native app and
// the web app can never drift into disagreeing about what a conversation is.
//
// Fields the server may omit are nullable here rather than defaulted, so a
// missing value stays visibly missing instead of silently becoming "".

// MARK: - User

@Serializable
data class User(
    val id: String,
    val email: String? = null,
    val fullName: String? = null,
    // The backend expresses "verified" two different ways depending on the
    // code path; either one means the same thing.
    @SerialName("emailVerified") val emailVerifiedFlag: Boolean? = null,
    @SerialName("email_confirmed_at") val emailConfirmedAt: String? = null,
) {
    val emailVerified: Boolean?
        get() = emailVerifiedFlag ?: emailConfirmedAt?.let { true }

    /** What to show when we have to name this person in the UI. */
    val displayName: String
        get() = fullName?.takeIf { it.isNotBlank() }
            ?: email?.takeIf { it.isNotEmpty() }
            ?: "—"
}

// MARK: - Workspace

@Serializable
data class Workspace(
    val id: String,
    val name: String,
    val slug: String,
    /**
     * Resolved server-side from `workspace_branding` — either a URL someone
     * pasted or a signed link into our own storage. Absent for a workspace
     * that never set one, which is most of them on the first day.
     */
    @SerialName("logo_url") val logoUrl: String? = null,
)

// MARK: - Contact

@Serializable
data class Contact(
    val id: String,
    @SerialName("workspace_id") val workspaceId: String? = null,
    val name: String? = null,
    val email: String? = null,
    val phone: String? = null,
    @SerialName("avatar_url") val avatarUrl: String? = null,
    /** Stable anonymous code for a visitor who never gave a name. */
    @SerialName("visitor_code") val visitorCode: String? = null,
    @SerialName("created_at") @Serializable(InstantSerializer::class) val createdAt: Instant? = null,
)

// MARK: - Conversation

@Serializable(ConversationStatus.Serializer::class)
enum class ConversationStatus(val wire: String) {
    OPEN("open"), PENDING("pending"), RESOLVED("resolved"), CLOSED("closed");

    /** A status the server adds later degrades to `open` rather than failing. */
    internal object Serializer : FallbackEnumSerializer<ConversationStatus>(
        "ConversationStatus", entries.toTypedArray(), { it.wire }, OPEN
    )
}

/** The contact summary the list endpoint nests inside each conversation. */
@Serializable
data class ConversationContact(
    val name: String? = null,
    val email: String? = null,
    @SerialName("avatar_url") val avatarUrl: String? = null,
    @SerialName("visitor_code") val visitorCode: String? = null,
)

/**
 * The last message preview the list endpoint computes server-side.
 *
 * `body` alone is not enough to write a preview line with. A system notice's
 * body is an English sentence frozen into the row when it was written, and an
 * attachment-only message has no body at all — which is why the list endpoint
 * ships the pieces to rebuild both (`server/routes/conversations.ts`, the
 * `lastByConv` block).
 */
@Serializable
data class MessagePreview(
    val body: String? = null,
    @SerialName("created_at") @Serializable(InstantSerializer::class) val createdAt: Instant? = null,
    @SerialName("sender_type") val senderType: String? = null,
    @SerialName("sender_name") val senderName: String? = null,
    /** `image` / `audio` / `video` / `file` when the message is only an attachment. */
    @SerialName("attachment_kind") val attachmentKind: String? = null,
    /** Which system notice this is, when it is one. */
    @SerialName("system_kind") val systemKind: String? = null,
    /** Everything that notice needs to be written out again in any language. */
    @SerialName("system_meta") val systemMeta: JsonElement? = null,
)

/**
 * How urgent a thread is.
 *
 * Only the two levels above normal are ever shown — badging the ordinary case
 * would make the badge mean nothing.
 */
@Serializable(ConversationPriority.Serializer::class)
enum class ConversationPriority(val wire: String) {
    LOW("low"), NORMAL("normal"), HIGH("high"), URGENT("urgent");

    val isElevated: Boolean get() = this == HIGH || this == URGENT

    internal object Serializer : FallbackEnumSerializer<ConversationPriority>(
        "ConversationPriority", entries.toTypedArray(), { it.wire }, NORMAL
    )
}

@Serializable
data class Conversation(
    val id: String,
    @SerialName("workspace_id") val workspaceId: String,
    @SerialName("contact_id") val contactId: String? = null,
    val subject: String? = null,
    val status: ConversationStatus = ConversationStatus.OPEN,
    @SerialName("assigned_to") val assignedTo: String? = null,
    val priority: ConversationPriority? = null,
    /**
     * Free-form labels the team puts on a thread. The server normalizes them,
     * so what comes back is what should be shown.
     */
    val tags: List<String>? = null,
    @SerialName("created_at") @Serializable(InstantSerializer::class) val createdAt: Instant? = null,
    @SerialName("updated_at") @Serializable(InstantSerializer::class) val updatedAt: Instant? = null,
    @SerialName("contacts") val contact: ConversationContact? = null,
    @SerialName("last_message") val lastMessage: MessagePreview? = null,
    @SerialName("unread_count") val unreadCount: Int? = null,
    @SerialName("ai_state") val aiState: String? = null,
    /**
     * Only the keys the app reads are looked at; the rest of the object is
     * server bookkeeping.
     */
    val metadata: JsonElement? = null,
) {
    val hasUnread: Boolean get() = (unreadCount ?: 0) > 0

    /**
     * Who is answering: `metadata.ai_state` first, then the top-level column.
     *
     * Both exist server-side and the nested one is authoritative — this is the
     * same precedence `InboxPage.tsx` reads them in.
     */
    val aiStateValue: String?
        get() = metadata.string("ai_state")?.takeIf { it.isNotEmpty() } ?: aiState

    /**
     * The timestamp the list sorts and labels by: when something last happened
     * in the thread, not when it was created.
     */
    val lastActivity: Instant?
        get() = lastMessage?.createdAt ?: updatedAt ?: createdAt
}

// MARK: - Message

@Serializable(SenderType.Serializer::class)
enum class SenderType(val wire: String) {
    /** A human operator — us. */
    AGENT("agent"),
    /** The visitor. */
    CONTACT("contact"),
    /** An automated reply. */
    AI("ai"),
    /** Legacy generic bot. */
    BOT("bot"),
    /** A state change note, not something a person typed. */
    SYSTEM("system");

    /** Whether this message sits on our side of the transcript. */
    val isOutgoing: Boolean
        get() = when (this) {
            AGENT, AI, BOT -> true
            CONTACT, SYSTEM -> false
        }

    internal object Serializer : FallbackEnumSerializer<SenderType>(
        "SenderType", entries.toTypedArray(), { it.wire }, SYSTEM
    )
}

/**
 * A file hanging off a message — a photo, a voice note, a document.
 *
 * Deliberately carries no URL. The server streams the bytes through
 * `GET /api/conversation-attachments/:id/file` and never lets a storage
 * provider's own URL reach a client, so the id is the only handle there is
 * (`server/routes/conversationAttachments.ts`).
 */
@Serializable
data class MessageAttachment(
    val id: String,
    @SerialName("file_name") val fileName: String? = null,
    @SerialName("mime_type") val mimeType: String? = null,
    @SerialName("size_bytes") val sizeBytes: Int? = null,
    /** What the server decided this is, from the MIME type. */
    val kind: String? = null,
) {
    /** How to draw it. */
    enum class Kind { IMAGE, AUDIO, VIDEO, FILE }

    /**
     * The server sends `kind`, but an older row or a new channel might not, so
     * the MIME type is the fallback and `FILE` is the floor — a card with a
     * name on it is never wrong.
     */
    val resolvedKind: Kind
        get() {
            kind?.let { raw -> Kind.entries.firstOrNull { it.name.equals(raw, true) } }?.let { return it }
            val mime = mimeType ?: ""
            return when {
                mime.startsWith("image/") -> Kind.IMAGE
                mime.startsWith("audio/") -> Kind.AUDIO
                mime.startsWith("video/") -> Kind.VIDEO
                else -> Kind.FILE
            }
        }

    /**
     * A name worth showing. Some channels send a bare extension as the file
     * name — a widget voice note arrives called `m4a` — and a card labelled
     * "m4a" tells the operator nothing.
     */
    val displayName: String?
        get() = (fileName ?: "").trim()
            .takeIf { it.isNotEmpty() && it.contains(".") && it.length > 4 }
}

@Serializable
data class Message(
    val id: String,
    @SerialName("conversation_id") val conversationId: String,
    @SerialName("sender_type") val senderType: SenderType,
    @SerialName("sender_id") val senderId: String? = null,
    val body: String,
    @SerialName("created_at") @Serializable(InstantSerializer::class) val createdAt: Instant? = null,
    @SerialName("sender_name") val senderName: String? = null,
    @SerialName("sender_avatar") val senderAvatar: String? = null,
    /**
     * Server bookkeeping. For a system notice this is what the sentence has to
     * be rebuilt from, because `body` is English and cannot change.
     */
    val metadata: JsonElement? = null,
    /**
     * Files on this message. One inbound channel message can carry several — a
     * WhatsApp album, a Telegram document with a caption.
     */
    val attachments: List<MessageAttachment>? = null,
) {
    /**
     * Whether this message is nothing but its files. The text bubble is
     * skipped entirely for these — an empty rounded rectangle beside a photo
     * is the bug this was.
     */
    val isAttachmentOnly: Boolean
        get() = body.isBlank() && !attachments.isNullOrEmpty()
}

// MARK: - Response envelopes

@Serializable
data class LoginResponse(val sessionToken: String? = null, val user: User? = null)

@Serializable
data class SessionResponse(val user: User? = null)

@Serializable
data class WorkspacesResponse(val workspaces: List<Workspace> = emptyList())

@Serializable
data class ConversationsResponse(val conversations: List<Conversation> = emptyList())

@Serializable
data class MessagesResponse(val messages: List<Message> = emptyList())

@Serializable
data class ContactsResponse(val contacts: List<Contact> = emptyList())

/** The shape the API uses for every failure. */
@Serializable
data class ErrorResponse(
    val error: String? = null,
    val passwordSetupRequired: Boolean? = null,
)
