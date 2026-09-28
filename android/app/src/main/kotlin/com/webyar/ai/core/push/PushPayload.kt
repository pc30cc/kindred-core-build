package com.webyar.ai.core.push

/**
 * What a push says, in the keys the server sends it with.
 *
 * `server/services/push/dispatch.ts` puts camelCase strings in FCM's `data`:
 * `type`, `workspaceId`, `conversationId`, `messageId` — and, for a
 * colleague's message in team chat, `peerId` in place of a conversation. The
 * same keys arrive as the extras of the launch intent when the operator taps
 * a notification the system drew while the app was in the background —
 * which is why the app's own notifications put them there under the same
 * names.
 */
data class PushPayload(
    val type: String?,
    val workspaceId: String?,
    val conversationId: String?,
    val messageId: String?,
    /** The colleague a team message is from: the thread a tap opens. */
    val peerId: String? = null,
) {
    /** Enough to open a conversation. */
    val opensConversation: Boolean get() = !workspaceId.isNullOrBlank() && !conversationId.isNullOrBlank()

    /** A colleague's message in team chat. */
    val isTeamMessage: Boolean get() = type == TYPE_TEAM_MESSAGE

    /** Enough to open the thread with a colleague. */
    val opensTeamThread: Boolean get() = isTeamMessage && !workspaceId.isNullOrBlank() && !peerId.isNullOrBlank()

    /** Somewhere for a tap to go. */
    val opensSomething: Boolean get() = opensConversation || opensTeamThread

    /** Super Admin → Notifications → "Send test": a diagnostic, about no conversation. */
    val isTest: Boolean get() = type == TYPE_TEST

    companion object {
        const val KEY_TYPE = "type"
        const val KEY_WORKSPACE = "workspaceId"
        const val KEY_CONVERSATION = "conversationId"
        const val KEY_MESSAGE = "messageId"
        const val KEY_PEER = "peerId"

        /** `server/routes/adminNotifications.ts`, the test send. */
        const val TYPE_TEST = "test"

        /** `notifyTeamMessage` in the server's push dispatch. */
        const val TYPE_TEAM_MESSAGE = "team_message"

        fun from(data: Map<String, String>): PushPayload = PushPayload(
            type = data[KEY_TYPE],
            workspaceId = data[KEY_WORKSPACE]?.takeIf { isId(it) },
            conversationId = data[KEY_CONVERSATION]?.takeIf { isId(it) },
            messageId = data[KEY_MESSAGE]?.takeIf { isId(it) },
            peerId = data[KEY_PEER]?.takeIf { isId(it) },
        )

        /** Ids are what the server makes them; anything else in a payload is not one of ours. */
        internal fun isId(value: String): Boolean = value.length in 1..64 && value.all { it.isLetterOrDigit() || it == '-' || it == '_' }
    }
}

