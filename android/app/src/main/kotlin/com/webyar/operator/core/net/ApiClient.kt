package com.webyar.operator.core.net

import com.webyar.operator.core.model.Account
import com.webyar.operator.core.model.Contact
import com.webyar.operator.core.model.ContactsResponse
import com.webyar.operator.core.model.Conversation
import com.webyar.operator.core.model.ConversationStatus
import com.webyar.operator.core.model.ConversationsResponse
import com.webyar.operator.core.model.Entitlements
import com.webyar.operator.core.model.ErrorResponse
import com.webyar.operator.core.model.InboxCounts
import com.webyar.operator.core.model.InboxFilter
import com.webyar.operator.core.model.LoginResponse
import com.webyar.operator.core.model.Message
import com.webyar.operator.core.model.MessagesResponse
import com.webyar.operator.core.model.SessionResponse
import com.webyar.operator.core.model.User
import com.webyar.operator.core.model.Workspace
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
import io.ktor.http.ContentType
import io.ktor.http.HttpMethod
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import io.ktor.serialization.kotlinx.json.json
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
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
}

private fun String.urlEncoded(): String = java.net.URLEncoder.encode(this, "UTF-8")

/** Path segments are ids, so only the characters that would break a path. */
private fun String.urlPath(): String = urlEncoded().replace("+", "%20")
