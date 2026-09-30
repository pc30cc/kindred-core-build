package com.webyar.ai.feature.support

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.webyar.ai.core.media.AttachmentRules
import com.webyar.ai.core.model.SupportConversation
import com.webyar.ai.core.model.SupportHistory
import com.webyar.ai.core.model.SupportItem
import com.webyar.ai.core.model.SupportPostResult
import com.webyar.ai.core.model.SupportStatus
import com.webyar.ai.core.net.ApiError
import com.webyar.ai.core.net.WebyarApi
import com.webyar.ai.core.runCatchingUnlessCancelled
import com.webyar.ai.core.sync.SupportSignal
import com.webyar.ai.i18n.Language
import com.webyar.ai.i18n.Str
import com.webyar.ai.i18n.StrAndroid
import com.webyar.ai.i18n.displayText
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.time.Instant
import java.util.UUID

/**
 * What an error from `/api/platform-support` means to the operator: its own
 * codes first (docs/PLATFORM_SUPPORT.md), then the app's usual wording.
 */
internal fun supportErrorText(error: Throwable, language: Language): String {
    val code = (error as? ApiError.Server)?.serverMessage.orEmpty()
    return when {
        "conversation_ended" in code -> StrAndroid.supportConversationEnded(language)
        "rate_limited" in code -> StrAndroid.supportRateLimited(language)
        "file_too_large" in code -> StrAndroid.supportFileTooLarge(language)
        "file_type_not_allowed" in code -> Str.fileTypeNotAllowed(language)
        "support_disabled" in code || "support_not_configured" in code -> StrAndroid.supportUnavailable(language)
        else -> error.displayText(language)
    }
}

/**
 * Settings' view of support: whether to offer it, whether the team is online
 * now, and how much of what it wrote is unread.
 */
class SupportStatusViewModel(private val api: WebyarApi) : ViewModel() {

    private val _status = MutableStateFlow<SupportStatus?>(null)

    /** Null until the first answer; then kept while a later read fails. */
    val status: StateFlow<SupportStatus?> = _status.asStateFlow()

    private var job: Job? = null

    fun refresh() {
        job?.cancel()
        job = viewModelScope.launch {
            runCatchingUnlessCancelled { api.supportStatus() }.onSuccess { _status.value = it }
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

/** What the support chat is showing, and so what its bottom is. */
enum class SupportComposer {
    /**
     * No conversation is open: a page as fresh as the very first — the
     * greeting, and the composer, whose first message opens a conversation.
     */
    Fresh,

    /** A conversation is open: its messages, and the composer writes to it. */
    Active,

    /**
     * The conversation on screen ended while it was open here: its end and
     * its rating, no composer, and a button that starts a new one.
     */
    Ended,
}

sealed interface SupportChatState {
    data object Loading : SupportChatState
    data class Failed(val message: String) : SupportChatState

    /** The history as the server last told it, and what is still on its way. */
    data class Loaded(
        val conversations: List<SupportConversation> = emptyList(),
        val items: List<SupportItem> = emptyList(),
        val activeConversationId: String? = null,
        val pending: List<PendingSupportItem> = emptyList(),
        /**
         * The conversation on screen when none is open: one that ended while
         * it was open here, so its end and its rating are seen. Null for a
         * fresh start — on arrival with nothing open, or after "Start a new
         * conversation".
         */
        val endedHereId: String? = null,
    ) : SupportChatState {
        /** The conversation the chat shows: the open one, or the one that just ended here. */
        val shown: SupportConversation?
            get() = conversations.firstOrNull { it.id == (activeConversationId ?: endedHereId) }

        /**
         * An open conversation is written to; an ended one is not — ever. With
         * nothing open the page starts afresh, and earlier conversations are
         * in [closed], not in the chat.
         */
        val composer: SupportComposer
            get() = when {
                activeConversationId != null -> SupportComposer.Active
                shown?.ended == true -> SupportComposer.Ended
                else -> SupportComposer.Fresh
            }

        /** The shown conversation's messages and joins; none on a fresh page. */
        val shownItems: List<SupportItem>
            get() = shown?.let { conversation -> items.filter { it.conversationId == conversation.id } }.orEmpty()

        /** Every conversation that has ended, the newest first: the "closed conversations" list. */
        val closed: List<SupportConversation> get() = closedConversations(conversations)

        val isEmpty: Boolean get() = shownItems.isEmpty() && pending.isEmpty()
    }
}

/** The conversations that have ended, the one that ended last first. */
internal fun closedConversations(conversations: List<SupportConversation>): List<SupportConversation> =
    conversations.filter { it.ended }.sortedByDescending { it.endedAt ?: it.createdAt }

/**
 * A line to know a closed conversation by: what the operator wrote first —
 * its text, or the name of the file they sent — else the team's first word.
 */
internal fun conversationPreview(conversationId: String, items: List<SupportItem>): String? {
    val own = items.filter { it.conversationId == conversationId && !it.isJoin }
    val first = own.firstOrNull { !it.fromTeam } ?: own.firstOrNull()
    return first?.body?.trim()?.takeIf { it.isNotEmpty() }?.lineSequence()?.first()
        ?: first?.attachments?.firstOrNull()?.fileName
}

/**
 * Rates a conversation once. A second tap while the first is on its way, or
 * after it landed, does nothing; a conversation the server says is rated
 * already, or cannot be, is simply read again ([onStale]). The chat and the
 * closed conversations both rate through one.
 */
internal class SupportRater(
    private val api: WebyarApi,
    private val scope: CoroutineScope,
    private val language: () -> Language,
    private val onRated: (SupportConversation) -> Unit,
    private val onStale: () -> Unit,
    private val onError: (String) -> Unit,
) {
    private val _busy = MutableStateFlow<Set<String>>(emptySet())

    /** Conversations whose rating is on its way; their button waits. */
    val busy: StateFlow<Set<String>> = _busy.asStateFlow()

    fun rate(conversation: SupportConversation?, score: Int, comment: String?) {
        if (conversation == null || score !in 1..5 || conversation.id in _busy.value || !conversation.canRate) return
        val id = conversation.id
        _busy.update { it + id }
        scope.launch {
            runCatchingUnlessCancelled {
                api.rateSupportConversation(id, score, comment?.trim()?.take(SupportChatViewModel.MAX_COMMENT)?.ifBlank { null })
            }.onSuccess(onRated).onFailure { error ->
                val code = (error as? ApiError.Server)?.serverMessage.orEmpty()
                if ("already_rated" in code || "not_ratable" in code) onStale() else onError(supportErrorText(error, language()))
            }
            _busy.update { it - id }
        }
    }
}

/**
 * The support chat: the conversation that is open, or — with none open — a
 * fresh page like the very first, and the composer that writes to it. The
 * conversations that ended are in [SupportChatState.Loaded.closed], read in
 * their own screen ([SupportArchiveViewModel]).
 *
 * A message or a file shows at once as "sending" and becomes the server's
 * when it lands; one that fails stays, marked, with a retry. The client id
 * travels with every attempt — and a file's bytes stay with it — so a retry
 * never posts twice. Messages go one at a time, in the order they were
 * written.
 *
 * Each names the conversation it was written to: the open one, or none for
 * the first message of a new one. Once a conversation has ended nothing more
 * is written to it: the composer gives way to the end and a button that
 * starts a new conversation, and a message the team's close overtook is
 * refused by the server (`conversation_ended`) and handed back to the
 * composer, never moved to another conversation.
 */
class SupportChatViewModel(
    private val api: WebyarApi,
    private val language: () -> Language,
) : ViewModel() {

    private val _state = MutableStateFlow<SupportChatState>(SupportChatState.Loading)
    val state: StateFlow<SupportChatState> = _state.asStateFlow()

    private val _status = MutableStateFlow<SupportStatus?>(null)

    /** Who answers and whether they are there: the bar, the offline banner, the hours. */
    val status: StateFlow<SupportStatus?> = _status.asStateFlow()

    private val _draft = MutableStateFlow("")
    val draft: StateFlow<String> = _draft.asStateFlow()

    private val _notice = MutableStateFlow<String?>(null)
    val notice: StateFlow<String?> = _notice.asStateFlow()

    private val rater = SupportRater(
        api = api,
        scope = viewModelScope,
        language = language,
        onRated = { updated ->
            _state.update { state ->
                val loaded = state as? SupportChatState.Loaded ?: return@update state
                loaded.copy(conversations = loaded.conversations.map { if (it.id == updated.id) updated else it })
            }
        },
        onStale = ::loadHistory,
        onError = { _notice.value = it },
    )

    /** Conversations whose rating is on its way; their button waits. */
    val rating: StateFlow<Set<String>> = rater.busy

    private var opened = false
    private var workspaceId: String? = null

    /** One message on the wire at a time: they arrive in the order they were written. */
    private val sending = Mutex()
    private var historyJob: Job? = null
    private var statusJob: Job? = null

    /** On screen and resumed: what the team writes is being read. */
    private var visible = false

    /** The team's messages as of the last read, to tell what is new since. */
    private var knownTeamItems: Set<String>? = null
    private var teamNewsUnread = false

    fun open(workspaceId: String?) {
        this.workspaceId = workspaceId
        if (opened) return
        opened = true
        refresh()
    }

    fun setDraft(value: String) {
        _draft.value = value
    }

    fun clearNotice() {
        _notice.value = null
    }

    /** Something the screen could not do — a file that would not open. */
    fun report(message: String) {
        _notice.value = message
    }

    fun refresh() {
        loadStatus()
        loadHistory()
    }

    fun loadHistory() {
        historyJob?.cancel()
        historyJob = viewModelScope.launch {
            runCatchingUnlessCancelled { api.supportHistory() }
                .onSuccess(::applyHistory)
                .onFailure { error ->
                    // A read that fails over a chat on screen keeps it; only a
                    // chat that never arrived shows the failure.
                    if (_state.value !is SupportChatState.Loaded) {
                        _state.value = SupportChatState.Failed(supportErrorText(error, language()))
                    }
                }
        }
    }

    private fun loadStatus() {
        statusJob?.cancel()
        statusJob = viewModelScope.launch {
            runCatchingUnlessCancelled { api.supportStatus() }.onSuccess {
                _status.value = it
                markReadIfDue()
            }
        }
    }

    private fun applyHistory(history: SupportHistory) {
        val delivered = history.items.mapNotNullTo(HashSet()) { it.clientMessageId }
        _state.update { current ->
            val loaded = current as? SupportChatState.Loaded
            SupportChatState.Loaded(
                conversations = history.conversations,
                items = history.items,
                activeConversationId = history.activeConversationId,
                pending = loaded?.pending.orEmpty().filterNot { it.clientMessageId in delivered },
                // Arriving, an open conversation is shown, else a fresh page.
                // Already here, the conversation on screen stays when it
                // ends, until the operator starts a new one.
                endedHereId = if (history.activeConversationId != null || loaded == null) {
                    null
                } else {
                    (loaded.activeConversationId ?: loaded.endedHereId)
                        ?.takeIf { id -> history.conversations.any { it.id == id } }
                },
            )
        }
        val team = history.items.filter { it.fromTeam && !it.isJoin }.mapTo(HashSet()) { it.id }
        val known = knownTeamItems
        if (known != null && !known.containsAll(team)) teamNewsUnread = true
        knownTeamItems = team
        markReadIfDue()
    }

    /**
     * Tells the server the chat has been read — while it is on screen, and
     * only when there is something to read: an unread count, or a reply
     * that arrived since the last look.
     */
    private fun markReadIfDue() {
        if (!visible) return
        val unread = (_status.value?.unread ?: 0) > 0
        if (!unread && !teamNewsUnread) return
        teamNewsUnread = false
        _status.update { it?.copy(unread = 0) }
        viewModelScope.launch { runCatchingUnlessCancelled { api.markSupportRead() } }
    }

    /**
     * After the conversation on screen ended: a fresh page, as at the very
     * first, whose first message opens a new conversation.
     */
    fun startNewConversation() {
        _state.update { state ->
            val loaded = state as? SupportChatState.Loaded ?: return@update state
            if (loaded.composer == SupportComposer.Ended) loaded.copy(endedHereId = null) else loaded
        }
    }

    fun send() {
        val body = _draft.value.trim()
        if (body.isEmpty()) return
        if (body.length > MAX_BODY) {
            _notice.value = StrAndroid.messageTooLong(language(), MAX_BODY)
            return
        }
        if (!enqueue { target -> PendingSupportItem(newClientMessageId(), body, Instant.now(), conversationId = target) }) return
        _draft.value = ""
    }

    /**
     * A picked file. Refused here, before a byte is sent, when the server
     * would refuse it: over [MAX_FILE_BYTES], or not one of the six types.
     */
    fun sendFile(bytes: ByteArray, fileName: String, mimeType: String) {
        val mime = AttachmentRules.canonicalMime(mimeType)
        if (mime == null || mime !in AttachmentRules.PICKABLE_MIME_TYPES) {
            _notice.value = Str.fileTypeNotAllowed(language())
            return
        }
        if (bytes.size > MAX_FILE_BYTES) {
            _notice.value = StrAndroid.supportFileTooLarge(language())
            return
        }
        enqueue { target ->
            PendingSupportItem(newClientMessageId(), "", Instant.now(), SupportUpload(bytes, fileName, mime), conversationId = target)
        }
    }

    /** Tries a message or file that did not go through again, with the same id. */
    fun retry(clientMessageId: String) {
        val current = _state.value as? SupportChatState.Loaded ?: return
        val entry = current.pending.firstOrNull { it.clientMessageId == clientMessageId && it.failed } ?: return
        val again = entry.copy(failed = false)
        _state.value = current.copy(pending = current.pending.map { if (it.clientMessageId == clientMessageId) again else it })
        deliver(again)
    }

    /**
     * Adds what [make] writes — to the open conversation, or, on a fresh
     * page, to a new one — and sends it. Nothing is written to a
     * conversation that ended on screen; the operator starts a new one.
     */
    private fun enqueue(make: (target: String?) -> PendingSupportItem): Boolean {
        val current = _state.value as? SupportChatState.Loaded ?: return false
        if (current.composer == SupportComposer.Ended) return false
        val entry = make(current.activeConversationId)
        _state.value = current.copy(pending = current.pending + entry)
        deliver(entry)
        return true
    }

    private fun deliver(entry: PendingSupportItem) {
        viewModelScope.launch {
            runCatchingUnlessCancelled {
                sending.withLock {
                    val file = entry.file
                    if (file == null) {
                        api.sendSupportMessage(entry.body, entry.clientMessageId, entry.conversationId, workspaceId)
                    } else {
                        api.sendSupportAttachment(
                            file.fileName,
                            file.mimeType,
                            file.bytes,
                            entry.clientMessageId,
                            entry.conversationId,
                            workspaceId,
                        )
                    }
                }
            }.onSuccess { result ->
                _state.update { merge(it, result, entry.clientMessageId) }
                // The team may have answered already, or joined: read the
                // chat as the server has it.
                loadHistory()
            }.onFailure { error ->
                if (isConversationEnded(error)) {
                    handBack(entry)
                    return@onFailure
                }
                _state.update { state ->
                    val loaded = state as? SupportChatState.Loaded ?: return@update state
                    loaded.copy(
                        pending = loaded.pending.map {
                            if (it.clientMessageId == entry.clientMessageId) it.copy(failed = true) else it
                        },
                    )
                }
                _notice.value = supportErrorText(error, language())
            }
        }
    }

    /**
     * The team ended the conversation while [entry] was on its way to it: it
     * leaves the transcript, its words go back to the composer for a new
     * conversation, and the chat is read again to show the end.
     */
    private fun handBack(entry: PendingSupportItem) {
        _state.update { state ->
            val loaded = state as? SupportChatState.Loaded ?: return@update state
            val ended = loaded.activeConversationId?.takeIf { it == entry.conversationId }
            loaded.copy(
                pending = loaded.pending.filterNot { it.clientMessageId == entry.clientMessageId },
                activeConversationId = loaded.activeConversationId?.takeIf { it != entry.conversationId },
                endedHereId = ended ?: loaded.endedHereId,
            )
        }
        if (entry.file == null) {
            _draft.update { current -> if (current.isBlank()) entry.body else "$current\n${entry.body}" }
        }
        _notice.value = StrAndroid.supportConversationEnded(language())
        loadHistory()
    }

    private fun isConversationEnded(error: Throwable): Boolean =
        "conversation_ended" in (error as? ApiError.Server)?.serverMessage.orEmpty()

    private fun merge(state: SupportChatState, result: SupportPostResult, clientMessageId: String): SupportChatState {
        val loaded = state as? SupportChatState.Loaded ?: return state
        val conversation = result.conversation
        val conversations = if (loaded.conversations.any { it.id == conversation.id }) {
            loaded.conversations.map { if (it.id == conversation.id) conversation else it }
        } else {
            loaded.conversations + conversation
        }
        val items = if (loaded.items.any { it.id == result.item.id }) loaded.items else loaded.items + result.item
        return loaded.copy(
            conversations = conversations,
            items = items,
            activeConversationId = if (conversation.ended) loaded.activeConversationId else conversation.id,
            pending = loaded.pending.filterNot { it.clientMessageId == clientMessageId },
        )
    }

    /** Rates the conversation that ended on screen — once; see [SupportRater]. */
    fun rate(conversationId: String, score: Int, comment: String?) {
        val loaded = _state.value as? SupportChatState.Loaded ?: return
        rater.rate(loaded.conversations.firstOrNull { it.id == conversationId }, score, comment)
    }

    /**
     * While on screen: the chat is being read, the team's news arrives as
     * signals, and — in case the channel is down — the history is read every
     * little while too, the status every minute.
     */
    suspend fun follow(signals: Flow<SupportSignal>?) {
        visible = true
        try {
            // Back from the background: what happened meanwhile. The first
            // time, [open]'s own read is still on its way.
            if (_state.value is SupportChatState.Loading) markReadIfDue() else refresh()
            coroutineScope {
                if (signals != null) {
                    launch { signals.collect { if (it.kind in LIVE_KINDS) loadHistory() } }
                }
                var ticks = 0
                while (true) {
                    delay(HISTORY_POLL_MS)
                    ticks++
                    if (ticks % STATUS_EVERY_TICKS == 0) loadStatus()
                    loadHistory()
                }
            }
        } finally {
            visible = false
        }
    }

    /** A support file's bytes, or null when they cannot be had; either side's. */
    suspend fun attachment(id: String): ByteArray? =
        runCatchingUnlessCancelled { api.supportAttachmentData(id) }.getOrNull()

    private fun newClientMessageId(): String = UUID.randomUUID().toString()

    companion object {
        /** The server's limit on a message body. */
        const val MAX_BODY = 4000

        /** The server's limit on a rating comment. */
        const val MAX_COMMENT = 1000

        /** The server's limit on a support file, decoded. */
        const val MAX_FILE_BYTES = 2 * 1024 * 1024

        private const val HISTORY_POLL_MS = 15_000L
        private const val STATUS_EVERY_TICKS = 4

        /** The events that mean the history moved (docs/PLATFORM_SUPPORT.md, Realtime). */
        private val LIVE_KINDS = setOf("support_message", "support_update", "support_read")
    }
}

sealed interface SupportArchiveState {
    data object Loading : SupportArchiveState
    data class Failed(val message: String) : SupportArchiveState

    /** The history as the server last told it; only its ended conversations are shown. */
    data class Loaded(
        val conversations: List<SupportConversation> = emptyList(),
        val items: List<SupportItem> = emptyList(),
    ) : SupportArchiveState {
        val closed: List<SupportConversation> get() = closedConversations(conversations)

        fun conversation(id: String): SupportConversation? = conversations.firstOrNull { it.id == id }

        fun itemsOf(id: String): List<SupportItem> = items.filter { it.conversationId == id }

        fun preview(id: String): String? = conversationPreview(id, items)
    }
}

/**
 * The conversations that ended: the list, the newest first, and one of them
 * read back with its end and its rating. Nothing here is written to — a new
 * question is a new conversation, in the chat.
 */
class SupportArchiveViewModel(
    private val api: WebyarApi,
    private val language: () -> Language,
) : ViewModel() {

    private val _state = MutableStateFlow<SupportArchiveState>(SupportArchiveState.Loading)
    val state: StateFlow<SupportArchiveState> = _state.asStateFlow()

    private val _notice = MutableStateFlow<String?>(null)
    val notice: StateFlow<String?> = _notice.asStateFlow()

    private val rater = SupportRater(
        api = api,
        scope = viewModelScope,
        language = language,
        onRated = { updated ->
            _state.update { state ->
                val loaded = state as? SupportArchiveState.Loaded ?: return@update state
                loaded.copy(conversations = loaded.conversations.map { if (it.id == updated.id) updated else it })
            }
        },
        onStale = ::load,
        onError = { _notice.value = it },
    )

    /** Conversations whose rating is on its way. */
    val rating: StateFlow<Set<String>> = rater.busy

    private var opened = false
    private var job: Job? = null

    fun open() {
        if (opened) return
        opened = true
        load()
    }

    fun load() {
        job?.cancel()
        job = viewModelScope.launch {
            runCatchingUnlessCancelled { api.supportHistory() }
                .onSuccess { _state.value = SupportArchiveState.Loaded(it.conversations, it.items) }
                .onFailure { error ->
                    if (_state.value !is SupportArchiveState.Loaded) {
                        _state.value = SupportArchiveState.Failed(supportErrorText(error, language()))
                    }
                }
        }
    }

    /** Read again on the team's news: a conversation reopened, or a reply to an old one. */
    suspend fun follow(signals: Flow<SupportSignal>?) {
        signals?.collect { if (it.kind in LIVE_KINDS) load() }
    }

    fun rate(conversationId: String, score: Int, comment: String?) {
        val loaded = _state.value as? SupportArchiveState.Loaded ?: return
        rater.rate(loaded.conversation(conversationId), score, comment)
    }

    fun clearNotice() {
        _notice.value = null
    }

    /** A support file's bytes, or null when they cannot be had. */
    suspend fun attachment(id: String): ByteArray? =
        runCatchingUnlessCancelled { api.supportAttachmentData(id) }.getOrNull()

    private companion object {
        val LIVE_KINDS = setOf("support_message", "support_update")
    }
}
