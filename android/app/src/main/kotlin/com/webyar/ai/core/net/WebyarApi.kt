package com.webyar.ai.core.net

import com.webyar.ai.core.model.NotificationPrefs
import com.webyar.ai.core.model.NotificationPrefsUpdate
import com.webyar.ai.core.model.Account
import com.webyar.ai.core.model.AccountProfile
import com.webyar.ai.core.model.AccountSessionsResponse
import com.webyar.ai.core.model.AvailabilityResponse
import com.webyar.ai.core.model.AvailabilityUpdate
import com.webyar.ai.core.model.CallChannel
import com.webyar.ai.core.model.CallInvitation
import com.webyar.ai.core.model.CallToken
import com.webyar.ai.core.model.CannedResponse
import com.webyar.ai.core.model.ChannelInbox
import com.webyar.ai.core.model.ColleaguesResponse
import com.webyar.ai.core.model.Contact
import com.webyar.ai.core.model.Conversation
import com.webyar.ai.core.model.ConversationNote
import com.webyar.ai.core.model.ConversationPriority
import com.webyar.ai.core.model.ConversationStatus
import com.webyar.ai.core.model.EmailThreadResponse
import com.webyar.ai.core.model.EmailThreadSummary
import com.webyar.ai.core.model.Entitlements
import com.webyar.ai.core.model.GmailConnection
import com.webyar.ai.core.model.InboxCounts
import com.webyar.ai.core.model.InboxFilter
import com.webyar.ai.core.model.Message
import com.webyar.ai.core.model.MobileAppConfig
import com.webyar.ai.core.model.Promotions
import com.webyar.ai.core.model.SayNowVoice
import com.webyar.ai.core.model.TeamThreadResponse
import com.webyar.ai.core.model.User
import com.webyar.ai.core.model.VisitorProfile
import com.webyar.ai.core.model.Workspace
import com.webyar.ai.core.model.WorkspaceAccess
import com.webyar.ai.core.model.WorkspaceMember
import com.webyar.ai.core.model.ConversationSlice
import com.webyar.ai.core.model.InboxPage
import com.webyar.ai.core.model.MessagesPage
import com.webyar.ai.core.model.PushDeviceRegistration
import com.webyar.ai.core.model.PushDeviceResponse
import com.webyar.ai.core.model.RealtimeConnect
import com.webyar.ai.core.model.RealtimeSubscribe
import com.webyar.ai.core.model.SentMessage
import java.io.File
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import com.webyar.ai.core.model.EmailFolder
import com.webyar.ai.core.model.EmailThreadsResponse
import com.webyar.ai.core.model.EmailDraft
import com.webyar.ai.core.model.EmailChanges
import com.webyar.ai.core.model.EmailMailbox
import com.webyar.ai.core.model.StagedEmailAttachment
import com.webyar.ai.core.model.LiveVisitor
import com.webyar.ai.core.model.VisitorPageHistory
import com.webyar.ai.core.model.StartChatResult
import com.webyar.ai.core.model.VisitorMapResponse
import com.webyar.ai.core.model.VisitorMapConfig
import com.webyar.ai.core.model.AnalyticsOverview
import com.webyar.ai.core.model.AnalyticsRows
import com.webyar.ai.core.model.AnalyticsPages
import com.webyar.ai.core.model.AnalyticsEvents

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

    /**
     * Fires when the server answers 401 to a request carrying the token in
     * hand — the session was revoked, from the web or another phone, while
     * this one was in use. Not for a sign-in's wrong password, which carries
     * no token, nor for a request still in flight from a session already
     * replaced.
     */
    val sessionLost: Flow<Unit> get() = emptyFlow()
    /**
     * Emails a reset link. [locale] is the interface language: the one message
     * the product writes to somebody not signed in has no stored preference
     * to go by, so without it the email came in English whatever the screen
     * it was asked for was written in.
     */
    suspend fun requestPasswordReset(email: String, locale: String)

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

    // MARK: - Incremental reads
    //
    // Each has a default written in terms of the calls above, which is what a
    // backend with no incremental support answers with — the sample backend
    // today, and an older server in effect. The real client overrides all of
    // them.

    /**
     * The inbox list, unless it is unchanged since [etag].
     *
     * The endpoint has no delta, so this is the cheapest way to ask "did
     * anything change?": the server still builds the list, the phone only
     * receives a header when the answer is no.
     */
    suspend fun inboxPage(workspaceId: String, filter: InboxFilter, etag: String?): InboxPage =
        InboxPage.Changed(conversations(workspaceId, filter), etag = null)

    /**
     * These conversations, as they stand — and, when [filter] is given, only
     * those still in that queue.
     *
     * The second half is the point. Whether a thread belongs in a queue is
     * the server's decision (assignment scope, the AI-intro rule, who handled
     * a resolved thread), and a phone that guessed it would be wrong in ways
     * nobody could see. Asking about the handful of ids an event named keeps
     * the list exact without reading all of it.
     */
    suspend fun conversationsByIds(
        workspaceId: String,
        ids: List<String>,
        filter: InboxFilter?,
    ): ConversationSlice {
        if (ids.isEmpty()) return ConversationSlice(emptyList())
        val wanted = ids.toSet()
        val queues = if (filter != null) listOf(filter) else InboxFilter.entries
        return ConversationSlice(
            queues.flatMap { conversations(workspaceId, it) }
                .filter { it.id in wanted }
                .distinctBy { it.id },
        )
    }

    /** One conversation, whichever queue it is in — for a notification tap. */
    suspend fun conversation(workspaceId: String, conversationId: String): Conversation? =
        conversationsByIds(workspaceId, listOf(conversationId), filter = null).rows.firstOrNull()

    /**
     * The thread, or only what changed in it since [cursor].
     *
     * The answer says which it was: a server that cannot do a delta answers
     * in full, and the caller must then treat it as the whole thread.
     */
    suspend fun messagesPage(conversationId: String, cursor: String?): MessagesPage =
        MessagesPage(messages(conversationId), sync = null)

    /**
     * Sends, and answers with the row the server stored — which is how a
     * pending bubble learns its server id without re-reading the thread.
     * Null from a backend that does not echo the row.
     */
    suspend fun sendMessage(
        body: String,
        conversationId: String,
        workspaceId: String,
        clientMessageId: String,
        attachmentId: String? = null,
    ): SentMessage? {
        send(body, conversationId, workspaceId, clientMessageId, attachmentId)
        return null
    }

    /**
     * An attachment straight to a file, for the kinds that are played or
     * handed to another app rather than drawn: a voice note, a video, a PDF.
     *
     * Streaming, in the real client — a video in a `ByteArray` is the whole
     * video in the heap of a 2 GB phone.
     */
    suspend fun downloadAttachment(id: String, target: File) {
        target.writeBytes(attachmentData(id))
    }

    // MARK: - Realtime

    /** Anything but `centrifugo` keeps the app on foreground delta polling. */
    suspend fun realtimeConnect(workspaceId: String, intent: String): RealtimeConnect =
        RealtimeConnect(vendor = "disabled")

    suspend fun realtimeInboxSubscribe(workspaceId: String): RealtimeSubscribe =
        RealtimeSubscribe(vendor = "disabled")

    /**
     * The operators channel. Being subscribed to it is what the server reads
     * as "online in an app" (`operatorPresenceSource.ts`), which is what the
     * availability setting "available while using the app" means.
     */
    suspend fun realtimePresenceSubscribe(workspaceId: String): RealtimeSubscribe =
        RealtimeSubscribe(vendor = "disabled")

    /**
     * This operator's own channel (`ws:<workspace>:user:<id>`): team-chat
     * activity meant for them alone. A server that predates it answers 404,
     * and the app keeps polling the team chat as before.
     */
    suspend fun realtimeUserSubscribe(workspaceId: String): RealtimeSubscribe =
        RealtimeSubscribe(vendor = "disabled")

    // MARK: - Visitors (`/api/visitor-intel`, plan module `visitor_tracking`)

    /** Who is on the site, newest activity first as the server sorts it; offline ones only when asked. */
    suspend fun liveVisitors(workspaceId: String, includeOffline: Boolean): List<LiveVisitor> = emptyList()

    suspend fun visitorPageHistory(workspaceId: String, sessionId: String): VisitorPageHistory = VisitorPageHistory()

    /** Opens a conversation with the visitor, reusing their open one when there is one. */
    suspend fun startChatWithVisitor(workspaceId: String, sessionId: String): StartChatResult = StartChatResult()

    suspend fun visitorMap(workspaceId: String): VisitorMapResponse = VisitorMapResponse()

    suspend fun visitorMapConfig(workspaceId: String): VisitorMapConfig = VisitorMapConfig(enabled = false)

    // MARK: - Website analytics (`/api/web-analytics`, plan module `web_analytics`)
    //
    // Dates are YYYY-MM-DD, inclusive, in UTC as the server counts days.

    suspend fun analyticsOverview(workspaceId: String, start: String, end: String): AnalyticsOverview = AnalyticsOverview()

    suspend fun analyticsLiveVisitors(workspaceId: String): Int = 0

    /** [dimension]: channel | source | campaign. */
    suspend fun analyticsTrafficSources(workspaceId: String, dimension: String, start: String, end: String): AnalyticsRows = AnalyticsRows()

    /** [dimension]: country | city | language. */
    suspend fun analyticsGeography(workspaceId: String, dimension: String, start: String, end: String): AnalyticsRows = AnalyticsRows()

    /** [dimension]: device | os | browser. */
    suspend fun analyticsTechnology(workspaceId: String, dimension: String, start: String, end: String): AnalyticsRows = AnalyticsRows()

    /** [kind]: top | entry | exit. */
    suspend fun analyticsPages(workspaceId: String, kind: String, start: String, end: String): AnalyticsPages = AnalyticsPages()

    suspend fun analyticsEvents(workspaceId: String, start: String, end: String): AnalyticsEvents = AnalyticsEvents()

    // MARK: - Push devices

    suspend fun registerPushDevice(registration: PushDeviceRegistration): PushDeviceResponse =
        PushDeviceResponse(ok = true, deviceId = registration.deviceId, pushEnabled = false)

    /**
     * Stops this device receiving this operator's notifications.
     *
     * Must run BEFORE the session is revoked: the route needs it, and the
     * server deliberately keeps device lifecycle apart from sign-out
     * (`server/services/push/devices.ts`), so nothing else will.
     */
    suspend fun unregisterPushDevice(deviceId: String) {}
    suspend fun markSeen(conversationId: String)
    suspend fun setStatus(status: ConversationStatus, conversationId: String, workspaceId: String)
    suspend fun inboxCounts(workspaceId: String, scope: String): InboxCounts

    suspend fun contacts(workspaceId: String): List<Contact>
    suspend fun entitlements(workspaceId: String): Entitlements

    /**
     * The operator's role and the AI and call-center switches, read side by
     * side as the desktop apps do. A side request that fails leaves its value
     * null — off — and never fails the plan: only a lost session (401) is
     * thrown.
     */
    suspend fun workspaceAccess(workspaceId: String): WorkspaceAccess
    suspend fun account(): Account

    // MARK: - Conversation actions

    /**
     * Takes an AI-answered thread over.
     *
     * Tries the conversations route first and falls back to the ai-agent one
     * on a 404 — the endpoint moved, and both spellings are live on different
     * deployments. A client that knows only the new one breaks on an older
     * server for no reason the operator could understand.
     */
    suspend fun takeOverConversation(conversationId: String, workspaceId: String)

    suspend fun claim(conversationId: String, workspaceId: String)

    /** Has the assistant say something, in the operator's chosen voice. */
    suspend fun aiSayNow(conversationId: String, body: String, voice: SayNowVoice)

    /**
     * Changes whatever is named and leaves the rest alone.
     *
     * [assignedTo] is an [Assignee] rather than a `String?` because null here
     * is ambiguous in a way that matters: "do not touch the assignee" and
     * "assign this to nobody" are different requests, and a nullable string
     * cannot say which one is meant.
     */
    suspend fun updateConversation(
        conversationId: String,
        workspaceId: String,
        status: ConversationStatus? = null,
        priority: ConversationPriority? = null,
        assignedTo: Assignee? = null,
        tags: List<String>? = null,
    )

    // MARK: - Attachments

    /**
     * Reserves an attachment, uploads its bytes, and returns the id to send.
     *
     * Two calls rather than one multipart POST because that is what the
     * server offers: init records the row and checks the plan's size limit
     * before a byte is sent, which is the difference between a rejected
     * upload and a wasted one on a phone connection.
     */
    suspend fun uploadAttachment(
        conversationId: String?,
        workspaceId: String,
        fileName: String,
        mimeType: String,
        bytes: ByteArray,
    ): String

    suspend fun attachmentData(id: String): ByteArray

    // MARK: - Canned responses

    suspend fun cannedResponses(workspaceId: String, locale: String, query: String): List<CannedResponse>

    suspend fun trackCannedResponseUse(id: String, workspaceId: String)

    // MARK: - Notes

    suspend fun notes(conversationId: String, workspaceId: String): List<ConversationNote>
    suspend fun addNote(conversationId: String, workspaceId: String, body: String)
    suspend fun deleteNote(conversationId: String, workspaceId: String, noteId: String)

    // MARK: - People

    suspend fun workspaceMembers(workspaceId: String): List<WorkspaceMember>

    /** Visitor device and location, keyed by conversation. */
    suspend fun visitorIntelByConversation(
        workspaceId: String,
        conversationIds: List<String>,
    ): Map<String, VisitorProfile>

    /** The same, for surfaces that have a contact and no conversation. */
    suspend fun visitorIntelByContact(
        workspaceId: String,
        contactIds: List<String>,
    ): Map<String, VisitorProfile>

    // MARK: - Team chat

    suspend fun colleagues(workspaceId: String): ColleaguesResponse
    suspend fun teamThread(workspaceId: String, peerId: String): TeamThreadResponse
    suspend fun sendTeamMessage(
        workspaceId: String,
        recipientId: String,
        body: String,
        attachmentId: String? = null,
    )
    suspend fun markTeamThreadRead(workspaceId: String, peerId: String)

    // MARK: - Channels and email

    suspend fun channelInboxes(workspaceId: String): List<ChannelInbox>

    suspend fun emailThreads(workspaceId: String, search: String? = null): List<EmailThreadSummary>
    // `mailbox` is the provider (`gmail`, `yahoo`) a call is about when a
    // workspace has more than one mailbox connected; null is the server's
    // default one, which is all an app that knows of one mailbox ever asks.
    suspend fun emailThread(workspaceId: String, threadId: String, mailbox: String? = null): EmailThreadResponse
    suspend fun setEmailThreadRead(workspaceId: String, threadId: String, isRead: Boolean, mailbox: String? = null)
    suspend fun setEmailThreadStarred(workspaceId: String, threadId: String, starred: Boolean, mailbox: String? = null)
    suspend fun sendEmail(
        workspaceId: String,
        threadId: String?,
        to: List<String>,
        subject: String,
        body: String,
    )
    suspend fun gmailConnection(workspaceId: String): GmailConnection?

    /**
     * One page of a folder, with the cursor for the next. Defaulted onto
     * [emailThreads] so a fake that only knows the old call still answers —
     * with one page and no more.
     */
    suspend fun emailThreadsPage(
        workspaceId: String,
        folder: EmailFolder,
        search: String?,
        before: String?,
        mailbox: String? = null,
    ): EmailThreadsResponse =
        if (before != null) EmailThreadsResponse() else EmailThreadsResponse(emailThreads(workspaceId, search))

    /** A full send — Cc, Bcc, attachments, a new thread. Defaulted onto [sendEmail]. */
    suspend fun sendEmailDraft(workspaceId: String, draft: EmailDraft, mailbox: String? = null) =
        sendEmail(workspaceId, draft.threadId, draft.to, draft.subject, draft.body)

    /** Uploads a file to go with a mail being written. */
    suspend fun stageEmailAttachment(
        workspaceId: String,
        bytes: ByteArray,
        filename: String,
        contentType: String,
        mailbox: String? = null,
    ): StagedEmailAttachment = throw UnsupportedOperationException("stageEmailAttachment")

    /** A received or sent attachment's bytes. */
    suspend fun emailAttachmentData(workspaceId: String, attachmentId: String, mailbox: String? = null): ByteArray =
        throw UnsupportedOperationException("emailAttachmentData")

    /**
     * Every mailbox the workspace has connected, each with its unread count.
     *
     * Defaulted onto [gmailConnection] — one mailbox, count unknown — so a
     * server from before `/mailboxes`, or a fake that never heard of it,
     * still has an answer.
     */
    suspend fun emailMailboxes(workspaceId: String): List<EmailMailbox> =
        gmailConnection(workspaceId)
            ?.takeIf { it.connected == true }
            ?.let { listOf(EmailMailbox(provider = "gmail", address = it.emailAddress, status = it.status)) }
            .orEmpty()

    /** Ids of what changed since [since]; a reset when nothing can be said from there. */
    suspend fun emailChanges(workspaceId: String, since: String, mailbox: String? = null): EmailChanges =
        EmailChanges(reset = true)

    // MARK: - Availability and promotions

    suspend fun availability(): AvailabilityResponse
    suspend fun updateAvailability(update: AvailabilityUpdate): AvailabilityResponse
    suspend fun promotions(workspaceId: String, locale: String): Promotions

    /**
     * Super Admin's switches for this app. Defaulted, so a fake that has no
     * opinion behaves like a platform that never touched them.
     */
    suspend fun mobileAppConfig(): MobileAppConfig = MobileAppConfig.DEFAULT

    /**
     * What the app needs before anyone signs in: the language a first launch
     * starts in and whether the platform is down for maintenance. Public —
     * the sign-in screen asks it. Defaulted like [mobileAppConfig].
     */
    suspend fun publicAppConfig(): MobileAppConfig = MobileAppConfig.DEFAULT

    // MARK: - Calls

    /**
     * Workspace first, as everywhere else in this interface.
     *
     * It used to read `(conversationId, workspaceId)` — the Swift order, where
     * the labels are part of the call and cannot be transposed. Kotlin has no
     * such protection: both are `String`, both are UUIDs, and the one call
     * site passed them the other way round. The server saw a conversation id
     * where it wanted a workspace, answered `403 not_a_workspace_member`, and
     * every call the operator placed failed.
     */
    suspend fun inviteToCall(
        workspaceId: String,
        conversationId: String,
        channel: CallChannel,
    ): CallInvitation
    suspend fun cancelInvitation(id: String)
    suspend fun invitation(id: String): CallInvitation
    suspend fun callToken(callSessionId: String, displayName: String?): CallToken
    suspend fun hangUp(callSessionId: String)

    /**
     * Ends a call for a reason other than the operator hanging up —
     * `system_ended` when the visitor left or the room was lost, `failed`
     * when the operator never got in. `POST /api/calls/:id/end`.
     *
     * [hangUp] records `operator_ended`, and saying that about a call the
     * visitor walked out of puts the wrong name in the conversation's
     * timeline. Idempotent on the server: the first end wins, so a visitor's
     * own `visitor_ended` is never overwritten by this.
     *
     * Defaulted to [hangUp], so a fake with no opinion still ends the call.
     */
    suspend fun endCall(callSessionId: String, reason: String) = hangUp(callSessionId)

    // MARK: - Call centre

    /**
     * Answers a call-centre call that rang this phone:
     * `POST /api/call-center/calls/:id/accept`. The server takes it for this
     * operator, stops every other phone, and makes the room; joining it is
     * then [callToken] like any other call.
     *
     * Defaulted, like [endCall], so a fake with no call centre fails loudly
     * rather than failing to compile.
     */
    suspend fun acceptCenterCall(workspaceId: String, callSessionId: String): Unit =
        throw UnsupportedOperationException("acceptCenterCall")

    /**
     * Ends an answered call-centre call. Its own route rather than [hangUp]:
     * this one also closes the queue entry and frees the operator's slot for
     * the next caller.
     */
    suspend fun endCenterCall(workspaceId: String, callSessionId: String): Unit =
        throw UnsupportedOperationException("endCenterCall")

    // MARK: - Account

    /**
     * Anything left null is left alone: `explicitNulls = false` drops it from
     * the body and the route only writes keys that arrived. `phone = ""` is
     * how the number is cleared, because the route reads `phone || null`.
     */
    suspend fun updateProfile(
        fullName: String? = null,
        preferredLocale: String? = null,
        firstName: String? = null,
        lastName: String? = null,
        phone: String? = null,
    ): Account
    suspend fun uploadAvatar(bytes: ByteArray, contentType: String, fileName: String?): AccountProfile?
    suspend fun deleteAvatar()
    suspend fun sessions(): AccountSessionsResponse

    /**
     * How this operator wants to be told things.
     *
     * Per user, not per workspace: the server's row is keyed on the user with
     * a null workspace, and an operator who works two workspaces does not
     * want two sets of switches to keep in step.
     */
    suspend fun notificationPrefs(): NotificationPrefs

    /** Sends only what changed; see [NotificationPrefsUpdate]. */
    suspend fun updateNotificationPrefs(update: NotificationPrefsUpdate): NotificationPrefs
    suspend fun revokeSession(id: String)

    /**
     * Ends every session except this one.
     *
     * The server keeps the caller's own alive deliberately
     * (`revokeAllSessions(..., currentSessionId)`), so this is "sign out
     * everywhere else" and never "sign myself out" — which is exactly what
     * somebody looking at a long list of their own devices wants.
     */
    suspend fun revokeOtherSessions(): Int
    suspend fun changePassword(current: String, new: String)
}

/**
 * Who a conversation is assigned to, as a change request.
 *
 * Exists so that "leave the assignee alone" (pass nothing) and "assign this to
 * nobody" ([Nobody]) can be told apart. iOS spells the same distinction as a
 * double optional, which Kotlin has no equivalent for and which nobody enjoys
 * reading in either language.
 */
sealed interface Assignee {
    data class To(val userId: String) : Assignee
    data object Nobody : Assignee
}
