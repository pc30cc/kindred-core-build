package com.webyar.operator.core.net

import com.webyar.operator.core.model.Account
import com.webyar.operator.core.model.AccountAvatarResponse
import com.webyar.operator.core.model.AccountProfile
import com.webyar.operator.core.model.AccountSessionsResponse
import com.webyar.operator.core.model.AvailabilityResponse
import com.webyar.operator.core.model.AvailabilityUpdate
import com.webyar.operator.core.model.CallChannel
import com.webyar.operator.core.model.CallInvitation
import com.webyar.operator.core.model.CallInvitationResponse
import com.webyar.operator.core.model.CallToken
import com.webyar.operator.core.model.CannedResponse
import com.webyar.operator.core.model.CannedResponsesResponse
import com.webyar.operator.core.model.ChannelInbox
import com.webyar.operator.core.model.ColleaguesResponse
import com.webyar.operator.core.model.Contact
import com.webyar.operator.core.model.ContactsResponse
import com.webyar.operator.core.model.Conversation
import com.webyar.operator.core.model.ConversationNote
import com.webyar.operator.core.model.ConversationPriority
import com.webyar.operator.core.model.ConversationStatus
import com.webyar.operator.core.model.ConversationsResponse
import com.webyar.operator.core.model.EmailThreadResponse
import com.webyar.operator.core.model.EmailThreadSummary
import com.webyar.operator.core.model.EmailThreadsResponse
import com.webyar.operator.core.model.Entitlements
import com.webyar.operator.core.model.ErrorResponse
import com.webyar.operator.core.model.GmailConnection
import com.webyar.operator.core.model.GmailConnectionResponse
import com.webyar.operator.core.model.InboxCounts
import com.webyar.operator.core.model.InboxFilter
import com.webyar.operator.core.model.LoginResponse
import com.webyar.operator.core.model.Message
import com.webyar.operator.core.model.MessagesResponse
import com.webyar.operator.core.model.NotesResponse
import com.webyar.operator.core.model.PluginCatalogResponse
import com.webyar.operator.core.model.Promotions
import com.webyar.operator.core.model.SayNowVoice
import com.webyar.operator.core.model.SessionResponse
import com.webyar.operator.core.model.TeamThreadResponse
import com.webyar.operator.core.model.User
import com.webyar.operator.core.model.VisitorIntelResponse
import com.webyar.operator.core.model.VisitorProfile
import com.webyar.operator.core.model.Workspace
import com.webyar.operator.core.model.WorkspaceMember
import com.webyar.operator.core.model.WorkspaceMembersResponse
import com.webyar.operator.core.model.WorkspacesResponse
import com.webyar.operator.core.storage.PlatformOrigin
import com.webyar.operator.core.storage.SecureStore
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.request.HttpRequestBuilder
import io.ktor.client.request.header
import io.ktor.client.request.request
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.client.statement.readRawBytes
import io.ktor.http.ContentType
import io.ktor.http.HttpMethod
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import io.ktor.serialization.kotlinx.json.json
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * Talks to the same REST API the web client uses.
 *
 * Native sessions use `Authorization: Bearer <opaque token>` — the server runs
 * the identical security flow it runs for the web's cookie session and simply
 * returns the token in the login response body instead
 * (`server/lib/sessionTransport.ts`).
 *
 * iOS makes this an `actor`; the Kotlin equivalent is a [Mutex] around the two
 * pieces of mutable state, the token and the origin. Requests themselves are
 * not serialised — only reads and writes of those two.
 */
class ApiClient(
    private val store: SecureStore,
    private val origins: PlatformOrigin = PlatformOrigin(store),
) : WebyarApi {

    private val json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
        coerceInputValues = true
    }

    private val http = HttpClient(OkHttp) {
        expectSuccess = false
        install(ContentNegotiation) { json(json) }
        install(HttpTimeout) {
            // A hung request is worse than a failed one: the operator is left
            // staring at a spinner. Fail fast enough to show a retry.
            requestTimeoutMillis = 20_000
            connectTimeoutMillis = 20_000
            socketTimeoutMillis = 60_000
        }
    }

    private val lock = Mutex()
    /** Held in memory so the Keystore is not read on every single request. */
    private var token: String? = null
    private var tokenLoaded = false
    private var baseUrl: String? = null

    // MARK: - Session lifecycle

    private suspend fun currentToken(): String? = lock.withLock {
        if (!tokenLoaded) {
            token = store.readToken()
            tokenLoaded = true
        }
        token
    }

    private suspend fun setToken(value: String?) {
        lock.withLock {
            token = value
            tokenLoaded = true
        }
        store.writeToken(value)
    }

    override suspend fun hasToken(): Boolean = currentToken() != null

    private suspend fun origin(): String = lock.withLock {
        baseUrl ?: origins.current().also { baseUrl = it }
    }

    // MARK: - Where the platform lives

    @Serializable
    private data class PlatformOrigins(
        val apiBaseUrl: String? = null,
        val appBaseUrl: String? = null,
        val publicBaseUrl: String? = null,
        val helpCenterUrl: String? = null,
        /**
         * Already resolved server-side. Every client used to append its own
         * path here and they disagreed.
         */
        val supportUrl: String? = null,
    ) {
        private fun https(raw: String?) = raw?.takeIf { it.startsWith("https://") }
        val api: String? get() = https(apiBaseUrl)
        val support: String? get() = https(supportUrl) ?: https(helpCenterUrl) ?: https(publicBaseUrl)
    }

    /**
     * Asks the platform where it lives and moves there if the answer differs.
     *
     * The retry is the important part. If the origin we remembered has gone
     * dark — a domain typed wrong in Super Admin, a certificate that lapsed —
     * we forget it and ask the value compiled into the build instead. Without
     * that, one bad edit would brick every installed copy until the store
     * shipped a new one.
     */
    override suspend fun refreshOrigin() {
        askOrigins(origin())?.let { return adopt(it) }
        if (!origins.isStored()) return
        origins.forget()
        val fallback = origins.current()
        lock.withLock { baseUrl = fallback }
        askOrigins(fallback)?.let { adopt(it) }
    }

    private suspend fun adopt(found: PlatformOrigins) {
        origins.rememberSupport(found.support)
        val api = found.api ?: return
        if (api == origin()) return
        origins.remember(api)
        lock.withLock { baseUrl = api }
    }

    /**
     * Deliberately its own request rather than going through [perform]: it runs
     * before there is a session, it must not be treated as a failure worth
     * showing, and it has to be able to ask a host we are about to stop
     * trusting.
     */
    private suspend fun askOrigins(at: String): PlatformOrigins? = runCatching {
        val response = http.request("$at/api/platform/origins") {
            method = HttpMethod.Get
            header("Accept", "application/json")
        }
        if (!response.status.isSuccess()) return null
        json.decodeFromString<PlatformOrigins>(response.bodyAsText())
    }.getOrNull()

    // MARK: - Request plumbing

    private suspend fun build(
        method: HttpMethod,
        path: String,
        query: List<Pair<String, String>> = emptyList(),
        body: Any? = null,
    ): HttpResponse {
        val url = buildString {
            append(origin().trimEnd('/'))
            append(path)
            if (query.isNotEmpty()) {
                append('?')
                append(query.joinToString("&") { (k, v) -> "$k=${v.urlEncoded()}" })
            }
        }
        return try {
            http.request(url) {
                this.method = method
                header("Accept", "application/json")
                currentTokenHeader(this)
                if (body != null) {
                    contentType(ContentType.Application.Json)
                    setBody(body)
                }
            }
        } catch (t: Throwable) {
            throw ApiError.Transport(t)
        }
    }

    private suspend fun currentTokenHeader(builder: HttpRequestBuilder) {
        currentToken()?.let { builder.header("Authorization", "Bearer $it") }
    }

    private suspend fun HttpResponse.orThrow(): HttpResponse {
        if (status.isSuccess()) return this
        // Only 401 means "this session is void". A 403 means the session is
        // fine and this particular thing is not allowed — treating the two the
        // same signed an operator out of the whole app because one endpoint
        // refused them.
        if (status.value == 401) throw ApiError.Unauthorized
        val message = runCatching { json.decodeFromString<ErrorResponse>(bodyAsText()).error }.getOrNull()
        throw ApiError.Server(status.value, message)
    }

    private suspend inline fun <reified T> HttpResponse.decode(): T {
        orThrow()
        return try {
            body<T>()
        } catch (t: Throwable) {
            throw ApiError.Decoding(t)
        }
    }

    // MARK: - Auth

    @Serializable
    private data class LoginBody(
        val email: String,
        val password: String,
        /** Asks the server for a Bearer-transport session instead of a cookie. */
        val client: String = "mobile",
    )

    override suspend fun logIn(email: String, password: String): User {
        val result: LoginResponse =
            build(HttpMethod.Post, "/api/auth/login", body = LoginBody(email, password)).decode()
        val sessionToken = result.sessionToken
        val user = result.user
        if (sessionToken == null || user == null) throw ApiError.Decoding()
        setToken(sessionToken)
        return user
    }

    /** Confirms the stored token still names a live session. */
    override suspend fun currentUser(): User {
        if (currentToken() == null) throw ApiError.Unauthorized
        val result: SessionResponse = build(HttpMethod.Get, "/api/auth/session").decode()
        return result.user ?: throw ApiError.Unauthorized
    }

    /**
     * Only a confirmed server-side revocation clears the token. A network
     * failure here proves nothing, so the caller stays signed in and can retry
     * — clearing locally would show a signed-out UI while a usable session
     * still existed on the server.
     */
    override suspend fun logOut() {
        build(HttpMethod.Post, "/api/auth/logout").orThrow()
        setToken(null)
    }

    override suspend fun discardSession() = setToken(null)

    @Serializable
    private data class ResetBody(val email: String)

    /**
     * Asks the server to email a reset link.
     *
     * The response is deliberately not inspected for whether the address
     * exists: the endpoint answers the same either way so that it cannot be
     * used to discover which addresses have accounts, and the UI must not undo
     * that by reporting a difference.
     */
    override suspend fun requestPasswordReset(email: String) {
        build(HttpMethod.Post, "/api/auth-email/send-reset", body = ResetBody(email)).orThrow()
    }

    // MARK: - Workspaces and conversations

    override suspend fun workspaces(): List<Workspace> =
        build(HttpMethod.Get, "/api/workspaces").decode<WorkspacesResponse>().workspaces

    override suspend fun conversations(workspaceId: String, filter: InboxFilter): List<Conversation> {
        val query = buildList {
            add("workspace_id" to workspaceId)
            add("queue" to filter.queue)
            filter.status?.let { add("status" to it) }
            if (filter.needsHumanOnly) add("needsHuman" to "true")
        }
        return build(HttpMethod.Get, "/api/conversations", query).decode<ConversationsResponse>().conversations
    }

    override suspend fun messages(conversationId: String): List<Message> =
        build(HttpMethod.Get, "/api/conversations/${conversationId.urlPath()}/messages")
            .decode<MessagesResponse>().messages

    @Serializable
    private data class SendBody(
        val conversation_id: String,
        val workspace_id: String,
        val body: String,
        /**
         * The server collapses a replay of the same key instead of sending
         * twice, which is what makes a retry safe. Must be 8–64 characters.
         */
        val client_message_id: String,
        /**
         * Set when the message carries a file. The server requires a body or
         * an attachment, so a file with no caption sends an empty body.
         */
        val attachment_id: String? = null,
    )

    override suspend fun send(
        body: String,
        conversationId: String,
        workspaceId: String,
        clientMessageId: String,
        attachmentId: String?,
    ) {
        build(
            HttpMethod.Post,
            "/api/conversations/send-message",
            body = SendBody(conversationId, workspaceId, body, clientMessageId, attachmentId),
        ).orThrow()
    }

    /**
     * Takes no body: the route authorises against the conversation's own
     * `workspace_id`, so a client-supplied one could only ever disagree.
     */
    override suspend fun markSeen(conversationId: String) {
        build(HttpMethod.Post, "/api/conversations/${conversationId.urlPath()}/seen").orThrow()
    }

    @Serializable
    private data class StatusBody(val workspace_id: String, val status: String)

    override suspend fun setStatus(status: ConversationStatus, conversationId: String, workspaceId: String) {
        build(
            HttpMethod.Patch,
            "/api/conversations/${conversationId.urlPath()}",
            body = StatusBody(workspaceId, status.wire),
        ).orThrow()
    }

    override suspend fun inboxCounts(workspaceId: String, scope: String): InboxCounts =
        build(
            HttpMethod.Get,
            "/api/conversations/inbox-tab-counts",
            listOf("workspace_id" to workspaceId, "scope" to scope),
        ).decode()

    override suspend fun contacts(workspaceId: String): List<Contact> =
        build(HttpMethod.Get, "/api/contacts", listOf("workspace_id" to workspaceId))
            .decode<ContactsResponse>().contacts

    override suspend fun entitlements(workspaceId: String): Entitlements =
        build(HttpMethod.Get, "/api/plans/workspace/${workspaceId.urlPath()}/effective").decode()

    override suspend fun account(): Account =
        build(HttpMethod.Get, "/api/account/me").decode()

    // MARK: - Conversation actions

    @Serializable
    private data class TakeOverBody(val workspaceId: String, val assign_to_me: Boolean = true)

    override suspend fun takeOverConversation(conversationId: String, workspaceId: String) {
        val id = conversationId.urlPath()
        val body = TakeOverBody(workspaceId)
        try {
            build(HttpMethod.Post, "/api/conversations/$id/take-over", body = body).orThrow()
        } catch (e: ApiError.Server) {
            // The endpoint moved and both spellings are live on different
            // deployments. A client that knows only the new one breaks on an
            // older server for no reason the operator could understand.
            if (e.status != 404) throw e
            build(HttpMethod.Post, "/api/ai-agent/conversations/$id/take-over", body = body).orThrow()
        }
    }

    @Serializable
    private data class ClaimBody(val workspace_id: String)

    override suspend fun claim(conversationId: String, workspaceId: String) {
        build(
            HttpMethod.Post,
            "/api/conversations/${conversationId.urlPath()}/claim",
            body = ClaimBody(workspaceId),
        ).orThrow()
    }

    @Serializable
    private data class SayNowBody(val body: String, val attribution: String)

    override suspend fun aiSayNow(conversationId: String, body: String, voice: SayNowVoice) {
        build(
            HttpMethod.Post,
            "/api/ai-agent/conversations/${conversationId.urlPath()}/ai-say-now",
            // The server's field is still `attribution`; only the app's name
            // for it changed, and renaming the wire format to match would be a
            // server change for the sake of a label.
            body = SayNowBody(body, voice.wireValue),
        ).orThrow()
    }

    @Serializable
    private data class ConversationPatch(
        val workspace_id: String,
        val status: String? = null,
        val priority: String? = null,
        val assigned_to: String? = null,
        val tags: List<String>? = null,
    )

    override suspend fun updateConversation(
        conversationId: String,
        workspaceId: String,
        status: ConversationStatus?,
        priority: ConversationPriority?,
        assignedTo: Assignee?,
        tags: List<String>?,
    ) {
        build(
            HttpMethod.Patch,
            "/api/conversations/${conversationId.urlPath()}",
            body = ConversationPatch(
                workspace_id = workspaceId,
                status = status?.wire,
                priority = priority?.wire,
                assigned_to = when (assignedTo) {
                    is Assignee.To -> assignedTo.userId
                    // Explicitly null, and omitted when the caller passed
                    // nothing — which the encoder does for us because the
                    // default is null and `explicitNulls` is off.
                    Assignee.Nobody -> null
                    null -> null
                },
                tags = tags,
            ),
        ).orThrow()
    }

    // MARK: - Attachments

    @Serializable
    private data class AttachmentInitBody(
        val workspace_id: String,
        val conversation_id: String?,
        val file_name: String,
        val mime_type: String,
        val size_bytes: Int,
    )

    @Serializable
    private data class AttachmentInitResponse(@SerialName("attachment_id") val attachmentId: String)

    @Serializable
    private data class AttachmentUploadBody(val workspace_id: String, val data: String)

    override suspend fun uploadAttachment(
        conversationId: String?,
        workspaceId: String,
        fileName: String,
        mimeType: String,
        bytes: ByteArray,
    ): String {
        // Init first: it records the row and checks the plan's size limit
        // before a byte is sent, which is the difference between a rejected
        // upload and a wasted one on a phone connection.
        val attachmentId = build(
            HttpMethod.Post,
            "/api/conversation-attachments/init",
            body = AttachmentInitBody(
                workspace_id = workspaceId,
                conversation_id = conversationId,
                file_name = fileName,
                mime_type = mimeType,
                size_bytes = bytes.size,
            ),
        ).decode<AttachmentInitResponse>().attachmentId

        build(
            HttpMethod.Post,
            "/api/conversation-attachments/${attachmentId.urlPath()}/upload",
            body = AttachmentUploadBody(
                workspace_id = workspaceId,
                data = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP),
            ),
        ).orThrow()
        return attachmentId
    }

    override suspend fun attachmentData(id: String): ByteArray =
        build(HttpMethod.Get, "/api/conversation-attachments/${id.urlPath()}/file")
            .orThrow()
            .readRawBytes()

    // MARK: - Canned responses

    override suspend fun cannedResponses(
        workspaceId: String,
        locale: String,
        query: String,
    ): List<CannedResponse> {
        val items = buildList {
            add("workspace_id" to workspaceId)
            add("locale" to locale)
            add("limit" to "50")
            query.trim().takeIf { it.isNotEmpty() }?.let { add("q" to it) }
        }
        return build(HttpMethod.Get, "/api/canned-responses", items)
            .decode<CannedResponsesResponse>().items
    }

    @Serializable
    private data class TrackUseBody(val workspace_id: String)

    override suspend fun trackCannedResponseUse(id: String, workspaceId: String) {
        build(
            HttpMethod.Post,
            "/api/canned-responses/${id.urlPath()}/track-use",
            body = TrackUseBody(workspaceId),
        ).orThrow()
    }

    // MARK: - Notes

    override suspend fun notes(conversationId: String, workspaceId: String): List<ConversationNote> =
        build(
            HttpMethod.Get,
            "/api/conversations/${conversationId.urlPath()}/notes",
            listOf("workspace_id" to workspaceId),
        ).decode<NotesResponse>().notes

    @Serializable
    private data class NoteBody(val workspace_id: String, val body: String)

    override suspend fun addNote(conversationId: String, workspaceId: String, body: String) {
        build(
            HttpMethod.Post,
            "/api/conversations/${conversationId.urlPath()}/notes",
            body = NoteBody(workspaceId, body),
        ).orThrow()
    }

    override suspend fun deleteNote(conversationId: String, workspaceId: String, noteId: String) {
        build(
            HttpMethod.Delete,
            "/api/conversations/${conversationId.urlPath()}/notes/${noteId.urlPath()}",
            listOf("workspace_id" to workspaceId),
        ).orThrow()
    }

    // MARK: - People

    override suspend fun workspaceMembers(workspaceId: String): List<WorkspaceMember> =
        build(
            HttpMethod.Get,
            "/api/workspace-members",
            // This route spells it `workspaceId`; most of the others use
            // `workspace_id`. Matching the server is what matters.
            listOf("workspaceId" to workspaceId),
        ).decode<WorkspaceMembersResponse>().members

    @Serializable
    private data class VisitorIntelBody(
        val workspace_id: String,
        val conversation_ids: List<String>? = null,
        val contact_ids: List<String>? = null,
    )

    override suspend fun visitorIntelByConversation(
        workspaceId: String,
        conversationIds: List<String>,
    ): Map<String, VisitorProfile> {
        val ids = conversationIds.filter { it.isNotEmpty() }.distinct().take(BATCH_LIMIT)
        if (ids.isEmpty()) return emptyMap()
        return build(
            HttpMethod.Post,
            "/api/visitor-intel/network/batch",
            body = VisitorIntelBody(workspace_id = workspaceId, conversation_ids = ids),
        ).decode<VisitorIntelResponse>().byConversation.orEmpty()
    }

    override suspend fun visitorIntelByContact(
        workspaceId: String,
        contactIds: List<String>,
    ): Map<String, VisitorProfile> {
        val ids = contactIds.filter { it.isNotEmpty() }.distinct().take(BATCH_LIMIT)
        if (ids.isEmpty()) return emptyMap()
        return build(
            HttpMethod.Post,
            "/api/visitor-intel/network/batch",
            body = VisitorIntelBody(workspace_id = workspaceId, contact_ids = ids),
        ).decode<VisitorIntelResponse>().byContact.orEmpty()
    }

    // MARK: - Team chat

    override suspend fun colleagues(workspaceId: String): ColleaguesResponse =
        build(HttpMethod.Get, "/api/team-chat/colleagues", listOf("workspace_id" to workspaceId))
            .decode()

    override suspend fun teamThread(workspaceId: String, peerId: String): TeamThreadResponse =
        build(
            HttpMethod.Get,
            "/api/team-chat/thread",
            listOf("workspace_id" to workspaceId, "peer_id" to peerId),
        ).decode()

    @Serializable
    private data class TeamMessageBody(
        val workspace_id: String,
        val recipient_id: String,
        val body: String,
        val attachment_id: String? = null,
    )

    override suspend fun sendTeamMessage(
        workspaceId: String,
        recipientId: String,
        body: String,
        attachmentId: String?,
    ) {
        build(
            HttpMethod.Post,
            "/api/team-chat/messages",
            body = TeamMessageBody(workspaceId, recipientId, body, attachmentId),
        ).orThrow()
    }

    @Serializable
    private data class TeamReadBody(val workspace_id: String, val peer_id: String)

    override suspend fun markTeamThreadRead(workspaceId: String, peerId: String) {
        build(
            HttpMethod.Post,
            "/api/team-chat/read",
            body = TeamReadBody(workspaceId, peerId),
        ).orThrow()
    }

    // MARK: - Channels and email

    override suspend fun channelInboxes(workspaceId: String): List<ChannelInbox> =
        build(HttpMethod.Get, "/api/plugins/catalog", listOf("workspace_id" to workspaceId))
            .decode<PluginCatalogResponse>()
            .items.orEmpty()
            .filter { it.isUsableInbox }
            .mapNotNull { it.slug }
            .map(::ChannelInbox)

    override suspend fun emailThreads(workspaceId: String, search: String?): List<EmailThreadSummary> {
        val query = buildList {
            add("limit" to "50")
            search?.takeIf { it.isNotEmpty() }?.let { add("q" to it) }
        }
        return build(HttpMethod.Get, "/api/email-inbox/${workspaceId.urlPath()}/threads", query)
            .decode<EmailThreadsResponse>().threads
    }

    override suspend fun emailThread(workspaceId: String, threadId: String): EmailThreadResponse =
        build(
            HttpMethod.Get,
            "/api/email-inbox/${workspaceId.urlPath()}/threads/${threadId.urlPath()}",
        ).decode()

    @Serializable
    private data class EmailReadBody(val is_read: Boolean)

    override suspend fun setEmailThreadRead(workspaceId: String, threadId: String, isRead: Boolean) {
        build(
            HttpMethod.Post,
            "/api/email-inbox/${workspaceId.urlPath()}/threads/${threadId.urlPath()}/read",
            body = EmailReadBody(isRead),
        ).orThrow()
    }

    @Serializable
    private data class EmailStarBody(val starred: Boolean)

    override suspend fun setEmailThreadStarred(workspaceId: String, threadId: String, starred: Boolean) {
        build(
            HttpMethod.Post,
            "/api/email-inbox/${workspaceId.urlPath()}/threads/${threadId.urlPath()}/star",
            body = EmailStarBody(starred),
        ).orThrow()
    }

    @Serializable
    private data class EmailSendBody(
        val thread_id: String?,
        val to: List<String>,
        val subject: String,
        val text_body: String,
    )

    override suspend fun sendEmail(
        workspaceId: String,
        threadId: String?,
        to: List<String>,
        subject: String,
        body: String,
    ) {
        build(
            HttpMethod.Post,
            "/api/email-inbox/${workspaceId.urlPath()}/send",
            body = EmailSendBody(threadId, to, subject, body),
        ).orThrow()
    }

    override suspend fun gmailConnection(workspaceId: String): GmailConnection? =
        build(HttpMethod.Get, "/api/plugins/gmail/connection", listOf("workspace_id" to workspaceId))
            .decode<GmailConnectionResponse>().connection

    // MARK: - Availability and promotions

    override suspend fun availability(): AvailabilityResponse =
        build(HttpMethod.Get, "/api/availability").decode()

    override suspend fun updateAvailability(update: AvailabilityUpdate): AvailabilityResponse =
        build(HttpMethod.Patch, "/api/availability", body = update).decode()

    override suspend fun promotions(workspaceId: String, locale: String): Promotions =
        build(
            HttpMethod.Get,
            "/api/mobile-app/promotions",
            listOf("workspace_id" to workspaceId, "locale" to locale),
        ).decode()

    // MARK: - Calls

    @Serializable
    private data class InvitationBody(
        val workspace_id: String,
        val conversation_id: String,
        val channel: String,
    )

    override suspend fun inviteToCall(
        conversationId: String,
        workspaceId: String,
        channel: CallChannel,
    ): CallInvitation =
        build(
            HttpMethod.Post,
            "/api/call-invitations",
            body = InvitationBody(workspaceId, conversationId, channel.wire),
        ).decode<CallInvitationResponse>().invitation

    override suspend fun cancelInvitation(id: String) {
        build(HttpMethod.Post, "/api/call-invitations/${id.urlPath()}/cancel").orThrow()
    }

    override suspend fun invitation(id: String): CallInvitation =
        build(HttpMethod.Get, "/api/call-invitations/${id.urlPath()}")
            .decode<CallInvitationResponse>().invitation

    @Serializable
    private data class TokenBody(val participant_type: String, val display_name: String?)

    override suspend fun callToken(callSessionId: String, displayName: String?): CallToken =
        build(
            HttpMethod.Post,
            "/api/calls/${callSessionId.urlPath()}/token",
            body = TokenBody("operator", displayName),
        ).decode()

    override suspend fun hangUp(callSessionId: String) {
        build(HttpMethod.Post, "/api/calls/${callSessionId.urlPath()}/hangup").orThrow()
    }

    // MARK: - Account

    @Serializable
    private data class ProfileBody(val full_name: String?, val preferred_locale: String?)

    override suspend fun updateProfile(fullName: String?, preferredLocale: String?): Account {
        build(HttpMethod.Patch, "/api/account/me", body = ProfileBody(fullName, preferredLocale))
            .orThrow()
        // Re-read rather than trust the PATCH's echo: the server normalises a
        // locale and may reject part of the change, and the screen should show
        // what was stored rather than what was asked for.
        return account()
    }

    @Serializable
    private data class AvatarBody(val data: String, val contentType: String, val fileName: String?)

    override suspend fun uploadAvatar(
        bytes: ByteArray,
        contentType: String,
        fileName: String?,
    ): AccountProfile? =
        build(
            HttpMethod.Post,
            "/api/account/avatar",
            body = AvatarBody(
                data = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP),
                contentType = contentType,
                fileName = fileName,
            ),
        ).decode<AccountAvatarResponse>().profile

    override suspend fun deleteAvatar() {
        build(HttpMethod.Delete, "/api/account/avatar").orThrow()
    }

    override suspend fun sessions(): AccountSessionsResponse =
        build(HttpMethod.Get, "/api/account/security/sessions").decode()

    override suspend fun revokeSession(id: String) {
        build(HttpMethod.Delete, "/api/account/security/sessions/${id.urlPath()}").orThrow()
    }

    @Serializable
    private data class PasswordBody(val currentPassword: String, val newPassword: String)

    override suspend fun changePassword(current: String, new: String) {
        build(
            HttpMethod.Post,
            "/api/account/change-password",
            body = PasswordBody(current, new),
        ).orThrow()
    }

    private companion object {
        /**
         * The visitor-intel batch cap.
         *
         * The server's own limit; sending more is a 400 rather than a
         * truncation, so the client trims instead of finding out.
         */
        const val BATCH_LIMIT = 500
    }

}


private fun String.urlEncoded(): String = java.net.URLEncoder.encode(this, "UTF-8")

/** Path segments are ids, so only the characters that would break a path. */
private fun String.urlPath(): String = urlEncoded().replace("+", "%20")