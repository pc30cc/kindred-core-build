package com.webyar.operator.core.sync

import com.webyar.operator.core.Diag
import com.webyar.operator.core.cache.CacheMapping
import com.webyar.operator.core.cache.CacheScope
import com.webyar.operator.core.cache.CacheStore
import com.webyar.operator.core.cache.MessageEntity
import com.webyar.operator.core.cache.SendState
import com.webyar.operator.core.cache.SyncKeys
import com.webyar.operator.core.cache.SyncStateEntity
import com.webyar.operator.core.cache.ThreadWriter
import com.webyar.operator.core.model.Message
import com.webyar.operator.core.model.MessageAttachment
import com.webyar.operator.core.model.SenderType
import com.webyar.operator.core.model.SentMessage
import com.webyar.operator.core.net.ApiError
import com.webyar.operator.core.net.WebyarApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * Transcripts, local-first, and the outbox.
 *
 * ## Reading
 *
 * The first read of a thread is whole; every read after it asks the server
 * only for what changed since the cursor it handed back
 * (`GET …/messages?since=`), so a new message in a ten-thousand-message
 * thread costs one row, not ten thousand. The cursor is the server's
 * `updated_at` (migration 216), which is what makes an EDIT visible to a
 * delta — a delivery status, a call card, `seen_at` — where `created_at`
 * alone would miss all three.
 *
 * A delta cannot express a deletion. The server deletes a message only with
 * its whole conversation — which the thread endpoint then answers 404, and
 * [sync] removes the conversation — so a full re-read is needed rarely:
 * every [FULL_RECONCILE_MS], and after Clear Cache or eviction.
 *
 * ## One message, however many times it arrives
 *
 * The same message can reach this class five ways: the pending copy written
 * when the operator tapped Send, the send's own echo, the realtime
 * publication, a push, and the next delta. They are one row because they are
 * matched in a fixed order — **server id, then `client_message_id`** — and a
 * row keeps its local id for life. A copy older than the stored one (by the
 * server's `updated_at`) never replaces it.
 *
 * ## Sending
 *
 * A message is written to the cache first, as PENDING, with a
 * `client_message_id` minted ONCE for it. Every attempt to deliver it —
 * the first, a retry after a failure, a resume after the process was killed
 * — sends that same key, and the server's unique index on it
 * (`070_post_send_action_guards.sql`) collapses a replay into the original
 * row. That is what makes a retry safe. The version this replaced minted a
 * fresh key per attempt, so a send whose response was lost and was then
 * retried posted twice.
 */
class MessageRepository(
    private val api: WebyarApi,
    private val store: CacheStore,
    private val clock: () -> Long = System::currentTimeMillis,
    private val newId: () -> String = { UUID.randomUUID().toString() },
    private val diag: Diag = Diag.Android,
) {
    /** One read at a time per thread: two overlapping reads would each move the cursor. */
    private val locks = ConcurrentHashMap<String, Mutex>()

    /**
     * Threads somebody is looking at, or whose first read is in flight. A
     * realtime message for one of these is written even before its first
     * read lands; for any other thread without a cursor it is not, because a
     * transcript made of one message and a gap is worse than none.
     */
    private val watched = ConcurrentHashMap.newKeySet<String>()

    fun observeThread(scope: CacheScope, conversationId: String): Flow<List<Message>> =
        store.observeThread(scope, conversationId)

    fun watch(conversationId: String) {
        watched += conversationId
    }

    fun unwatch(conversationId: String) {
        watched -= conversationId
    }

    /** Whether this phone holds a transcript of this thread it can bring up to date. */
    suspend fun isCached(scope: CacheScope, conversationId: String): Boolean =
        runCatching { store.syncState(scope, SyncKeys.thread(conversationId))?.cursor != null }
            .getOrDefault(false)

    private fun lockFor(conversationId: String): Mutex = locks.getOrPut(conversationId) { Mutex() }

    // MARK: - Reading

    /**
     * Brings one thread up to date: a delta when there is a cursor and a full
     * read is not due, the whole thread otherwise.
     */
    suspend fun sync(
        scope: CacheScope,
        conversationId: String,
        reason: String,
        forceFull: Boolean = false,
    ): ThreadSync = lockFor(conversationId).withLock {
        val state = store.syncState(scope, SyncKeys.thread(conversationId))
        val started = clock()
        val cursor = state?.cursor?.takeUnless { forceFull || fullReadDue(state, started) }
        val page = try {
            api.messagesPage(conversationId, cursor)
        } catch (e: ApiError.Server) {
            if (e.status == 404) {
                store.removeConversation(scope, conversationId)
                diag.info(AREA, "thread ${Diag.id(conversationId)} is gone (404); removed ($reason)")
                return@withLock ThreadSync.Gone
            }
            throw e
        }
        // A delta only when both sides agree it is one: a server that could
        // not do it answers in full, and a full answer must replace.
        val delta = cursor != null && page.isDelta
        store.thread(scope, conversationId) {
            merge(page.messages, delta = delta, cursor = page.sync?.cursor, startedAt = started)
        }
        diag.info(
            AREA,
            "thread ${Diag.id(conversationId)} ${if (delta) "delta" else "full"}: " +
                "${page.messages.size} rows ($reason) in ${clock() - started}ms",
        )
        if (delta) ThreadSync.Delta(page.messages.size) else ThreadSync.Full(page.messages.size)
    }

    private fun fullReadDue(state: SyncStateEntity, now: Long): Boolean {
        val last = state.fullReadAt ?: return true
        return now - last > FULL_RECONCILE_MS
    }

    /**
     * Applies a message the server pushed over realtime.
     *
     * A realtime row is the publication's copy: it has no `updated_at`, and
     * a recovered publication can be older than the row a delta already
     * stored. So it only ever FILLS: it confirms a pending row, it adds a
     * row that is missing, and it leaves a row a read already wrote alone.
     * A later change to that row moves its `updated_at`, and the next delta
     * brings it — the cursor never covers a realtime write, because a
     * realtime write never moves the cursor.
     */
    suspend fun applyRealtime(scope: CacheScope, message: Message): Boolean {
        val conversationId = message.conversationId
        if (conversationId.isBlank()) return false
        return lockFor(conversationId).withLock {
            val hasCursor = store.syncState(scope, SyncKeys.thread(conversationId))?.cursor != null
            store.thread(scope, conversationId) {
                val existing = byServerIds(listOf(message.id)).firstOrNull()
                    ?: message.clientMessageId?.let { byClientIds(listOf(it)).firstOrNull() }
                when {
                    existing == null && !hasCursor && conversationId !in watched -> false
                    existing != null && existing.sendState == SendState.SENT.code && existing.serverId != null -> false
                    else -> {
                        upsert(listOf(CacheMapping.toEntity(scope, message, existing, clock())))
                        true
                    }
                }
            }
        }
    }

    /**
     * Merges one server answer into the thread, in the caller's transaction.
     *
     * For a full read, a confirmed row the answer no longer contains is
     * deleted — unless it was written after the read began, which is a
     * realtime row the read could not have seen yet.
     */
    private suspend fun ThreadWriter.merge(
        incoming: List<Message>,
        delta: Boolean,
        cursor: String?,
        startedAt: Long,
    ) {
        val now = clock()
        // A row that names another conversation is not this thread's,
        // however it got into this answer.
        val rows = incoming.filter { it.conversationId == conversationId }
        val byServer = byServerIds(rows.map { it.id }).associateBy { it.serverId }
        val byClient = byClientIds(rows.mapNotNull { it.clientMessageId }).associateBy { it.clientMessageId }

        val writes = LinkedHashMap<String, MessageEntity>()
        val duplicates = HashSet<String>()
        for (message in rows) {
            val serverHit = byServer[message.id]
            val clientHit = message.clientMessageId?.let { byClient[it] }
            val existing = serverHit ?: clientHit
            // Two local rows for one message — a server row and a pending one
            // written before the server's id was known. The server's wins.
            if (serverHit != null && clientHit != null && clientHit.localId != serverHit.localId) {
                duplicates += clientHit.localId
            }
            if (existing != null && MessageRevision.isStale(message, existing)) continue
            val entity = CacheMapping.toEntity(scope, message, existing, now)
            writes[entity.localId] = entity
        }
        if (duplicates.isNotEmpty()) delete(duplicates)
        upsert(writes.values.toList())

        if (!delta) {
            val present = rows.map { it.id }.toSet()
            val doomed = keys()
                .filter { it.sendState == SendState.SENT.code && (it.serverId == null || it.serverId !in present) }
                // Only rows no newer than the read: a realtime row that landed
                // while it was in flight is newer than the answer. (One that
                // landed in the very millisecond it began is dropped, and the
                // next delta brings it back — its `updated_at` is past the
                // cursor this read hands back.)
                .filter { it.cachedAt <= startedAt }
                .map { it.localId }
            if (doomed.isNotEmpty()) delete(doomed)
        }

        val previous = state()
        putState(
            SyncStateEntity(
                accountId = scope.accountId,
                workspaceId = scope.workspaceId,
                key = SyncKeys.thread(conversationId),
                // A full answer from a server with no cursor support leaves
                // none, which keeps every later read full — correct for it.
                cursor = if (delta) cursor ?: previous?.cursor else cursor,
                etag = null,
                fullReadAt = if (delta) previous?.fullReadAt else now,
                payload = null,
                updatedAt = now,
            ),
        )
    }

    // MARK: - Sending

    /**
     * Writes the operator's message to the outbox, PENDING, and returns its
     * local id. Delivery is a separate step ([deliver]), so the bubble is on
     * screen before any request is made — and survives the process dying
     * before one is.
     */
    suspend fun enqueue(
        scope: CacheScope,
        conversationId: String,
        body: String,
        sender: OutgoingSender?,
        attachment: MessageAttachment? = null,
    ): String {
        val clientId = newId()
        val localId = "l:$clientId"
        val now = clock()
        val row = MessageEntity(
            accountId = scope.accountId,
            localId = localId,
            workspaceId = scope.workspaceId,
            conversationId = conversationId,
            serverId = null,
            clientMessageId = clientId,
            senderType = SenderType.AGENT.wire,
            senderId = sender?.id,
            senderName = sender?.name,
            senderAvatar = sender?.avatarUrl,
            body = body,
            createdAt = null,
            updatedAt = null,
            metadataJson = CacheMapping.encodeMetadata(buildJsonObject { put("client_message_id", JsonPrimitive(clientId)) }),
            attachmentsJson = CacheMapping.encodeAttachments(attachment?.let { listOf(it) }),
            sendState = SendState.PENDING.code,
            outboxAttachmentId = attachment?.id,
            sortAt = now,
            cachedAt = now,
        )
        store.thread(scope, conversationId) { upsert(listOf(row)) }
        diag.info(AREA, "outbox +1 in ${Diag.id(conversationId)}")
        return localId
    }

    /**
     * Sends one outbox row, with the key it was minted with.
     *
     * Safe to call again for the same row — after a failure, or for a row
     * found PENDING at launch — because the server answers a replay of the
     * same `client_message_id` with the original row instead of a second
     * message.
     */
    suspend fun deliver(scope: CacheScope, localId: String): SendOutcome {
        val row = store.message(scope, localId) ?: return SendOutcome.Missing
        if (row.sendState == SendState.SENT.code) return SendOutcome.Sent
        val clientId = row.clientMessageId ?: return SendOutcome.Missing
        setState(scope, row, SendState.PENDING)
        val echo = try {
            api.sendMessage(
                body = row.body,
                conversationId = row.conversationId,
                workspaceId = row.workspaceId,
                clientMessageId = clientId,
                attachmentId = row.outboxAttachmentId,
            )
        } catch (e: kotlinx.coroutines.CancellationException) {
            // The request may or may not have reached the server. PENDING is
            // the truth, and a resume re-sends with the same key.
            throw e
        } catch (e: Throwable) {
            setState(scope, row, SendState.FAILED)
            diag.warn(AREA, "send failed in ${Diag.id(row.conversationId)}: ${e.javaClass.simpleName}")
            return SendOutcome.Failed(e)
        }
        confirm(scope, row, echo)
        return SendOutcome.Sent
    }

    /**
     * The server has it. With an echo the row takes its server id now; without
     * one (an older server, the sample backend) it is marked sent and the next
     * read matches it by `client_message_id`.
     */
    private suspend fun confirm(scope: CacheScope, row: MessageEntity, echo: SentMessage?) {
        lockFor(row.conversationId).withLock {
            store.thread(scope, row.conversationId) {
                val current = byClientIds(listOfNotNull(row.clientMessageId)).firstOrNull() ?: return@thread
                if (current.sendState == SendState.SENT.code && current.serverId != null) return@thread
                val serverId = echo?.id
                // Realtime may have written the server's copy first, under the
                // server id, before this pending row was matched to it.
                val twin = serverId?.let { id -> byServerIds(listOf(id)).firstOrNull { it.localId != current.localId } }
                if (twin != null) delete(listOf(twin.localId))
                val created = echo?.createdAt?.toEpochMilli()
                upsert(
                    listOf(
                        current.copy(
                            serverId = serverId ?: current.serverId,
                            createdAt = created ?: current.createdAt,
                            sortAt = created ?: current.sortAt,
                            metadataJson = echo?.metadata?.toString() ?: current.metadataJson,
                            sendState = SendState.SENT.code,
                            outboxAttachmentId = null,
                            cachedAt = clock(),
                        ),
                    ),
                )
            }
        }
    }

    private suspend fun setState(scope: CacheScope, row: MessageEntity, state: SendState) {
        store.thread(scope, row.conversationId) {
            val current = byClientIds(listOfNotNull(row.clientMessageId)).firstOrNull() ?: return@thread
            if (current.sendState == SendState.SENT.code) return@thread
            upsert(listOf(current.copy(sendState = state.code)))
        }
    }

    /**
     * What is left in the outbox when the app comes back.
     *
     * A PENDING row younger than [RESUME_WINDOW_MS] was in flight when the
     * process stopped: it is re-sent, with its original key, which the server
     * collapses if the first attempt did land. An older one is not re-sent on
     * the operator's behalf — a reply written an hour ago may no longer be
     * the right thing to say — and becomes FAILED, waiting for them to tap
     * Retry. FAILED rows are never re-sent automatically.
     */
    suspend fun resumeOutbox(scope: CacheScope): List<String> {
        val now = clock()
        val rows = runCatching { store.outbox(scope) }.getOrDefault(emptyList())
        val resend = mutableListOf<String>()
        for (row in rows) {
            if (row.sendState != SendState.PENDING.code) continue
            if (now - row.sortAt <= RESUME_WINDOW_MS) resend += row.localId else setState(scope, row, SendState.FAILED)
        }
        if (rows.isNotEmpty()) diag.info(AREA, "outbox at resume: ${rows.size} rows, ${resend.size} re-sent")
        return resend
    }

    /** The operator gave up on a failed message. Only an unsent row can go. */
    suspend fun discard(scope: CacheScope, localId: String) {
        val row = store.message(scope, localId) ?: return
        if (row.sendState == SendState.SENT.code) return
        store.thread(scope, row.conversationId) { delete(listOf(localId)) }
    }

    companion object {
        private const val AREA = "Sync"

        /** How often a thread is re-read whole, to notice what a delta cannot say. */
        const val FULL_RECONCILE_MS = 6 * 60 * 60 * 1000L

        /** How old a pending send can be and still be re-sent without asking. */
        const val RESUME_WINDOW_MS = 10 * 60 * 1000L
    }
}

/** Who a message typed on this phone is from, for the pending bubble. */
data class OutgoingSender(val id: String?, val name: String?, val avatarUrl: String?)

sealed interface ThreadSync {
    data class Full(val count: Int) : ThreadSync
    data class Delta(val count: Int) : ThreadSync
    data object Gone : ThreadSync
}

sealed interface SendOutcome {
    data object Sent : SendOutcome
    data class Failed(val error: Throwable) : SendOutcome
    data object Missing : SendOutcome
}

/** Which of two copies of one message is the newer. */
internal object MessageRevision {
    /**
     * True when [incoming] is older than [stored] by the server's own clock.
     * A copy without `updated_at` (a realtime publication, the send echo)
     * cannot be judged and is not stale — which is why realtime writes only
     * fill and never overwrite a read row (see `applyRealtime`).
     */
    fun isStale(incoming: Message, stored: MessageEntity): Boolean {
        val have = stored.updatedAt ?: return false
        val got = incoming.updatedAt?.toEpochMilli() ?: return false
        return got < have
    }
}
