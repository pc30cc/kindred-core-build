package com.webyar.operator.feature.team

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.webyar.operator.core.model.Colleague
import com.webyar.operator.core.net.WebyarApi
import com.webyar.operator.i18n.Language
import com.webyar.operator.i18n.displayText
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import com.webyar.operator.core.sync.TeamSignal
import kotlinx.coroutines.flow.Flow

sealed interface ColleaguesState {
    data object Loading : ColleaguesState
    data class Loaded(val colleagues: List<Colleague>) : ColleaguesState
    data class Failed(val message: String) : ColleaguesState
}

/**
 * The internal inbox: operators talking to each other, not to visitors.
 *
 * The console keeps this inside the Inbox under "Internal inbox" and so does
 * this app — it is reached from the same title menu. It is a different shape
 * from a conversation though: no contact, no queue, no status, just a
 * colleague and a thread with them, which is why it is its own screen rather
 * than another filter over the same list.
 */
class ColleaguesViewModel(
    private val api: WebyarApi,
    private val language: () -> Language,
) : ViewModel() {

    private val _state = MutableStateFlow<ColleaguesState>(ColleaguesState.Loading)
    val state: StateFlow<ColleaguesState> = _state.asStateFlow()

    private val _query = MutableStateFlow("")
    val query: StateFlow<String> = _query.asStateFlow()

    private val _refreshing = MutableStateFlow(false)
    val refreshing: StateFlow<Boolean> = _refreshing.asStateFlow()

    private var workspaceId: String? = null
    private var loaded: List<Colleague> = emptyList()

    fun bind(workspaceId: String) {
        if (this.workspaceId == workspaceId) return
        this.workspaceId = workspaceId
        _query.value = ""
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

    /**
     * Keeps the list — and each colleague's unread count — current while it
     * is on screen: re-read the moment the operator's own channel says a
     * team thread moved, and every twenty seconds regardless, the console's
     * rate. Quietly: no skeleton, no pull-to-refresh spinner, and a failed
     * re-read leaves the list as it was.
     */
    suspend fun followWhileVisible(workspaceId: String, signals: Flow<TeamSignal>? = null) {
        followTeam(signals, TEAM_LIST_POLL_MS, wanted = { it.workspaceId == workspaceId }) {
            if (this.workspaceId != workspaceId) return@followTeam
            runCatching { api.colleagues(workspaceId).colleagues }
                .onSuccess { if (this.workspaceId == workspaceId) { loaded = it; publish() } }
        }
    }

    private fun load(showSkeleton: Boolean = true) {
        val workspace = workspaceId ?: return
        if (showSkeleton) _state.value = ColleaguesState.Loading
        viewModelScope.launch {
            runCatching { api.colleagues(workspace).colleagues }
                .onSuccess { loaded = it; publish() }
                .onFailure {
                    if (showSkeleton || loaded.isEmpty()) {
                        _state.value = ColleaguesState.Failed(it.displayText(language()))
                    }
                }
            _refreshing.value = false
        }
    }

    /**
     * Clears the badge as the thread opens rather than one refresh later.
     *
     * The server is told separately, by the thread screen. This is only so the
     * operator does not watch a count they have just read sit there until the
     * next pull.
     */
    fun markRead(userId: String) {
        loaded = loaded.map { if (it.userId == userId) it.copy(unread = 0) else it }
        publish()
    }

    fun colleague(userId: String): Colleague? = loaded.firstOrNull { it.userId == userId }

    private fun publish() {
        val needle = _query.value.trim().lowercase()
        _state.value = ColleaguesState.Loaded(
            if (needle.isEmpty()) {
                loaded
            } else {
                loaded.filter { colleague ->
                    listOfNotNull(colleague.fullName, colleague.email)
                        .any { it.lowercase().contains(needle) }
                }
            }
        )
    }
}
