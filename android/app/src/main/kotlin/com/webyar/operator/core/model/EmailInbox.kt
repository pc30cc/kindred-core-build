package com.webyar.operator.core.model

import kotlinx.serialization.Serializable
import java.time.Instant

// The Email Inbox is a real mailbox — Gmail today — and is deliberately a
// different surface from the chat inbox, right down to its own API prefix
// (`/api/email-inbox`, not `/api/email`). These types mirror
// `src/lib/emailInbox-api.ts` field for field, and the server already speaks
// camelCase here, so almost none of them need a @SerialName.

@Serializable
data class EmailAddress(val email: String)

@Serializable
data class EmailThreadSummary(
    val id: String,
    val provider: String? = null,
    val subject: String? = null,
    val participants: List<EmailAddress>? = null,
    @Serializable(InstantSerializer::class) val lastMessageAt: Instant? = null,
    val isRead: Boolean? = null,
    val isStarred: Boolean? = null,
    val labels: List<String>? = null,
    val lastMessageSnippet: String? = null,
) {
    /**
     * Who the row is about: everyone on the thread except, where we can tell,
     * the mailbox itself.
     *
     * Falls back to the full list when excluding the mailbox would leave
     * nothing — a note to yourself is still from somebody.
     */
    fun people(excludingMailbox: String?): String {
        val all = participants.orEmpty().map { it.email }
        val others = if (excludingMailbox == null) all
        else all.filterNot { it.equals(excludingMailbox, ignoreCase = true) }
        return (others.ifEmpty { all }).joinToString(", ")
    }
}

@Serializable
data class EmailAttachmentView(
    val id: String,
    val filename: String? = null,
    val contentType: String? = null,
    val sizeBytes: Long? = null,
    val contentId: String? = null,
    val url: String? = null,
)

@Serializable
data class EmailMessageView(
    val id: String,
    val externalMessageId: String? = null,
    val direction: String? = null,
    val fromAddress: String? = null,
    val toAddresses: List<EmailAddress>? = null,
    val ccAddresses: List<EmailAddress>? = null,
    val textBody: String? = null,
    val htmlBody: String? = null,
    val snippet: String? = null,
    val isRead: Boolean? = null,
    val deliveryStatus: String? = null,
    val deliveryError: String? = null,
    @Serializable(InstantSerializer::class) val sentAt: Instant? = null,
    val attachments: List<EmailAttachmentView>? = null,
) {
    val isOutbound: Boolean get() = direction == "outbound"

    /**
     * What to show in the trail.
     *
     * The plain-text part when there is one; otherwise the HTML with its tags
     * taken out, because a mail written only in HTML is common and showing its
     * markup is worse than showing its words imperfectly.
     *
     * A WebView per message would render it properly and is the obvious next
     * step. It is also a much larger surface to get right — an email is
     * arbitrary third-party HTML, so a WebView needs JavaScript off, remote
     * content gated, and its own navigation policy, or the mail decides what
     * the app does. This stays text until that is worth building.
     */
    val displayBody: String
        get() {
            textBody?.trim()?.takeIf { it.isNotEmpty() }?.let { return it }
            htmlBody?.takeIf { it.isNotEmpty() }?.let { return EmailBody.plainText(it) }
            return snippet.orEmpty()
        }
}

@Serializable
data class EmailThreadResponse(
    val thread: EmailThreadSummary,
    val messages: List<EmailMessageView> = emptyList(),
)

@Serializable
data class EmailThreadsResponse(
    val threads: List<EmailThreadSummary> = emptyList(),
    val nextBefore: String? = null,
)

/**
 * The connected mailbox, so the screen can say whose inbox this is — and say
 * something useful when there isn't one.
 */
@Serializable
data class GmailConnection(
    val connected: Boolean? = null,
    val emailAddress: String? = null,
    val status: String? = null,
)

@Serializable
data class GmailConnectionResponse(
    val connection: GmailConnection? = null,
    val platformConfigured: Boolean? = null,
)

/**
 * Turns an HTML mail into something readable as plain text.
 *
 * Not a parser and not trying to be: it drops the parts that are never
 * content, unwraps the tags, and puts back the handful of entities that appear
 * in almost every message. Anything cleverer belongs in a WebView.
 */
object EmailBody {

    private val BLOCKS = Regex(
        // DOT_MATCHES_ALL so a block spanning several lines is still one match.
        "<(script|style|head)[^>]*>.*?</\\1>",
        setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL),
    )
    private val LINE_ENDING_TAGS = Regex(
        "<(br|/p|/div|/tr|/li|/h[1-6])[^>]*>",
        RegexOption.IGNORE_CASE,
    )
    private val ANY_TAG = Regex("<[^>]+>")
    private val RUNS_OF_SPACE = Regex("[ \\t]+")
    private val RUNS_OF_BLANK_LINES = Regex("\n{3,}")

    /**
     * The named entities worth spelling out, and NOT `&amp;` — see below.
     *
     * A mail written in a rich-text editor is full of these: the em dash a
     * word processor inserts for a typed hyphen, the curly quotes it
     * substitutes, the ellipsis. Leaving them shows the operator
     * «Thanks &mdash; received.» instead of «Thanks — received.»
     */
    private val ENTITIES = listOf(
        "&nbsp;" to " ", "&lt;" to "<", "&gt;" to ">",
        "&quot;" to "\"", "&apos;" to "'", "&zwnj;" to "‌",
        "&mdash;" to "—", "&ndash;" to "–", "&hellip;" to "…",
        "&lsquo;" to "‘", "&rsquo;" to "’",
        "&ldquo;" to "“", "&rdquo;" to "”",
        "&laquo;" to "«", "&raquo;" to "»",
        "&middot;" to "·", "&bull;" to "•",
        "&copy;" to "©", "&reg;" to "®", "&trade;" to "™",
        "&euro;" to "€", "&pound;" to "£", "&deg;" to "°",
    )

    /** `&#8212;` and `&#x2014;`, which is how much of the world's mail writes a dash. */
    private val NUMERIC_ENTITY = Regex("&#(x[0-9a-f]+|[0-9]+);", RegexOption.IGNORE_CASE)

    fun plainText(html: String): String {
        var text = BLOCKS.replace(html, " ")
        // Tags that end a line, before the ones that do not.
        text = LINE_ENDING_TAGS.replace(text, "\n")
        text = ANY_TAG.replace(text, "")
        for ((entity, character) in ENTITIES) {
            text = text.replace(entity, character, ignoreCase = true)
        }
        text = NUMERIC_ENTITY.replace(text) { match ->
            val digits = match.groupValues[1]
            val code = if (digits.startsWith("x", ignoreCase = true)) {
                digits.drop(1).toIntOrNull(16)
            } else {
                digits.toIntOrNull()
            }
            // A code point outside Unicode is left exactly as it was written.
            // Showing `&#1114112;` is ugly; showing whatever it truncated to
            // would be wrong.
            if (code != null && code in 1..0x10FFFF) {
                runCatching { String(Character.toChars(code)) }.getOrDefault(match.value)
            } else {
                match.value
            }
        }
        // LAST, and that is the point of it being last: a mail that wants to
        // show the text "&mdash;" writes "&amp;mdash;", and decoding the
        // ampersand first would turn it into an em dash — quietly changing
        // what somebody wrote.
        text = text.replace("&amp;", "&", ignoreCase = true)
        // Three blank lines in a row are an artefact of the markup, not of
        // what anybody wrote.
        text = RUNS_OF_SPACE.replace(text, " ")
        text = RUNS_OF_BLANK_LINES.replace(text, "\n\n")
        return text.trim()
    }
}
