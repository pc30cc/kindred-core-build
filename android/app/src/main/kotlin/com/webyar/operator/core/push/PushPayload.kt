package com.webyar.operator.core.push

/**
 * What a push says, in the keys the server sends it with.
 *
 * `server/services/push/dispatch.ts` puts camelCase strings in FCM's `data`:
 * `type`, `workspaceId`, `conversationId`, `messageId`. The same keys arrive
 * as the extras of the launch intent when the operator taps a notification
 * the system drew while the app was in the background — which is why the
 * app's own notifications put them there under the same names.
 */
data class PushPayload(
    val type: String?,
    val workspaceId: String?,
    val conversationId: String?,
    val messageId: String?,
) {
    /** Enough to open a conversation. */
    val opensConversation: Boolean get() = !workspaceId.isNullOrBlank() && !conversationId.isNullOrBlank()

    companion object {
        const val KEY_TYPE = "type"
        const val KEY_WORKSPACE = "workspaceId"
        const val KEY_CONVERSATION = "conversationId"
        const val KEY_MESSAGE = "messageId"

        fun from(data: Map<String, String>): PushPayload = PushPayload(
            type = data[KEY_TYPE],
            workspaceId = data[KEY_WORKSPACE]?.takeIf { isId(it) },
            conversationId = data[KEY_CONVERSATION]?.takeIf { isId(it) },
            messageId = data[KEY_MESSAGE]?.takeIf { isId(it) },
        )

        /** Ids are what the server makes them; anything else in a payload is not one of ours. */
        internal fun isId(value: String): Boolean = value.length in 1..64 && value.all { it.isLetterOrDigit() || it == '-' || it == '_' }
    }
}

