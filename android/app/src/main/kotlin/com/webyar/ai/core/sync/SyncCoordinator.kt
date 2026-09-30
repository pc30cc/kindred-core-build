package com.webyar.ai.core.sync

import com.webyar.ai.core.Diag
import com.webyar.ai.core.cache.CacheScope
import com.webyar.ai.core.model.InboxCounts
import com.webyar.ai.core.model.InboxFilter
import com.webyar.ai.core.model.Message
import com.webyar.ai.core.model.RealtimeEventPayload
import com.webyar.ai.core.net.ApiError
import com.webyar.ai.core.runCatchingUnlessCancelled
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import com.webyar.ai.core.model.string
import com.webyar.ai.core.model.get
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.channels.BufferOverflow

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
 *  - A targeted read that fails is **tried again**, backing off; one that
 *    keeps failing is owed to the next reconcile, which runs when the
 *    network or the socket comes back rather than at the next poll.
 *
 * Everything it starts runs under one job of its own, a child of the app's,
 * so that signing out stops all of it — and [clearAndJoin] can wait until
 * nothing of the old account's is left to write.
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

    private val _team = MutableSharedFlow<TeamSignal>(
        extraBufferCapacity = 16,
        onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )

    /**
     * Team-chat activity heard on the operator's own channel, for the screens
     * that show it: the colleagues' count on the inbox, their list, an open
     * thread. Ids only — each listener re-reads what it shows.
     */
    val team: SharedFlow<TeamSignal> = _team.asSharedFlow()

    private val _email = MutableSharedFlow<EmailSignal>(
        extraBufferCapacity = 16,
        onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )

    /**
     * A mailbox of the workspace changed — heard on the inbox channel
     * (`email_mailbox_changed`) or by an email push. Nothing about the mail
     * itself: whoever shows the mailbox asks the server what changed.
     */
    val email: SharedFlow<EmailSignal> = _email.asSharedFlow()
    private val openThreads = MutableStateFlow<Set<String>>(emptySet())
    private val openTeamThreads = MutableStateFlow<Set<String>>(emptySet())
    private val openEmailThreads = MutableStateFlow<Set<String>>(emptySet())
    private val foreground = MutableStateFlow(false)
    private val _realtime = MutableStateFlow(RealtimeHealth.IDLE)
    val realtime: StateFlow<RealtimeHealth> = _realtime.asStateFlow()

    /** The last inbox read's failure, or null once one succeeds. A secondary status, never a screen. */
    private val _failure = MutableStateFlow<Throwable?>(null)
    val failure: StateFlow<Throwable?> = _failure.asStateFlow()

    private val _counts = MutableStateFlow<CountsSnapshot?>(null)
    val counts: StateFlow<CountsSnapshot?> = _counts.asStateFlow()

    /**
     * An id queued for a read, with the scope it was heard in. A flush reads
     * only what belongs to the scope in focus when it runs: an id heard for
     * one workspace and flushed after a switch must not be read — and
     * written — under the other.
     */
    private data class Pending(val scope: CacheScope, val id: String)

    /**
     * Guards the batches and, with them, [focus] and [openThreads] — so a
     * reconcile reads the scope and the threads open in it as one pair.
     */
    private val batchLock = Any()
    private val pendingConversations = LinkedHashSet<Pending>()
    private val pendingReasons = LinkedHashSet<String>()
    private var conversationFlush: Job? = null
    private var conversationFailures = 0
    private val pendingThreads = LinkedHashSet<Pending>()
    private val pendingThreadReasons = LinkedHashSet<String>()
    private var threadFlush: Job? = null
    private var threadFailures = 0

    /** Scopes focused since sign-in; each one's outbox is resumed on a return to the foreground. */
    private val visitedScopes = LinkedHashSet<CacheScope>()

    /** One resume at a time: two at once would both find the same PENDING rows. */
    private val outboxLock = Mutex()

    /**
     * A read failed past its retries (or a reconcile failed), so the cache
     * may be behind in ways no event will report. The next reconcile — on
     * the network or the socket coming back, or in the foreground — pays it.
     */
    @Volatile private var dirty = false

    /** The job every coroutine this coordinator starts runs under; replaced on sign-out. */
    @Volatile private var work: Job = newWork()

    init {
        startLoop(work)
    }

    private fun newWork(): Job = SupervisorJob(appScope.coroutineContext[Job])

    private fun launchWork(block: suspend CoroutineScope.() -> Unit): Job =
        CoroutineScope(appScope.coroutineContext + work).launch(block = block)

    /**
     * The fallback poll and the safety net: one loop, whose cadence follows
     * whether realtime is carrying the app. It lives in [job], so sign-out
     * stops it with everything else and a new one starts for whoever is next.
     */
    private fun startLoop(job: Job) {
        CoroutineScope(appScope.coroutineContext + job).launch {
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
        val previous: Focus?
        synchronized(batchLock) {
            previous = focus.value
            if (previous != null && previous.scope != scope) {
                // A different workspace or account: whatever was queued for the
                // old one is the old one's, and a late answer for it could only
                // write rows nobody is looking at.
                pendingConversations.clear()
                pendingReasons.clear()
                pendingThreads.clear()
                pendingThreadReasons.clear()
                conversationFlush?.cancel()
                threadFlush?.cancel()
                conversationFlush = null
                threadFlush = null
                conversationFailures = 0
                threadFailures = 0
                openThreads.value = emptySet()
            }
            focus.value = Focus(scope, filter)
            visitedScopes += scope
        }
        if (previous?.scope == scope) return
        if (previous != null) diag.info(AREA, "focus moved to ${scope.tag}; old scope's work dropped")
        // A scope coming on screen has its outbox resumed. At a cold start
        // this is the only place it can be: the return to the foreground
        // comes first, before anything is in focus, and finds no scope.
        launchWork { resumeOutbox(scope) }
    }

    /**
     * A chat opened with no inbox behind it — restored after the process was
     * killed, or reached from a notification — still has to hear about its
     * conversation. Realtime publications and the poll are dropped while
     * nothing is in focus, so the Open queue is focused here unless the
     * inbox has already focused something.
     */
    fun ensureFocus(scope: CacheScope) {
        val current = focus.value
        if (current == null || current.scope != scope) focusInbox(scope, InboxFilter.OPEN)
    }

    fun openThread(conversationId: String) {
        synchronized(batchLock) { openThreads.update { it + conversationId } }
        messages.watch(conversationId)
    }

    /** Which threads are on screen, for a push deciding whether to notify. */
    fun openThreadIds(): Set<String> = openThreads.value

    fun closeThread(conversationId: String) {
        openThreads.update { it - conversationId }
        messages.unwatch(conversationId)
    }

    /** A colleague's team thread came on screen; a push from them needs no notification. */
    fun openTeamThread(peerId: String) {
        openTeamThreads.update { it + peerId }
    }

    fun closeTeamThread(peerId: String) {
        openTeamThreads.update { it - peerId }
    }

    /** Which colleagues' threads are on screen, for a push deciding whether to notify. */
    fun openTeamPeerIds(): Set<String> = openTeamThreads.value

    /** An email thread came on screen; a push about it needs no notification. */
    fun openEmailThread(threadId: String) {
        openEmailThreads.update { it + threadId }
    }

    fun closeEmailThread(threadId: String) {
        openEmailThreads.update { it - threadId }
    }

    /** Which email threads are on screen, for a push deciding whether to notify. */
    fun openEmailThreadIds(): Set<String> = openEmailThreads.value

    /**
     * Signed out: nothing is in focus and nothing may be written for anyone.
     *
     * Everything this coordinator started is cancelled — a batch still in
     * its window, a flush already waiting on the network, a resume, the
     * poll. Cancelled is not finished, though: a read whose answer is being
     * written goes on until the write ends. Before the account's rows are
     * purged, use [clearAndJoin], which returns only once all of it has.
     */
    fun clear() {
        stop()
    }

    /** [clear], and returns once nothing the old account started can still write. */
    suspend fun clearAndJoin() {
        stop().join()
        // A read that was finishing as it was cancelled may have set these.
        _counts.value = null
        _failure.value = null
    }

    /** Stops the current job and starts the next one; returns the old job, to wait on. */
    private fun stop(): Job {
        val old: Job
        val next = newWork()
        synchronized(batchLock) {
            pendingConversations.clear()
            pendingReasons.clear()
            pendingThreads.clear()
            pendingThreadReasons.clear()
            conversationFlush = null
            threadFlush = null
            conversationFailures = 0
            threadFailures = 0
            visitedScopes.clear()
            focus.value = null
            openThreads.value = emptySet()
            openEmailThreads.value = emptySet()
            old = work
            work = next
        }
        dirty = false
        old.cancel()
        startLoop(next)
        _counts.value = null
        _failure.value = null
        return old
    }

    fun setForeground(value: Boolean) {
        if (foreground.value == value) return
        foreground.value = value
        diag.info(AREA, if (value) "foreground" else "background: polling stops, push takes over")
        if (value) launchWork { onForeground() }
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
        val conversationId = message.conversationId
        launchWork {
            val applied = runCatchingUnlessCancelled { messages.applyRealtime(f.scope, message) }
            if (applied.getOrDefault(false)) diag.info(AREA, "realtime message applied to ${Diag.id(conversationId)}")
            val error = applied.exceptionOrNull() ?: return@launchWork
            // The row was not written. A thread this phone keeps would stay
            // without it until something else moved it, so its delta is
            // asked for instead — the delta carries the same row.
            diag.warn(AREA, "realtime message not applied: ${error.javaClass.simpleName}")
            if (conversationId in openThreads.value || messages.isCached(f.scope, conversationId)) {
                queueThread(f.scope, conversationId, "realtime retry")
            }
        }
        queueConversation(f.scope, conversationId, "realtime message")
        // The envelope a visitor's photo arrives in names the attachment in
        // its metadata but carries no `attachments` list, so the row it
        // writes is an empty bubble. For a thread on screen, such a message
        // brings a delta, which carries the attachment; a complete one needs
        // nothing more.
        if (conversationId in openThreads.value && message.namesMissingAttachment()) {
            queueThread(f.scope, conversationId, "realtime attachment")
        }
    }

    /**
     * An operator event. None carries the new row, so each becomes a targeted
     * read of the conversations it names — and a delta of the thread, if that
     * thread is open, for the system line most of them add.
     */
    fun onRealtimeEvent(workspaceId: String, event: RealtimeEventPayload) {
        val kindHeard = event.kind
        // A mailbox is not a conversation either, and its screens listen
        // whatever queue is in focus — the count on the inbox most of all.
        if (kindHeard == EMAIL_MAILBOX_KIND) {
            _email.tryEmit(EmailSignal(workspaceId, event.provider, event.historyId))
            return
        }
        // Team chat is not about any conversation, and not about the queue
        // on screen: it goes to whoever shows it, focus or no focus.
        if (kindHeard != null && kindHeard.startsWith(TEAM_KIND_PREFIX)) {
            _team.tryEmit(TeamSignal(workspaceId, kindHeard, event.senderId, event.recipientId, event.peerId))
            return
        }
        val f = focus.value ?: return
        if (f.scope.workspaceId != workspaceId) return
        val kind = event.kind ?: return
        val conversationId = event.conversationId?.takeIf { it.isNotBlank() }
        if (conversationId == null) {
            val contact = event.contactId ?: return
            launchWork {
                val ids = conversations.idsForContact(f.scope, contact)
                ids.forEach { queueConversation(f.scope, it, kind) }
            }
            return
        }
        queueConversation(f.scope, conversationId, kind)
        if (conversationId in openThreads.value) queueThread(f.scope, conversationId, kind)
    }

    /**
     * The first session of a realtime run is up. Nothing was heard before
     * it, so whatever changed between the screens' last reads and this
     * subscribe — a message in the second it took to connect, everything
     * since the last foreground — is found only by reading: one reconcile.
     */
    fun onRealtimeConnected() {
        focus.value ?: return
        launchWork { reconcile("connect") }
    }

    /**
     * Back from a disconnect. When Centrifugo replayed what was missed
     * ([recovered]) the publications have already come through the handlers
     * above and there is nothing to do — unless a read failed meanwhile;
     * otherwise nothing is assumed and the queue and the open thread are
     * reconciled from their cursors.
     */
    fun onRealtimeReconnected(recovered: Boolean) {
        if (recovered && !dirty) {
            diag.info(AREA, "realtime recovered every missed publication; no reconcile needed")
            return
        }
        launchWork { reconcile("reconnect") }
    }

    /**
     * The network came back. A read this phone still owes is made now, not
     * at the next poll — in the foreground only: in the background push
     * carries the app, and the return to the front reconciles anyway.
     */
    fun onNetworkAvailable() {
        if (!dirty || !foreground.value || focus.value == null) return
        launchWork { reconcile("network") }
    }

    /**
     * A push, in the foreground or on a notification tap. The same path as a
     * realtime event, so a message that arrives both ways is still one read
     * of one row.
     */
    /**
     * A colleague's message, heard by push rather than on the operator's own
     * channel — the channel may be down, or not yet up. The screens that show
     * team chat read again, exactly as for the realtime event; when both
     * arrive, the second read finds nothing new.
     */
    fun onTeamPush(workspaceId: String, peerId: String) {
        _team.tryEmit(TeamSignal(workspaceId, TEAM_MESSAGE_KIND, senderId = peerId, peerId = peerId))
    }

    /** New mail, heard by push — the channel may be down, or the app was in the background. */
    fun onEmailPush(workspaceId: String, provider: String?) {
        _email.tryEmit(EmailSignal(workspaceId, provider, historyId = null))
    }

    fun onPush(workspaceId: String, conversationId: String?) {
        val f = focus.value ?: return
        if (f.scope.workspaceId != workspaceId || conversationId.isNullOrBlank()) return
        queueConversation(f.scope, conversationId, "push")
        launchWork {
            if (conversationId in openThreads.value || messages.isCached(f.scope, conversationId)) {
                queueThread(f.scope, conversationId, "push")
            }
        }
    }

    /**
     * Something this phone just did changed a conversation — a status, an
     * assignee, a sent message. [thread] is false when the thread already
     * holds the change (a send, confirmed by its own echo).
     */
    fun onLocalChange(conversationId: String, reason: String, thread: Boolean = true) {
        val f = focus.value ?: return
        queueConversation(f.scope, conversationId, reason)
        if (thread && conversationId in openThreads.value) queueThread(f.scope, conversationId, reason)
    }

    // MARK: - Batching

    private fun queueConversation(scope: CacheScope, conversationId: String, reason: String) {
        synchronized(batchLock) {
            pendingConversations += Pending(scope, conversationId)
            pendingReasons += reason
            if (conversationFlush?.isActive == true) return
            conversationFlush = launchWork {
                delay(policy.batchWindowMs)
                flushConversations()
            }
        }
    }

    private suspend fun flushConversations() {
        // The ids, the scope they are read in and the threads open in it, as
        // one snapshot. Ids heard for another scope are that scope's, and
        // dropped with it.
        val (f, ids, reasons, openNow) = synchronized(batchLock) {
            val f = focus.value
            val ids = pendingConversations.filter { it.scope == f?.scope }.map { it.id }
            val reasons = pendingReasons.joinToString(",")
            pendingConversations.clear()
            pendingReasons.clear()
            conversationFlush = null
            Snapshot(f, ids, reasons, openThreads.value)
        }
        if (f == null || ids.isEmpty()) return
        val failed = LinkedHashSet<String>()
        runCatchingUnlessCancelled { conversations.refreshConversations(f.scope, ids, f.filter, reasons) }
            .onFailure {
                failed += ids
                diag.warn(AREA, "targeted read failed ($reasons): ${it.javaClass.simpleName}")
            }
        // Open is kept current whichever queue is on screen: the Inbox tab's
        // badge and the strip's dots count it. The same ids, asked about in
        // Open too — a new conversation there, or one that has left it —
        // when Open is not the queue just read. A failure is the reconcile's
        // to pay, as for any read it owes.
        if (f.filter != InboxFilter.OPEN) {
            runCatchingUnlessCancelled { conversations.refreshConversations(f.scope, ids, InboxFilter.OPEN, reasons) }
                .onFailure {
                    dirty = true
                    diag.warn(AREA, "open-queue read failed ($reasons): ${it.javaClass.simpleName}")
                }
        }
        // A thread on screen is read by itself too, whatever queue it is in
        // now. The focused read only answers for its own queue — a chat
        // opened from the AI's that the AI has just handed over (or that the
        // operator took over, resolved, reassigned) left it, and only the
        // queue's absence was recorded: the header and the composer kept the
        // old state. By id, the row is rewritten wherever it went.
        val open = ids.filter { it in openNow }
        if (open.isNotEmpty()) {
            runCatchingUnlessCancelled {
                conversations.refreshConversations(f.scope, open, filter = null, reason = reasons, removeMissing = false)
            }
                .onFailure {
                    failed += open
                    diag.warn(AREA, "open-thread read failed ($reasons): ${it.javaClass.simpleName}")
                }
        }
        runCatchingUnlessCancelled { refreshCounts(f.scope, f.filter.queue) }
        synchronized(batchLock) {
            if (failed.isEmpty()) {
                conversationFailures = 0
                return
            }
            // Tried again, later and later; past the limit the reconcile owes it.
            if (focus.value?.scope != f.scope) return
            conversationFailures++
            if (conversationFailures > policy.retryLimit) {
                conversationFailures = 0
                giveUp("targeted read")
                return
            }
            pendingConversations += failed.map { Pending(f.scope, it) }
            pendingReasons += "retry"
            // A batch already waiting (news arrived meanwhile) takes them along.
            if (conversationFlush?.isActive == true) return
            val wait = retryDelay(conversationFailures)
            conversationFlush = launchWork {
                delay(wait)
                flushConversations()
            }
        }
    }

    private fun queueThread(scope: CacheScope, conversationId: String, reason: String) {
        synchronized(batchLock) {
            pendingThreads += Pending(scope, conversationId)
            pendingThreadReasons += reason
            if (threadFlush?.isActive == true) return
            threadFlush = launchWork {
                delay(policy.batchWindowMs)
                flushThreads()
            }
        }
    }

    private suspend fun flushThreads() {
        val (f, ids, reason) = synchronized(batchLock) {
            val f = focus.value
            val ids = pendingThreads.filter { it.scope == f?.scope }.map { it.id }
            val reason = pendingThreadReasons.joinToString(",")
            pendingThreads.clear()
            pendingThreadReasons.clear()
            threadFlush = null
            Snapshot(f, ids, reason, emptySet())
        }
        if (f == null || ids.isEmpty()) return
        val failed = LinkedHashSet<String>()
        for (id in ids) {
            // Moved on to another scope: the rest is the old one's.
            if (focus.value?.scope != f.scope) return
            runCatchingUnlessCancelled { messages.sync(f.scope, id, reason) }
                .onFailure {
                    failed += id
                    diag.warn(AREA, "thread delta failed ($reason): ${it.javaClass.simpleName}")
                }
        }
        synchronized(batchLock) {
            if (failed.isEmpty()) {
                threadFailures = 0
                return
            }
            if (focus.value?.scope != f.scope) return
            threadFailures++
            if (threadFailures > policy.retryLimit) {
                threadFailures = 0
                giveUp("thread delta")
                return
            }
            pendingThreads += failed.map { Pending(f.scope, it) }
            pendingThreadReasons += "retry"
            if (threadFlush?.isActive == true) return
            val wait = retryDelay(threadFailures)
            threadFlush = launchWork {
                delay(wait)
                flushThreads()
            }
        }
    }

    /** One flush's input, read under [batchLock]. */
    private data class Snapshot(val focus: Focus?, val ids: List<String>, val reasons: String, val open: Set<String>)

    private fun retryDelay(attempt: Int): Long =
        (policy.retryBaseMs shl (attempt - 1).coerceIn(0, 16)).coerceAtMost(policy.retryMaxMs)

    private fun giveUp(what: String) {
        dirty = true
        diag.warn(AREA, "$what still failing after ${policy.retryLimit} retries; the next reconcile catches up")
    }

    // MARK: - Reconciling

    private suspend fun onForeground() {
        focus.value ?: return
        reconcile("foreground")
        // Every scope visited since sign-in, not only the one on screen: a
        // send left PENDING in another workspace is as much in flight.
        val scopes = synchronized(batchLock) { visitedScopes.toList() }
        for (scope in scopes) resumeOutbox(scope)
    }

    /** Re-sends what was in flight when the process stopped; see [MessageRepository.resumeOutbox]. */
    suspend fun resumeOutbox(scope: CacheScope) {
        outboxLock.withLock {
            val ids = runCatchingUnlessCancelled { messages.resumeOutbox(scope) }
                .onFailure { diag.warn(AREA, "outbox resume failed: ${it.javaClass.simpleName}") }
                .getOrDefault(emptyList())
            for (id in ids) runCatchingUnlessCancelled { messages.deliver(scope, id) }
        }
    }

    /** "Has anything changed?" for the queue on screen and every open thread. */
    suspend fun reconcile(reason: String): Boolean {
        // The scope and the threads open in it, read together: a workspace
        // switch between two separate reads would pair one scope with the
        // other's threads, and write them under it.
        val (f, open) = synchronized(batchLock) { focus.value to openThreads.value }
        if (f == null) return false
        // What is owed up to now is covered by this read; a failure owes it again.
        dirty = false
        val inbox = refreshInbox(f.scope, f.filter, force = false, reason = reason)
        var changed = inbox.getOrNull() is InboxRefresh.Replaced
        var failed = inbox.isFailure
        // And Open, when another queue is on screen, for the badge that counts
        // it — conditionally, so an unchanged Open costs a 304.
        if (f.filter != InboxFilter.OPEN) {
            val openQueue = runCatchingUnlessCancelled {
                conversations.refreshInbox(f.scope, InboxFilter.OPEN, force = false, reason = reason)
            }
            if (openQueue.getOrNull() is InboxRefresh.Replaced) changed = true
            openQueue.exceptionOrNull()?.let {
                failed = true
                diag.warn(AREA, "open-queue read failed ($reason): ${it.javaClass.simpleName}")
            }
        }
        for (id in open) {
            if (focus.value?.scope != f.scope) break
            val thread = runCatchingUnlessCancelled { messages.sync(f.scope, id, reason) }
            val result = thread.getOrNull()
            if (result is ThreadSync.Delta && result.count > 0 || result is ThreadSync.Full) changed = true
            thread.exceptionOrNull()?.let {
                failed = true
                diag.warn(AREA, "thread read failed ($reason): ${it.javaClass.simpleName}")
            }
        }
        runCatchingUnlessCancelled { refreshCounts(f.scope, f.filter.queue) }
        if (failed && focus.value?.scope == f.scope) dirty = true
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
        /** `team_message`, `team_read`: the operator's own channel (`publishTeamEvent`). */
        const val TEAM_KIND_PREFIX = "team_"

        /** The realtime event a sent team message is announced with. */
        const val TEAM_MESSAGE_KIND = "team_message"

        /** A mailbox changed (`gmailChangeNotifier.ts`); ids and cursors only, never mail. */
        const val EMAIL_MAILBOX_KIND = "email_mailbox_changed"
    }
}

/**
 * One of the workspace's mailboxes changed: new mail, or something moved.
 *
 * [provider] is which mailbox (`gmail`, `yahoo`) when the server said;
 * [historyId] is Gmail's cursor after the change, when there is one.
 */
data class EmailSignal(
    val workspaceId: String,
    val provider: String?,
    val historyId: String?,
)

/**
 * Something moved in one of this operator's team threads, as the server
 * announced it on their own channel: a message sent or received
 * (`team_message`, with [senderId] and [recipientId]) or a thread read on
 * another of their devices (`team_read`, with [peerId]).
 */
data class TeamSignal(
    val workspaceId: String,
    val kind: String,
    val senderId: String? = null,
    val recipientId: String? = null,
    val peerId: String? = null,
) {
    /** Whether this is about the thread with [peer]. */
    fun involves(peer: String): Boolean = peer == senderId || peer == recipientId || peer == peerId
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
 * A failed targeted read is tried again after 2, 4, 8 and 16 s — about half
 * a minute, then it is left to the next reconcile.
 */
data class SyncPolicy(
    val batchWindowMs: Long = 400,
    val pollMinMs: Long = 30_000,
    val pollMaxMs: Long = 120_000,
    val pollFailureMaxMs: Long = 300_000,
    val safetyIntervalMs: Long = 600_000,
    val retryBaseMs: Long = 2_000,
    val retryMaxMs: Long = 30_000,
    val retryLimit: Int = 4,
)

/** For the repositories' error handling: a failure the operator should hear about as "offline". */
val Throwable.isOffline: Boolean get() = this is ApiError.Transport

/** Names an attachment (in its metadata) that did not come with it. */
internal fun Message.namesMissingAttachment(): Boolean =
    attachments.isNullOrEmpty() &&
        (metadata.string("attachment_id") != null || metadata["attachments"] != null || metadata["attachment"] != null)
