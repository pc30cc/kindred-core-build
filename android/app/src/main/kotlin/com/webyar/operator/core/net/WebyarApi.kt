package com.webyar.operator.core.net

import com.webyar.operator.core.model.Account
import com.webyar.operator.core.model.Contact
import com.webyar.operator.core.model.Conversation
import com.webyar.operator.core.model.ConversationStatus
import com.webyar.operator.core.model.Entitlements
import com.webyar.operator.core.model.InboxCounts
import com.webyar.operator.core.model.InboxFilter
import com.webyar.operator.core.model.Message
import com.webyar.operator.core.model.User
import com.webyar.operator.core.model.Workspace

/**
 * What the app needs from a backend.
 *
 * The screens depend on this rather than on [ApiClient] directly, which is
 * what allows the sample backend to drive the whole UI with no network at all
 * — needed to lay out and screenshot every screen, and to run the UI tests
 * with no account and no credentials anywhere in the test target.
 *
 * Narrower than its iOS counterpart on purpose. `WebyarAPI.swift` declares
 * around sixty methods because sixty screens exist there; ADR-003 sequences
 * the Android port so that the vertical slice comes before breadth, and a
 * method with no caller is a method nothing has ever proved. Calls, email,
 * team chat, canned responses, notes and the rest arrive with the screens that
 * use them.
 */
interface WebyarApi {
    suspend fun hasToken(): Boolean

    suspend fun logIn(email: String, password: String): User
    suspend fun currentUser(): User
    suspend fun logOut()
    /** Drops the local session without asking. Only for a confirmed 401. */
    suspend fun discardSession()
    suspend fun requestPasswordReset(email: String)

    /** Asks the platform where it lives, before anything else talks to it. */
    suspend fun refreshOrigin()

    suspend fun workspaces(): List<Workspace>
    suspend fun conversations(workspaceId: String, filter: InboxFilter): List<Conversation>
    suspend fun messages(conversationId: String): List<Message>
    suspend fun send(
        body: String,
        conversationId: String,
        workspaceId: String,
        clientMessageId: String,
        attachmentId: String? = null,
    )
    suspend fun markSeen(conversationId: String)
    suspend fun setStatus(status: ConversationStatus, conversationId: String, workspaceId: String)
    suspend fun inboxCounts(workspaceId: String, scope: String): InboxCounts

    suspend fun contacts(workspaceId: String): List<Contact>
    suspend fun entitlements(workspaceId: String): Entitlements
    suspend fun account(): Account
}
