package com.webyar.ai.feature.email

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.webyar.ai.core.model.EmailDraft
import com.webyar.ai.core.model.EmailMessageView
import com.webyar.ai.core.model.EmailThreadSummary
import com.webyar.ai.core.model.StagedEmailAttachment
import com.webyar.ai.core.net.WebyarApi
import com.webyar.ai.i18n.Format
import com.webyar.ai.i18n.Language
import com.webyar.ai.i18n.StrEmail
import com.webyar.ai.i18n.displayText
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.util.UUID

/** A file on its way into a mail: uploading, ready, or refused. */
data class ComposeAttachment(
    val localId: String,
    val filename: String,
    val sizeBytes: Long,
    val staged: StagedEmailAttachment? = null,
    val failed: Boolean = false,
) {
    val uploading: Boolean get() = staged == null && !failed
}

data class EmailComposeForm(
    val to: String = "",
    val cc: String = "",
    val bcc: String = "",
    val showCopies: Boolean = false,
    val subject: String = "",
    val body: String = "",
    val attachments: List<ComposeAttachment> = emptyList(),
    val sending: Boolean = false,
    val error: String? = null,
    val sent: Boolean = false,
    /** Filled in once the thread (when there is one) has been read. */
    val ready: Boolean = false,
    /**
     * What the fields held when the form became ready: a reply's addresses
     * and subject, a forward's quoted mail, or nothing at all for a new one.
     */
    val initial: ComposeFields = ComposeFields(),
) {
    val fields: ComposeFields get() = ComposeFields(to, cc, bcc, subject, body)

    /**
     * Anything the operator would lose by leaving: a field changed from how
     * it started, or a file. A forward arrives with the quoted mail already
     * in the body, and leaving it untouched loses nothing — while an address
     * typed into a new mail with no words yet is still work.
     */
    val touched: Boolean
        get() = fields.trimmed() != initial.trimmed() || attachments.isNotEmpty()
}

/** The typed parts of a mail, compared to tell whether anything was written. */
data class ComposeFields(
    val to: String = "",
    val cc: String = "",
    val bcc: String = "",
    val subject: String = "",
    val body: String = "",
) {
    fun trimmed() = ComposeFields(to.trim(), cc.trim(), bcc.trim(), subject.trim(), body.trim())
}

/** What a reply, a reply-to-all or a forward starts out with. */
data class EmailPrefill(
    val threadId: String?,
    val to: List<String>,
    val cc: List<String>,
    val subject: String,
    val body: String,
)

/**
 * The composer: a new mail, or an answer to a thread.
 *
 * Addresses are typed as text and split on commas, the way every mail client
 * takes them, and checked before anything leaves — a mistyped address is
 * said now, beside the field, rather than after a round trip. Files upload
 * as they are picked, so Send only waits for the mail itself.
 */
class EmailComposeViewModel(
    private val api: WebyarApi,
    private val language: () -> Language,
) : ViewModel() {

    private val _form = MutableStateFlow(EmailComposeForm())
    val form: StateFlow<EmailComposeForm> = _form.asStateFlow()

    private var workspaceId: String? = null
    private var threadId: String? = null
    /** The mailbox it is sent from (`gmail`, `yahoo`); null for the workspace's default one. */
    private var provider: String? = null
    private var started = false

    /**
     * [mailbox] is the workspace's own address (left out of a reply's To and
     * Cc); [provider] the mailbox the mail goes from.
     */
    fun start(
        workspaceId: String,
        sourceThreadId: String?,
        mode: EmailReplyMode?,
        mailbox: String?,
        provider: String? = null,
    ) {
        if (started) return
        started = true
        this.workspaceId = workspaceId
        this.provider = provider
        if (sourceThreadId == null || mode == null) {
            _form.update { it.copy(ready = true) }
            return
        }
        // A reply belongs to its thread whether or not the thread could be
        // read: if the fetch fails the operator can still address it by hand,
        // and it must not go out as a new conversation because of that.
        if (mode != EmailReplyMode.FORWARD) threadId = sourceThreadId
        viewModelScope.launch {
            runCatching { api.emailThread(workspaceId, sourceThreadId, provider) }
                .onSuccess { response ->
                    val prefill = prefill(mode, response.thread, response.messages, mailbox, language())
                    threadId = prefill.threadId
                    _form.update {
                        val filled = it.copy(
                            to = prefill.to.joinToString(", "),
                            cc = prefill.cc.joinToString(", "),
                            showCopies = prefill.cc.isNotEmpty(),
                            subject = prefill.subject,
                            body = prefill.body,
                            ready = true,
                        )
                        filled.copy(initial = filled.fields)
                    }
                }
                .onFailure { error ->
                    _form.update { it.copy(ready = true, error = error.displayText(language())) }
                }
        }
    }

    fun setTo(value: String) = _form.update { it.copy(to = value, error = null) }
    fun setCc(value: String) = _form.update { it.copy(cc = value, error = null) }
    fun setBcc(value: String) = _form.update { it.copy(bcc = value, error = null) }
    fun setSubject(value: String) = _form.update { it.copy(subject = value, error = null) }
    fun setBody(value: String) = _form.update { it.copy(body = value, error = null) }
    fun showCopies() = _form.update { it.copy(showCopies = true) }
    fun dismissError() = _form.update { it.copy(error = null) }
    /** Something the operator tried that could not be done — a file too large, say. */
    fun report(message: String) = _form.update { it.copy(error = message) }

    fun attach(bytes: ByteArray, filename: String, contentType: String) {
        val workspace = workspaceId ?: return
        val entry = ComposeAttachment(UUID.randomUUID().toString(), filename, bytes.size.toLong())
        _form.update { it.copy(attachments = it.attachments + entry) }
        viewModelScope.launch {
            runCatching { api.stageEmailAttachment(workspace, bytes, filename, contentType, provider) }
                .onSuccess { staged -> replace(entry.localId) { it.copy(staged = staged) } }
                .onFailure {
                    replace(entry.localId) { it.copy(failed = true) }
                    _form.update { it.copy(error = StrEmail.uploadFailed(language())) }
                }
        }
    }

    fun removeAttachment(localId: String) =
        _form.update { form -> form.copy(attachments = form.attachments.filterNot { it.localId == localId }) }

    private fun replace(localId: String, change: (ComposeAttachment) -> ComposeAttachment) =
        _form.update { form -> form.copy(attachments = form.attachments.map { if (it.localId == localId) change(it) else it }) }

    fun send() {
        val workspace = workspaceId ?: return
        val current = _form.value
        if (current.sending) return
        val l = language()

        val to = addresses(current.to)
        val cc = addresses(current.cc)
        val bcc = addresses(current.bcc)
        val bad = (to + cc + bcc).filterNot(::isAddress)
        val problem = when {
            bad.isNotEmpty() -> StrEmail.invalidAddresses(l, bad.joinToString(", "))
            to.isEmpty() -> StrEmail.needsRecipient(l)
            current.subject.isBlank() -> StrEmail.needsSubject(l)
            current.attachments.any { it.uploading } -> StrEmail.uploading(l)
            // A file whose upload failed is still on screen, in red, and the
            // mail below it very likely says "attached". Sending used to drop
            // it without a word — `mapNotNull { it.staged }` — and report
            // Sent, so the mail went out without the one thing it was for.
            // The operator removes it or attaches it again; then it sends.
            current.attachments.any { it.failed } -> StrEmail.uploadFailed(l)
            else -> null
        }
        if (problem != null) {
            _form.update { it.copy(error = problem) }
            return
        }

        _form.update { it.copy(sending = true, error = null) }
        viewModelScope.launch {
            runCatching {
                api.sendEmailDraft(
                    workspace,
                    EmailDraft(
                        threadId = threadId,
                        to = to,
                        cc = cc,
                        bcc = bcc,
                        subject = current.subject.trim(),
                        // The server needs a body; a mail of attachments
                        // alone still says something.
                        body = current.body.trim().ifEmpty { " " },
                        attachments = current.attachments.mapNotNull { it.staged },
                    ),
                    provider,
                )
            }
                .onSuccess { _form.update { it.copy(sending = false, sent = true) } }
                .onFailure { error -> _form.update { it.copy(sending = false, error = error.displayText(l)) } }
        }
    }

    companion object {
        private val ADDRESS = Regex("^[^@\\s,;<>]+@[^@\\s,;<>]+\\.[^@\\s,;<>]+$")
        private val BARE_SEPARATORS = Regex("[\\s,;]+")

        /**
         * Addresses as typed, or as a mail header gives them.
         *
         * Entries are separated by commas, semicolons and line breaks — but
         * not inside quotes or angle brackets, because Gmail hands senders
         * back as `"Ahmadi, Sara" <sara@example.com>` and a comma in a
         * display name is not the end of an address. An entry with `<…>` is
         * the address inside it, whatever name stands in front; an entry
         * without one is bare addresses, which people also separate with
         * spaces. Duplicates go regardless of case.
         */
        fun addresses(text: String): List<String> {
            val out = mutableListOf<String>()
            val entry = StringBuilder()
            var quoted = false
            var bracketed = false
            fun flush() {
                val value = entry.toString()
                entry.setLength(0)
                if ('<' in value) {
                    out += address(value)
                } else {
                    out += value.split(BARE_SEPARATORS)
                }
            }
            for (c in text) {
                when {
                    c == '"' && !bracketed -> { quoted = !quoted; entry.append(c) }
                    c == '<' && !quoted -> { bracketed = true; entry.append(c) }
                    c == '>' && !quoted -> { bracketed = false; entry.append(c) }
                    (c == ',' || c == ';' || c == '\n') && !quoted && !bracketed -> flush()
                    else -> entry.append(c)
                }
            }
            flush()
            return out
                .map { it.trim() }
                .filter { it.isNotEmpty() }
                .distinctBy { it.lowercase() }
        }

        /**
         * One address as a header writes it: `Sara Ahmadi <sara@x.com>` is
         * `sara@x.com`; a bare address is itself. What goes to the server,
         * and what two addresses are compared by.
         */
        fun address(value: String): String {
            val open = value.lastIndexOf('<')
            if (open < 0) return value.trim()
            val close = value.indexOf('>', open + 1)
            val inside = if (close < 0) value.substring(open + 1) else value.substring(open + 1, close)
            return inside.trim()
        }

        /** The same mailbox, whatever name or case either side is written with. */
        fun sameAddress(a: String, b: String): Boolean = address(a).equals(address(b), ignoreCase = true)

        fun isAddress(value: String): Boolean = ADDRESS.matches(value)

        private val RE = Regex("^(re|پاسخ|ynt|yanıt)\\s*:", RegexOption.IGNORE_CASE)
        private val FWD = Regex("^(fwd?|ارسال|ilt)\\s*:", RegexOption.IGNORE_CASE)

        /**
         * Who a reply goes to and what it is called.
         *
         * Reply is the last person who wrote in; Reply all adds everyone else
         * on that mail, less the mailbox itself; Forward starts a new thread
         * addressed to nobody, with the mail it forwards set out underneath.
         */
        fun prefill(
            mode: EmailReplyMode,
            thread: EmailThreadSummary,
            messages: List<EmailMessageView>,
            mailbox: String?,
            language: Language,
        ): EmailPrefill {
            // Every address here is reduced to its bare form first: the
            // server stores senders as Gmail wrote them (`Name <a@b>`) and
            // takes back only plain addresses, and the mailbox and the people
            // are only recognised as themselves once the names are off.
            fun isMailbox(address: String) = mailbox != null && sameAddress(address, mailbox)
            val subject = thread.subject.orEmpty().trim()
            val last = messages.lastOrNull()
            val lastInbound = messages.lastOrNull { !it.isOutbound }

            val sender = lastInbound?.fromAddress?.let(::address)?.takeIf { it.isNotBlank() }
            val fallback = thread.participants.orEmpty().map { address(it.email) }
                .filter { it.isNotBlank() }
                .filterNot(::isMailbox)
            val replyTo = listOfNotNull(sender).ifEmpty { fallback.take(1) }

            return when (mode) {
                EmailReplyMode.REPLY -> EmailPrefill(
                    threadId = thread.id,
                    to = replyTo,
                    cc = emptyList(),
                    subject = if (RE.containsMatchIn(subject)) subject else "Re: $subject".trim(),
                    body = "",
                )
                EmailReplyMode.REPLY_ALL -> {
                    val others = (last?.toAddresses.orEmpty() + last?.ccAddresses.orEmpty())
                        .map { address(it.email) }
                        .filter { it.isNotBlank() }
                        .filterNot(::isMailbox)
                        .filterNot { other -> replyTo.any { sameAddress(it, other) } }
                        .distinctBy { it.lowercase() }
                    EmailPrefill(
                        threadId = thread.id,
                        to = replyTo,
                        cc = others,
                        subject = if (RE.containsMatchIn(subject)) subject else "Re: $subject".trim(),
                        body = "",
                    )
                }
                EmailReplyMode.FORWARD -> {
                    val original = last
                    val body = if (original == null) "" else buildString {
                        append("\n\n")
                        append(StrEmail.forwardedHeader(language)).append('\n')
                        append(StrEmail.from(language)).append(": ").append(original.fromAddress.orEmpty()).append('\n')
                        original.sentAt?.let {
                            append(StrEmail.date(language)).append(": ")
                                .append(Format.dayHeader(it, language)).append(' ')
                                .append(Format.bubbleTime(it, language)).append('\n')
                        }
                        append(StrEmail.subject(language)).append(": ").append(subject).append('\n')
                        val to = original.toAddresses.orEmpty().joinToString(", ") { it.email }
                        if (to.isNotEmpty()) append(StrEmail.to(language)).append(": ").append(to).append('\n')
                        append('\n')
                        append(original.displayBody)
                    }
                    EmailPrefill(
                        threadId = null,
                        to = emptyList(),
                        cc = emptyList(),
                        subject = if (FWD.containsMatchIn(subject)) subject else "Fwd: $subject".trim(),
                        body = body,
                    )
                }
            }
        }
    }
}
