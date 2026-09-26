package com.webyar.operator.testing

import com.webyar.operator.core.model.Conversation
import com.webyar.operator.core.model.ConversationContact
import com.webyar.operator.core.model.ConversationSlice
import com.webyar.operator.core.model.ConversationStatus
import com.webyar.operator.core.model.InboxCounts
import com.webyar.operator.core.model.InboxFilter
import com.webyar.operator.core.model.InboxPage
import com.webyar.operator.core.model.Message
import com.webyar.operator.core.model.MessagesPage
import com.webyar.operator.core.model.PushDeviceRegistration
import com.webyar.operator.core.model.PushDeviceResponse
import com.webyar.operator.core.model.RealtimeConnect
import com.webyar.operator.core.model.RealtimeSubscribe
import com.webyar.operator.core.model.SenderType
import com.webyar.operator.core.model.SentMessage
import com.webyar.operator.core.model.SyncInfo
import com.webyar.operator.core.net.ApiError
import com.webyar.operator.core.net.SampleApi
import com.webyar.operator.core.net.WebyarApi
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import java.time.Instant

/**
 * A server the tests can script: threads with real `updated_at` revisions
 * and the delta cursor the real route computes, queues with an ETag, the
 * send route's idempotency, and switches to make any of it fail.
 *
 * Everything not scripted here is the sample backend's.
 */
open class ScriptedApi(base: WebyarApi = SampleApi()) : WebyarApi by base {

    /** The server's clock, in epoch ms. Every write stamps `updated_at` with it. */
    var now: Long = 1_760_000_000_000L

    fun tick(ms: Long = 1_000) {
        now += ms
    }

    private var serial = 0

    // MARK: - Threads

    val threads = HashMap<String, MutableList<Message>>()

    /** Every cursor a thread read was made with, in order; null is a full read. */
    val threadReads = mutableListOf<String?>()
    var failThreads: Throwable? = null
    var deltaSupported = true

    fun message(
        conversationId: String,
        body: String,
        sender: SenderType = SenderType.CONTACT,
        clientId: String? = null,
    ): Message {
        tick()
        val stamp = Instant.ofEpochMilli(now)
        return Message(
            id = "m-${++serial}",
            conversationId = conversationId,
            senderType = sender,
            body = body,
            createdAt = stamp,
            updatedAt = stamp,
            metadata = clientId?.let { buildJsonObject { put("client_message_id", JsonPrimitive(it)) } },
        )
    }

    fun post(conversationId: String, body: String, sender: SenderType = SenderType.CONTACT): Message =
        message(conversationId, body, sender).also { threads.getOrPut(conversationId) { mutableListOf() } += it }

    /** [count] messages, [spacingMs] apart on the server's clock. */
    fun seed(conversationId: String, count: Int, spacingMs: Long = 1_000): List<Message> = (1..count).map {
        tick(spacingMs - 1_000)
        post(conversationId, "message $it")
    }

    /** An edit server-side — a delivery status, a call card — which moves `updated_at`. */
    fun edit(conversationId: String, id: String, body: String): Message {
        tick()
        val thread = threads.getValue(conversationId)
        val index = thread.indexOfFirst { it.id == id }
        val edited = thread[index].copy(body = body, updatedAt = Instant.ofEpochMilli(now))
        thread[index] = edited
        return edited
    }

    override suspend fun messagesPage(conversationId: String, cursor: String?): MessagesPage {
        threadReads += cursor
        failThreads?.let { throw it }
        val rows = threads[conversationId] ?: throw ApiError.Server(404, "conversation_not_found")
        val since = cursor?.let { Instant.parse(it).toEpochMilli() }
        val maxRevision = rows.maxOfOrNull { it.updatedAt!!.toEpochMilli() }
        if (since == null || !deltaSupported) {
            return MessagesPage(rows.toList(), SyncInfo("full", maxRevision?.let { Instant.ofEpochMilli(it).toString() }))
        }
        // The route's own rule: reach back ten seconds, never move the cursor back.
        val changed = rows.filter { it.updatedAt!!.toEpochMilli() > since - 10_000 }
        val next = maxOf(since, changed.maxOfOrNull { it.updatedAt!!.toEpochMilli() } ?: since)
        return MessagesPage(changed.sortedBy { it.createdAt }, SyncInfo("delta", Instant.ofEpochMilli(next).toString()))
    }

    // MARK: - Sending

    /** Every `client_message_id` a send carried, attempt by attempt. */
    val sendKeys = mutableListOf<String>()

    /** The next N sends fail before reaching the server. */
    var failSends = 0

    /** The next send is stored, and its answer lost on the way back. */
    var loseNextAnswer = false

    override suspend fun sendMessage(
        body: String,
        conversationId: String,
        workspaceId: String,
        clientMessageId: String,
        attachmentId: String?,
    ): SentMessage? {
        sendKeys += clientMessageId
        if (failSends > 0) {
            failSends--
            throw ApiError.Transport(null)
        }
        val thread = threads.getOrPut(conversationId) { mutableListOf() }
        // The unique index on (conversation_id, metadata->>'client_message_id'):
        // a replay answers with the row that is already there.
        val row = thread.firstOrNull { it.clientMessageId == clientMessageId }
            ?: message(conversationId, body, SenderType.AGENT, clientMessageId).also { thread += it }
        if (loseNextAnswer) {
            loseNextAnswer = false
            throw ApiError.Transport(null)
        }
        return SentMessage(
            id = row.id,
            conversationId = conversationId,
            senderType = row.senderType,
            body = row.body,
            createdAt = row.createdAt,
            metadata = row.metadata,
        )
    }

    fun agentMessages(conversationId: String): List<Message> =
        threads[conversationId].orEmpty().filter { it.senderType == SenderType.AGENT }

    // MARK: - Queues

    val queues = HashMap<InboxFilter, MutableList<Conversation>>()
    val listReads = mutableListOf<Pair<InboxFilter, String?>>()
    val idReads = mutableListOf<List<String>>()
    var failLists: Throwable? = null
    var idsSupported = true

    fun row(
        id: String,
        workspaceId: String = "ws-1",
        status: ConversationStatus = ConversationStatus.OPEN,
        unread: Int = 0,
        name: String = "Visitor $id",
    ): Conversation {
        tick()
        return Conversation(
            id = id,
            workspaceId = workspaceId,
            status = status,
            updatedAt = Instant.ofEpochMilli(now),
            contact = ConversationContact(name = name),
            unreadCount = unread,
        )
    }

    fun put(filter: InboxFilter, vararg rows: Conversation) {
        queues.getOrPut(filter) { mutableListOf() }.apply {
            rows.forEach { row -> removeAll { it.id == row.id } }
            addAll(rows)
        }
    }

    fun remove(filter: InboxFilter, id: String) {
        queues[filter]?.removeAll { it.id == id }
    }

    private fun etagOf(rows: List<Conversation>) = "W/\"${rows.hashCode()}\""

    override suspend fun inboxPage(workspaceId: String, filter: InboxFilter, etag: String?): InboxPage {
        listReads += filter to etag
        failLists?.let { throw it }
        val rows = queues[filter].orEmpty().filter { it.workspaceId == workspaceId }
        val tag = etagOf(rows)
        return if (etag == tag) InboxPage.NotModified else InboxPage.Changed(rows, tag)
    }

    override suspend fun conversationsByIds(
        workspaceId: String,
        ids: List<String>,
        filter: InboxFilter?,
    ): ConversationSlice {
        idReads += ids
        failLists?.let { throw it }
        val pool = (if (filter != null) queues[filter].orEmpty() else queues.values.flatten())
            .filter { it.workspaceId == workspaceId }
        val rows = pool.filter { it.id in ids }.distinctBy { it.id }
        return if (idsSupported) ConversationSlice(rows) else ConversationSlice(rows, wholeList = pool)
    }

    val byIdReads = mutableListOf<String>()

    override suspend fun conversation(workspaceId: String, conversationId: String): Conversation? {
        byIdReads += conversationId
        failLists?.let { throw it }
        return queues.values.flatten().firstOrNull { it.id == conversationId && it.workspaceId == workspaceId }
    }

    var counts = InboxCounts(open = 1)
    var countReads = 0

    override suspend fun inboxCounts(workspaceId: String, scope: String): InboxCounts {
        countReads++
        return counts
    }

    // MARK: - Realtime

    var connectAnswer: RealtimeConnect = RealtimeConnect(
        vendor = "centrifugo",
        wsUrl = "wss://rt.test/connection/websocket",
        token = "connection-token",
        expiresAt = null,
    )
    var inboxAnswer = RealtimeSubscribe(vendor = "centrifugo", channel = "ws:ws-1:inbox", token = "inbox-token")
    var presenceAnswer = RealtimeSubscribe(vendor = "centrifugo", channel = "ws:ws-1:operators", token = "presence-token")
    val connectIntents = mutableListOf<String>()
    var failConnect: Throwable? = null

    override suspend fun realtimeConnect(workspaceId: String, intent: String): RealtimeConnect {
        connectIntents += intent
        failConnect?.let { throw it }
        return connectAnswer
    }

    override suspend fun realtimeInboxSubscribe(workspaceId: String): RealtimeSubscribe = inboxAnswer

    override suspend fun realtimePresenceSubscribe(workspaceId: String): RealtimeSubscribe = presenceAnswer

    // MARK: - Push devices

    val registrations = mutableListOf<PushDeviceRegistration>()
    val unregistrations = mutableListOf<String>()
    var failRegistration: Throwable? = null

    override suspend fun registerPushDevice(registration: PushDeviceRegistration): PushDeviceResponse {
        failRegistration?.let { throw it }
        registrations += registration
        return PushDeviceResponse(ok = true, deviceId = registration.deviceId, pushEnabled = true)
    }

    override suspend fun unregisterPushDevice(deviceId: String) {
        failRegistration?.let { throw it }
        unregistrations += deviceId
    }
}
