package com.webyar.ai.feature.support

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.webyar.ai.core.model.SupportMessage
import com.webyar.ai.core.model.SupportStatus
import com.webyar.ai.core.model.SupportThread
import com.webyar.ai.core.net.ApiError
import com.webyar.ai.core.net.WebyarApi
import com.webyar.ai.core.sync.SupportSignal
import com.webyar.ai.i18n.Language
import com.webyar.ai.i18n.StrAndroid
import com.webyar.ai.i18n.displayText
import kotlinx.coroutines.Job
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.time.Instant
import java.util.UUID

/**
 * What an error from `/api/platform-support` means to the operator: its own
 * codes first (docs/PLATFORM_SUPPORT.md), then the app's usual wording.
 */
internal fun supportErrorText(error: Throwable, language: Language): String {
    val code = (error as? ApiError.Server)?.serverMessage.orEmpty()
    return when {
        "rate_limited" in code -> StrAndroid.supportRateLimited(language)
        "thread_closed" in code -> StrAndroid.supportClosed(language)
        "support_disabled" in code || "support_not_configured" in code || "support_member" in code ->
            StrAndroid.supportUnavailable(language)
        else -> error.displayText(language)
    }
}

/**
 * Settings' view of support: whether to offer it, whether the team is online
 * now, and the operator's earlier requests with what is new in them.
 */
class SupportHomeViewModel(
    private val api: WebyarApi,
    private val language: () -> Language,
) : ViewModel() {

    private val _status = MutableStateFlow<SupportStatus?>(null)

    /** Null until the first answer; then kept while a later read fails. */
    val status: StateFlow<SupportStatus?> = _status.asStateFlow()

    private val _threads = MutableStateFlow<List<SupportThread>>(emptyList())
    val threads: StateFlow<List<SupportThread>> = _threads.asStateFlow()

    private val _loaded = MutableStateFlow(false)

    /** The threads have been read at least once. */
    val loaded: StateFlow<Boolean> = _loaded.asStateFlow()

    private var job: Job? = null

    fun refresh() {
        job?.cancel()
        job = viewModelScope.launch {
            runCatching { api.supportStatus() }.onSuccess { _status.value = it }
            // Earlier requests stay readable even while support is off.
            runCatching { api.supportThreads() }.onSuccess {
                _threads.value = it
                _loaded.value = true
            }
        }
    }

    /**
     * Reads again on the team's news and, while on screen, every minute —
     * "online" is a clock as much as an event.
     */
    suspend fun follow(signals: Flow<SupportSignal>?) {
        coroutineScope {
            if (signals != null) launch { signals.collect { refresh() } }
            while (true) {
                refresh()
                delay(STATUS_POLL_MS)
            }
        }
    }

    private companion object {
        const val STATUS_POLL_MS = 60_000L
    }
}

/** A message the operator sent that the server has not confirmed yet. */
data class PendingSupportMessage(
    val clientMessageId: String,
    val body: String,
    val createdAt: Instant,
    val failed: Boolean = false,
)

sealed interface SupportThreadState {
    data object Loading : SupportThreadState
    data class Failed(val message: String) : SupportThreadState

    /** [thread] is null for a chat that has not been started yet. */
    data class Loaded(
        val thread: SupportThread?,
        val messages: List<SupportMessage>,
        val pending: List<PendingSupportMessage> = emptyList(),
    ) : SupportThreadState {
        val closed: Boolean get() = thread?.isClosed == true
    }
}

/**
 * One support thread — or the chat about to start — as the operator reads
 * and writes it.
 *
 * A message shows at once as "sending" and becomes the server's when it
 * lands; one that fails stays, marked, with a retry. The client id travels
 * with every attempt, so a retry never posts twice.
 */
class SupportThreadViewModel(
    private val api: WebyarApi,
    private val language: () -> Language,
) : ViewModel() {

    private val _state = MutableStateFlow<SupportThreadState>(SupportThreadState.Loading)
    val state: StateFlow<SupportThreadState> = _state.asStateFlow()

    private val _threadId = MutableStateFlow<String?>(null)

    /** The thread on screen; set once a new chat's first message lands. */
    val threadId: StateFlow<String?> = _threadId.asStateFlow()

    private val _draft = MutableStateFlow("")
    val draft: StateFlow<String> = _draft.asStateFlow()

    private val _notice = MutableStateFlow<String?>(null)
    val notice: StateFlow<String?> = _notice.asStateFlow()

    private var opened = false
    private var workspaceId: String? = null
    private var loadJob: Job? = null

    /** [threadId] null: a new chat, which the first message opens. */
    fun open(threadId: String?, workspaceId: String?) {
        this.workspaceId = workspaceId
        if (opened) return
        opened = true
        _threadId.value = threadId
        if (threadId == null) {
            _state.value = SupportThreadState.Loaded(thread = null, messages = emptyList())
        } else {
            load()
        }
    }

    fun setDraft(value: String) {
        _draft.value = value
    }

    fun clearNotice() {
        _notice.value = null
    }

    fun load() {
        val id = _threadId.value ?: return
        loadJob?.cancel()
        loadJob = viewModelScope.launch {
            runCatching { api.supportThread(id) }
                .onSuccess { detail ->
                    _state.update { current ->
                        val pending = (current as? SupportThreadState.Loaded)?.pending.orEmpty()
                        val delivered = detail.messages.mapNotNull { it.clientMessageId }.toSet()
                        SupportThreadState.Loaded(
                            thread = detail.thread,
                            messages = detail.messages,
                            pending = pending.filterNot { it.clientMessageId in delivered },
                        )
                    }
                    if (detail.thread.unread > 0) markRead(id)
                }
                .onFailure { error ->
                    // A read that fails over a thread on screen keeps it; only
                    // a thread that never arrived shows the failure.
                    if (_state.value !is SupportThreadState.Loaded) {
                        _state.value = SupportThreadState.Failed(supportErrorText(error, language()))
                    }
                }
        }
    }

    private fun markRead(id: String) {
        viewModelScope.launch { runCatching { api.markSupportThreadRead(id) } }
    }

    fun send() {
        val body = _draft.value.trim()
        if (body.isEmpty()) return
        val current = _state.value as? SupportThreadState.Loaded ?: return
        if (current.closed) return
        val pending = PendingSupportMessage(UUID.randomUUID().toString(), body, Instant.now())
        _draft.value = ""
        _state.value = current.copy(pending = current.pending + pending)
        deliver(pending)
    }

    /** Tries a message that did not go through again, with the same id. */
    fun retry(clientMessageId: String) {
        val current = _state.value as? SupportThreadState.Loaded ?: return
        val pending = current.pending.firstOrNull { it.clientMessageId == clientMessageId } ?: return
        val again = pending.copy(failed = false)
        _state.value = current.copy(pending = current.pending.map { if (it.clientMessageId == clientMessageId) again else it })
        deliver(again)
    }

    private fun deliver(pending: PendingSupportMessage) {
        viewModelScope.launch {
            val id = _threadId.value
            runCatching {
                if (id == null) {
                    api.sendSupportChat(pending.body, pending.clientMessageId, workspaceId)
                } else {
                    api.replySupportThread(id, pending.body, pending.clientMessageId)
                }
            }.onSuccess { result ->
                _threadId.value = result.thread.id
                _state.update { state ->
                    val loaded = state as? SupportThreadState.Loaded ?: return@update state
                    val messages = if (loaded.messages.any { it.id == result.message.id }) {
                        loaded.messages
                    } else {
                        loaded.messages + result.message
                    }
                    loaded.copy(
                        thread = result.thread,
                        messages = messages,
                        pending = loaded.pending.filterNot { it.clientMessageId == pending.clientMessageId },
                    )
                }
                // The team may have answered already (an auto-reply, a fast
                // agent): read the thread as the server has it.
                load()
            }.onFailure { error ->
                _state.update { state ->
                    val loaded = state as? SupportThreadState.Loaded ?: return@update state
                    loaded.copy(
                        pending = loaded.pending.map {
                            if (it.clientMessageId == pending.clientMessageId) it.copy(failed = true) else it
                        },
                    )
                }
                _notice.value = supportErrorText(error, language())
            }
        }
    }

    /**
     * While on screen: the team's replies arrive as signals, and — in case
     * the channel is down — the thread is read every little while too.
     */
    suspend fun follow(signals: Flow<SupportSignal>?) {
        coroutineScope {
            if (signals != null) {
                launch {
                    signals.collect { signal ->
                        val id = _threadId.value ?: return@collect
                        if (signal.about(id)) load()
                    }
                }
            }
            while (true) {
                delay(THREAD_POLL_MS)
                load()
            }
        }
    }

    private companion object {
        const val THREAD_POLL_MS = 15_000L
    }
}

/** A new ticket: a subject and a message, for when nobody is online. */
class SupportTicketViewModel(
    private val api: WebyarApi,
    private val language: () -> Language,
) : ViewModel() {

    private val _subject = MutableStateFlow("")
    val subject: StateFlow<String> = _subject.asStateFlow()

    private val _body = MutableStateFlow("")
    val body: StateFlow<String> = _body.asStateFlow()

    private val _submitting = MutableStateFlow(false)
    val submitting: StateFlow<Boolean> = _submitting.asStateFlow()

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    private val _created = MutableStateFlow<SupportThread?>(null)

    /** The ticket, once filed. */
    val created: StateFlow<SupportThread?> = _created.asStateFlow()

    /** One id for every attempt: a retried submit is the same ticket. */
    private val clientMessageId = UUID.randomUUID().toString()

    val canSubmit: Boolean
        get() = _subject.value.isNotBlank() && _body.value.isNotBlank() && !_submitting.value

    fun setSubject(value: String) {
        _subject.value = value.take(MAX_SUBJECT)
        _error.value = null
    }

    fun setBody(value: String) {
        _body.value = value.take(MAX_BODY)
        _error.value = null
    }

    fun submit(workspaceId: String?) {
        if (!canSubmit || _created.value != null) return
        _submitting.value = true
        _error.value = null
        viewModelScope.launch {
            runCatching {
                api.createSupportTicket(_subject.value.trim(), _body.value.trim(), clientMessageId, workspaceId)
            }.onSuccess { result ->
                _created.value = result.thread
            }.onFailure { error ->
                _error.value = supportErrorText(error, language())
            }
            _submitting.value = false
        }
    }

    private companion object {
        const val MAX_SUBJECT = 200
        const val MAX_BODY = 4000
    }
}
