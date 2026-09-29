package com.webyar.ai.feature.team

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.webyar.ai.core.model.TeamMessage
import com.webyar.ai.core.net.ApiError
import com.webyar.ai.core.net.WebyarApi
import com.webyar.ai.i18n.Language
import com.webyar.ai.i18n.StrAndroid
import com.webyar.ai.i18n.displayText
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import com.webyar.ai.core.sync.TeamSignal
import kotlinx.coroutines.flow.Flow

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

    /** Whether [pollWhileVisible] has run before: the next run is a return. */
    private var visibleBefore = false

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
            val result = runCatching { api.teamThread(workspace, peer) }
            // Opened again under another workspace while this was on its
            // way — a notification tap that switches workspace keeps the
            // same colleague's screen, and this model with it. The answer is
            // the old workspace's thread, and the new one's own load has the say.
            if (workspace != workspaceId || peer != peerId) return@launch
            result
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
            // As in [load]: an answer for the workspace this was, not the one it is.
            if (workspace != workspaceId || peer != peerId) return
            _me.value = it.me
            _state.value = TeamThreadState.Loaded(it.messages)
            // New from them, and on screen: read. Otherwise the colleagues'
            // count went on counting what the operator was looking at.
            if (it.messages.any { m -> m.senderId == peer && m.readAt == null }) {
                runCatching { api.markTeamThreadRead(workspace, peer) }
            }
        }
        // A failure here means only the refresh failed; the message went. The
        // ten-second poll will pick it up.
    }

    /**
     * Re-reads the thread every ten seconds, and whenever the server says a
     * message moved in it, for as long as somebody is looking at it.
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
    suspend fun pollWhileVisible(signals: Flow<TeamSignal>? = null) {
        // The first time on screen, [open]'s own load is the read, and one
        // more straight after it would be the same request twice. Every time
        // after that — back from the background, or back through the very
        // notification this colleague's new message raised — the thread is
        // read at once. The screen was paused, so nothing was listening to
        // [signals] while that message arrived: without this it stayed out
        // of the transcript, and unread on the server, for up to a whole
        // poll after the operator tapped through to see it.
        val returning = visibleBefore
        visibleBefore = true
        // [signals] is the operator's own realtime channel: a message in this
        // thread re-reads it at once rather than at the next tick.
        followTeam(
            signals = signals,
            pollMs = POLL_MILLIS,
            wanted = { signal -> peerId?.let(signal::involves) == true },
            immediately = returning,
        ) {
            // Not while a send is in flight: the reload that follows the send
            // is the authoritative one, and a poll landing in between puts the
            // pre-send transcript back for a moment.
            if (!_sending.value) reload()
        }
    }

    fun send() {
        val typed = _draft.value
        val body = typed.trim()
        val workspace = workspaceId ?: return
        val peer = peerId ?: return
        if (body.isEmpty() || _sending.value) return
        if (body.length > MAX_BODY_CHARS) {
            // Said now, beside the words, rather than after a round trip
            // that comes back as a bare 400.
            _notice.value = StrAndroid.messageTooLong(language(), MAX_BODY_CHARS)
            return
        }

        _sending.value = true
        _sendFailed.value = false
        viewModelScope.launch {
            runCatching { api.sendTeamMessage(workspace, peer, body, attachmentId = null) }
                .onSuccess {
                    // Cleared only if it is still what went: the composer
                    // stays live during the send, and words typed while it
                    // was on its way are the next message, not this one.
                    _draft.compareAndSet(typed, "")
                    reload()
                }
                .onFailure(::failed)
            _sending.value = false
        }
    }

    /**
     * Where a failed send is said.
     *
     * A connection that never reached the server is [sendFailed]'s one
     * sentence about the network. A server that answered and refused — the
     * file it will not take, a colleague no longer in the workspace — says
     * why in [notice], because "you are offline" over a refusal sends the
     * operator to check a connection that demonstrably works.
     */
    private fun failed(error: Throwable) {
        if (error is ApiError && error !is ApiError.Transport) {
            _notice.value = error.displayText(language())
        } else {
            _sendFailed.value = true
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
                .onFailure(::failed)
            _sending.value = false
        }
    }

    suspend fun attachment(id: String): ByteArray? =
        runCatching { api.attachmentData(id) }.getOrNull()

    companion object {
        /** What the console polls at. */
        private const val POLL_MILLIS = 10_000L

        /** The server's own limit on a message (`body` in server/routes/teamChat.ts). */
        const val MAX_BODY_CHARS = 5000
    }
}
