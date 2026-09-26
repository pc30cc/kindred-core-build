package com.webyar.operator.feature.inbox

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.webyar.operator.core.cache.CacheScope
import com.webyar.operator.core.model.ChannelInbox
import com.webyar.operator.core.model.Conversation
import com.webyar.operator.core.model.Entitlements
import com.webyar.operator.core.model.InboxCounts
import com.webyar.operator.core.model.InboxFilter
import com.webyar.operator.core.model.VisitorProfile
import com.webyar.operator.core.model.WorkspaceAccess
import com.webyar.operator.core.model.channelKey
import com.webyar.operator.core.net.WebyarApi
import com.webyar.operator.core.sync.SyncGraph
import com.webyar.operator.core.sync.isOffline
import com.webyar.operator.i18n.StrAndroid
import com.webyar.operator.i18n.Format
import com.webyar.operator.i18n.Language
import com.webyar.operator.i18n.displayText
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * The inbox: which queue, which channel, what is in it, and how much.
 *
 * **Local-first.** What the screen shows is the cache ([SyncGraph]'s Room
 * flow for this scope and queue), from the first frame of a cold start —
 * the network only ever writes the cache, and the cache's flow carries the
 * change here. A failed refresh therefore never costs the operator the list
 * they were reading: with rows on screen it becomes [syncProblem], a line
 * above the list, and only a queue that has never once been read can end in
 * [InboxState.Failed].
 *
 * Search is done HERE rather than by the server, because the conversations
 * endpoint has no query parameter — the console narrows its own list the same
 * way. That is fine for a phone, where the page is fifty rows; it would not be
 * fine for a desktop showing a thousand, which is why this is stated rather
 * than left to look like an oversight.
 */
class InboxViewModel(
    private val api: WebyarApi,
    /** Last-but-one so `InboxViewModel(api) { language }` still reads as it always did. */
    private val sync: SyncGraph = SyncGraph.inMemory(api),
    private val language: () -> Language,
) : ViewModel() {

    private val _state = MutableStateFlow<InboxState>(InboxState.Loading)
    val state: StateFlow<InboxState> = _state.asStateFlow()

    private val _filter = MutableStateFlow(InboxFilter.OPEN)
    val filter: StateFlow<InboxFilter> = _filter.asStateFlow()

    private val _counts = MutableStateFlow(InboxCounts())
    val counts: StateFlow<InboxCounts> = _counts.asStateFlow()

    private val _channels = MutableStateFlow<List<ChannelInbox>>(emptyList())
    val channels: StateFlow<List<ChannelInbox>> = _channels.asStateFlow()

    /** Null means every channel, which is the ordinary case. */
    private val _channel = MutableStateFlow<String?>(null)
    val channel: StateFlow<String?> = _channel.asStateFlow()

    private val _query = MutableStateFlow("")
    val query: StateFlow<String> = _query.asStateFlow()

    private val _intel = MutableStateFlow<Map<String, VisitorProfile>>(emptyMap())
    val intel: StateFlow<Map<String, VisitorProfile>> = _intel.asStateFlow()

    private val _refreshing = MutableStateFlow(false)
    val refreshing: StateFlow<Boolean> = _refreshing.asStateFlow()

    /**
     * Why the list on screen may be out of date — offline, the server
     * refusing — or null when the last read worked. Shown above the rows,
     * never instead of them.
     */
    private val _syncProblem = MutableStateFlow<String?>(null)
    val syncProblem: StateFlow<String?> = _syncProblem.asStateFlow()

    private var workspaceId: String? = null
    private var scope: CacheScope? = null

    /** The queue as the cache last said, before search and channel. Null until it has said anything. */
    private var loaded: List<Conversation>? = null

    /** Whether this queue has been read from the server at least once in this scope. */
    private var everRead = false

    /** The last refresh's failure, for a queue with nothing cached to show instead. */
    private var failure: String? = null

    private var listJob: Job? = null
    private var countsJob: Job? = null

    /** Rows whose visitor intel has been asked for, so a re-emission does not ask again. */
    private val intelAsked = HashSet<String>()

    // MARK: - Loading

    fun bind(workspaceId: String) {
        if (this.workspaceId == workspaceId) return
        this.workspaceId = workspaceId
        scope = sync.scope(workspaceId)
        // A different workspace is a different plan and a different list, so
        // nothing from the old one carries over — including the channel
        // filter, which may name a plugin this workspace has never installed.
        _channel.value = null
        _query.value = ""
        _intel.value = emptyMap()
        intelAsked.clear()
        _counts.value = InboxCounts()
        _syncProblem.value = null
        observe()
        observeCounts()
        load()
        loadChannels()
    }

    /**
     * A queue and a channel are siblings in the menu, so they behave as
     * siblings here: choosing either one drops the other. This is iOS's rule
     * (`InboxViewModel.open`) and it is the only one that keeps the header
     * honest — a queue chosen while "Telegram" stayed underneath left the bar
     * naming a narrowing that the operator had just navigated away from, with
     * no obvious way back.
     */
    fun select(filter: InboxFilter) {
        val queueChanged = _filter.value != filter
        val channelDropped = _channel.value != null
        if (!queueChanged && !channelDropped) return
        _filter.value = filter
        _channel.value = null
        if (queueChanged) {
            // A different queue is a different question: carrying the search
            // terms across would silently filter a list nobody searched.
            _query.value = ""
            observe()
            observeCounts()
            load()
        } else {
            // Same queue, channel lifted: the list is already in hand.
            publish()
        }
    }

    fun selectChannel(key: String?) {
        if (_channel.value == key) return
        _channel.value = key
        // A channel inbox shows what is open on it, as on iOS. The queue has
        // to actually change for that to be true, and a queue change is a new
        // request — the conversations endpoint has no `channel` parameter, so
        // the channel itself is laid over whatever comes back.
        if (key != null && _filter.value != InboxFilter.OPEN) {
            _filter.value = InboxFilter.OPEN
            _query.value = ""
            observe()
            observeCounts()
            load()
        } else {
            publish()
        }
    }

    fun setQuery(value: String) {
        _query.value = value
        publish()
    }

    /** Pull-to-refresh: a real request, not a conditional one. */
    fun refresh() {
        _refreshing.value = true
        load(force = true)
    }

    /**
     * The cache's copy of this queue, for as long as this queue is the one on
     * screen. The first emission is whatever was saved — which on a warm
     * cache is the inbox, before any request has been made.
     */
    private fun observe() {
        val scope = scope ?: return
        val filter = _filter.value
        listJob?.cancel()
        loaded = null
        everRead = false
        failure = null
        publish()
        sync.coordinator.focusInbox(scope, filter)
        listJob = viewModelScope.launch {
            everRead = sync.conversations.hasList(scope, filter)
            sync.conversations.observeInbox(scope, filter).collect { rows ->
                loaded = rows
                publish()
                loadIntel(rows)
            }
        }
    }

    private fun observeCounts() {
        val scope = scope ?: return
        val queue = _filter.value.queue
        countsJob?.cancel()
        countsJob = viewModelScope.launch {
            sync.coordinator.counts.collect { snapshot ->
                if (snapshot != null && snapshot.matches(scope, queue)) _counts.value = snapshot.counts
            }
        }
    }

    private fun load(force: Boolean = false) {
        val scope = scope ?: return
        val filter = _filter.value
        viewModelScope.launch {
            val result = sync.coordinator.refreshInbox(scope, filter, force = force, reason = if (force) "pull" else "open")
            // The answer is for the queue that was asked about. If the
            // operator has moved on, the cache has it for when they return,
            // and this screen has nothing to say about it.
            if (this@InboxViewModel.scope == scope && _filter.value == filter) {
                result
                    .onSuccess {
                        everRead = true
                        failure = null
                        _syncProblem.value = null
                    }
                    .onFailure { error ->
                        val text = error.displayText(language())
                        failure = text
                        // Offline says what the operator is looking at: what
                        // this phone saved. Any other failure says itself.
                        _syncProblem.value = if (error.isOffline) StrAndroid.showingSaved(language()) else text
                    }
                publish()
            }
            _refreshing.value = false
            sync.coordinator.refreshCounts(scope, filter.queue)
        }
    }

    private fun loadChannels() {
        val workspace = workspaceId ?: return
        viewModelScope.launch {
            runCatching { api.channelInboxes(workspace) }.onSuccess { fresh ->
                if (workspaceId != workspace) return@onSuccess
                _channels.value = fresh
                // A channel that has just left the plan must not stay
                // selected with nothing behind it, or the list is filtered by
                // a name no row in the menu carries any more.
                if (_channel.value != null && fresh.none { it.key == _channel.value }) {
                    _channel.value = null
                    publish()
                }
            }
        }
    }

    /**
     * Where the visitors are and what they are on.
     *
     * One batched call for the rows it does not already know, rather than
     * one per row: fifty rows appearing at once would otherwise be fifty
     * requests, and a list that re-emits because one row changed would ask
     * for all fifty again. Kept in memory for the life of this workspace —
     * it is advisory decoration, not something worth a table.
     */
    private fun loadIntel(conversations: List<Conversation>) {
        val workspace = workspaceId ?: return
        val known = _intel.value.keys
        val ids = conversations.map { it.id }.filter { it !in known && it !in intelAsked }
        if (ids.isEmpty()) return
        intelAsked += ids
        viewModelScope.launch {
            runCatching { api.visitorIntelByConversation(workspace, ids) }
                .onSuccess { fresh -> if (workspaceId == workspace) _intel.update { it + fresh } }
                .onFailure { intelAsked -= ids.toSet() }
        }
    }

    // MARK: - What the screen sees

    private fun publish() {
        val rows = loaded
        _state.value = when {
            rows == null -> InboxState.Loading
            // Nothing cached and never read: the skeleton while the first
            // read is out, and its failure if it fails — the one case where
            // there is nothing better to show than the error.
            rows.isEmpty() && !everRead -> failure?.let(InboxState::Failed) ?: InboxState.Loading
            else -> InboxState.Loaded(narrow(rows))
        }
    }

    private fun narrow(rows: List<Conversation>): List<Conversation> {
        val terms = _query.value.trim()
        val channel = _channel.value
        return rows
            .filter { channel == null || it.channelKey == channel }
            .filter { terms.isEmpty() || it.matches(terms) }
    }

    /**
     * What counts as a match.
     *
     * Name, email, subject and the last message's body — the four things an
     * operator would be looking at when they reach for the magnifier. Case is
     * folded; the visitor code is included because an anonymous visitor has
     * nothing else to be searched by.
     */
    private fun Conversation.matches(terms: String): Boolean {
        val needle = terms.lowercase()
        return listOfNotNull(
            contact?.name,
            contact?.email,
            contact?.visitorCode,
            subject,
            Format.preview(lastMessage?.body),
        ).any { it.lowercase().contains(needle) }
    }

    /** The queues this plan (and the AI switches, for the AI queue) include. */
    fun filters(entitlements: Entitlements?, access: WorkspaceAccess, automated: Int?): List<InboxFilter> =
        InboxFilter.available(entitlements, access, automated)

    /** The subset that stays on the strip above the list. */
    fun chips(entitlements: Entitlements?, access: WorkspaceAccess, automated: Int?): List<InboxFilter> =
        InboxFilter.chips(entitlements, access, automated)
}
