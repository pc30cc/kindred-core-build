package com.webyar.operator.feature.chat

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.webyar.operator.core.cache.CacheScope
import com.webyar.operator.core.media.AttachmentRules
import com.webyar.operator.core.model.CannedResponse
import com.webyar.operator.core.model.CannedText
import com.webyar.operator.core.model.Conversation
import com.webyar.operator.core.model.ConversationNote
import com.webyar.operator.core.model.ConversationPriority
import com.webyar.operator.core.model.ConversationStatus
import com.webyar.operator.core.model.Message
import com.webyar.operator.core.model.MessageAttachment
import com.webyar.operator.core.model.SayNowVoice
import com.webyar.operator.core.model.WorkspaceMember
import com.webyar.operator.core.net.ApiError
import com.webyar.operator.core.net.Assignee
import com.webyar.operator.core.net.WebyarApi
import com.webyar.operator.core.runCatchingUnlessCancelled
import com.webyar.operator.core.sync.SendOutcome
import com.webyar.operator.core.sync.SyncGraph
import com.webyar.operator.core.sync.ThreadSync
import com.webyar.operator.core.sync.isOffline
import com.webyar.operator.i18n.Language
import com.webyar.operator.i18n.Str
import com.webyar.operator.i18n.StrAndroid
import com.webyar.operator.i18n.displayText
import com.webyar.operator.ui.components.AttachmentCache
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * One open conversation: its transcript, its draft, and everything the header
 * menu can do to it.
 *
 * Split from the inbox's own view model rather than sharing one, because the
 * two have different lifetimes: the list outlives any conversation opened from
 * it, and a single model holding both would keep a transcript alive for every
 * thread the operator had ever glanced at.
 *
 * **Local-first**, like the inbox: the transcript on screen is the cache's
 * (Room) and is there before any request — on a cold start, offline, or
 * after a notification tap. Opening asks the server only for what changed
 * since the last read (a delta), and nothing this model does ever re-reads a
 * whole thread to show one new message. The conversation in the header comes
 * from the cache too, by id, so a thread can be opened without the inbox
 * having loaded — or even listing it.
 */
class ChatViewModel(
    private val api: WebyarApi,
    /** Last-but-one so `ChatViewModel(api) { language }` still reads as it always did. */
    private val sync: SyncGraph = SyncGraph.inMemory(api),
    private val language: () -> Language,
) : ViewModel() {

    private val _chat = MutableStateFlow<ChatState>(ChatState.Loading)
    val chat: StateFlow<ChatState> = _chat.asStateFlow()

    /** The thread's own row, from the cache — the header and the menu read it. */
    private val _conversation = MutableStateFlow<Conversation?>(null)
    val conversation: StateFlow<Conversation?> = _conversation.asStateFlow()

    private val _draft = MutableStateFlow("")
    val draft: StateFlow<String> = _draft.asStateFlow()

    private val _sending = MutableStateFlow(false)
    val sending: StateFlow<Boolean> = _sending.asStateFlow()

    private val _shortcuts = MutableStateFlow<ShortcutsState>(ShortcutsState.Loading)
    val shortcuts: StateFlow<ShortcutsState> = _shortcuts.asStateFlow()

    private val _notes = MutableStateFlow<List<ConversationNote>>(emptyList())
    val notes: StateFlow<List<ConversationNote>> = _notes.asStateFlow()

    private val _members = MutableStateFlow<List<WorkspaceMember>>(emptyList())
    val members: StateFlow<List<WorkspaceMember>> = _members.asStateFlow()

    /** Whose voice the AI writes in. Remembered for the session, because an
     *  operator who picked one is almost always about to pick it again. */
    private val _sayNowVoice = MutableStateFlow(SayNowVoice.SPECIALIST)
    val sayNowVoice: StateFlow<SayNowVoice> = _sayNowVoice.asStateFlow()

    /** The last thing worth telling the operator, shown once and dismissed. */
    private val _notice = MutableStateFlow<String?>(null)
    val notice: StateFlow<String?> = _notice.asStateFlow()

    private var conversationId: String? = null
    private var workspaceId: String? = null
    private var scope: CacheScope? = null

    /** The transcript as the cache last said. Null until it has said anything. */
    private var rows: List<Message>? = null
    private var everRead = false
    private var failure: String? = null
    /** The server says this conversation no longer exists. */
    private var gone = false
    private var jobs: List<Job> = emptyList()

    /** Saved replies used in this draft, reported once the message is sent. */
    private val usedShortcuts = mutableListOf<String>()

    // MARK: - Opening

    /** Opens a conversation the caller already holds — its row seeds the cache. */
    fun open(conversation: Conversation, workspaceId: String) = open(conversation.id, workspaceId, conversation)

    /**
     * Opens a conversation by id. The cache answers first; a conversation
     * the cache has never seen (a notification tap, a restored route) is
     * fetched by id — never by reading a whole queue to find it.
     */
    fun open(conversationId: String, workspaceId: String, known: Conversation? = null) {
        if (this.conversationId == conversationId && this.workspaceId == workspaceId && jobs.any { it.isActive }) return
        close()
        val scope = sync.scope(workspaceId) ?: return
        this.conversationId = conversationId
        this.workspaceId = workspaceId
        this.scope = scope
        rows = null
        everRead = false
        failure = null
        gone = false
        _chat.value = ChatState.Loading
        _conversation.value = known
        _draft.value = ""
        _notes.value = emptyList()
        usedShortcuts.clear()
        sync.coordinator.openThread(conversationId)

        jobs = listOf(
            viewModelScope.launch {
                if (known != null) sync.conversations.remember(scope, known)
                sync.conversations.markOpened(scope, conversationId)
                // A row that disappears (the conversation was deleted) keeps
                // its last header rather than blanking it under the operator.
                sync.conversations.observeConversation(scope, conversationId).collect { row ->
                    row?.let { _conversation.value = it }
                }
            },
            viewModelScope.launch {
                if (known == null && sync.conversations.cached(scope, conversationId) == null) {
                    runCatchingUnlessCancelled { sync.conversations.conversation(scope, conversationId) }
                }
            },
            viewModelScope.launch {
                everRead = sync.messages.isCached(scope, conversationId)
                sync.messages.observeThread(scope, conversationId).collect {
                    rows = it
                    publish()
                }
            },
            viewModelScope.launch { refresh("open") },
        )
        loadNotes()
    }

    private fun close() {
        jobs.forEach { it.cancel() }
        jobs = emptyList()
        conversationId?.let { sync.coordinator.closeThread(it) }
    }

    override fun onCleared() {
        close()
    }

    /**
     * Brings the transcript up to date, then marks it seen.
     *
     * A failure with messages already on screen is a notice, not a state: the
     * operator keeps reading what was saved. Only a thread with nothing saved
     * shows the failure in place of the transcript.
     */
    private suspend fun refresh(reason: String) {
        val scope = scope ?: return
        val id = conversationId ?: return
        val result = runCatchingUnlessCancelled { sync.messages.sync(scope, id, reason) }
        if (this.scope != scope || conversationId != id) return
        result
            .onSuccess { outcome ->
                everRead = true
                failure = null
                gone = outcome == ThreadSync.Gone
            }
            .onFailure { error ->
                failure = error.displayText(language())
                if (!rows.isNullOrEmpty() && error.isOffline) _notice.value = StrAndroid.showingSaved(language())
            }
        publish()
        if (!rows.isNullOrEmpty()) {
            // Advisory: failing to mark a thread seen must never stop it being
            // read.
            runCatchingUnlessCancelled { api.markSeen(id) }
                .onSuccess { sync.conversations.clearUnread(scope, id) }
        }
    }

    private fun publish() {
        val list = rows
        _chat.value = when {
            gone -> ChatState.Failed(Str.errorNotFound(language()))
            list == null -> ChatState.Loading
            list.isEmpty() && !everRead -> failure?.let(ChatState::Failed) ?: ChatState.Loading
            else -> ChatState.Loaded(list)
        }
    }

    // MARK: - Writing

    fun setDraft(value: String) {
        _draft.value = value
    }

    /**
     * Puts the message in the thread now, then sends it.
     *
     * The bubble appears before any request — written to the outbox with the
     * one `client_message_id` it will ever have — and the draft clears with it.
     * A send that fails leaves the bubble marked, with Retry on it; Retry
     * sends the same key again, so a first attempt that did land is not
     * posted twice.
     */
    fun send() {
        val scope = scope ?: return
        val id = conversationId ?: return
        val body = _draft.value.trim()
        if (body.isEmpty() || _sending.value) return

        _sending.value = true
        val shortcutsUsed = usedShortcuts.toList()
        usedShortcuts.clear()
        viewModelScope.launch {
            val localId = runCatchingUnlessCancelled {
                sync.messages.enqueue(scope, id, body, sync.sender())
            }.getOrElse {
                _notice.value = it.displayText(language())
                _sending.value = false
                return@launch
            }
            _draft.value = ""
            _sending.value = false
            deliver(scope, localId, shortcutsUsed)
        }
    }

    /** Sends a failed message again — the same message, with the same key. */
    fun retry(message: Message) {
        val scope = scope ?: return
        val localId = message.localId ?: return
        if (message.delivery != Message.Delivery.FAILED) return
        viewModelScope.launch { deliver(scope, localId, emptyList()) }
    }

    /** Takes a message that never reached the server out of the thread. */
    fun discard(message: Message) {
        val scope = scope ?: return
        val localId = message.localId ?: return
        if (message.delivery == Message.Delivery.SENT) return
        viewModelScope.launch { runCatchingUnlessCancelled { sync.messages.discard(scope, localId) } }
    }

    private suspend fun deliver(scope: CacheScope, localId: String, shortcutsUsed: List<String>) {
        when (val outcome = sync.messages.deliver(scope, localId)) {
            SendOutcome.Sent -> {
                reportShortcutUses(scope.workspaceId, shortcutsUsed)
                // The inbox row's preview moved; the thread already has the
                // message, confirmed by the send's own echo.
                conversationId?.let { sync.coordinator.onLocalChange(it, "send", thread = false) }
            }
            is SendOutcome.Failed -> _notice.value = outcome.error.displayText(language())
            SendOutcome.Missing -> Unit
        }
    }

    /**
     * Uploads, then sends the message that carries it.
     *
     * The upload happens before anything is written: until the server has
     * the file there is no attachment id to send, and a pending bubble for a
     * file that never uploaded would be a promise the outbox cannot keep
     * after a restart. Once it has, the message goes through the outbox like
     * any other — and its bytes go straight into the attachment cache, so the
     * operator's own photo is never downloaded back.
     */
    fun sendAttachment(bytes: ByteArray, fileName: String, mimeType: String) {
        val scope = scope ?: return
        val id = conversationId ?: return
        _sending.value = true
        viewModelScope.launch {
            val attachmentId = runCatchingUnlessCancelled {
                api.uploadAttachment(
                    conversationId = id,
                    workspaceId = scope.workspaceId,
                    fileName = fileName,
                    mimeType = mimeType,
                    bytes = bytes,
                )
            }.getOrElse {
                _notice.value = Str.attachmentFailed(language())
                _sending.value = false
                return@launch
            }
            AttachmentCache.put(AttachmentCache.key(scope, attachmentId), bytes)
            val attachment = MessageAttachment(
                id = attachmentId,
                fileName = fileName,
                mimeType = mimeType,
                sizeBytes = bytes.size,
                kind = AttachmentRules.kindOf(mimeType),
            )
            val localId = runCatchingUnlessCancelled {
                sync.messages.enqueue(scope, id, _draft.value.trim(), sync.sender(), attachment)
            }.getOrElse {
                _notice.value = Str.attachmentFailed(language())
                _sending.value = false
                return@launch
            }
            _draft.value = ""
            _sending.value = false
            deliver(scope, localId, emptyList())
        }
    }

    // MARK: - Saved replies

    fun loadShortcuts(query: String = "") {
        val workspace = workspaceId ?: return
        viewModelScope.launch {
            runCatching { api.cannedResponses(workspace, language().code, query) }
                .onSuccess { _shortcuts.value = ShortcutsState.Loaded(it) }
                .onFailure { error ->
                    _shortcuts.value = when {
                        // A retry can never fix a missing table, so this is
                        // told apart from an ordinary failure and offered no
                        // "try again".
                        error is ApiError && error.isFeatureMissing -> ShortcutsState.Unavailable
                        else -> ShortcutsState.Failed(error.displayText(language()))
                    }
                }
        }
    }

    /**
     * Puts a saved reply in the draft with its placeholders resolved.
     *
     * Appended rather than replacing: an operator who has already written half
     * a sentence and then reaches for a greeting wants both.
     */
    fun insertShortcut(reply: CannedResponse, context: CannedText.Context) {
        val expanded = CannedText.interpolate(reply.body, context)
        _draft.update { existing ->
            if (existing.isBlank()) expanded else existing.trimEnd() + "\n" + expanded
        }
        usedShortcuts += reply.id
    }

    /**
     * Reports which replies were actually sent, not which were opened.
     *
     * The count is what orders the picker, so counting an insertion the
     * operator then deleted would push a reply nobody uses to the top.
     */
    private fun reportShortcutUses(workspace: String, ids: List<String>) {
        if (ids.isEmpty()) return
        viewModelScope.launch {
            ids.forEach { runCatching { api.trackCannedResponseUse(it, workspace) } }
        }
    }

    // MARK: - Say now

    fun setSayNowVoice(voice: SayNowVoice) {
        _sayNowVoice.value = voice
    }

    fun sayNow() {
        val id = conversationId ?: return
        val body = _draft.value.trim()
        if (body.isEmpty() || _sending.value) return
        _sending.value = true
        viewModelScope.launch {
            runCatching { api.aiSayNow(id, body, _sayNowVoice.value) }
                .onSuccess {
                    _draft.value = ""
                    refresh("say now")
                }
                .onFailure { _notice.value = it.displayText(language()) }
            _sending.value = false
        }
    }

    // MARK: - What the header menu does

    fun takeOver() = act("take over") { api.takeOverConversation(it, requireWorkspace()) }
    fun claim() = act("claim") { api.claim(it, requireWorkspace()) }

    fun setStatus(status: ConversationStatus) =
        act("status") { api.setStatus(status, it, requireWorkspace()) }

    fun setPriority(priority: ConversationPriority) =
        act("priority") { api.updateConversation(it, requireWorkspace(), priority = priority) }

    fun assign(to: Assignee) =
        act("assign") { api.updateConversation(it, requireWorkspace(), assignedTo = to) }

    fun setTags(tags: List<String>) =
        act("tags") { api.updateConversation(it, requireWorkspace(), tags = tags) }

    fun loadMembers() {
        val workspace = workspaceId ?: return
        viewModelScope.launch {
            runCatching { api.workspaceMembers(workspace) }.onSuccess { _members.value = it }
        }
    }

    // MARK: - Notes

    fun loadNotes() {
        val id = conversationId ?: return
        val workspace = workspaceId ?: return
        viewModelScope.launch {
            runCatching { api.notes(id, workspace) }.onSuccess { if (conversationId == id) _notes.value = it }
        }
    }

    fun addNote(body: String) {
        val id = conversationId ?: return
        val workspace = workspaceId ?: return
        if (body.isBlank()) return
        viewModelScope.launch {
            runCatching { api.addNote(id, workspace, body.trim()) }
                .onSuccess { loadNotes() }
                .onFailure { _notice.value = it.displayText(language()) }
        }
    }

    fun deleteNote(note: ConversationNote) {
        val id = conversationId ?: return
        val workspace = workspaceId ?: return
        viewModelScope.launch {
            runCatching { api.deleteNote(id, workspace, note.id) }
                .onSuccess { loadNotes() }
                .onFailure { _notice.value = it.displayText(language()) }
        }
    }

    /** Puts something in front of the operator that did not come from the API. */
    fun report(message: String) {
        _notice.value = message
    }

    fun dismissNotice() {
        _notice.value = null
    }

    // MARK: -

    /**
     * Runs an action against the open conversation, then asks for what it
     * changed.
     *
     * Not a patch of the local copy: every one of these actions also inserts
     * a system message server-side, and a local edit would show the new
     * status with no line in the transcript saying who changed it. Not a
     * re-read of the thread either — the coordinator asks for the row and
     * the thread's delta, which is the system line and nothing else.
     */
    private fun act(reason: String, block: suspend (String) -> Unit) {
        val id = conversationId ?: return
        if (workspaceId == null) return
        viewModelScope.launch {
            runCatching { block(id) }
                .onSuccess { sync.coordinator.onLocalChange(id, reason) }
                .onFailure { _notice.value = it.displayText(language()) }
        }
    }

    private fun requireWorkspace(): String = workspaceId.orEmpty()
}
