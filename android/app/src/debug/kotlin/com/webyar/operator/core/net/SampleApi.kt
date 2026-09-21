package com.webyar.operator.core.net

import com.webyar.operator.core.model.Account
import com.webyar.operator.core.model.AccountProfile
import com.webyar.operator.core.model.Contact
import com.webyar.operator.core.model.Conversation
import com.webyar.operator.core.model.ConversationContact
import com.webyar.operator.core.model.ConversationPriority
import com.webyar.operator.core.model.ConversationStatus
import com.webyar.operator.core.model.Entitlements
import com.webyar.operator.core.model.InboxCounts
import com.webyar.operator.core.model.InboxFilter
import com.webyar.operator.core.model.Message
import com.webyar.operator.core.model.MessagePreview
import com.webyar.operator.core.model.SenderType
import com.webyar.operator.core.model.User
import com.webyar.operator.core.model.Workspace
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.time.Instant

/**
 * A backend that answers from memory.
 *
 * It exists so every screen can be laid out, reviewed and screenshotted
 * without a live server or a real account, and so the UI tests need no
 * account, no network and no credentials anywhere in the test target.
 *
 * The content is deliberately awkward rather than tidy — a very long Latin
 * name beside Persian ones, mixed scripts in one list, a three-digit unread
 * count, a visitor who never gave a name — because a layout only proves
 * itself against the cases that break it, not against neat sample rows that
 * fit by luck.
 *
 * This file lives in `src/debug`, so a release build physically cannot
 * contain it. That is the Android equivalent of the `#if DEBUG` the Swift
 * original is wrapped in, and it is the stronger of the two: there is no
 * build flag to get this wrong with.
 */
class SampleApi : WebyarApi {

    private val lock = Mutex()
    private val statuses = mutableMapOf<String, ConversationStatus>()
    private val extraMessages = mutableMapOf<String, MutableList<Message>>()

    override suspend fun hasToken(): Boolean = true

    // MARK: - Auth

    override suspend fun logIn(email: String, password: String): User = OPERATOR
    override suspend fun currentUser(): User = OPERATOR
    override suspend fun logOut() {}
    override suspend fun discardSession() {}
    override suspend fun requestPasswordReset(email: String) {}
    override suspend fun refreshOrigin() {}

    /**
     * Two of them, on purpose.
     *
     * Settings shows the operator every workspace they belong to, and with a
     * single one the list, the checkmark and the "switch to this one" tap all
     * go untested — the one-workspace row is a different branch. Most real
     * accounts have one; the interesting one is the account that has two.
     */
    override suspend fun workspaces(): List<Workspace> = listOf(
        Workspace(id = "ws-1", name = "Sample Workspace", slug = "sample"),
        Workspace(id = "ws-2", name = "Second Workspace", slug = "second"),
    )

    // MARK: - Conversations

    override suspend fun conversations(workspaceId: String, filter: InboxFilter): List<Conversation> {
        val all = lock.withLock {
            CONVERSATIONS.map { c -> statuses[c.id]?.let { c.copy(status = it) } ?: c }
        }
        return when (filter) {
            InboxFilter.OPEN ->
                all.filter { it.status == ConversationStatus.OPEN || it.status == ConversationStatus.PENDING }
            InboxFilter.NEEDS_HUMAN ->
                all.filter {
                    (it.status == ConversationStatus.OPEN || it.status == ConversationStatus.PENDING) &&
                        it.assignedTo == null
                }
            InboxFilter.PENDING -> all.filter { it.status == ConversationStatus.PENDING }
            InboxFilter.RESOLVED ->
                all.filter { it.status == ConversationStatus.RESOLVED || it.status == ConversationStatus.CLOSED }
            InboxFilter.AI -> all.filter { it.lastMessage?.senderType == "ai" }
            // Nothing in the sample set is spam, and an empty queue is the
            // honest picture of a healthy workspace.
            InboxFilter.SPAM -> emptyList()
        }
    }

    override suspend fun messages(conversationId: String): List<Message> = lock.withLock {
        (MESSAGES[conversationId].orEmpty()) + (extraMessages[conversationId].orEmpty())
    }

    override suspend fun send(
        body: String,
        conversationId: String,
        workspaceId: String,
        clientMessageId: String,
        attachmentId: String?,
    ) {
        lock.withLock {
            extraMessages.getOrPut(conversationId) { mutableListOf() }.add(
                Message(
                    id = clientMessageId,
                    conversationId = conversationId,
                    senderType = SenderType.AGENT,
                    senderId = OPERATOR.id,
                    body = body,
                    createdAt = Instant.now(),
                    senderName = OPERATOR.fullName,
                )
            )
        }
    }

    override suspend fun markSeen(conversationId: String) {}

    override suspend fun setStatus(status: ConversationStatus, conversationId: String, workspaceId: String) {
        lock.withLock { statuses[conversationId] = status }
    }

    override suspend fun inboxCounts(workspaceId: String, scope: String): InboxCounts =
        InboxCounts(open = 4, pending = 1, resolved = 2, all = 7, needsHuman = 2, automated = 1)

    override suspend fun contacts(workspaceId: String): List<Contact> = CONTACTS

    /** Everything on, so no screen is hidden behind a plan while it is being laid out. */
    override suspend fun entitlements(workspaceId: String): Entitlements =
        Entitlements(workspaceId = workspaceId)

    override suspend fun account(): Account = Account(
        id = OPERATOR.id,
        email = OPERATOR.email,
        emailConfirmedAt = "2026-01-01T00:00:00Z",
        profile = AccountProfile(id = OPERATOR.id, fullName = OPERATOR.fullName, preferredLocale = "fa"),
    )

    private companion object {
        val OPERATOR = User(
            id = "u-1",
            email = "operator@webyar.app",
            fullName = "Sara Karimi",
            emailVerifiedFlag = true,
        )

        fun ago(minutes: Long): Instant = Instant.now().minusSeconds(minutes * 60)

        val CONVERSATIONS: List<Conversation> = listOf(
            Conversation(
                id = "c-1",
                workspaceId = "ws-1",
                contactId = "p-1",
                status = ConversationStatus.OPEN,
                priority = ConversationPriority.URGENT,
                tags = emptyList(),
                createdAt = ago(90),
                updatedAt = ago(4),
                contact = ConversationContact(name = "مریم حسینی", email = "maryam@example.com"),
                lastMessage = MessagePreview(
                    body = "سلام، سفارش من هنوز ارسال نشده. می‌تونید وضعیتش رو بررسی کنید؟",
                    createdAt = ago(4),
                    senderType = "contact",
                ),
                unreadCount = 3,
                aiState = "human_active",
            ),
            Conversation(
                id = "c-2",
                workspaceId = "ws-1",
                contactId = "p-2",
                status = ConversationStatus.OPEN,
                assignedTo = "u-1",
                priority = ConversationPriority.HIGH,
                tags = emptyList(),
                createdAt = ago(300),
                updatedAt = ago(52),
                contact = ConversationContact(
                    name = "Alexander Konstantinopoulos",
                    email = "alexander.konstantinopoulos@verylongcompanyname.example",
                ),
                // Deliberately long: proves the preview truncates at two lines
                // instead of pushing the timestamp or the badge out of the row.
                lastMessage = MessagePreview(
                    body = "Thanks for getting back to me. I tried the steps you suggested but the " +
                        "export still fails at around 80% with a timeout, and it happens on both of " +
                        "our accounts.",
                    createdAt = ago(52),
                    senderType = "contact",
                ),
                // Three digits, because a badge sized for one is the bug.
                unreadCount = 128,
                aiState = "human_active",
            ),
            Conversation(
                id = "c-3",
                workspaceId = "ws-1",
                contactId = "p-3",
                status = ConversationStatus.OPEN,
                priority = ConversationPriority.NORMAL,
                tags = emptyList(),
                createdAt = ago(600),
                updatedAt = ago(140),
                // No name at all: the visitor who never introduced themselves,
                // which is also the case a saved reply's {{contact.name}} has
                // nothing to resolve against.
                contact = ConversationContact(visitorCode = "8F2C"),
                lastMessage = MessagePreview(
                    body = "Merhaba, fiyatlandırma hakkında bilgi alabilir miyim?",
                    createdAt = ago(140),
                    senderType = "contact",
                ),
                unreadCount = 0,
            ),
            Conversation(
                id = "c-4",
                workspaceId = "ws-1",
                contactId = "p-4",
                status = ConversationStatus.PENDING,
                priority = ConversationPriority.NORMAL,
                tags = emptyList(),
                createdAt = ago(1400),
                updatedAt = ago(380),
                contact = ConversationContact(name = "Emre Yılmaz", email = "emre@example.com"),
                // An AI-owned thread, so the automated queue is not empty.
                lastMessage = MessagePreview(
                    body = "Tabii, hemen kontrol ediyorum.",
                    createdAt = ago(380),
                    senderType = "ai",
                ),
                unreadCount = 0,
                aiState = "ai_managed",
            ),
            Conversation(
                id = "c-5",
                workspaceId = "ws-1",
                contactId = "p-5",
                status = ConversationStatus.RESOLVED,
                assignedTo = "u-1",
                priority = ConversationPriority.LOW,
                tags = emptyList(),
                createdAt = ago(5000),
                updatedAt = ago(2800),
                contact = ConversationContact(name = "علی رضایی"),
                // No body at all: an attachment-only message, which is the row
                // that used to render as an empty preview line.
                lastMessage = MessagePreview(
                    body = null,
                    createdAt = ago(2800),
                    senderType = "contact",
                    senderName = "علی رضایی",
                    attachmentKind = "image",
                ),
                unreadCount = 0,
            ),
        )

        val MESSAGES: Map<String, List<Message>> = mapOf(
            "c-1" to listOf(
                msg("m-1", "c-1", SenderType.CONTACT, "سلام وقت بخیر", 95),
                msg("m-2", "c-1", SenderType.AI, "سلام! چطور می‌تونم کمکتون کنم؟", 94),
                msg("m-3", "c-1", SenderType.CONTACT, "سفارش شمارهٔ ۴۸۱۲۰ رو دو هفته پیش ثبت کردم و هنوز چیزی به دستم نرسیده.", 92),
                msg("m-4", "c-1", SenderType.SYSTEM, "Sara Karimi joined the conversation", 60),
                msg("m-5", "c-1", SenderType.AGENT, "سلام مریم جان، الان بررسی می‌کنم و چند لحظهٔ دیگر خبر می‌دهم.", 58),
                msg("m-6", "c-1", SenderType.CONTACT, "ممنون، منتظر می‌مانم.", 10),
                msg("m-7", "c-1", SenderType.AGENT, "بررسی کردم. سفارش در انبار آماده شده ولی هنوز تحویل پست نشده.", 9),
                msg("m-8", "c-1", SenderType.CONTACT, "یعنی چند روز دیگر طول می‌کشد؟", 8),
                msg("m-9", "c-1", SenderType.AGENT, "امروز تحویل پست می‌شود و معمولاً دو تا سه روز کاری طول می‌کشد.", 7),
                msg("m-10", "c-1", SenderType.CONTACT, "کد رهگیری‌اش را هم می‌فرستید؟", 6),
                msg("m-11", "c-1", SenderType.AGENT, "بله، به محض ثبت در سامانهٔ پست برایتان می‌فرستم.", 5),
                msg("m-12", "c-1", SenderType.CONTACT, "ممنون می‌شم", 4),
                msg("m-13", "c-1", SenderType.CONTACT, "سلام، سفارش من هنوز ارسال نشده. می‌تونید وضعیتش رو بررسی کنید؟", 3),
            ),
            "c-2" to listOf(
                msg("n-1", "c-2", SenderType.CONTACT, "Hi — we're hitting an issue exporting our reports.", 320),
                msg("n-2", "c-2", SenderType.AGENT, "Sorry about that. Could you tell me roughly how large the export is, and whether it fails at the same point every time?", 310),
                msg("n-3", "c-2", SenderType.CONTACT, "Thanks for getting back to me. I tried the steps you suggested but the export still fails at around 80% with a timeout, and it happens on both of our accounts.", 52),
            ),
            "c-3" to listOf(
                msg("t-1", "c-3", SenderType.CONTACT, "Merhaba, fiyatlandırma hakkında bilgi alabilir miyim?", 140),
            ),
            "c-4" to listOf(
                msg("a-1", "c-4", SenderType.CONTACT, "Siparişim ne zaman kargoya verilir?", 400),
                msg("a-2", "c-4", SenderType.AI, "Tabii, hemen kontrol ediyorum.", 380),
            ),
        )

        fun msg(
            id: String,
            conversationId: String,
            sender: SenderType,
            body: String,
            minutesAgo: Long,
        ) = Message(
            id = id,
            conversationId = conversationId,
            senderType = sender,
            senderId = if (sender == SenderType.AGENT) "u-1" else null,
            body = body,
            createdAt = ago(minutesAgo),
            senderName = if (sender == SenderType.AGENT) "Sara Karimi" else null,
        )

        val CONTACTS: List<Contact> = listOf(
            Contact(id = "p-1", workspaceId = "ws-1", name = "مریم حسینی", email = "maryam@example.com", createdAt = ago(9000)),
            Contact(id = "p-2", workspaceId = "ws-1", name = "Alexander Konstantinopoulos", email = "alexander.konstantinopoulos@verylongcompanyname.example", createdAt = ago(8000)),
            Contact(id = "p-3", workspaceId = "ws-1", visitorCode = "8F2C", createdAt = ago(700)),
            Contact(id = "p-4", workspaceId = "ws-1", name = "Emre Yılmaz", email = "emre@example.com", createdAt = ago(6000)),
            Contact(id = "p-5", workspaceId = "ws-1", name = "علی رضایی", phone = "+989121234567", createdAt = ago(5200)),
        )
    }
}
