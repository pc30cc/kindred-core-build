package com.webyar.operator.core.sync

import com.webyar.operator.core.Diag
import com.webyar.operator.core.cache.CacheScope
import com.webyar.operator.core.model.InboxCounts
import com.webyar.operator.core.model.InboxFilter
import com.webyar.operator.core.model.Message
import com.webyar.operator.core.model.RealtimeEventPayload
import com.webyar.operator.core.net.ApiError
import com.webyar.operator.core.runCatchingUnlessCancelled
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * How realtime is doing, as the rest of the app needs to know it.
 *
 * Nothing on screen shows this — an operator does not care which transport
 * brought a message — but it decides whether the foreground poll runs, and
 * it is what the diagnostics log reports.
 */
enum class RealtimeHealth {
    /** Not trying: in the background, signed out, or no workspace yet. */
    IDLE,
    CONNECTING,
    CONNECTED,

    /** Trying and failing, or the server has no socket to offer: polling carries the app. */
    DEGRADED,
}

/**
 * The one door every change comes in through.
 *
 * Realtime publications, pushes, a return to the foreground, a pull, a
 * send's confirmation — each is a different reason to look, and each arrives
 * here, and each ends up as the same few targeted reads in the repositories,
 * which write the cache, which the screens read. Nothing that arrives here
 * touches a screen's state.
 *
 * What it adds on top of the repositories is judgement about cost:
 *
 *  - Ids named by events are **batched**: ten messages in a second are one
 *    targeted read of ten ids, not ten reads, and never a reload of the
 *    queue.
 *  - A thread is re-read (by delta) only when it is open on screen. A cached
 *    thread nobody is looking at is brought up to date when it is opened.
 *  - The **fallback poll** runs only while the app is in front AND realtime is
 *    not connected. It asks "did the queue change?" (a 304 when not) and the
 *    open thread for its delta; its interval stretches while nothing changes
 *    and resets when something does. In the background nothing runs at all:
 *    push is the background's transport.
 *  - While realtime is healthy, a **safety** reconcile runs every
 *    [SyncPolicy.safetyIntervalMs] — a conditional read that is a 304 unless
 *    realtime missed something.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class SyncCoordinator(
    val conversations: ConversationRepository,
    val messages: MessageRepository,
    private val appScope: CoroutineScope,
    private val clock: () -> Long = System::currentTimeMillis,
    private val diag: Diag = Diag.Android,
    private val policy: SyncPolicy = SyncPolicy(),
) {
    /** The queue on screen, in the scope on screen. Events are read against it. */
    data class Focus(val scope: CacheScope, val filter: InboxFilter)

    private val focus = MutableStateFlow<Focus?>(null)
    private val openThreads = MutableStateFlow<Set<String>>(emptySet())
    private val foreground = MutableStateFlow(false)
    private val _realtime = MutableStateFlow(RealtimeHealth.IDLE)
    val realtime: StateFlow<RealtimeHealth> = _realtime.asStateFlow()

    /** The last inbox read's failure, or null once one succeeds. A secondary status, never a screen. */
    private val _failure = MutableStateFlow<Throwable?>(null)
    val failure: StateFlow<Throwable?> = _failure.asStateFlow()

    private val _counts = MutableStateFlow<CountsSnapshot?>(null)
    val counts: StateFlow<CountsSnapshot?> = _counts.asStateFlow()

    private val batchLock = Any()
    private val pendingConversations = LinkedHashSet<String>()
    private val pendingReasons = LinkedHashSet<String>()
    private var conversationFlush: Job? = null
    private val pendingThreads = LinkedHashSet<String>()
    private var threadFlush: Job? = null

    init {
        // The fallback poll and the safety net: one loop, whose cadence
        // follows whether realtime is carrying the app.
        appScope.launch {
            combine(foreground, _realtime, focus) { fg, rt, f -> Triple(fg, rt, f) }
                .distinctUntilChanged()
                .collectLatest { (fg, rt, f) ->
                    if (!fg || f == null) return@collectLatest
                    if (rt == RealtimeHealth.CONNECTED) safetyLoop() else pollLoop(rt)
                }
        }
    }

    // MARK: - What is on screen

    fun focusInbox(scope: CacheScope, filter: InboxFilter) {
        val previous = focus.value
        if (previous != null && previous.scope != scope) {
            // A different workspace or account: whatever was queued for the
            // old one is the old one's, and a late answer for it could only
            // write rows nobody is looking at.
            synchronized(batchLock) {
                pendingConversations.clear()
                pendingThreads.clear()
                conversationFlush?.cancel()
                threadFlush?.cancel()
                conversationFlush = null
                threadFlush = null
            }
            openThreads.value = emptySet()
            diag.info(AREA, "focus moved to ${scope.tag}; old scope's work dropped")
        }
        focus.value = Focus(scope, filter)
    }

    fun openThread(conversationId: String) {
        openThreads.update { it + conversationId }
        messages.watch(conversationId)
    }

    /** Which threads are on screen, for a push deciding whether to notify. */
    fun openThreadIds(): Set<String> = openThreads.value

    fun closeThread(conversationId: String) {
        openThreads.update { it - conversationId }
        messages.unwatch(conversationId)
    }

    /** Signed out: nothing is in focus and nothing may be written for anyone. */
    fun clear() {
        synchronized(batchLock) {
            pendingConversations.clear()
            pendingThreads.clear()
            conversationFlush?.cancel()
            threadFlush?.cancel()
        }
        focus.value = null
        openThreads.value = emptySet()
        _counts.value = null
        _failure.value = null
    }

    fun setForeground(value: Boolean) {
        if (foreground.value == value) return
        foreground.value = value
        diag.info(AREA, if (value) "foreground" else "background: polling stops, push takes over")
        if (value) appScope.launch { onForeground() }
    }

    fun setRealtime(health: RealtimeHealth) {
        if (_realtime.value == health) return
        _realtime.value = health
    }

    // MARK: - Reads the screens ask for

    /** A queue, conditionally; the failure is kept for the screen's status line. */
    suspend fun refreshInbox(scope: CacheScope, filter: InboxFilter, force: Boolean, reason: String): Result<InboxRefresh> {
        val result = runCatchingUnlessCancelled { conversations.refreshInbox(scope, filter, force, reason) }
        if (focus.value?.scope == scope) _failure.value = result.exceptionOrNull()
        result.exceptionOrNull()?.let { diag.warn(AREA, "inbox read failed ($reason): ${it.javaClass.simpleName}") }
        return result
    }

    suspend fun refreshCounts(scope: CacheScope, queue: String) {
        conversations.cachedCounts(scope, queue)?.let { cached ->
            if (_counts.value?.matches(scope, queue) != true) _counts.value = CountsSnapshot(scope, queue, cached)
        }
        val fresh = conversations.refreshCounts(scope, queue) ?: return
        _counts.value = CountsSnapshot(scope, queue, fresh)
    }

    // MARK: - What arrives

    /** A full message over realtime: written as it is, then its row in the list asked about. */
    fun onRealtimeMessage(workspaceId: String, message: Message) {
        val f = focus.value ?: return
        if (f.scope.workspaceId != workspaceId) return
        appScope.launch {
            val wrote = runCatchingUnlessCancelled { messages.applyRealtime(f.scope, message) }.getOrDefault(false)
            if (wrote) diag.info(AREA, "realtime message applied to ${Diag.id(message.conversationId)}")
        }
        queueConversation(message.conversationId, "realtime message")
    }

    /**
     * An operator event. None carries the new row, so each becomes a targeted
     * read of the conversations it names — and a delta of the thread, if that
     * thread is open, for the system line most of them add.
     */
    fun onRealtimeEvent(workspaceId: String, event: RealtimeEventPayload) {
        val f = focus.value ?: return
        if (f.scope.workspaceId != workspaceId) return
        val kind = event.kind ?: return
        val conversationId = event.conversationId?.takeIf { it.isNotBlank() }
        if (conversationId == null) {
            val contact = event.contactId ?: return
            appScope.launch {
                val ids = conversations.idsForContact(f.scope, contact)
                ids.forEach { queueConversation(it, kind) }
            }
            return
        }
        queueConversation(conversationId, kind)
        if (conversationId in openThreads.value) queueThread(conversationId, kind)
    }

    /**
     * Back from a disconnect. When Centrifugo replayed what was missed
     * ([recovered]) the publications have already come through the handlers
     * above and there is nothing to do; otherwise nothing is assumed and the
     * queue and the open thread are reconciled from their cursors.
     */
    fun onRealtimeReconnected(recovered: Boolean) {
        if (recovered) {
            diag.info(AREA, "realtime recovered every missed publication; no reconcile needed")
            return
        }
        appScope.launch { reconcile("reconnect") }
    }

    /**
     * A push, in the foreground or on a notification tap. The same path as a
     * realtime event, so a message that arrives both ways is still one read
     * of one row.
     */
    fun onPush(workspaceId: String, conversationId: String?) {
        val f = focus.value ?: return
        if (f.scope.workspaceId != workspaceId || conversationId.isNullOrBlank()) return
        queueConversation(conversationId, "push")
        appScope.launch {
            if (conversationId in openThreads.value || messages.isCached(f.scope, conversationId)) {
                queueThread(conversationId, "push")
            }
        }
    }

    /**
     * Something this phone just did changed a conversation — a status, an
     * assignee, a sent message. [thread] is false when the thread already
     * holds the change (a send, confirmed by its own echo).
     */
    fun onLocalChange(conversationId: String, reason: String, thread: Boolean = true) {
        queueConversation(conversationId, reason)
        if (thread && conversationId in openThreads.value) queueThread(conversationId, reason)
    }

    // MARK: - Batching

    private fun queueConversation(conversationId: String, reason: String) {
        synchronized(batchLock) {
            pendingConversations += conversationId
            pendingReasons += reason
            if (conversationFlush?.isActive == true) return
            conversationFlush = appScope.launch {
                delay(policy.batchWindowMs)
                flushConversations()
            }
        }
    }

    private suspend fun flushConversations() {
        val f = focus.value ?: return
        val (ids, reasons) = synchronized(batchLock) {
            val ids = pendingConversations.toList()
            val reasons = pendingReasons.joinToString(",")
            pendingConversations.clear()
            pendingReasons.clear()
            conversationFlush = null
            ids to reasons
        }
        if (ids.isEmpty()) return
        runCatchingUnlessCancelled { conversations.refreshConversations(f.scope, ids, f.filter, reasons) }
            .onFailure { diag.warn(AREA, "targeted read failed ($reasons): ${it.javaClass.simpleName}") }
        runCatchingUnlessCancelled { refreshCounts(f.scope, f.filter.queue) }
    }

    private fun queueThread(conversationId: String, reason: String) {
        synchronized(batchLock) {
            pendingThreads += conversationId
            if (threadFlush?.isActive == true) return
            threadFlush = appScope.launch {
                delay(policy.batchWindowMs)
                flushThreads(reason)
            }
        }
    }

    private suspend fun flushThreads(reason: String) {
        val f = focus.value ?: return
        val ids = synchronized(batchLock) {
            val ids = pendingThreads.toList()
            pendingThreads.clear()
            threadFlush = null
            ids
        }
        for (id in ids) {
            runCatchingUnlessCancelled { messages.sync(f.scope, id, reason) }
                .onFailure { diag.warn(AREA, "thread delta failed ($reason): ${it.javaClass.simpleName}") }
        }
    }

    // MARK: - Reconciling

    private suspend fun onForeground() {
        val f = focus.value ?: return
        reconcile("foreground")
        resumeOutbox(f.scope)
    }

    /** Re-sends what was in flight when the process stopped; see [MessageRepository.resumeOutbox]. */
    suspend fun resumeOutbox(scope: CacheScope) {
        val ids = messages.resumeOutbox(scope)
        for (id in ids) runCatchingUnlessCancelled { messages.deliver(scope, id) }
    }

    /** "Has anything changed?" for the queue on screen and every open thread. */
    suspend fun reconcile(reason: String): Boolean {
        val f = focus.value ?: return false
        val inbox = refreshInbox(f.scope, f.filter, force = false, reason = reason)
        var changed = inbox.getOrNull() is InboxRefresh.Replaced
        for (id in openThreads.value) {
            val thread = runCatchingUnlessCancelled { messages.sync(f.scope, id, reason) }
            val result = thread.getOrNull()
            if (result is ThreadSync.Delta && result.count > 0 || result is ThreadSync.Full) changed = true
            thread.exceptionOrNull()?.let { diag.warn(AREA, "thread read failed ($reason): ${it.javaClass.simpleName}") }
        }
        runCatchingUnlessCancelled { refreshCounts(f.scope, f.filter.queue) }
        return changed && inbox.isSuccess
    }

    private suspend fun pollLoop(health: RealtimeHealth) {
        var interval = policy.pollMinMs
        diag.info(AREA, "fallback polling on (realtime $health), every ${interval / 1000}s to start")
        while (true) {
            delay(interval)
            val failed = _failure.value != null
            val changed = reconcile("poll")
            interval = when {
                // A server that is failing is not helped by being asked
                // more often; a phone that is offline is not either.
                _failure.value != null -> (interval * 2).coerceAtMost(policy.pollFailureMaxMs)
                changed -> policy.pollMinMs
                failed -> policy.pollMinMs
                else -> (interval * 3 / 2).coerceAtMost(policy.pollMaxMs)
            }
            diag.info(AREA, "poll: ${if (changed) "changes" else "nothing new"}; next in ${interval / 1000}s")
        }
    }

    private suspend fun safetyLoop() {
        while (true) {
            delay(policy.safetyIntervalMs)
            reconcile("safety")
        }
    }

    private companion object {
        const val AREA = "Sync"
    }
}

/** The counters the inbox badges show, with the scope and queue they belong to. */
data class CountsSnapshot(val scope: CacheScope, val queue: String, val counts: InboxCounts) {
    fun matches(scope: CacheScope, queue: String) = this.scope == scope && this.queue == queue
}

/**
 * The numbers the coordinator runs on, in one place.
 *
 * The poll starts at 30 s — twice the Mac's 15 s, because a phone's radio
 * is woken by every request and a desk's is not — and stretches to 2 min
 * while nothing changes; the safety check under a healthy socket is 10 min.
 */
data class SyncPolicy(
    val batchWindowMs: Long = 400,
    val pollMinMs: Long = 30_000,
    val pollMaxMs: Long = 120_000,
    val pollFailureMaxMs: Long = 300_000,
    val safetyIntervalMs: Long = 600_000,
)

/** For the repositories' error handling: a failure the operator should hear about as "offline". */
val Throwable.isOffline: Boolean get() = this is ApiError.Transport
