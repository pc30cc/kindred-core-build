package com.webyar.operator.feature.team

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.webyar.operator.core.model.TeamMessage
import com.webyar.operator.core.net.WebyarApi
import com.webyar.operator.i18n.Language
import com.webyar.operator.i18n.displayText
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

sealed interface TeamThreadState {
    data object Loading : TeamThreadState
    data class Loaded(val messages: List<TeamMessage>) : TeamThreadState
    data class Failed(val message: String) : TeamThreadState
}

/**
 * One colleague's thread.
 *
 * Polled every ten seconds, which is what the console does. A colleague
 * answering while you are looking at the screen should not need a pull to
 * appear, and there is no socket for internal messages to arrive on.
 */
class TeamThreadViewModel(
    private val api: WebyarApi,
    private val language: () -> Language,
) : ViewModel() {

    private val _state = MutableStateFlow<TeamThreadState>(TeamThreadState.Loading)
    val state: StateFlow<TeamThreadState> = _state.asStateFlow()

    /**
     * Our own id, as the server reports it.
     *
     * Which is how a message is known to be ours. Trusting the session's user
     * id instead would be one more thing that can drift out of step with what
     * the thread endpoint thinks.
     */
    private val _me = MutableStateFlow<String?>(null)
    val me: StateFlow<String?> = _me.asStateFlow()

    private val _draft = MutableStateFlow("")
    val draft: StateFlow<String> = _draft.asStateFlow()

    private val _sending = MutableStateFlow(false)
    val sending: StateFlow<Boolean> = _sending.asStateFlow()

    private val _sendFailed = MutableStateFlow(false)
    val sendFailed: StateFlow<Boolean> = _sendFailed.asStateFlow()

    /**
     * A problem with something the operator just did, in their own words.
     *
     * Separate from [sendFailed], which is one fixed sentence about the
     * network. "This file is too large" is not that sentence, and telling an
     * operator their 40 MB video failed because they are offline sends them
     * to check their connection.
     */
    private val _notice = MutableStateFlow<String?>(null)
    val notice: StateFlow<String?> = _notice.asStateFlow()

    private var workspaceId: String? = null
    private var peerId: String? = null

    fun open(workspaceId: String, peerId: String) {
        if (this.workspaceId == workspaceId && this.peerId == peerId) return
        this.workspaceId = workspaceId
        this.peerId = peerId
        _state.value = TeamThreadState.Loading
        _draft.value = ""
        load()
    }

    fun setDraft(value: String) {
        _draft.value = value
    }

    fun dismissSendError() {
        _sendFailed.value = false
    }

    fun report(message: String) {
        _notice.value = message
    }

    fun dismissNotice() {
        _notice.value = null
    }

    private fun load() {
        val workspace = workspaceId ?: return
        val peer = peerId ?: return
        viewModelScope.launch {
            runCatching { api.teamThread(workspace, peer) }
                .onSuccess {
                    _me.value = it.me
                    _state.value = TeamThreadState.Loaded(it.messages)
                    // Tell the server after the thread is on screen, not
                    // before: a read receipt for a thread that failed to load
                    // is a lie.
                    runCatching { api.markTeamThreadRead(workspace, peer) }
                }
                .onFailure { _state.value = TeamThreadState.Failed(it.displayText(language())) }
        }
    }

    fun retry() {
        _state.value = TeamThreadState.Loading
        load()
    }

    /**
     * Re-reads the thread without blanking it.
     *
     * [load] goes through Loading, which after a send would throw the
     * transcript away and put a placeholder where the operator's own message
     * had just appeared.
     */
    private suspend fun reload() {
        val workspace = workspaceId ?: return
        val peer = peerId ?: return
        runCatching { api.teamThread(workspace, peer) }.onSuccess {
            _me.value = it.me
            _state.value = TeamThreadState.Loaded(it.messages)
        }
        // A failure here means only the refresh failed; the message went. The
        // ten-second poll will pick it up.
    }

    /**
     * Re-reads the thread every ten seconds, for as long as somebody is
     * looking at it.
     *
     * A suspend function the screen runs rather than a job this model starts,
     * and the difference is not cosmetic. A view model sits in the navigation
     * back stack: one that started its own loop would go on polling a thread
     * the operator left twenty minutes ago, from a phone in a pocket. The
     * caller ties this to the screen being resumed, so it stops when the
     * screen does.
     *
     * It also makes the model testable. An endless `delay` inside
     * `viewModelScope` never lets a test scheduler go idle, which is a hang
     * rather than a failure — the worst kind to debug.
     */
    suspend fun pollWhileVisible() {
        while (currentCoroutineContext().isActive) {
            delay(POLL_MILLIS)
            // Not while a send is in flight: the reload that follows the send
            // is the authoritative one, and a poll landing in between puts the
            // pre-send transcript back for a moment.
            if (!_sending.value) reload()
        }
    }

    fun send() {
        val body = _draft.value.trim()
        val workspace = workspaceId ?: return
        val peer = peerId ?: return
        if (body.isEmpty() || _sending.value) return

        _sending.value = true
        _sendFailed.value = false
        viewModelScope.launch {
            runCatching { api.sendTeamMessage(workspace, peer, body, attachmentId = null) }
                .onSuccess {
                    _draft.value = ""
                    reload()
                }
                .onFailure { _sendFailed.value = true }
            _sending.value = false
        }
    }

    /**
     * A photo, a document or a voice note.
     *
     * Two steps, like the visitor chat: reserve a row and push the bytes, then
     * hand the id to the message. The reservation carries no conversation — an
     * internal file belongs to the workspace and to the operator who uploaded
     * it, and the server checks both before it will let a message name it.
     */
    fun sendAttachment(bytes: ByteArray, fileName: String, mimeType: String) {
        val workspace = workspaceId ?: return
        val peer = peerId ?: return
        if (_sending.value) return

        _sending.value = true
        _sendFailed.value = false
        viewModelScope.launch {
            runCatching {
                val attachmentId = api.uploadAttachment(
                    conversationId = null,
                    workspaceId = workspace,
                    fileName = fileName,
                    mimeType = mimeType,
                    bytes = bytes,
                )
                api.sendTeamMessage(workspace, peer, body = "", attachmentId = attachmentId)
            }
                .onSuccess { reload() }
                .onFailure { _sendFailed.value = true }
            _sending.value = false
        }
    }

    suspend fun attachment(id: String): ByteArray? =
        runCatching { api.attachmentData(id) }.getOrNull()

    private companion object {
        /** What the console polls at. */
        const val POLL_MILLIS = 10_000L
    }
}
