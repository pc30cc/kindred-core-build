package com.webyar.ai.feature.email

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.webyar.ai.core.model.EmailFolder
import com.webyar.ai.core.model.EmailMailFolder
import com.webyar.ai.core.model.EmailMailbox
import com.webyar.ai.core.model.EmailThreadResponse
import com.webyar.ai.core.model.EmailThreadSummary
import com.webyar.ai.core.net.ApiError
import com.webyar.ai.core.net.WebyarApi
import com.webyar.ai.core.sync.EmailSignal
import com.webyar.ai.i18n.Language
import com.webyar.ai.i18n.displayText
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

sealed interface EmailInboxState {
    data object Loading : EmailInboxState
    data class Loaded(val threads: List<EmailThreadSummary>) : EmailInboxState
    data class Failed(val message: String) : EmailInboxState
}

/**
 * The mailbox.
 *
 * A different screen from the chat inbox rather than another queue inside it,
 * deliberately: these are email threads with subjects, recipients and quoted
 * trails, not conversations with a visitor, and the server keeps them on a
 * separate surface for exactly that reason.
 *
 * It also keeps the workspace's mailboxes and their unread counts — a Gmail
 * and a Yahoo can both be connected — for the inbox's menu as much as for
 * this screen, and follows them live: a change signal (the inbox channel's
 * `email_mailbox_changed`, or an email push) re-reads the counts and asks
 * the server what changed since the list's cursor. Signals and answers carry
 * ids only; the mail itself is read when it is shown.
 */
class EmailInboxViewModel(
    private val api: WebyarApi,
    signals: Flow<EmailSignal>? = null,
    private val language: () -> Language,
) : ViewModel() {

    private val _state = MutableStateFlow<EmailInboxState>(EmailInboxState.Loading)
    val state: StateFlow<EmailInboxState> = _state.asStateFlow()

    /**
     * Whose mailbox this is — the address of the one on screen.
     *
     * Decorative: a failure never becomes an error state, it just leaves the
     * caption off the title.
     */
    private val _mailbox = MutableStateFlow<String?>(null)
    val mailbox: StateFlow<String?> = _mailbox.asStateFlow()

    /** Every connected mailbox of the workspace, with its unread count. */
    private val _mailboxes = MutableStateFlow<List<EmailMailbox>>(emptyList())
    val mailboxes: StateFlow<List<EmailMailbox>> = _mailboxes.asStateFlow()

    /** The mailbox on screen (`gmail`, `yahoo`); null is the server's default, before the list of them is known. */
    private val _provider = MutableStateFlow<String?>(null)
    val provider: StateFlow<String?> = _provider.asStateFlow()

    /** Unread threads across the workspace's mailboxes: the inbox's email count. */
    private val _unread = MutableStateFlow(0)
    val unread: StateFlow<Int> = _unread.asStateFlow()

    /**
     * Threads whose messages changed, for an open thread to read itself
     * again. Null means "anything may have": the server could not say
     * (a reset, or a mailbox without a cursor).
     */
    private val _threadChanges = MutableSharedFlow<Set<String>?>(extraBufferCapacity = 8)
    val threadChanges: SharedFlow<Set<String>?> = _threadChanges.asSharedFlow()

    /**
     * The workspace has the module but no mailbox connected yet.
     *
     * A thing to explain rather than an error to retry, which is why it is a
     * flag beside an empty list and not a [EmailInboxState.Failed].
     */
    private val _notConnected = MutableStateFlow(false)
    val notConnected: StateFlow<Boolean> = _notConnected.asStateFlow()

    private val _query = MutableStateFlow("")
    val query: StateFlow<String> = _query.asStateFlow()

    private val _refreshing = MutableStateFlow(false)
    val refreshing: StateFlow<Boolean> = _refreshing.asStateFlow()

    /** Everything, what is unread, or what is starred — the server's own filters, inside [mailFolder]. */
    private val _folder = MutableStateFlow(EmailFolder.INBOX)
    val folder: StateFlow<EmailFolder> = _folder.asStateFlow()

    /** The folder on screen (`inbox`, `sent`, `spam`, `label:…`). */
    private val _mailFolder = MutableStateFlow(EmailMailFolder.INBOX)
    val mailFolder: StateFlow<String> = _mailFolder.asStateFlow()

    /** The folder menu of the mailbox on screen, with its counts. */
    private val _folders = MutableStateFlow<List<EmailMailFolder>>(emptyList())
    val folders: StateFlow<List<EmailMailFolder>> = _folders.asStateFlow()

    /** The list is being read again in the background — a new mail, a change elsewhere. */
    private val _syncing = MutableStateFlow(false)
    val syncing: StateFlow<Boolean> = _syncing.asStateFlow()

    /** A further page is on its way. */
    private val _loadingMore = MutableStateFlow(false)
    val loadingMore: StateFlow<Boolean> = _loadingMore.asStateFlow()

    /** The workspace whose list is loaded. */
    private var workspaceId: String? = null
    /** The workspace whose mailboxes are counted — also before its list is ever opened. */
    private var tracked: String? = null
    private var loaded: List<EmailThreadSummary> = emptyList()
    /** Where the next page starts; null when this is all there is. */
    private var nextBefore: String? = null
    /** The mailbox's change cursor as of the first page; null when it has none (Yahoo). */
    private var cursor: String? = null
    private var generation = 0
    private var mailboxJob: Job? = null
    private var foldersJob: Job? = null
    private var countsJob: Job? = null
    private var signalJob: Job? = null
    /** Mailboxes named by the signals waiting out the debounce; null in the set is "any". */
    private val pendingProviders = mutableSetOf<String?>()

    /**
     * Threads that changed while their screen was not in front — under the
     * composer, say — to be read again when it is. [allStale] is "any of them".
     */
    private val staleThreads = mutableSetOf<String>()
    private var allStale = false

    /**
     * Threads already read on this device, kept while their content is
     * unchanged ([EmailThreadSummary.version]) so reopening one asks the
     * server nothing. Memory only, and small: mail is not written to disk.
     */
    private val bodies = object : LinkedHashMap<String, Pair<String, EmailThreadResponse>>(16, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Pair<String, EmailThreadResponse>>?) =
            size > BODY_CACHE_SIZE
    }

    init {
        signals?.let { flow -> viewModelScope.launch { flow.collect(::onSignal) } }
    }

    /**
     * Counts the workspace's mailboxes without loading a list — for the
     * inbox's menu, which shows the email count before the mailbox is ever
     * opened. Cheap to call again; only a new workspace starts over.
     */
    fun track(workspaceId: String) {
        if (tracked == workspaceId) return
        tracked = workspaceId
        _mailboxes.value = emptyList()
        _unread.value = 0
        refreshMailboxes()
    }

    /**
     * Loads the list of [workspaceId]'s mailbox — [provider]'s, or the one on
     * screen, or the first — and keeps it.
     */
    fun bind(workspaceId: String, provider: String? = null) {
        track(workspaceId)
        val sameWorkspace = this.workspaceId == workspaceId
        if (sameWorkspace && (provider == null || provider == _provider.value)) return
        if (!sameWorkspace) {
            this.workspaceId = workspaceId
            _query.value = ""
            // The last workspace's setup state and cached mail are not this one's.
            _notConnected.value = false
            synchronized(bodies) { bodies.clear() }
        }
        _provider.value = provider ?: if (sameWorkspace) _provider.value else _mailboxes.value.firstOrNull()?.provider
        publishAddress()
        // Another mailbox opens on its inbox, with its own menu.
        _mailFolder.value = EmailMailFolder.INBOX
        _folders.value = emptyList()
        loaded = emptyList()
        nextBefore = null
        cursor = null
        load()
        refreshFolders()
    }

    /** Shows another of the workspace's mailboxes. */
    fun selectMailbox(provider: String) {
        val workspace = workspaceId ?: tracked ?: return
        bind(workspace, provider)
    }

    fun selectFolder(folder: EmailFolder) {
        if (_folder.value == folder) return
        _folder.value = folder
        load()
    }

    /** Shows another folder of the mailbox — from the menu — with everything in it. */
    fun selectMailFolder(id: String) {
        if (_mailFolder.value == id) return
        _mailFolder.value = id
        _folder.value = EmailFolder.INBOX
        loaded = emptyList()
        nextBefore = null
        load()
    }

    /**
     * The menu of the mailbox on screen, read again: when it opens, on a
     * refresh, and after a change signal. A folder no longer there (a label
     * deleted in Gmail) sends the list back to the inbox.
     */
    fun refreshFolders() {
        val workspace = workspaceId ?: return
        val provider = _provider.value
        foldersJob?.cancel()
        foldersJob = viewModelScope.launch {
            val list = runCatching { api.emailFolders(workspace, provider) }.getOrNull()
            if (workspace != workspaceId || provider != _provider.value) return@launch
            // Not read just now: the menu still has the inbox, rather than
            // a loader that never ends.
            if (list == null) {
                if (_folders.value.isEmpty()) _folders.value = EmailMailFolder.FALLBACK
                return@launch
            }
            _folders.value = list
            if (list.none { it.id == _mailFolder.value }) selectMailFolder(EmailMailFolder.INBOX)
        }
    }

    val hasMore: Boolean get() = nextBefore != null

    /** The next page, when the list has been scrolled to its end. */
    fun loadMore() {
        val workspace = workspaceId ?: return
        val before = nextBefore ?: return
        if (_loadingMore.value) return
        val mine = generation
        val provider = _provider.value
        _loadingMore.value = true
        viewModelScope.launch {
            runCatching { api.emailThreadsPage(workspace, _folder.value, search = null, before = before, mailbox = provider, mailFolder = _mailFolder.value) }
                .onSuccess { page ->
                    if (mine != generation) return@onSuccess
                    val seen = loaded.mapTo(HashSet()) { it.id }
                    loaded = loaded + page.threads.filter { it.id !in seen }
                    nextBefore = page.nextBefore
                    publish()
                }
            _loadingMore.value = false
        }
    }

    /**
     * Starred or not, on the row, optimistically — the star flips under the
     * thumb and the request follows. In the Starred folder an unstarred row
     * stays until the next load rather than vanishing under the finger.
     */
    fun toggleStar(threadId: String) {
        val workspace = workspaceId ?: return
        val current = loaded.firstOrNull { it.id == threadId } ?: return
        val next = current.isStarred != true
        val provider = _provider.value
        update(threadId) { it.copy(isStarred = next) }
        viewModelScope.launch {
            runCatching { api.setEmailThreadStarred(workspace, threadId, next, provider) }
                .onFailure { update(threadId) { it.copy(isStarred = !next) } }
        }
    }

    /** Read or unread, from the row. */
    fun toggleRead(threadId: String) {
        val current = loaded.firstOrNull { it.id == threadId } ?: return
        setRead(threadId, current.isRead != true)
    }

    /**
     * Read or unread, said to the server from here rather than from the
     * thread's own model.
     *
     * "Mark unread" is chosen inside a thread that closes at the same
     * moment, and a request launched in the thread's scope would be
     * cancelled as the screen goes. This model lives as long as the
     * activity, so the request finishes. The row and the count change at
     * once, and change back if the server refuses.
     */
    fun setRead(threadId: String, read: Boolean) {
        val workspace = workspaceId ?: return
        val provider = _provider.value
        val row = loaded.firstOrNull { it.id == threadId }
        val before = row?.isRead
        // Unread is anything not marked read — the row's own dot says the same.
        val flips = row != null && (row.isRead == true) != read
        update(threadId) { it.copy(isRead = read) }
        if (flips) adjustUnread(if (read) -1 else 1)
        viewModelScope.launch {
            runCatching { api.setEmailThreadRead(workspace, threadId, read, provider) }
                .onSuccess { if (flips) recountOutsideInbox() }
                .onFailure {
                    if (workspace == workspaceId && row != null) {
                        update(threadId) { it.copy(isRead = before) }
                        if (flips) adjustUnread(if (read) 1 else -1)
                    }
                }
        }
    }

    /** The thread's star changed inside it: the row follows. */
    fun setStarredLocally(threadId: String, starred: Boolean) = update(threadId) { it.copy(isStarred = starred) }

    private fun update(threadId: String, change: (EmailThreadSummary) -> EmailThreadSummary) {
        loaded = loaded.map { if (it.id == threadId) change(it) else it }
        republish()
    }

    fun setQuery(value: String) {
        _query.value = value
        republish()
    }

    fun refresh() {
        // Nothing to refresh before a workspace is bound — and a spinner
        // raised here would have nothing to lower it.
        if (workspaceId == null) return
        _refreshing.value = true
        refreshMailboxes()
        refreshFolders()
        load(showSkeleton = false)
    }

    fun retry() = load()

    /**
     * The mailboxes and their counts, read again: on the way in, when the
     * app comes back to the front, and after a change signal.
     */
    fun refreshMailboxes() {
        val workspace = tracked ?: return
        mailboxJob?.cancel()
        mailboxJob = viewModelScope.launch {
            val list = runCatching { api.emailMailboxes(workspace) }.getOrNull() ?: return@launch
            if (tracked != workspace) return@launch
            _mailboxes.value = list
            _unread.value = list.sumOf { it.unread ?: 0 }
            if (workspaceId == workspace) {
                val shown = _provider.value
                when {
                    // Null was the server's default, which is the first of these;
                    // its menu is read again under its own name.
                    shown == null -> {
                        _provider.value = list.firstOrNull()?.provider
                        refreshFolders()
                    }
                    // The one on screen was disconnected: the next one, from the top.
                    list.isNotEmpty() && list.none { it.provider == shown } -> {
                        _provider.value = list.first().provider
                        _mailFolder.value = EmailMailFolder.INBOX
                        loaded = emptyList()
                        nextBefore = null
                        cursor = null
                        load()
                        refreshFolders()
                    }
                }
            }
            publishAddress()
        }
    }

    /**
     * A mailbox changed. Signals come in bursts — Gmail's own, then the
     * push beside it — so they wait a moment and are answered once.
     */
    fun onSignal(signal: EmailSignal) {
        if (signal.workspaceId != tracked) return
        synchronized(pendingProviders) { pendingProviders += signal.provider }
        signalJob?.cancel()
        signalJob = viewModelScope.launch {
            delay(SIGNAL_DEBOUNCE_MS)
            val providers = synchronized(pendingProviders) { pendingProviders.toSet().also { pendingProviders.clear() } }
            refreshMailboxes()
            refreshFolders()
            val shown = _provider.value
            // The list is asked only about its own workspace's mailbox: a
            // workspace just switched to has not loaded one yet.
            if (workspaceId == signal.workspaceId && (null in providers || shown == null || shown in providers)) checkChanges()
        }
    }

    /**
     * What moved since the first page was read, by id; the first page again
     * if anything did. A mailbox with no cursor (Yahoo) simply reads the
     * first page again.
     */
    private suspend fun checkChanges() {
        val workspace = workspaceId ?: return
        val provider = _provider.value
        val since = cursor
        val changes = since?.let { runCatching { api.emailChanges(workspace, it, provider) }.getOrNull() }
        if (workspace != workspaceId || provider != _provider.value) return
        if (changes != null) {
            changes.historyId?.let { cursor = it }
            if (!changes.reset && changes.threadIds.isEmpty()) return
            val content = if (changes.reset) null else (changes.contentThreadIds ?: changes.threadIds).toSet()
            forget(content)
            markStale(content)
            _threadChanges.tryEmit(content)
        } else {
            forget(null)
            markStale(null)
            _threadChanges.tryEmit(null)
        }
        load(showSkeleton = false, keepTail = true)
    }

    private fun load(showSkeleton: Boolean = true, keepTail: Boolean = false) {
        val workspace = workspaceId ?: return
        if (showSkeleton) _state.value = EmailInboxState.Loading
        val mine = ++generation
        val folder = _folder.value
        val box = _mailFolder.value
        val provider = _provider.value
        _syncing.value = true
        viewModelScope.launch {
            runCatching { api.emailThreadsPage(workspace, folder, search = null, before = null, mailbox = provider, mailFolder = box) }
                .onSuccess { page ->
                    // A folder switched meanwhile has its own load on the way.
                    if (mine != generation) return@onSuccess
                    // A refresh of the first page keeps the pages already
                    // scrolled below it rather than dropping the reader back
                    // to the top of a shorter list.
                    val oldest = page.threads.lastOrNull()?.lastMessageAt
                    val fresh = page.threads.mapTo(HashSet()) { it.id }
                    val tail = if (keepTail && oldest != null) {
                        loaded.filter { it.id !in fresh && it.lastMessageAt != null && it.lastMessageAt < oldest }
                    } else {
                        emptyList()
                    }
                    loaded = page.threads + tail
                    if (tail.isEmpty()) nextBefore = page.nextBefore
                    if ((folder == EmailFolder.INBOX && box == EmailMailFolder.INBOX) || cursor == null) cursor = page.historyId ?: cursor
                    _notConnected.value = false
                    publish()
                }
                .onFailure { error ->
                    // The same rule as success: a newer load — another
                    // folder, another workspace — has the say.
                    if (mine != generation) return@onFailure
                    if (error.isNotConnected) {
                        // 409 is the server saying the mailbox has never been
                        // connected, or no longer is. Not a failure — a setup
                        // step; and nothing read from it stays on the device.
                        _notConnected.value = true
                        loaded = emptyList()
                        nextBefore = null
                        cursor = null
                        synchronized(bodies) { bodies.clear() }
                        publish()
                    } else if (showSkeleton || loaded.isEmpty()) {
                        _state.value = EmailInboxState.Failed(error.displayText(language()))
                    }
                }
            // A newer load lowers the spinner itself, when it lands.
            if (mine != generation) return@launch
            _refreshing.value = false
            _syncing.value = false
        }
    }

    /**
     * Unbolds the row as its thread opens rather than at the next refresh,
     * and takes it off the count.
     *
     * Only the row: opening the thread is what tells the server it was read,
     * and saying so twice would be two requests for one act.
     */
    fun markReadLocally(threadId: String) {
        val row = loaded.firstOrNull { it.id == threadId }
        loaded = loaded.map { if (it.id == threadId) it.copy(isRead = true) else it }
        if (row != null && row.isRead != true) {
            adjustUnread(-1)
            recountOutsideInbox()
        }
        republish()
    }

    fun thread(id: String): EmailThreadSummary? = loaded.firstOrNull { it.id == id }

    // MARK: - Threads already read

    /** The thread as last read, if its content has not changed since. */
    fun cachedThread(threadId: String, provider: String?, version: String?, folder: String? = null): EmailThreadResponse? {
        version ?: return null
        val entry = synchronized(bodies) { bodies[bodyKey(provider, threadId, folder)] } ?: return null
        return entry.second.takeIf { entry.first == version }
    }

    /** Kept per folder too: Spam or Drafts shows a thread with other messages than the inbox does. */
    fun rememberThread(provider: String?, response: EmailThreadResponse, folder: String? = null) {
        synchronized(bodies) { bodies[bodyKey(provider, response.thread.id, folder)] = response.thread.version to response }
    }

    /**
     * [threadId] changed from this device — a reply sent on it, or marked
     * unread: its kept copy is dropped, and its screen reads it again.
     */
    fun noteChanged(threadId: String?) {
        threadId ?: return
        forget(setOf(threadId))
        markStale(setOf(threadId))
    }

    /** Whether [threadId] changed since its screen last read it; asking clears it. */
    fun consumeStale(threadId: String): Boolean = synchronized(staleThreads) {
        val stale = allStale || threadId in staleThreads
        allStale = false
        staleThreads.remove(threadId)
        stale
    }

    private fun markStale(threadIds: Set<String>?) = synchronized(staleThreads) {
        if (threadIds == null) allStale = true else staleThreads += threadIds
    }

    private fun forget(threadIds: Set<String>?) = synchronized(bodies) {
        if (threadIds == null) bodies.clear() else bodies.keys.removeAll { key -> threadIds.any { key.endsWith("|$it") } }
    }

    private fun bodyKey(provider: String?, threadId: String, folder: String?) =
        "${provider ?: _provider.value ?: "-"}|${folder ?: EmailMailFolder.INBOX}|$threadId"

    // MARK: -

    /**
     * A row read or unread here moves the count of the folder on screen, and
     * — only when that folder is the inbox — the mailbox's own count, which
     * is its inbox's. Elsewhere (a label, All mail) the same thread may or
     * may not be in the inbox: [recountOutsideInbox] asks.
     */
    private fun adjustUnread(delta: Int) {
        val box = _mailFolder.value
        _folders.value = _folders.value.map { folder ->
            if (folder.id == box && folder.unread != null) folder.copy(unread = (folder.unread + delta).coerceAtLeast(0)) else folder
        }
        if (box != EmailMailFolder.INBOX) return
        val shown = _provider.value ?: _mailboxes.value.firstOrNull()?.provider ?: return
        _mailboxes.value = _mailboxes.value.map { box ->
            if (box.provider == shown && box.unread != null) box.copy(unread = (box.unread + delta).coerceAtLeast(0)) else box
        }
        _unread.value = _mailboxes.value.sumOf { it.unread ?: 0 }
    }

    /**
     * Outside the inbox a read or unread thread may have moved the inbox's
     * count too: the counts are read again once the server has had the change.
     */
    private fun recountOutsideInbox() {
        if (_mailFolder.value == EmailMailFolder.INBOX) return
        countsJob?.cancel()
        countsJob = viewModelScope.launch {
            delay(RECOUNT_DELAY_MS)
            refreshMailboxes()
            refreshFolders()
        }
    }

    private fun publishAddress() {
        val list = _mailboxes.value
        _mailbox.value = (list.firstOrNull { it.provider == _provider.value } ?: list.firstOrNull())?.address
    }

    /**
     * The list on screen drawn again after a change made here — a search, a
     * star, a row read. Only a list already shown: while the mailbox is still
     * being read, redrawing would put "no mail" where the loader is, and the
     * mail would then appear all at once.
     */
    private fun republish() {
        if (_state.value is EmailInboxState.Loaded) publish()
    }

    private fun publish() {
        val needle = _query.value.trim().lowercase()
        _state.value = EmailInboxState.Loaded(
            if (needle.isEmpty()) loaded else loaded.filter { it.matches(needle) }
        )
    }

    /**
     * Filtered here rather than on the server, the same way the chat inbox
     * filters its own list, so "matches" means the same thing on both
     * screens. The server's `q=` would search the whole mailbox; this searches
     * what is on screen.
     */
    private fun EmailThreadSummary.matches(needle: String): Boolean {
        val haystack = listOfNotNull(subject, lastMessageSnippet) +
            participants.orEmpty().map { it.email }
        return haystack.any { it.lowercase().contains(needle) }
    }

    private companion object {
        /** The web's wait (`useEmailInbox.ts`): Gmail's push and ours arrive a moment apart. */
        const val SIGNAL_DEBOUNCE_MS = 1_500L
        /** Long enough for the thread screen's own read receipt to have landed. */
        const val RECOUNT_DELAY_MS = 2_000L
        const val BODY_CACHE_SIZE = 40
    }
}

/**
 * Whether this failure is "no mailbox connected" rather than a fault.
 *
 * The server says so two ways depending on where in the stack the request
 * stopped — a 409 status, or a 400 whose body names the reason — so both are
 * read.
 */
private val Throwable.isNotConnected: Boolean
    get() {
        val error = this as? ApiError.Server ?: return false
        return error.status == 409 ||
            error.serverMessage?.contains("email_not_connected") == true
    }
