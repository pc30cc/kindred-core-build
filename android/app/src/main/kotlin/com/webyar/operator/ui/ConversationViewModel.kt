package com.webyar.operator.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.webyar.operator.core.model.Conversation
import com.webyar.operator.core.model.InboxFilter
import com.webyar.operator.core.net.WebyarApi
import com.webyar.operator.feature.chat.ChatState
import com.webyar.operator.feature.inbox.InboxState
import com.webyar.operator.i18n.Language
import com.webyar.operator.i18n.displayText
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.util.UUID

/** The inbox list and one open conversation — the whole of the vertical slice. */
class ConversationViewModel(
    private val api: WebyarApi,
    private val language: () -> Language,
) : ViewModel() {

    private val _inbox = MutableStateFlow<InboxState>(InboxState.Loading)
    val inbox: StateFlow<InboxState> = _inbox.asStateFlow()

    private val _chat = MutableStateFlow<ChatState>(ChatState.Loading)
    val chat: StateFlow<ChatState> = _chat.asStateFlow()

    fun loadInbox(workspaceId: String, filter: InboxFilter = InboxFilter.OPEN) {
        _inbox.value = InboxState.Loading
        viewModelScope.launch {
            runCatching { api.conversations(workspaceId, filter) }
                .onSuccess { _inbox.value = InboxState.Loaded(it) }
                .onFailure { _inbox.value = InboxState.Failed(it.displayText(language())) }
        }
    }

    fun openConversation(conversation: Conversation) {
        _chat.value = ChatState.Loading
        viewModelScope.launch {
            runCatching { api.messages(conversation.id) }
                .onSuccess { _chat.value = ChatState.Loaded(it) }
                .onFailure { _chat.value = ChatState.Failed(it.displayText(language())) }
            // Advisory: failing to mark a thread seen must never stop it
            // being read.
            runCatching { api.markSeen(conversation.id) }
        }
    }

    /**
     * Sends, then re-reads the thread.
     *
     * `client_message_id` is a fresh UUID per attempt and the server collapses
     * a replay of the same key instead of sending twice — which is what makes
     * a retry safe rather than a way to double-post. Its 8–64 character
     * requirement is why this is the plain UUID string.
     */
    fun send(conversation: Conversation, body: String, workspaceId: String) {
        viewModelScope.launch {
            runCatching {
                api.send(
                    body = body,
                    conversationId = conversation.id,
                    workspaceId = workspaceId,
                    clientMessageId = UUID.randomUUID().toString(),
                )
                api.messages(conversation.id)
            }
                .onSuccess { _chat.value = ChatState.Loaded(it) }
                .onFailure { _chat.value = ChatState.Failed(it.displayText(language())) }
        }
    }
}
