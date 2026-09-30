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
    /** The email thread a new email is in. */
    val threadId: String? = null,
    /** A visitor's callback request. */
    val callbackId: String? = null,
    /**
     * The mailbox a new email arrived in (`gmail`, `yahoo`), when a workspace
     * can have more than one. Absent from a server that did not say.
     */
    val provider: String? = null,
) {
    /** Enough to open a conversation. */
    val opensConversation: Boolean get() = !workspaceId.isNullOrBlank() && !conversationId.isNullOrBlank()

    /** A colleague's message in team chat. */
    val isTeamMessage: Boolean get() = type == TYPE_TEAM_MESSAGE

    /** Enough to open the thread with a colleague. */
    val opensTeamThread: Boolean get() = isTeamMessage && !workspaceId.isNullOrBlank() && !peerId.isNullOrBlank()

    /** A new email in the workspace's email inbox. */
    val isEmail: Boolean get() = type == TYPE_EMAIL

    /** Enough to open the email thread. */
    val opensEmailThread: Boolean get() = isEmail && !workspaceId.isNullOrBlank() && !threadId.isNullOrBlank()

    /** A visitor asked to be called back. */
    val isCallback: Boolean get() = type == TYPE_CALLBACK

    /** Somewhere for a tap to go. */
    /** The platform's support team answered one of the operator's support threads. */
    val isSupport: Boolean get() = type == TYPE_SUPPORT

    val opensSupportThread: Boolean get() = isSupport && !workspaceId.isNullOrBlank() && !threadId.isNullOrBlank()

    val opensSomething: Boolean get() = opensConversation || opensTeamThread || opensEmailThread || opensSupportThread

    /** Super Admin → Notifications → "Send test": a diagnostic, about no conversation. */
    val isTest: Boolean get() = type == TYPE_TEST

    companion object {
        const val KEY_TYPE = "type"
        const val KEY_WORKSPACE = "workspaceId"
        const val KEY_CONVERSATION = "conversationId"
        const val KEY_MESSAGE = "messageId"
        const val KEY_PEER = "peerId"
        const val KEY_THREAD = "threadId"
        const val KEY_CALLBACK = "callbackId"
        const val KEY_PROVIDER = "provider"

        /** The mailboxes a push may name; anything else is not one of ours. */
        private val PROVIDERS = setOf("gmail", "yahoo")

        internal fun isProvider(value: String): Boolean = value in PROVIDERS

        /** `server/routes/adminNotifications.ts`, the test send. */
        const val TYPE_TEST = "test"

        /** `notifyTeamMessage` in the server's push dispatch. */
        const val TYPE_TEAM_MESSAGE = "team_message"

        /** `notifyEmailMessage`. */
        const val TYPE_EMAIL = "email_message"

        /** `notifyCallbackRequest`. */
        const val TYPE_CALLBACK = "callback_request"

        /** `notifySupportReply` (server/services/push/dispatch.ts): names the thread, not a conversation. */
        const val TYPE_SUPPORT = "support_reply"

        fun from(data: Map<String, String>): PushPayload = PushPayload(
            type = data[KEY_TYPE],
            workspaceId = data[KEY_WORKSPACE]?.takeIf { isId(it) },
            conversationId = data[KEY_CONVERSATION]?.takeIf { isId(it) },
            messageId = data[KEY_MESSAGE]?.takeIf { isId(it) },
            peerId = data[KEY_PEER]?.takeIf { isId(it) },
            threadId = data[KEY_THREAD]?.takeIf { isId(it) },
            callbackId = data[KEY_CALLBACK]?.takeIf { isId(it) },
            provider = data[KEY_PROVIDER]?.takeIf { isProvider(it) },
        )

        /** Ids are what the server makes them; anything else in a payload is not one of ours. */
        internal fun isId(value: String): Boolean = value.length in 1..64 && value.all { it.isLetterOrDigit() || it == '-' || it == '_' }
    }
}

