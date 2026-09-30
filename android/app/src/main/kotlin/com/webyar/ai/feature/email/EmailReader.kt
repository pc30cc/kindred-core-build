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
        val rtl = language == Language.FA
        val out = StringBuilder(4096 + messages.sumOf { (it.htmlBody?.length ?: 0) + (it.textBody?.length ?: 0) })
        out.append("<!doctype html><html dir=\"").append(if (rtl) "rtl" else "ltr").append("\"><head><meta charset=\"utf-8\">")
            .append("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">")
            .append("<style>").append(CSS).append(if (rtl) SIDE_RTL else SIDE_LTR).append(FIT).append("</style></head><body>")

        // The page's own lines stand on the page's side, whatever language
        // they are in: an English subject in a Persian reader is still
        // right-aligned, with its words in their own order.
        out.append("<h1 class=\"w-s\">")
            .append(escape(subject?.takeIf { it.isNotBlank() } ?: Str.emailNoSubject(language)))
            .append("</h1>")
        if (messages.size > 1) {
            out.append("<div class=\"w-cnt\">").append(escape(StrEmail.messagesCount(language, messages.size))).append("</div>")
        }

        val latest = messages.lastOrNull()
        if (latest == null) {
            out.append("<div class=\"w-b\" dir=\"auto\"><pre class=\"w-t\">")
                .append(escape(EmailBody.plainText(snippet.orEmpty())))
                .append("</pre></div>")
        } else {
            header(out, latest, mailbox, language)
            body(out, latest, language, scope = scopeOf(messages.size - 1))
        }

        if (messages.size > 1) {
            out.append("<div class=\"w-earlier\"><div class=\"w-et\">")
                .append(escape(StrEmail.earlierMessages(language, messages.size - 1)))
                .append("</div>")
            for (i in messages.size - 2 downTo 0) {
                val m = messages[i]
                val from = MailName.parse(m.fromAddress)
                // A mail still unread is opened for the operator, as the
                // trail did before this page existed.
                out.append(if (m.isRead == false) "<details class=\"w-card\" open><summary>" else "<details class=\"w-card\"><summary>")
                    .append(avatar(from, 30))
                    .append("<span class=\"w-who\">").append(escape(who(from, mailbox, language))).append("</span>")
                if (m.deliveryStatus == "draft") out.append("<span class=\"w-draft\">").append(escape(StrEmail.draft(language))).append("</span>")
                out.append("<span class=\"w-sn\">").append(escape(snippetOf(m))).append("</span>")
                    .append("<span class=\"w-dt\">").append(escape(Format.listTimestamp(m.sentAt, language))).append("</span>")
                    .append("</summary><div class=\"w-in\"><div class=\"w-meta\">")
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
                body(out, m, language, scope = scopeOf(i))
                out.append("</div></details>")
            }
            out.append("</div>")
        }
        out.append("</body></html>")
        return out.toString()
    }

    private fun header(out: StringBuilder, m: EmailMessageView, mailbox: String?, language: Language) {
        val from = MailName.parse(m.fromAddress)
        out.append("<div class=\"w-hd\">").append(avatar(from, 40)).append("<div class=\"w-hw\"><div class=\"w-hl\">")
            .append("<span class=\"w-hn\">").append(escape(who(from, mailbox, language))).append("</span>")
        if (m.deliveryStatus == "draft") out.append("<span class=\"w-draft\">").append(escape(StrEmail.draft(language))).append("</span>")
        out.append("<span class=\"w-hdt\">").append(escape(fullDate(m, language))).append("</span></div>")
        // The address beside a name, never twice: a bare address is its own name.
        if (from.name != null) {
            out.append("<div class=\"w-ha\" dir=\"ltr\">").append(escape(from.email)).append("</div>")
        }
        val to = m.toAddresses.orEmpty().map { recipient(it, mailbox, language) }
        val cc = m.ccAddresses.orEmpty().map { recipient(it, mailbox, language) }
        if (to.isNotEmpty() || cc.isNotEmpty()) {
            val parts = buildList {
                if (to.isNotEmpty()) add("${StrEmail.to(language)}: ${to.joinToString(", ")}")
                if (cc.isNotEmpty()) add("${StrEmail.cc(language)}: ${cc.joinToString(", ")}")
            }
            out.append("<div class=\"w-hr\">").append(escape(parts.joinToString(" · "))).append("</div>")
        }
        out.append("</div></div>")
    }

    /** The class that confines message [index]'s own stylesheet ([MailCss]). */
    private fun scopeOf(index: Int) = "m$index"

    private fun body(out: StringBuilder, m: EmailMessageView, language: Language, scope: String) {
        out.append("<div class=\"w-b ").append(scope).append("\" dir=\"auto\">")
        val html = m.htmlBody?.takeIf { it.isNotBlank() }
        if (html != null) {
            out.append(sanitize(html, m.attachments.orEmpty(), scope))
        } else {
            val text = m.textBody?.takeIf { it.isNotBlank() } ?: EmailBody.plainText(m.snippet.orEmpty())
            val (fresh, quoted) = EmailBody.splitQuoted(text)
            out.append("<pre class=\"w-t\">").append(escape(fresh)).append("</pre>")
            if (quoted != null) {
                // Plain-text mail carries its trail as "> " lines; folded, as
                // every mail client folds it.
                out.append("<details class=\"w-q\"><summary>")
                    .append(escape(StrEmail.showQuoted(language)))
                    .append("</summary><pre class=\"w-t\">").append(escape(quoted)).append("</pre></details>")
            }
        }
        out.append("</div>")
        // Inline pictures are part of the body, not files to open.
        val files = m.attachments.orEmpty().filter { !isInline(it, html) }
        if (files.isNotEmpty()) {
            out.append("<div class=\"w-files\">")
            for (f in files) {
                out.append("<a class=\"w-file\" dir=\"auto\" href=\"").append(escape(attachmentLink(f.id))).append("\">📎 ")
                    .append(escape(f.filename?.takeIf { it.isNotBlank() } ?: Str.file(language)))
                f.sizeBytes?.let { out.append("<span class=\"w-fs\">").append(escape(Format.fileSize(it, language))).append("</span>") }
                out.append("</a>")
            }
            out.append("</div>")
        }
        if (m.deliveryStatus == "failed" || !m.deliveryError.isNullOrBlank()) {
            val reason = m.deliveryError?.takeIf { it.isNotBlank() }
            out.append("<div class=\"w-err\" dir=\"auto\">")
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
        return "<span class=\"w-av\" style=\"width:${px}px;height:${px}px;background:hsl($hue,55%,88%)\">" +
            "<svg viewBox=\"0 0 24 24\"><path fill=\"hsl($hue,55%,32%)\" d=\"$PERSON\"/></svg></span>"
    }

    // MARK: - The mail's own HTML

    private val DROP_WITH_CONTENT = Regex(
        "<(script|iframe|frameset|frame|object|applet|noembed|textarea|select|template|title)\\b[^>]*>.*?</\\1\\s*>",
        setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL),
    )
    private val DROP_TAG = Regex(
        "</?(script|iframe|frameset|frame|object|applet|embed|meta|base|link|form|input|button|textarea|select|option|html|head|body|title|xmp|plaintext)\\b[^>]*>",
        RegexOption.IGNORE_CASE,
    )
    private val DOCTYPE = Regex("<!doctype[^>]*>", RegexOption.IGNORE_CASE)
    private val EVENT_ATTRIBUTE = Regex("\\s+on[a-z]+\\s*=\\s*(\"[^\"]*\"|'[^']*'|[^\\s>]+)", RegexOption.IGNORE_CASE)
    private val SCRIPT_URL = Regex("(href|src|action|formaction|xlink:href)\\s*=\\s*([\"']?)\\s*(javascript|vbscript|data:text/html)[^\"'\\s>]*\\2", RegexOption.IGNORE_CASE)
    private val CID_SRC = Regex("(src\\s*=\\s*)([\"']?)cid:([^\"'\\s>]+)\\2", RegexOption.IGNORE_CASE)
    private val STYLE_BLOCK = Regex("(<style\\b[^>]*>)(.*?)(</style\\s*>)", setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL))
    private val STYLE_OPEN = Regex("<style\\b", RegexOption.IGNORE_CASE)
    /** A start tag with its attributes (quoted values may hold `>`). */
    private val START_TAG = Regex("<([a-zA-Z][a-zA-Z0-9]*)(\\s(?:[^<>\"']|\"[^\"]*\"|'[^']*')*)?>")
    private val WIDTH_ATTRIBUTE = Regex("(\\s)width\\s*=\\s*([\"']?)\\s*(\\d+(?:\\.\\d+)?)\\s*(?:px)?\\s*\\2(?=[\\s/]|$)", RegexOption.IGNORE_CASE)
    private val STYLE_ATTRIBUTE = Regex("(\\sstyle\\s*=\\s*)(\"[^\"]*\"|'[^']*')", RegexOption.IGNORE_CASE)
    private val FIXED_WIDTH = Regex("(^|;)\\s*(min-width|width)\\s*:\\s*(\\d+(?:\\.\\d+)?)px\\s*(!\\s*important)?\\s*(?=;|$)", RegexOption.IGNORE_CASE)
    private val WHITESPACE = Regex("\\s+")

    /**
     * The mail's HTML with everything that is not drawing taken out, and its
     * stylesheet held inside the mail's own box ([scope], see [MailCss]).
     *
     * JavaScript is off in the WebView, so this is the second fence, not the
     * first: it keeps a mail from bringing a form, a frame onto some other
     * page, or a `<meta refresh>` that would navigate on its own. Styles and
     * pictures stay — they are what makes a mail look like itself.
     *
     * A mail cut off mid-way does not take the rest of the page with it: an
     * unclosed `<style>` would read everything after it as CSS, and an unclosed
     * comment would hide it, so the first is cut and the second closed.
     */
    internal fun sanitize(html: String, attachments: List<EmailAttachmentView>, scope: String = "m0"): String {
        var out = DROP_WITH_CONTENT.replace(html, "")
        // A style element's text ends at its first `</style`, for the WebView
        // as for this; scoping only rearranges what is inside, so it can
        // never make one either.
        out = STYLE_BLOCK.replace(out) { match -> "<style>" + MailCss.scope(match.groupValues[2], scope) + "</style>" }
        // Every closed one was just rewritten; a `<style` with no end after
        // it can only be the last, and the mail is cut there.
        STYLE_OPEN.findAll(out).lastOrNull()
            ?.takeIf { out.indexOf("</style>", it.range.first, ignoreCase = true) < 0 }
            ?.let { open -> out = out.substring(0, open.range.first) }
        if (out.lastIndexOf("<!--") > out.lastIndexOf("-->")) out += "-->"
        out = fluid(out)
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

    /** Elements whose fixed width is a desktop column's, not something drawn at a size (pictures keep theirs). */
    private val FLUID = setOf(
        "table", "tbody", "thead", "tfoot", "tr", "td", "th", "col", "colgroup", "div", "p", "span", "center", "a",
        "font", "section", "article", "header", "footer", "main", "nav", "aside", "blockquote", "ul", "ol", "li",
        "dl", "dt", "dd", "h1", "h2", "h3", "h4", "h5", "h6", "figure", "address", "pre",
    )
    private val CELLS = setOf("td", "th", "col", "colgroup")

    /**
     * A mail's desktop widths let go of, so it reflows to the phone.
     *
     * A 600-pixel mail is fixed widths all the way down: the wrapper table,
     * each column's cell, the boxes inside them. `max-width` cannot undo them
     * — a table is never narrower than its fixed-width contents — so they are
     * rewritten where they stand: a wide table becomes the column's full
     * width, a cell's width is left to the table, and a box of a hundred
     * pixels or more takes the width it is given. `min-width` goes. Pictures,
     * and the small fixed things (spacers, icons), keep their sizes.
     */
    private fun fluid(html: String): String = START_TAG.replace(html) { tag ->
        val name = tag.groupValues[1].lowercase()
        val attributes = tag.groupValues[2]
        if (name !in FLUID || attributes.isEmpty()) return@replace tag.value
        var rewritten = WIDTH_ATTRIBUTE.replace(attributes) { width ->
            val px = width.groupValues[3].toDouble()
            when {
                name == "table" && px >= WIDE_PX -> "${width.groupValues[1]}width=\"100%\""
                name == "table" || name in CELLS || px >= BOX_PX -> width.groupValues[1]
                else -> width.value
            }
        }
        rewritten = STYLE_ATTRIBUTE.replace(rewritten) { style ->
            val quoted = style.groupValues[2]
            val quote = quoted.first()
            val declarations = FIXED_WIDTH.replace(quoted.substring(1, quoted.length - 1)) { d ->
                val separator = d.groupValues[1]
                val px = d.groupValues[3].toDouble()
                when {
                    d.groupValues[2].equals("min-width", ignoreCase = true) -> separator
                    name == "table" && px >= WIDE_PX -> "${separator}width:100%"
                    name == "table" || name in CELLS || px >= BOX_PX -> "${separator}width:auto"
                    else -> d.value
                }
            }
            "${style.groupValues[1]}$quote$declarations$quote"
        }
        "<${tag.groupValues[1]}$rewritten>"
    }

    /** A table this wide is a page column: it becomes the phone's. */
    internal const val WIDE_PX = 300.0
    /** A box this wide has a desktop width; narrower is a spacer or an icon. */
    private const val BOX_PX = 100.0

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
     * adjustments: the app's own Persian face first, and a header that
     * scrolls with the mail instead of standing above it.
     *
     * Every class is the reader's own (`w-…`) and no rule names a bare
     * element, so a mail's markup never picks up the reader's look — a
     * mail's `<div class="meta">` stays the mail's. The header is drawn above
     * the mail (`z-index`) on white, so nothing a mail positions can cover
     * who sent it.
     */
    private val CSS = listOf(
        "html,body{background:#ffffff}",
        "body{margin:0;padding:14px 16px 24px;font-family:Vazirmatn,'Noto Naskh Arabic','Noto Sans Arabic',Roboto,'Segoe UI',Tahoma,sans-serif;font-size:15px;line-height:1.6;color:#1f2633;-webkit-text-size-adjust:100%;overflow-wrap:break-word}",
        "a{color:#2f6ae0}",
        ".w-s{font-size:19px;line-height:1.4;font-weight:700;color:#0f1729;margin:2px 0 4px;overflow-wrap:anywhere}",
        ".w-s,.w-cnt,.w-hd{position:relative;z-index:1;background:#ffffff}",
        ".w-cnt{font-size:12px;color:#6b7485;margin-bottom:4px}",
        ".w-hd{display:flex;align-items:flex-start;gap:12px;margin:12px 0 14px;padding-bottom:12px;border-bottom:1px solid #eef0f4}",
        ".w-hw{flex:1;min-width:0}",
        ".w-hl{display:flex;align-items:baseline;gap:8px}",
        ".w-hn{flex:1;min-width:0;font-weight:600;font-size:14.5px;color:#0f1729;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
        ".w-hdt{flex:none;font-size:12px;color:#98a2b3;white-space:nowrap}",
        ".w-draft{flex:none;font-size:12.5px;font-weight:600;color:#c62f35;white-space:nowrap}",
        ".w-ha{font-size:12.5px;color:#6b7485;overflow-wrap:anywhere}",
        ".w-hr{font-size:12.5px;color:#6b7485;margin-top:2px;overflow-wrap:anywhere}",
        ".w-t{white-space:pre-wrap;font-family:inherit;font-size:inherit;margin:0;unicode-bidi:plaintext;text-align:start}",
        ".w-q{margin-top:10px}",
        ".w-q>summary{display:inline-block;list-style:none;cursor:pointer;padding:2px 10px;border-radius:8px;background:#f1f4f9;color:#3b4252;font-size:12.5px}",
        ".w-q>summary::-webkit-details-marker{display:none}",
        ".w-q[open]>summary{margin-bottom:8px}",
        ".w-q .w-t{color:#6b7485;border-inline-start:3px solid #e3e7ee;padding-inline-start:10px}",
        ".w-err{margin-top:12px;padding:8px 12px;border-radius:8px;background:#fdecec;color:#c62f35;font-size:12.5px}",
        ".w-earlier{margin-top:26px;padding-top:14px;border-top:1px solid #e6e9ef}",
        ".w-et{font-size:12px;font-weight:600;color:#6b7485;margin:0 2px 10px}",
        ".w-card{border:1px solid #e3e7ee;border-radius:12px;margin-bottom:10px;background:#f8f9fb;overflow:hidden}",
        ".w-card[open]{background:#ffffff}",
        ".w-card>summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:12px;padding:10px 14px}",
        ".w-card>summary::-webkit-details-marker{display:none}",
        ".w-av{flex:none;border-radius:50%;display:flex;align-items:center;justify-content:center;overflow:hidden}",
        ".w-av svg{width:55%;height:55%}",
        ".w-who{flex:none;max-width:40%;font-weight:600;font-size:13px;color:#0f1729;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
        ".w-sn{flex:1;min-width:0;font-size:12.5px;color:#6b7485;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
        ".w-card[open]>summary .w-sn{visibility:hidden}",
        ".w-dt{flex:none;font-size:12px;color:#98a2b3;white-space:nowrap}",
        ".w-in{padding:4px 14px 14px;border-top:1px solid #eef0f4}",
        ".w-meta{font-size:12px;color:#6b7485;margin:8px 0 12px;overflow-wrap:anywhere}",
        ".w-files{margin-top:14px;display:flex;flex-wrap:wrap;gap:6px}",
        ".w-file{font-size:12.5px;color:#3b4252;background:#f1f4f9;border-radius:8px;padding:6px 10px;text-decoration:none;max-width:100%;overflow-wrap:anywhere}",
        ".w-fs{color:#98a2b3;margin-inline-start:6px}",
    ).joinToString("")

    /**
     * The page's own lines — subject, sender, recipients, the folded mails'
     * names and first words — on the page's side: each keeps its own word order (`plaintext`) but not
     * its own alignment, so an English subject in the Persian reader lines up
     * on the right with everything around it.
     */
    private const val SIDE_RTL = ".w-s,.w-cnt,.w-hn,.w-ha,.w-hr,.w-who,.w-sn,.w-meta,.w-et{unicode-bidi:plaintext;text-align:right}"
    private const val SIDE_LTR = ".w-s,.w-cnt,.w-hn,.w-ha,.w-hr,.w-who,.w-sn,.w-meta,.w-et{unicode-bidi:plaintext;text-align:left}"

    /**
     * A mail held to the phone's width.
     *
     * Mail is laid out for a 600-pixel desktop column: fixed-width tables and
     * pictures, `min-width` on the wrapper, cells that must not wrap. On a
     * phone each of those pushes the text past the edge. Nothing here may be
     * wider than the column it is in, nothing insists on a minimum width,
     * pictures scale with their width, and a long word or link breaks rather
     * than overflowing.
     *
     * `:not(#w):not(#w)` lifts these above anything a mail's own stylesheet
     * says, including its `!important` class rules. The box itself is a
     * containing block (`transform`) so a mail's fixed-position element stays
     * inside the mail instead of floating over the reader.
     *
     * What is still wider after all that ([fluid] does the heavy lifting)
     * scrolls sideways inside the mail's own box. It cannot be left to the
     * page: in a right-to-left page, whatever sticks out on the right is
     * beyond the start of the page and can never be scrolled to.
     */
    private val FIT = listOf(
        ".w-b{position:relative;z-index:0;transform:translateZ(0);overflow-wrap:anywhere;overflow-x:auto;overflow-y:hidden}",
        ".w-b:not(#w):not(#w),.w-b:not(#w):not(#w) *{max-width:100%!important;min-width:0!important;box-sizing:border-box!important}",
        ".w-b:not(#w):not(#w) img{height:auto!important}",
        ".w-b:not(#w):not(#w) table{table-layout:auto!important}",
        ".w-b:not(#w):not(#w) [nowrap],.w-b:not(#w):not(#w) [style*=nowrap i]{white-space:normal!important}",
        ".w-b:not(#w):not(#w) pre,.w-b:not(#w):not(#w) [style*=\"white-space:pre\" i]{white-space:pre-wrap!important}",
    ).joinToString("")
}
