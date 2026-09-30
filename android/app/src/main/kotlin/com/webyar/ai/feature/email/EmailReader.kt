package com.webyar.ai.feature.email

import com.webyar.ai.core.model.EmailAddress
import com.webyar.ai.core.model.EmailAttachmentView
import com.webyar.ai.core.model.EmailBody
import com.webyar.ai.core.model.EmailMessageView
import com.webyar.ai.i18n.Format
import com.webyar.ai.i18n.Language
import com.webyar.ai.i18n.Str
import com.webyar.ai.i18n.StrEmail
import java.net.URLDecoder
import java.net.URLEncoder

/** `"Sara Karimi" <sara@x.com>` as its two halves; a bare address has no name. */
internal data class MailName(val name: String?, val email: String) {
    val display: String get() = name ?: email

    companion object {
        private val NAMED = Regex("^\\s*\"?([^\"<]*?)\"?\\s*<([^>]+)>\\s*$")

        fun parse(raw: String?): MailName {
            val value = raw.orEmpty().trim()
            val match = NAMED.matchEntire(value)
                ?: return MailName(null, value)
            return MailName(match.groupValues[1].trim().takeIf { it.isNotEmpty() }, match.groupValues[2].trim())
        }
    }
}

/**
 * A thread as one page, the way the Windows app reads mail.
 *
 * The newest mail first and open, under a header that says who wrote it,
 * when, and to whom; then the earlier ones, newest first, each folded to one
 * line (a face, a name, the first words, a date) and opened with a tap. The
 * same white page and the same measurements as `EmailPage.xaml.cs` and the
 * web reader, so a mail looks the same on every screen the operator has.
 *
 * The page is always white, dark theme or not: a mail is somebody else's
 * design, drawn for white paper, and most of them are unreadable on anything
 * else.
 *
 * Nothing here runs. The WebView that shows this has JavaScript off, and the
 * mail's own HTML is cut down to what can be drawn: no scripts, frames,
 * forms, plugins or `<meta>`/`<base>`, and no `javascript:` links. Folding is
 * `<details>`, which the page does by itself. Links are the app's to follow
 * ([ATTACHMENT_SCHEME] opens a file; anything else goes to the browser).
 */
object EmailReader {

    /** A file chip's link: `webyar-attachment:<id>`. The WebView never loads it; the app opens the file. */
    const val ATTACHMENT_SCHEME = "webyar-attachment"

    /**
     * Where an inline picture (`cid:`) is fetched from.
     *
     * A host that cannot exist (`.invalid` is reserved for exactly this), so
     * the WebView asks the app for it — through `shouldInterceptRequest` —
     * and the bytes come from the signed-in API rather than from anywhere on
     * the network.
     */
    const val INLINE_HOST = "inline.webyar.invalid"

    fun attachmentLink(id: String): String = "$ATTACHMENT_SCHEME:${URLEncoder.encode(id, "UTF-8")}"

    fun inlineUrl(id: String): String = "https://$INLINE_HOST/${URLEncoder.encode(id, "UTF-8")}"

    /** The attachment id a link or an inline URL names, or null for anything else. */
    fun attachmentIdOf(url: String): String? {
        val raw = when {
            url.startsWith("$ATTACHMENT_SCHEME:") -> url.removePrefix("$ATTACHMENT_SCHEME:")
            url.startsWith("https://$INLINE_HOST/") -> url.removePrefix("https://$INLINE_HOST/")
            else -> return null
        }
        return runCatching { URLDecoder.decode(raw, "UTF-8") }.getOrNull()?.takeIf { it.isNotBlank() }
    }

    fun document(
        subject: String?,
        messages: List<EmailMessageView>,
        mailbox: String?,
        language: Language,
        snippet: String? = null,
    ): String {
        val dir = if (language == Language.FA) "rtl" else "ltr"
        val out = StringBuilder(4096 + messages.sumOf { (it.htmlBody?.length ?: 0) + (it.textBody?.length ?: 0) })
        out.append("<!doctype html><html dir=\"").append(dir).append("\"><head><meta charset=\"utf-8\">")
            .append("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">")
            .append("<style>").append(CSS).append("</style></head><body>")

        out.append("<h1 dir=\"auto\">")
            .append(escape(subject?.takeIf { it.isNotBlank() } ?: Str.emailNoSubject(language)))
            .append("</h1>")
        if (messages.size > 1) {
            out.append("<div class=\"cnt\">").append(escape(StrEmail.messagesCount(language, messages.size))).append("</div>")
        }

        val latest = messages.lastOrNull()
        if (latest == null) {
            out.append("<div class=\"b\" dir=\"auto\"><pre>")
                .append(escape(EmailBody.plainText(snippet.orEmpty())))
                .append("</pre></div>")
        } else {
            header(out, latest, mailbox, language)
            body(out, latest, language)
        }

        if (messages.size > 1) {
            out.append("<div class=\"earlier\"><div class=\"et\">")
                .append(escape(StrEmail.earlierMessages(language, messages.size - 1)))
                .append("</div>")
            for (i in messages.size - 2 downTo 0) {
                val m = messages[i]
                val from = MailName.parse(m.fromAddress)
                // A mail still unread is opened for the operator, as the
                // trail did before this page existed.
                out.append(if (m.isRead == false) "<details open><summary>" else "<details><summary>")
                    .append(avatar(from, 30))
                    .append("<span class=\"who\" dir=\"auto\">").append(escape(who(from, mailbox, language))).append("</span>")
                    .append("<span class=\"sn\" dir=\"auto\">").append(escape(snippetOf(m))).append("</span>")
                    .append("<span class=\"dt\">").append(escape(Format.listTimestamp(m.sentAt, language))).append("</span>")
                    .append("</summary><div class=\"in\"><div class=\"meta\" dir=\"auto\">")
                    .append(escape("${StrEmail.from(language)}: ${m.fromAddress.orEmpty()}"))
                    .append("<br>")
                    .append(escape("${StrEmail.to(language)}: ${joinEmails(m.toAddresses)}"))
                if (!m.ccAddresses.isNullOrEmpty()) {
                    out.append("<br>").append(escape("${StrEmail.cc(language)}: ${joinEmails(m.ccAddresses)}"))
                }
                m.sentAt?.let {
                    out.append("<br>").append(escape("${StrEmail.date(language)}: ${fullDate(m, language)}"))
                }
                out.append("</div>")
                body(out, m, language)
                out.append("</div></details>")
            }
            out.append("</div>")
        }
        out.append("</body></html>")
        return out.toString()
    }

    private fun header(out: StringBuilder, m: EmailMessageView, mailbox: String?, language: Language) {
        val from = MailName.parse(m.fromAddress)
        out.append("<div class=\"hd\">").append(avatar(from, 40)).append("<div class=\"hw\"><div class=\"hl\">")
            .append("<span class=\"hn\" dir=\"auto\">").append(escape(who(from, mailbox, language))).append("</span>")
            .append("<span class=\"hdt\">").append(escape(fullDate(m, language))).append("</span></div>")
        // The address beside a name, never twice: a bare address is its own name.
        if (from.name != null) {
            out.append("<div class=\"ha\" dir=\"ltr\">").append(escape(from.email)).append("</div>")
        }
        val to = m.toAddresses.orEmpty().map { recipient(it, mailbox, language) }
        val cc = m.ccAddresses.orEmpty().map { recipient(it, mailbox, language) }
        if (to.isNotEmpty() || cc.isNotEmpty()) {
            val parts = buildList {
                if (to.isNotEmpty()) add("${StrEmail.to(language)}: ${to.joinToString(", ")}")
                if (cc.isNotEmpty()) add("${StrEmail.cc(language)}: ${cc.joinToString(", ")}")
            }
            out.append("<div class=\"hr\" dir=\"auto\">").append(escape(parts.joinToString(" · "))).append("</div>")
        }
        out.append("</div></div>")
    }

    private fun body(out: StringBuilder, m: EmailMessageView, language: Language) {
        out.append("<div class=\"b\" dir=\"auto\">")
        val html = m.htmlBody?.takeIf { it.isNotBlank() }
        if (html != null) {
            out.append(sanitize(html, m.attachments.orEmpty()))
        } else {
            val text = m.textBody?.takeIf { it.isNotBlank() } ?: EmailBody.plainText(m.snippet.orEmpty())
            val (fresh, quoted) = EmailBody.splitQuoted(text)
            out.append("<pre>").append(escape(fresh)).append("</pre>")
            if (quoted != null) {
                // Plain-text mail carries its trail as "> " lines; folded, as
                // every mail client folds it.
                out.append("<details class=\"q\"><summary>")
                    .append(escape(StrEmail.showQuoted(language)))
                    .append("</summary><pre>").append(escape(quoted)).append("</pre></details>")
            }
        }
        out.append("</div>")
        // Inline pictures are part of the body, not files to open.
        val files = m.attachments.orEmpty().filter { !isInline(it, html) }
        if (files.isNotEmpty()) {
            out.append("<div class=\"files\">")
            for (f in files) {
                out.append("<a class=\"file\" dir=\"auto\" href=\"").append(escape(attachmentLink(f.id))).append("\">📎 ")
                    .append(escape(f.filename?.takeIf { it.isNotBlank() } ?: Str.file(language)))
                f.sizeBytes?.let { out.append("<span class=\"fs\">").append(escape(Format.fileSize(it, language))).append("</span>") }
                out.append("</a>")
            }
            out.append("</div>")
        }
        if (m.deliveryStatus == "failed" || !m.deliveryError.isNullOrBlank()) {
            val reason = m.deliveryError?.takeIf { it.isNotBlank() }
            out.append("<div class=\"err\" dir=\"auto\">")
                .append(escape(listOfNotNull(StrEmail.notDelivered(language), reason).joinToString(" — ")))
                .append("</div>")
        }
    }

    /** A picture the HTML draws where it stands (`cid:`), which is not also a file to list. */
    private fun isInline(attachment: EmailAttachmentView, html: String?): Boolean {
        val cid = attachment.contentId?.trim()?.removePrefix("<")?.removeSuffix(">")?.takeIf { it.isNotEmpty() } ?: return false
        return html?.contains("cid:$cid", ignoreCase = true) == true
    }

    private fun who(from: MailName, mailbox: String?, language: Language): String {
        val mine = mailbox != null && EmailComposeViewModel.sameAddress(from.email, mailbox)
        return if (mine && from.name == null) StrEmail.me(language) else from.display
    }

    private fun recipient(address: EmailAddress, mailbox: String?, language: Language): String {
        val parsed = MailName.parse(address.email)
        if (mailbox != null && EmailComposeViewModel.sameAddress(parsed.email, mailbox)) return StrEmail.me(language)
        return parsed.display
    }

    private fun joinEmails(list: List<EmailAddress>?): String =
        list.orEmpty().joinToString(", ") { it.email }

    private fun fullDate(m: EmailMessageView, language: Language): String {
        val at = m.sentAt ?: return ""
        return "${Format.dayHeader(at, language)} · ${Format.bubbleTime(at, language)}"
    }

    /** The first words, on one line. Gmail's snippets arrive HTML-escaped ("We&#39;re"). */
    private fun snippetOf(m: EmailMessageView): String {
        val raw = m.snippet?.takeIf { it.isNotBlank() }
            ?: m.textBody?.takeIf { it.isNotBlank() }
            ?: m.htmlBody?.let(EmailBody::plainText)
            ?: ""
        return EmailBody.plainText(raw).replace(WHITESPACE, " ").trim().take(200)
    }

    /**
     * The sender's face as the app draws one: no initials, a person on a
     * pastel disc whose hue is the address's — the same hue [MailAvatar]
     * gives the same sender in the list.
     */
    private fun avatar(from: MailName, px: Int): String {
        val hue = (from.email.lowercase().hashCode().toLong() and 0xFFFFFFFFL) % 360L
        return "<span class=\"av\" style=\"width:${px}px;height:${px}px;background:hsl($hue,55%,88%)\">" +
            "<svg viewBox=\"0 0 24 24\"><path fill=\"hsl($hue,55%,32%)\" d=\"$PERSON\"/></svg></span>"
    }

    // MARK: - The mail's own HTML

    private val DROP_WITH_CONTENT = Regex(
        "<(script|iframe|frameset|frame|object|applet|noembed|textarea|select|template)\\b[^>]*>.*?</\\1\\s*>",
        setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL),
    )
    private val DROP_TAG = Regex(
        "</?(script|iframe|frameset|frame|object|applet|embed|meta|base|link|form|input|button|textarea|select|option|html|head|body|title)\\b[^>]*>",
        RegexOption.IGNORE_CASE,
    )
    private val DOCTYPE = Regex("<!doctype[^>]*>", RegexOption.IGNORE_CASE)
    private val EVENT_ATTRIBUTE = Regex("\\s+on[a-z]+\\s*=\\s*(\"[^\"]*\"|'[^']*'|[^\\s>]+)", RegexOption.IGNORE_CASE)
    private val SCRIPT_URL = Regex("(href|src|action|formaction|xlink:href)\\s*=\\s*([\"']?)\\s*(javascript|vbscript|data:text/html)[^\"'\\s>]*\\2", RegexOption.IGNORE_CASE)
    private val CID_SRC = Regex("(src\\s*=\\s*)([\"']?)cid:([^\"'\\s>]+)\\2", RegexOption.IGNORE_CASE)
    private val WHITESPACE = Regex("\\s+")

    /**
     * The mail's HTML with everything that is not drawing taken out.
     *
     * JavaScript is off in the WebView, so this is the second fence, not the
     * first: it keeps a mail from bringing a form, a frame onto some other
     * page, or a `<meta refresh>` that would navigate on its own. Styles and
     * pictures stay — they are what makes a mail look like itself.
     */
    internal fun sanitize(html: String, attachments: List<EmailAttachmentView>): String {
        var out = DROP_WITH_CONTENT.replace(html, "")
        out = DOCTYPE.replace(out, "")
        out = DROP_TAG.replace(out, "")
        out = EVENT_ATTRIBUTE.replace(out, "")
        out = SCRIPT_URL.replace(out) { "${it.groupValues[1]}=\"#\"" }
        // Inline pictures: `cid:<content id>` → the app's own URL for that part.
        val byCid = attachments.mapNotNull { a ->
            a.contentId?.trim()?.removePrefix("<")?.removeSuffix(">")?.takeIf { it.isNotEmpty() }?.lowercase()?.let { it to a.id }
        }.toMap()
        if (byCid.isNotEmpty()) {
            out = CID_SRC.replace(out) { match ->
                val id = byCid[match.groupValues[3].lowercase()] ?: return@replace match.value
                "${match.groupValues[1]}\"${inlineUrl(id)}\""
            }
        }
        return out
    }

    internal fun escape(text: String): String {
        val sb = StringBuilder(text.length + 16)
        for (c in text) {
            when (c) {
                '&' -> sb.append("&amp;")
                '<' -> sb.append("&lt;")
                '>' -> sb.append("&gt;")
                '"' -> sb.append("&quot;")
                '\'' -> sb.append("&#39;")
                else -> sb.append(c)
            }
        }
        return sb.toString()
    }

    private const val PERSON = "M12 12a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zm0 2c-4.4 0-8 2.5-8 5.5V21h16v-1.5c0-3-3.6-5.5-8-5.5z"

    /**
     * The Windows reader's stylesheet (`EmailPage.xaml.cs`), with a phone's
     * adjustments: the app's own Persian face first, a header that scrolls
     * with the mail instead of standing above it, and wide newsletters held
     * to the screen's width rather than pushed off its edge.
     */
    private val CSS = listOf(
        "html,body{background:#ffffff}",
        "body{margin:0;padding:14px 16px 24px;font-family:Vazirmatn,'Noto Naskh Arabic','Noto Sans Arabic',Roboto,'Segoe UI',Tahoma,sans-serif;font-size:15px;line-height:1.6;color:#1f2633;-webkit-text-size-adjust:100%}",
        "h1{font-size:19px;line-height:1.4;font-weight:700;color:#0f1729;margin:2px 0 4px;overflow-wrap:anywhere}",
        ".cnt{font-size:12px;color:#6b7485;margin-bottom:4px}",
        ".hd{display:flex;align-items:flex-start;gap:12px;margin:12px 0 14px;padding-bottom:12px;border-bottom:1px solid #eef0f4}",
        ".hw{flex:1;min-width:0}",
        ".hl{display:flex;align-items:baseline;gap:8px}",
        ".hn{flex:1;min-width:0;font-weight:600;font-size:14.5px;color:#0f1729;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
        ".hdt{flex:none;font-size:12px;color:#98a2b3;white-space:nowrap}",
        ".ha{font-size:12.5px;color:#6b7485;overflow-wrap:anywhere;text-align:start}",
        ".hr{font-size:12.5px;color:#6b7485;margin-top:2px;overflow-wrap:anywhere}",
        ".b{overflow-wrap:anywhere;overflow-x:auto}",
        ".b img{max-width:100%!important;height:auto!important}",
        ".b table{max-width:100%!important}",
        ".b td,.b th{overflow-wrap:anywhere}",
        "pre{white-space:pre-wrap;font-family:inherit;margin:0}",
        "a{color:#2f6ae0}",
        ".q{margin-top:10px;border:0;background:none}",
        ".q>summary{display:inline-block;padding:2px 10px;border-radius:8px;background:#f1f4f9;color:#3b4252;font-size:12.5px}",
        ".q[open]>summary{margin-bottom:8px}",
        ".q pre{color:#6b7485;border-inline-start:3px solid #e3e7ee;padding-inline-start:10px}",
        ".err{margin-top:12px;padding:8px 12px;border-radius:8px;background:#fdecec;color:#c62f35;font-size:12.5px}",
        ".earlier{margin-top:26px;padding-top:14px;border-top:1px solid #e6e9ef}",
        ".et{font-size:12px;font-weight:600;color:#6b7485;margin:0 2px 10px}",
        "details{border:1px solid #e3e7ee;border-radius:12px;margin-bottom:10px;background:#f8f9fb;overflow:hidden}",
        "details[open]{background:#ffffff}",
        "summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:12px;padding:10px 14px}",
        "summary::-webkit-details-marker{display:none}",
        ".av{flex:none;border-radius:50%;display:flex;align-items:center;justify-content:center;overflow:hidden}",
        ".av svg{width:55%;height:55%}",
        ".who{flex:none;max-width:40%;font-weight:600;font-size:13px;color:#0f1729;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
        ".sn{flex:1;min-width:0;font-size:12.5px;color:#6b7485;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
        "details[open]>summary .sn{visibility:hidden}",
        ".dt{flex:none;font-size:12px;color:#98a2b3;white-space:nowrap}",
        ".in{padding:4px 14px 14px;border-top:1px solid #eef0f4}",
        ".meta{font-size:12px;color:#6b7485;margin:8px 0 12px;overflow-wrap:anywhere}",
        ".files{margin-top:14px;display:flex;flex-wrap:wrap;gap:6px}",
        ".file{font-size:12.5px;color:#3b4252;background:#f1f4f9;border-radius:8px;padding:6px 10px;text-decoration:none;max-width:100%;overflow-wrap:anywhere}",
        ".fs{color:#98a2b3;margin-inline-start:6px}",
    ).joinToString("")
}
