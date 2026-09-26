package com.webyar.operator.feature.email

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.webyar.operator.core.model.EmailMessageView
import com.webyar.operator.core.model.EmailThreadSummary
import com.webyar.operator.core.net.WebyarApi
import com.webyar.operator.i18n.Language
import com.webyar.operator.i18n.displayText
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

sealed interface EmailThreadState {
    data object Loading : EmailThreadState
    data class Loaded(val messages: List<EmailMessageView>) : EmailThreadState
    data class Failed(val message: String) : EmailThreadState
}

/** One thread: the trail, and a box to answer it. */
class EmailThreadViewModel(
    private val api: WebyarApi,
    private val language: () -> Language,
) : ViewModel() {

    private val _state = MutableStateFlow<EmailThreadState>(EmailThreadState.Loading)
    val state: StateFlow<EmailThreadState> = _state.asStateFlow()

    private val _thread = MutableStateFlow<EmailThreadSummary?>(null)
    val thread: StateFlow<EmailThreadSummary?> = _thread.asStateFlow()

    private val _draft = MutableStateFlow("")
    val draft: StateFlow<String> = _draft.asStateFlow()

    private val _sending = MutableStateFlow(false)
    val sending: StateFlow<Boolean> = _sending.asStateFlow()

    private val _sendFailed = MutableStateFlow(false)
    val sendFailed: StateFlow<Boolean> = _sendFailed.asStateFlow()

    private var workspaceId: String? = null
    private var threadId: String? = null

    val isStarred: Boolean get() = _thread.value?.isStarred == true

    fun open(workspaceId: String, threadId: String, known: EmailThreadSummary?) {
        if (this.workspaceId == workspaceId && this.threadId == threadId) return
        this.workspaceId = workspaceId
        this.threadId = threadId
        // The summary the list already has, so the subject is on screen before
        // the trail arrives rather than appearing a second later.
        _thread.value = known
        _state.value = EmailThreadState.Loading
        _draft.value = ""
        load()
    }

    fun setDraft(value: String) {
        _draft.value = value
    }

    fun dismissSendError() {
        _sendFailed.value = false
    }

    private fun load() {
        val workspace = workspaceId ?: return
        val id = threadId ?: return
        viewModelScope.launch {
            runCatching { api.emailThread(workspace, id) }
                .onSuccess {
                    _thread.value = it.thread
                    _state.value = EmailThreadState.Loaded(it.messages)
                    // Opening a thread is what reading it means.
                    runCatching { api.setEmailThreadRead(workspace, id, isRead = true) }
                }
                .onFailure { _state.value = EmailThreadState.Failed(it.displayText(language())) }
        }
    }

    fun retry() {
        _state.value = EmailThreadState.Loading
        load()
    }

    /**
     * Read again without a spinner — coming back from the composer, the
     * reply that was just sent should be in the trail.
     */
    fun reloadQuietly() {
        if (_state.value is EmailThreadState.Loaded) load()
    }

    /**
     * Starred, optimistically.
     *
     * The star flips under the thumb and the request follows. A failure leaves
     * the app disagreeing with the server about one boolean until the next
     * load, which is a better trade than a star that waits half a second to
     * decide whether it meant it.
     */
    fun toggleStar() {
        val workspace = workspaceId ?: return
        val current = _thread.value ?: return
        val next = current.isStarred != true
        _thread.value = current.copy(isStarred = next)
        viewModelScope.launch {
            runCatching { api.setEmailThreadStarred(workspace, current.id, next) }
        }
    }

    fun markUnread() {
        val workspace = workspaceId ?: return
        val id = threadId ?: return
        viewModelScope.launch {
            runCatching { api.setEmailThreadRead(workspace, id, isRead = false) }
        }
    }

    /**
     * Who a reply goes to.
     *
     * The last person who wrote in, which is what "reply" means to everyone
     * who has ever used a mail client. Falling back to the thread's
     * participants covers a thread we only ever sent to.
     */
    fun recipients(mailbox: String?): List<String> {
        val messages = (_state.value as? EmailThreadState.Loaded)?.messages.orEmpty()
        messages.lastOrNull { !it.isOutbound }?.fromAddress?.takeIf { it.isNotEmpty() }
            ?.let { return listOf(it) }

        val all = _thread.value?.participants.orEmpty().map { it.email }
        if (mailbox == null) return all
        return all.filterNot { it.equals(mailbox, ignoreCase = true) }
    }

    /**
     * Sends and reloads, so the trail shows what was recorded rather than an
     * optimistic copy of it — a mail that bounced is a row with a delivery
     * failure on it, and inventing the row would hide that.
     */
    fun send(mailbox: String?) {
        val body = _draft.value.trim()
        val workspace = workspaceId ?: return
        val current = _thread.value ?: return
        if (body.isEmpty() || _sending.value) return

        val to = recipients(mailbox)
        if (to.isEmpty()) {
            // Nowhere to send it. Better said now than after a round trip
            // that comes back with a validation error.
            _sendFailed.value = true
            return
        }

        _sending.value = true
        _sendFailed.value = false
        viewModelScope.launch {
            runCatching {
                // The server rewrites the subject from the thread when it is
                // given a `thread_id`, so what goes up here is only a
                // fallback for the case where it cannot find one.
                api.sendEmail(
                    workspaceId = workspace,
                    threadId = current.id,
                    to = to,
                    subject = current.subject.orEmpty(),
                    body = body,
                )
            }
                .onSuccess {
                    _draft.value = ""
                    load()
                }
                .onFailure { _sendFailed.value = true }
            _sending.value = false
        }
    }
}
