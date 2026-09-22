package com.webyar.operator.core.net

import com.webyar.operator.core.model.NotificationPrefs
import com.webyar.operator.core.model.NotificationPrefsUpdate
import com.webyar.operator.core.model.Account
import com.webyar.operator.core.model.AccountProfile
import com.webyar.operator.core.model.AccountSession
import com.webyar.operator.core.model.AccountSessionsResponse
import com.webyar.operator.core.model.AvailabilityPrefs
import com.webyar.operator.core.model.AvailabilityResponse
import com.webyar.operator.core.model.AvailabilityStatus
import com.webyar.operator.core.model.AvailabilityUpdate
import com.webyar.operator.core.model.CallChannel
import com.webyar.operator.core.model.CallInvitation
import com.webyar.operator.core.model.CallToken
import com.webyar.operator.core.model.CannedResponse
import com.webyar.operator.core.model.ChannelInbox
import com.webyar.operator.core.model.Colleague
import com.webyar.operator.core.model.ColleaguesResponse
import com.webyar.operator.core.model.Contact
import com.webyar.operator.core.model.Conversation
import com.webyar.operator.core.model.ConversationContact
import com.webyar.operator.core.model.ConversationNote
import com.webyar.operator.core.model.ConversationPriority
import com.webyar.operator.core.model.ConversationStatus
import com.webyar.operator.core.model.EmailAddress
import com.webyar.operator.core.model.EmailMessageView
import com.webyar.operator.core.model.EmailThreadResponse
import com.webyar.operator.core.model.EmailThreadSummary
import com.webyar.operator.core.model.EffectiveBool
import com.webyar.operator.core.model.Entitlements
import com.webyar.operator.core.model.GmailConnection
import com.webyar.operator.core.model.InboxCounts
import com.webyar.operator.core.model.InboxFilter
import com.webyar.operator.core.model.MemberProfile
import com.webyar.operator.core.model.Message
import com.webyar.operator.core.model.MessagePreview
import com.webyar.operator.core.model.MessageAttachment
import com.webyar.operator.core.model.Promotions
import com.webyar.operator.core.model.SayNowVoice
import com.webyar.operator.core.model.SenderType
import com.webyar.operator.core.model.TeamMessage
import com.webyar.operator.core.model.TeamThreadResponse
import com.webyar.operator.core.model.User
import com.webyar.operator.core.model.VisitorProfile
import com.webyar.operator.core.model.Workspace
import com.webyar.operator.core.model.WorkspaceMember
import java.time.Instant
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

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

    /**
     * Everything on, so no screen is hidden behind a plan while it is being
     * laid out.
     *
     * And it has to be SAID rather than left empty, which is what this used to
     * do. `moduleInPlan` returns false when `modules` is null and
     * `featureEnabled` is fail-closed, so an empty snapshot turns everything
     * OFF — the opposite of what the comment claimed. The symptom was quiet:
     * the Contacts tab never appeared, and the composer had no paperclip, no
     * microphone and no saved replies, in the one mode whose whole job is to
     * show every screen without an account.
     */
    override suspend fun entitlements(workspaceId: String): Entitlements =
        Entitlements(
            workspaceId = workspaceId,
            modules = ON.associateWith { EffectiveBool(value = true) },
            features = FEATURES.associateWith { EffectiveBool(value = true) },
            channels = CHANNELS.associateWith { EffectiveBool(value = true) },
            plan = Entitlements.PlanSummary(slug = "pro", name = "Pro", tier = "pro"),
        )

    override suspend fun account(): Account = Account(
        id = OPERATOR.id,
        email = OPERATOR.email,
        emailConfirmedAt = "2026-01-01T00:00:00Z",
        profile = AccountProfile(id = OPERATOR.id, fullName = OPERATOR.fullName, preferredLocale = "fa"),
    )


    // MARK: - Conversation actions
    //
    // Accepted and forgotten. The sample backend exists to lay screens out,
    // not to model a workflow: a take-over that changed state here would have
    // to model assignment, presence and the AI's own view of the thread, and
    // every screenshot would then depend on the order the shots were taken in.

    override suspend fun takeOverConversation(conversationId: String, workspaceId: String) {}
    override suspend fun claim(conversationId: String, workspaceId: String) {}
    override suspend fun aiSayNow(conversationId: String, body: String, voice: SayNowVoice) {}

    override suspend fun updateConversation(
        conversationId: String,
        workspaceId: String,
        status: ConversationStatus?,
        priority: ConversationPriority?,
        assignedTo: Assignee?,
        tags: List<String>?,
    ) {
        // Status is the one that shows on a list row, so it is the one worth
        // remembering across a screenshot pass.
        status?.let { lock.withLock { statuses[conversationId] = it } }
    }

    // MARK: - Attachments

    override suspend fun uploadAttachment(
        conversationId: String?,
        workspaceId: String,
        fileName: String,
        mimeType: String,
        bytes: ByteArray,
    ): String = "att-sample"

    override suspend fun attachmentData(id: String): ByteArray = ByteArray(0)

    // MARK: - Canned responses
    //
    // The first reply carries TWO placeholders, one that resolves and one that
    // cannot — which is the pair that matters, because the rule is that an
    // unresolvable name keeps its braces so the operator sees it before they
    // send it.

    override suspend fun cannedResponses(
        workspaceId: String,
        locale: String,
        query: String,
    ): List<CannedResponse> {
        val all = CANNED
        val q = query.trim().lowercase()
        if (q.isEmpty()) return all
        return all.filter { q in it.shortcut.lowercase() || q in it.title.lowercase() }
    }

    override suspend fun trackCannedResponseUse(id: String, workspaceId: String) {}

    // MARK: - Notes

    override suspend fun notes(conversationId: String, workspaceId: String): List<ConversationNote> =
        lock.withLock { notesByConversation[conversationId].orEmpty().toList() }

    override suspend fun addNote(conversationId: String, workspaceId: String, body: String) {
        lock.withLock {
            notesByConversation.getOrPut(conversationId) { mutableListOf() }.add(
                ConversationNote(
                    id = "note-${System.nanoTime()}",
                    body = body,
                    authorId = OPERATOR.id,
                    author = MemberProfile(id = OPERATOR.id, fullName = OPERATOR.fullName, email = OPERATOR.email),
                    createdAt = Instant.now(),
                )
            )
        }
    }

    override suspend fun deleteNote(conversationId: String, workspaceId: String, noteId: String) {
        lock.withLock { notesByConversation[conversationId]?.removeAll { it.id == noteId } }
    }

    // MARK: - People

    override suspend fun workspaceMembers(workspaceId: String): List<WorkspaceMember> = MEMBERS

    override suspend fun visitorIntelByConversation(
        workspaceId: String,
        conversationIds: List<String>,
    ): Map<String, VisitorProfile> = conversationIds.mapNotNull { id ->
        INTEL[id]?.let { id to it }
    }.toMap()

    override suspend fun visitorIntelByContact(
        workspaceId: String,
        contactIds: List<String>,
    ): Map<String, VisitorProfile> = contactIds.mapNotNull { id ->
        INTEL_BY_CONTACT[id]?.let { id to it }
    }.toMap()

    // MARK: - Team chat

    override suspend fun colleagues(workspaceId: String): ColleaguesResponse =
        ColleaguesResponse(colleagues = COLLEAGUES, totalUnread = 2, me = OPERATOR.id)

    override suspend fun teamThread(workspaceId: String, peerId: String): TeamThreadResponse =
        TeamThreadResponse(
            messages = lock.withLock { teamMessages[peerId].orEmpty().toList() },
            me = OPERATOR.id,
        )

    override suspend fun sendTeamMessage(
        workspaceId: String,
        recipientId: String,
        body: String,
        attachmentId: String?,
    ) {
        lock.withLock {
            teamMessages.getOrPut(recipientId) { mutableListOf() }.add(
                TeamMessage(
                    id = "tm-${System.nanoTime()}",
                    senderId = OPERATOR.id,
                    recipientId = recipientId,
                    body = body,
                    createdAt = Instant.now(),
                )
            )
        }
    }

    override suspend fun markTeamThreadRead(workspaceId: String, peerId: String) {}

    // MARK: - Channels and email

    override suspend fun channelInboxes(workspaceId: String): List<ChannelInbox> =
        listOf(ChannelInbox("telegram"), ChannelInbox("bale"), ChannelInbox("whatsapp"))

    override suspend fun emailThreads(workspaceId: String, search: String?): List<EmailThreadSummary> {
        val q = search?.trim()?.lowercase().orEmpty()
        if (q.isEmpty()) return EMAIL_THREADS
        return EMAIL_THREADS.filter { q in it.subject.orEmpty().lowercase() }
    }

    override suspend fun emailThread(workspaceId: String, threadId: String): EmailThreadResponse =
        EmailThreadResponse(
            thread = EMAIL_THREADS.firstOrNull { it.id == threadId } ?: EMAIL_THREADS.first(),
            messages = EMAIL_MESSAGES,
        )

    override suspend fun setEmailThreadRead(workspaceId: String, threadId: String, isRead: Boolean) {}
    override suspend fun setEmailThreadStarred(workspaceId: String, threadId: String, starred: Boolean) {}
    override suspend fun sendEmail(
        workspaceId: String,
        threadId: String?,
        to: List<String>,
        subject: String,
        body: String,
    ) {}

    override suspend fun gmailConnection(workspaceId: String): GmailConnection? =
        GmailConnection(connected = true, emailAddress = "support@webyar.app", status = "active")

    // MARK: - Availability and promotions

    override suspend fun availability(): AvailabilityResponse = AVAILABILITY

    override suspend fun updateAvailability(update: AvailabilityUpdate): AvailabilityResponse = AVAILABILITY

    /**
     * Off.
     *
     * A promotion that lands mid-screenshot ruins the shot, and the card has
     * its own screenshot path. `PromotionCenter`'s own rules are unit-tested
     * rather than exercised here.
     */
    override suspend fun promotions(workspaceId: String, locale: String): Promotions = Promotions.NONE

    // MARK: - Calls

    override suspend fun inviteToCall(
        conversationId: String,
        workspaceId: String,
        channel: CallChannel,
    ): CallInvitation = CallInvitation(
        id = "inv-1",
        status = "pending",
        channel = channel.wire,
        conversationId = conversationId,
        expiresAt = Instant.now().plusSeconds(120),
    )

    override suspend fun cancelInvitation(id: String) {}

    override suspend fun invitation(id: String): CallInvitation =
        CallInvitation(id = id, status = "pending", channel = "audio")

    /**
     * There is no room to join, and saying so is the honest answer.
     *
     * A fabricated token would send the call screen into a connection attempt
     * against a signalling URL that does not exist, and the failure would
     * arrive seconds later looking like a network fault rather than like the
     * sample backend having no media server.
     */
    override suspend fun callToken(callSessionId: String, displayName: String?): CallToken =
        throw ApiError.Server(status = 501, serverMessage = "sample backend has no media server")

    override suspend fun hangUp(callSessionId: String) {}

    // MARK: - Account

    override suspend fun updateProfile(
        fullName: String?,
        preferredLocale: String?,
        firstName: String?,
        lastName: String?,
        phone: String?,
    ): Account = account()

    override suspend fun uploadAvatar(
        bytes: ByteArray,
        contentType: String,
        fileName: String?,
    ): AccountProfile? = AccountProfile(id = OPERATOR.id, fullName = OPERATOR.fullName)

    override suspend fun deleteAvatar() {}

    override suspend fun sessions(): AccountSessionsResponse = SESSIONS

    override suspend fun revokeSession(id: String) {}

    override suspend fun revokeOtherSessions(): Int = 0

    override suspend fun changePassword(current: String, new: String) {}

    /**
     * Held in memory, and shaped like the DEPLOYED server rather than like
     * `server/routes/notifications.ts` in this repository — the two differ,
     * and the one the app actually meets is the one worth rehearsing
     * against. See [NotificationPrefs].
     */
    private var prefs = NotificationPrefs(
        disableAll = false,
        pushScope = "all",
        pushPreview = true,
        pushInternalNotes = true,
        pushWhenOnline = true,
        pushWhenOffline = true,
        playSound = true,
        quietHoursEnabled = false,
    )

    override suspend fun notificationPrefs(): NotificationPrefs = prefs

    override suspend fun updateNotificationPrefs(
        update: NotificationPrefsUpdate,
    ): NotificationPrefs {
        prefs = prefs.copy(
            disableAll = update.disableAll ?: prefs.disableAll,
            pushScope = update.pushScope ?: prefs.pushScope,
            pushPreview = update.pushPreview ?: prefs.pushPreview,
            pushInternalNotes = update.pushInternalNotes ?: prefs.pushInternalNotes,
            pushWhenOnline = update.pushWhenOnline ?: prefs.pushWhenOnline,
            pushWhenOffline = update.pushWhenOffline ?: prefs.pushWhenOffline,
            playSound = update.playSound ?: prefs.playSound,
            quietHoursEnabled = update.quietHoursEnabled ?: prefs.quietHoursEnabled,
            quietHoursStart = update.quietHoursStart ?: prefs.quietHoursStart,
            quietHoursEnd = update.quietHoursEnd ?: prefs.quietHoursEnd,
            quietHoursTimezone = update.quietHoursTimezone ?: prefs.quietHoursTimezone,
        )
        return prefs
    }

    private val notesByConversation = mutableMapOf<String, MutableList<ConversationNote>>()
    /**
     * Seeded, not empty.
     *
     * The colleagues list showed a last-message preview for every row and the
     * thread behind it opened blank, which is the one thing this backend
     * exists to prevent — the previews were written and the threads they
     * previewed were not.
     */
    private val teamMessages: MutableMap<String, MutableList<TeamMessage>> =
        TEAM_THREADS.mapValues { it.value.toMutableList() }.toMutableMap()

    private companion object {
        val OPERATOR = User(
            id = "u-1",
            email = "operator@webyar.app",
            fullName = "Sara Karimi",
            emailVerifiedFlag = true,
        )

        fun ago(minutes: Long): Instant = Instant.now().minusSeconds(minutes * 60)

        /**
         * The `metadata.channel` a conversation carries when it did not come
         * in through the widget.
         *
         * Without this the channel strip listed three inboxes and every one of
         * them was empty, because nothing in the fixture was ever filed under
         * a channel — a strip that looks broken in the one mode whose job is
         * to show every screen working.
         */
        fun channel(key: String): JsonElement =
            buildJsonObject { put("channel", JsonPrimitive(key)) }

        /** The keys `AppSidebar.tsx` gates a whole section on. */
        val ON = listOf("contacts", "email", "team_chat", "voice_video", "canned_responses")

        /** The keys a single control inside a screen asks about. */
        val FEATURES = listOf(
            "widget_attachments", "widget_voice_notes", "widget_emoji", "canned_responses",
            // The two extra inbox queues. Without these the chip strip is one
            // chip wide and the screen hides it, so the sample build showed
            // neither the strip nor four of the six queues — in the mode whose
            // whole job is to show every screen working.
            "inbox_needs_human", "inbox_ai_queue",
        )

        val CHANNELS = listOf("voice", "video", "telegram", "bale", "whatsapp")

        // MARK: - The awkward cases
        //
        // Every list below is chosen to break a layout that only works on
        // tidy rows: a saved reply whose placeholder cannot resolve, a
        // colleague with no name at all, an email subject long enough to wrap
        // twice, a session from a device nobody recognises.

        val CANNED = listOf(
            CannedResponse(
                id = "cr-1",
                shortcut = "hi",
                title = "Greeting",
                // Two placeholders: one that resolves and one that cannot,
                // which is exactly the pair the interpolation rule is about.
                body = "سلام {{contact.name}} عزیز، به {{workspace.name}} خوش آمدید.",
                locale = "fa",
                usageCount = 128,
            ),
            CannedResponse(
                id = "cr-2",
                shortcut = "wait",
                title = "Looking into it",
                body = "همین الان بررسی می‌کنم و خبر می‌دهم.",
                locale = "fa",
                usageCount = 41,
            ),
            CannedResponse(
                id = "cr-3",
                shortcut = "bye",
                title = "Closing",
                body = "Thanks for getting in touch — {{agent.first_name}}",
                locale = "en",
                usageCount = 7,
            ),
        )

        val MEMBERS = listOf(
            WorkspaceMember(
                id = "m-1", userId = "u-1", role = "owner",
                profile = MemberProfile(id = "u-1", fullName = "Sara Karimi", email = "operator@webyar.app"),
                departmentNames = listOf("پشتیبانی"),
            ),
            WorkspaceMember(
                id = "m-2", userId = "u-2", role = "agent",
                profile = MemberProfile(id = "u-2", fullName = "Reza Ahmadi", email = "reza@webyar.app"),
            ),
            // Suspended: the transfer list must show them and refuse to hand
            // them work, rather than pretending they are not there.
            WorkspaceMember(
                id = "m-3", userId = "u-3", role = "agent",
                suspendedAt = ago(60 * 24 * 30),
                profile = MemberProfile(id = "u-3", fullName = "Mehdi Tavakoli", email = "mehdi@webyar.app"),
            ),
        )

        val INTEL = mapOf(
            "c-1" to VisitorProfile(
                geo = VisitorProfile.Geo(countryCode = "IR", country = "Iran", city = "Tehran"),
                device = VisitorProfile.Device(browser = "Chrome", os = "Windows", device = "desktop"),
                lastSeenAt = Instant.parse("2025-03-02T09:12:00Z"),
            ),
            "c-2" to VisitorProfile(
                // A country the server knew only by its code. The detail has
                // to name it anyway.
                geo = VisitorProfile.Geo(countryCode = "DE", city = "Berlin"),
                device = VisitorProfile.Device(browser = "Safari", os = "macOS", device = "desktop"),
                lastSeenAt = Instant.parse("2025-03-01T18:40:00Z"),
            ),
            // No geo at all — a visitor behind a VPN, or an IP the privacy
            // policy would not resolve. The row still has to render.
            "c-4" to VisitorProfile(
                device = VisitorProfile.Device(browser = "Firefox", os = "Android", device = "mobile"),
            ),
        )

        /**
         * The same answers, keyed the other way.
         *
         * Derived rather than written out, because the two have to agree: a
         * visitor filed as a Mac in Germany on the inbox and as bare initials
         * on the contacts list is the exact inconsistency the shared endpoint
         * exists to prevent, and hand-keeping two maps in step is how that
         * creeps back in. The link is the conversation's `contactId`.
         *
         * `by lazy` rather than a plain initializer: `CONVERSATIONS` is
         * declared further down, and an object's properties initialize in the
         * order they are written, so an eager version of this would read a
         * null the day somebody moved either one.
         */
        val INTEL_BY_CONTACT: Map<String, VisitorProfile> by lazy {
            CONVERSATIONS.mapNotNull { conversation ->
                val contactId = conversation.contactId ?: return@mapNotNull null
                INTEL[conversation.id]?.let { contactId to it }
            }.toMap()
        }

        val COLLEAGUES = listOf(
            Colleague(
                userId = "u-2", role = "agent", fullName = "Reza Ahmadi",
                email = "reza@webyar.app", unread = 2,
                lastMessage = Colleague.LastTeamMessage(
                    body = "اون تیکت رو دیدی؟", createdAt = ago(14), outgoing = false,
                ),
            ),
            Colleague(
                userId = "u-3", role = "agent", fullName = "Mehdi Tavakoli",
                email = "mehdi@webyar.app", unread = 0,
                lastMessage = Colleague.LastTeamMessage(
                    body = null, createdAt = ago(300), outgoing = true, attachmentKind = "image",
                ),
            ),
            // Name absent entirely: `displayName` has to fall through to the
            // email, and the avatar has to draw initials from that.
            Colleague(userId = "u-9", role = "agent", email = "newcomer@webyar.app", unread = 0),
        )

        /**
         * What the previews in [COLLEAGUES] are previews OF.
         *
         * Keyed by the peer, which is how `teamThread` reads them. Reza's
         * thread ends on his question, unanswered, so the badge of 2 on his
         * row has something behind it; Mehdi's ends on a photo we sent, which
         * is the attachment-only preview case.
         */
        val TEAM_THREADS: Map<String, List<TeamMessage>> = mapOf(
            "u-2" to listOf(
                TeamMessage(
                    id = "tm-1", senderId = "u-2", recipientId = "u-1",
                    body = "سلام، صبح بخیر", createdAt = ago(60 * 26),
                ),
                TeamMessage(
                    id = "tm-2", senderId = "u-1", recipientId = "u-2",
                    body = "صبح بخیر رضا جان", createdAt = ago(60 * 25),
                ),
                // Yesterday above, today below: the transcript has to draw a
                // day header between these two.
                TeamMessage(
                    id = "tm-3", senderId = "u-2", recipientId = "u-1",
                    body = "اون تیکت مربوط به پرداخت رو بررسی کردی؟",
                    createdAt = ago(16),
                ),
                TeamMessage(
                    id = "tm-4", senderId = "u-2", recipientId = "u-1",
                    body = "اون تیکت رو دیدی؟", createdAt = ago(14),
                ),
            ),
            "u-3" to listOf(
                TeamMessage(
                    id = "tm-5", senderId = "u-3", recipientId = "u-1",
                    body = "این اسکرین‌شات رو برات می‌فرستم", createdAt = ago(320),
                ),
                TeamMessage(
                    id = "tm-6", senderId = "u-1", recipientId = "u-3",
                    body = null, createdAt = ago(300),
                    attachment = MessageAttachment(
                        id = "ta-1", fileName = "screenshot.png",
                        mimeType = "image/png", sizeBytes = 184_320, kind = "image",
                    ),
                ),
            ),
            // u-9 has no thread at all: a colleague you have never written to,
            // which is the empty transcript this screen also has to draw.
        )

        val EMAIL_THREADS = listOf(
            EmailThreadSummary(
                id = "t-1",
                provider = "gmail",
                subject = "Invoice #2026-0914 and the renewal terms we discussed last week",
                participants = listOf(
                    EmailAddress("billing@example.com"),
                    EmailAddress("support@webyar.app"),
                ),
                lastMessageAt = ago(45),
                isRead = false,
                isStarred = true,
                lastMessageSnippet = "Please find attached the invoice for…",
            ),
            EmailThreadSummary(
                id = "t-2",
                provider = "gmail",
                subject = "سؤال درباره‌ی افزونه‌ی تلگرام",
                participants = listOf(EmailAddress("maryam@example.com")),
                lastMessageAt = ago(60 * 20),
                isRead = true,
                isStarred = false,
                lastMessageSnippet = "سلام، می‌خواستم بدانم…",
            ),
        )

        val EMAIL_MESSAGES = listOf(
            EmailMessageView(
                id = "em-1",
                direction = "inbound",
                fromAddress = "billing@example.com",
                toAddresses = listOf(EmailAddress("support@webyar.app")),
                textBody = "Please find attached the invoice for September.",
                sentAt = ago(90),
                isRead = true,
            ),
            // HTML only, which is the common case and the one that proves
            // `EmailBody.plainText` is doing something.
            EmailMessageView(
                id = "em-2",
                direction = "outbound",
                fromAddress = "support@webyar.app",
                toAddresses = listOf(EmailAddress("billing@example.com")),
                htmlBody = "<div><p>Thanks &mdash; received.</p><p>We&#39;ll process it today.</p></div>",
                sentAt = ago(45),
                deliveryStatus = "sent",
            ),
        )

        val AVAILABILITY = AvailabilityResponse(
            prefs = AvailabilityPrefs(
                forceOffline = false,
                availableWhenUsingApp = true,
                scheduleEnabled = false,
                timezone = "Asia/Tehran",
            ),
            status = AvailabilityStatus(state = "online"),
        )

        val SESSIONS = AccountSessionsResponse(
            sessions = listOf(
                AccountSession(
                    id = "s-1",
                    browser = "Webyar",
                    os = "Android 16",
                    device = "Pixel 6",
                    city = "Tehran",
                    country = "Iran",
                    countryCode = "IR",
                    isCurrent = true,
                    createdAt = ago(60 * 24 * 3),
                    lastActiveAt = ago(1),
                ),
                // No location at all, which is what a privacy-restricted IP
                // gives back — the row has to render without a place.
                AccountSession(
                    id = "s-2",
                    browser = "Chrome 141",
                    os = "macOS",
                    device = "desktop",
                    isCurrent = false,
                    createdAt = ago(60 * 24 * 40),
                    lastActiveAt = ago(60 * 26),
                ),
            ),
            currentSessionId = "s-1",
        )


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
                metadata = channel("telegram"),
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
                metadata = channel("whatsapp"),
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
