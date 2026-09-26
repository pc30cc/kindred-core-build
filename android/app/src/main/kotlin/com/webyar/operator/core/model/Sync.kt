package com.webyar.operator.core.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

// The shapes the incremental reads answer with. Every one of them mirrors a
// response the server already sends; see `server/services/messageSync.ts` for
// the thread cursor and `server/routes/conversations.ts` for the rest.

/**
 * `GET /api/conversations/:id/messages[?since=]`.
 *
 * `sync` is absent from a server older than the cursor (and from the sample
 * backend), which reads as a full answer with no cursor — exactly what an old
 * server's reply is.
 */
@Serializable
data class MessagesPage(
    val messages: List<Message> = emptyList(),
    val sync: SyncInfo? = null,
) {
    /** True only when the server says so; anything else replaces the thread. */
    val isDelta: Boolean get() = sync?.mode == "delta"
}

@Serializable
data class SyncInfo(
    /** `full` or `delta`. */
    val mode: String? = null,
    /**
     * Opaque to the app. Today it is the newest `updated_at` the server read,
     * but it is stored and sent back exactly as received — parsing it would
     * make the client a second owner of a format the server can change.
     */
    val cursor: String? = null,
)

/**
 * The inbox list, conditionally.
 *
 * The list endpoint has no delta; what it has is Express's weak ETag. A
 * `304` is the server saying nothing on this list changed, which costs the
 * phone a header instead of the whole queue.
 */
sealed interface InboxPage {
    data class Changed(val conversations: List<Conversation>, val etag: String?) : InboxPage
    data object NotModified : InboxPage
}

/**
 * The answer to "what do these conversations look like now, and are they
 * still in this queue?"
 *
 * [rows] are the asked-for ids that ARE in the queue; an id missing from it
 * has left. [wholeList] is set only when the server ignored the narrowing
 * (it predates `?ids=`) and so sent the entire queue — which the caller can
 * then use as the full reconcile it effectively paid for, rather than throw
 * it away.
 */
data class ConversationSlice(
    val rows: List<Conversation>,
    val wholeList: List<Conversation>? = null,
)

/** `GET /api/conversations/:id` — one row, in the list's own shape. */
@Serializable
data class ConversationResponse(val conversation: Conversation? = null)

/**
 * What `POST /api/conversations/send-message` answers.
 *
 * `message` is the row as stored — the new one, or on a replay of the same
 * `client_message_id` the original, with `duplicate = true`. Either way its
 * id is the one the transcript should carry from now on.
 */
@Serializable
data class SendMessageResponse(
    val ok: Boolean? = null,
    val message: SentMessage? = null,
    val duplicate: Boolean? = null,
)

/**
 * The send route's echo of the row. Narrower than [Message]: it selects a
 * fixed column list and names a single `attachment`, not the list.
 */
@Serializable
data class SentMessage(
    val id: String,
    @SerialName("conversation_id") val conversationId: String? = null,
    @SerialName("sender_type") val senderType: SenderType? = null,
    @SerialName("sender_id") val senderId: String? = null,
    val body: String? = null,
    @SerialName("created_at") @Serializable(InstantSerializer::class) val createdAt: java.time.Instant? = null,
    val metadata: JsonElement? = null,
)
