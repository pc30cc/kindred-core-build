package com.webyar.operator.feature.email

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.webyar.operator.core.model.EmailThreadSummary
import com.webyar.operator.core.net.ApiError
import com.webyar.operator.core.net.WebyarApi
import com.webyar.operator.i18n.Language
import com.webyar.operator.i18n.displayText
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
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
 */
class EmailInboxViewModel(
    private val api: WebyarApi,
    private val language: () -> Language,
) : ViewModel() {

    private val _state = MutableStateFlow<EmailInboxState>(EmailInboxState.Loading)
    val state: StateFlow<EmailInboxState> = _state.asStateFlow()

    /**
     * Whose mailbox this is.
     *
     * Decorative: a failure never becomes an error state, it just leaves the
     * caption off the title.
     */
    private val _mailbox = MutableStateFlow<String?>(null)
    val mailbox: StateFlow<String?> = _mailbox.asStateFlow()

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

    private var workspaceId: String? = null
    private var loaded: List<EmailThreadSummary> = emptyList()

    fun bind(workspaceId: String) {
        if (this.workspaceId == workspaceId) return
        this.workspaceId = workspaceId
        _query.value = ""
        _mailbox.value = null
        load()
    }

    fun setQuery(value: String) {
        _query.value = value
        publish()
    }

    fun refresh() {
        _refreshing.value = true
        load(showSkeleton = false)
    }

    fun retry() = load()

    private fun load(showSkeleton: Boolean = true) {
        val workspace = workspaceId ?: return
        if (showSkeleton) _state.value = EmailInboxState.Loading
        viewModelScope.launch {
            runCatching { api.emailThreads(workspace, search = null) }
                .onSuccess {
                    loaded = it
                    _notConnected.value = false
                    publish()
                }
                .onFailure { error ->
                    if (error.isNotConnected) {
                        // 409 is the server saying the mailbox has never been
                        // connected. Not a failure — a setup step.
                        _notConnected.value = true
                        loaded = emptyList()
                        publish()
                    } else if (showSkeleton || loaded.isEmpty()) {
                        _state.value = EmailInboxState.Failed(error.displayText(language()))
                    }
                }
            _refreshing.value = false
            runCatching { api.gmailConnection(workspace) }
                .onSuccess { _mailbox.value = it?.emailAddress }
        }
    }

    /**
     * Unbolds the row as its thread opens rather than at the next refresh.
     *
     * Only the row: opening the thread is what tells the server it was read,
     * and saying so twice would be two requests for one act.
     */
    fun markReadLocally(threadId: String) {
        loaded = loaded.map { if (it.id == threadId) it.copy(isRead = true) else it }
        publish()
    }

    fun thread(id: String): EmailThreadSummary? = loaded.firstOrNull { it.id == id }

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
}

/**
 * Whether this failure is "no mailbox connected" rather than a fault.
 *
 * The server says so two ways depending on where in the stack the request
 * stopped — a 409 status, or a 400 whose body names the reason — so both are
 * read rather than only the one that happened to be seen first.
 */
private val Throwable.isNotConnected: Boolean
    get() {
        val error = this as? ApiError.Server ?: return false
        return error.status == 409 ||
            error.serverMessage?.contains("email_not_connected") == true
    }
