package com.webyar.operator.feature.chat

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.webyar.operator.core.net.Assignee
import com.webyar.operator.core.model.CannedResponse
import com.webyar.operator.core.model.CannedText
import com.webyar.operator.core.model.Conversation
import com.webyar.operator.core.model.ConversationNote
import com.webyar.operator.core.model.ConversationPriority
import com.webyar.operator.core.model.ConversationStatus
import com.webyar.operator.core.model.SayNowVoice
import com.webyar.operator.core.model.WorkspaceMember
import com.webyar.operator.core.net.ApiError
import com.webyar.operator.core.net.WebyarApi
import com.webyar.operator.i18n.Language
import com.webyar.operator.i18n.Str
import com.webyar.operator.i18n.displayText
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.util.UUID

/**
 * One open conversation: its transcript, its draft, and everything the header
 * menu can do to it.
 *
 * Split from the inbox's own view model rather than sharing one, because the
 * two have different lifetimes: the list outlives any conversation opened from
 * it, and a single model holding both would keep a transcript alive for every
 * thread the operator had ever glanced at.
 */
class ChatViewModel(
    private val api: WebyarApi,
    private val language: () -> Language,
) : ViewModel() {

    private val _chat = MutableStateFlow<ChatState>(ChatState.Loading)
    val chat: StateFlow<ChatState> = _chat.asStateFlow()

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

    private var current: Conversation? = null
    private var workspaceId: String? = null

    /** Saved replies used in this draft, reported once the message is sent. */
    private val usedShortcuts = mutableListOf<String>()

    // MARK: - Opening

    fun open(conversation: Conversation, workspaceId: String) {
        if (current?.id == conversation.id && _chat.value is ChatState.Loaded) return
        current = conversation
        this.workspaceId = workspaceId
        _chat.value = ChatState.Loading
        _draft.value = ""
        usedShortcuts.clear()
        reload()
        loadNotes()
    }

    private fun reload() {
        val conversation = current ?: return
        viewModelScope.launch {
            runCatching { api.messages(conversation.id) }
                .onSuccess { _chat.value = ChatState.Loaded(it) }
                .onFailure { _chat.value = ChatState.Failed(it.displayText(language())) }
            // Advisory: failing to mark a thread seen must never stop it being
            // read.
            runCatching { api.markSeen(conversation.id) }
        }
    }

    // MARK: - Writing

    fun setDraft(value: String) {
        _draft.value = value
    }

    fun send() {
        val conversation = current ?: return
        val workspace = workspaceId ?: return
        val body = _draft.value.trim()
        if (body.isEmpty() || _sending.value) return

        _sending.value = true
        viewModelScope.launch {
            runCatching {
                api.send(
                    body = body,
                    conversationId = conversation.id,
                    workspaceId = workspace,
                    // A fresh key per attempt, which the server collapses on
                    // replay — that is what makes a retry safe rather than a
                    // way to double-post.
                    clientMessageId = UUID.randomUUID().toString(),
                )
                api.messages(conversation.id)
            }
                .onSuccess { messages ->
                    _chat.value = ChatState.Loaded(messages)
                    _draft.value = ""
                    flushShortcutUses(workspace)
                }
                .onFailure { _notice.value = it.displayText(language()) }
            _sending.value = false
        }
    }

    /**
     * Uploads, then sends the message that carries it.
     *
     * Two steps rather than one, and the draft is kept until the second
     * succeeds: an upload that lands and a send that does not would otherwise
     * leave the operator with a file on the server, nothing in the thread and
     * an empty box.
     */
    fun sendAttachment(bytes: ByteArray, fileName: String, mimeType: String) {
        val conversation = current ?: return
        val workspace = workspaceId ?: return
        _sending.value = true
        viewModelScope.launch {
            runCatching {
                val attachmentId = api.uploadAttachment(
                    conversationId = conversation.id,
                    workspaceId = workspace,
                    fileName = fileName,
                    mimeType = mimeType,
                    bytes = bytes,
                )
                api.send(
                    body = _draft.value.trim(),
                    conversationId = conversation.id,
                    workspaceId = workspace,
                    clientMessageId = UUID.randomUUID().toString(),
                    attachmentId = attachmentId,
                )
                api.messages(conversation.id)
            }
                .onSuccess {
                    _chat.value = ChatState.Loaded(it)
                    _draft.value = ""
                }
                .onFailure { _notice.value = Str.attachmentFailed(language()) }
            _sending.value = false
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
    private fun flushShortcutUses(workspace: String) {
        val ids = usedShortcuts.toList()
        usedShortcuts.clear()
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
        val conversation = current ?: return
        val body = _draft.value.trim()
        if (body.isEmpty() || _sending.value) return
        _sending.value = true
        viewModelScope.launch {
            runCatching { api.aiSayNow(conversation.id, body, _sayNowVoice.value) }
                .onSuccess {
                    _draft.value = ""
                    reload()
                }
                .onFailure { _notice.value = it.displayText(language()) }
            _sending.value = false
        }
    }

    // MARK: - What the header menu does

    fun takeOver() = act { api.takeOverConversation(it.id, requireWorkspace()) }
    fun claim() = act { api.claim(it.id, requireWorkspace()) }

    fun setStatus(status: ConversationStatus) =
        act { api.setStatus(status, it.id, requireWorkspace()) }

    fun setPriority(priority: ConversationPriority) =
        act { api.updateConversation(it.id, requireWorkspace(), priority = priority) }

    fun assign(to: Assignee) =
        act { api.updateConversation(it.id, requireWorkspace(), assignedTo = to) }

    fun setTags(tags: List<String>) =
        act { api.updateConversation(it.id, requireWorkspace(), tags = tags) }

    fun loadMembers() {
        val workspace = workspaceId ?: return
        viewModelScope.launch {
            runCatching { api.workspaceMembers(workspace) }.onSuccess { _members.value = it }
        }
    }

    // MARK: - Notes

    fun loadNotes() {
        val conversation = current ?: return
        val workspace = workspaceId ?: return
        viewModelScope.launch {
            runCatching { api.notes(conversation.id, workspace) }.onSuccess { _notes.value = it }
        }
    }

    fun addNote(body: String) {
        val conversation = current ?: return
        val workspace = workspaceId ?: return
        if (body.isBlank()) return
        viewModelScope.launch {
            runCatching { api.addNote(conversation.id, workspace, body.trim()) }
                .onSuccess { loadNotes() }
                .onFailure { _notice.value = it.displayText(language()) }
        }
    }

    fun deleteNote(note: ConversationNote) {
        val conversation = current ?: return
        val workspace = workspaceId ?: return
        viewModelScope.launch {
            runCatching { api.deleteNote(conversation.id, workspace, note.id) }
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
     * Runs an action against the open conversation, then re-reads the thread.
     *
     * Re-reading rather than patching the local copy: every one of these
     * actions also inserts a system message server-side, and a local edit
     * would show the new status with no line in the transcript saying who
     * changed it.
     */
    private fun act(block: suspend (Conversation) -> Unit) {
        val conversation = current ?: return
        if (workspaceId == null) return
        viewModelScope.launch {
            runCatching { block(conversation) }
                .onSuccess { reload() }
                .onFailure { _notice.value = it.displayText(language()) }
        }
    }

    private fun requireWorkspace(): String = workspaceId.orEmpty()
}
