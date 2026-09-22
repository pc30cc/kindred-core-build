package com.webyar.operator.feature.inbox

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.webyar.operator.core.model.ChannelInbox
import com.webyar.operator.core.model.Conversation
import com.webyar.operator.core.model.Entitlements
import com.webyar.operator.core.model.InboxCounts
import com.webyar.operator.core.model.InboxFilter
import com.webyar.operator.core.model.VisitorProfile
import com.webyar.operator.core.model.channelKey
import com.webyar.operator.core.net.WebyarApi
import com.webyar.operator.i18n.Format
import com.webyar.operator.i18n.Language
import com.webyar.operator.i18n.displayText
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * The inbox: which queue, which channel, what is in it, and how much.
 *
 * Search is done HERE rather than by the server, because the conversations
 * endpoint has no query parameter — the console narrows its own list the same
 * way. That is fine for a phone, where the page is fifty rows; it would not be
 * fine for a desktop showing a thousand, which is why this is stated rather
 * than left to look like an oversight.
 */
class InboxViewModel(
    private val api: WebyarApi,
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

    private var workspaceId: String? = null

    /** Everything loaded for the current queue, before search and channel. */
    private var loaded: List<Conversation> = emptyList()

    // MARK: - Loading

    fun bind(workspaceId: String) {
        if (this.workspaceId == workspaceId) return
        this.workspaceId = workspaceId
        // A different workspace is a different plan and a different list, so
        // nothing from the old one carries over — including the channel
        // filter, which may name a plugin this workspace has never installed.
        _channel.value = null
        _query.value = ""
        _intel.value = emptyMap()
        load()
        loadChannels()
    }

    fun select(filter: InboxFilter) {
        if (_filter.value == filter) return
        _filter.value = filter
        // A different queue is a different question: carrying the search terms
        // across would silently filter a list nobody searched.
        _query.value = ""
        load()
    }

    fun selectChannel(key: String?) {
        _channel.value = key
    }

    fun setQuery(value: String) {
        _query.value = value
        publish()
    }

    fun refresh() {
        _refreshing.value = true
        load(showSpinner = false)
    }

    private fun load(showSpinner: Boolean = true) {
        val workspace = workspaceId ?: return
        if (showSpinner) _state.value = InboxState.Loading
        viewModelScope.launch {
            runCatching { api.conversations(workspace, _filter.value) }
                .onSuccess {
                    loaded = it
                    publish()
                    loadIntel(it)
                }
                .onFailure { _state.value = InboxState.Failed(it.displayText(language())) }
            _refreshing.value = false
            loadCounts()
        }
    }

    private fun loadCounts() {
        val workspace = workspaceId ?: return
        viewModelScope.launch {
            // Advisory: a badge that failed to load is a missing number, not a
            // reason to show the operator an error over a list that loaded.
            runCatching { api.inboxCounts(workspace, _filter.value.queue) }
                .onSuccess { _counts.value = it }
        }
    }

    private fun loadChannels() {
        val workspace = workspaceId ?: return
        viewModelScope.launch {
            runCatching { api.channelInboxes(workspace) }.onSuccess { _channels.value = it }
        }
    }

    /**
     * Where the visitors are and what they are on.
     *
     * One batched call for the whole page rather than one per row: fifty rows
     * appearing at once would otherwise be fifty requests, and the rows that
     * scrolled past before their answer came back would have paid for nothing.
     */
    private fun loadIntel(conversations: List<Conversation>) {
        val workspace = workspaceId ?: return
        val ids = conversations.map { it.id }
        if (ids.isEmpty()) return
        viewModelScope.launch {
            runCatching { api.visitorIntelByConversation(workspace, ids) }
                .onSuccess { fresh -> _intel.update { it + fresh } }
        }
    }

    // MARK: - What the screen sees

    private fun publish() {
        val terms = _query.value.trim()
        val channel = _channel.value

        val filtered = loaded
            .filter { channel == null || it.channelKey == channel }
            .filter { terms.isEmpty() || it.matches(terms) }

        _state.value = InboxState.Loaded(filtered)
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

    /** The queues this plan includes. */
    fun filters(entitlements: Entitlements?): List<InboxFilter> = InboxFilter.available(entitlements)

    /** The subset that stays on the strip above the list. */
    fun chips(entitlements: Entitlements?): List<InboxFilter> = InboxFilter.chips(entitlements)
}
