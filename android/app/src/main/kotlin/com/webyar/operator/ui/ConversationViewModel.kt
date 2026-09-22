package com.webyar.operator.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.webyar.operator.core.model.InboxFilter
import com.webyar.operator.core.net.WebyarApi
import com.webyar.operator.feature.inbox.InboxState
import com.webyar.operator.i18n.Language
import com.webyar.operator.i18n.displayText
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * The inbox list.
 *
 * One open conversation used to live here too. It moved to `ChatViewModel`
 * when the chat grew past a transcript and a send button: the two have
 * different lifetimes, and a single model holding both would keep a transcript
 * alive for every thread the operator had ever glanced at.
 */
class ConversationViewModel(
    private val api: WebyarApi,
    private val language: () -> Language,
) : ViewModel() {

    private val _inbox = MutableStateFlow<InboxState>(InboxState.Loading)
    val inbox: StateFlow<InboxState> = _inbox.asStateFlow()

    private val _filter = MutableStateFlow(InboxFilter.OPEN)
    val filter: StateFlow<InboxFilter> = _filter.asStateFlow()

    fun loadInbox(workspaceId: String, filter: InboxFilter = _filter.value) {
        _filter.value = filter
        _inbox.value = InboxState.Loading
        viewModelScope.launch {
            runCatching { api.conversations(workspaceId, filter) }
                .onSuccess { _inbox.value = InboxState.Loaded(it) }
                .onFailure { _inbox.value = InboxState.Failed(it.displayText(language())) }
        }
    }
}
