package com.webyar.ai.feature.email

import com.webyar.ai.core.model.EmailAddress
import com.webyar.ai.core.model.EmailAttachmentView
import com.webyar.ai.core.model.EmailMessageView
import com.webyar.ai.i18n.Language
import com.webyar.ai.i18n.Str
import com.webyar.ai.i18n.StrEmail
import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The thread as one page, read the way the Windows app reads mail — and the
 * mail's own HTML cut down to what can only be drawn.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class EmailReaderTest {

    private fun message(
        id: String,
        from: String,
        html: String? = null,
        text: String? = null,
        minutesAgo: Long,
        read: Boolean = true,
        attachments: List<EmailAttachmentView> = emptyList(),
    ) = EmailMessageView(
        id = id,
        direction = "inbound",
        fromAddress = from,
        toAddresses = listOf(EmailAddress("support@webyar.app")),
        htmlBody = html,
        textBody = text,
        snippet = text ?: "snippet of $id",
        isRead = read,
        sentAt = Instant.now().minusSeconds(minutesAgo * 60),
        attachments = attachments,
    )

    private val trail = listOf(
        message("m-1", "\"Sara Karimi\" <sara@example.com>", text = "The first mail", minutesAgo = 300),
        message("m-2", "support@webyar.app", text = "Our answer", minutesAgo = 200),
        message("m-3", "\"Sara Karimi\" <sara@example.com>", html = "<p>The <b>newest</b> mail</p>", minutesAgo = 10),
    )

    @Test
    fun `the newest mail comes first and open, the earlier ones folded newest first`() {
        val page = EmailReader.document("Invoice", trail, mailbox = "support@webyar.app", language = Language.EN)

        val newest = page.indexOf("The <b>newest</b> mail")
        val earlier = page.indexOf(StrEmail.earlierMessages(Language.EN, 2))
        val answer = page.indexOf("Our answer")
        val first = page.indexOf("The first mail")
        assertTrue(newest in 0 until earlier)
        // Newest first among the folded ones: the answer before the first mail.
        assertTrue(earlier < answer && answer < first)
        // Folded, and the earlier ones are cards with the sender's name on them.
        assertEquals(2, Regex("<details class=\"w-card\">").findAll(page).count())
        assertTrue(page.contains("Sara Karimi"))
        // The mailbox's own mail is "me".
        assertTrue(page.contains(">${StrEmail.me(Language.EN)}<"))
    }

    @Test
    fun `an unread earlier mail is opened for the operator`() {
        val unread = trail.mapIndexed { i, m -> if (i == 0) m.copy(isRead = false) else m }
        val page = EmailReader.document("Invoice", unread, mailbox = null, language = Language.EN)
        assertTrue(page.contains("<details class=\"w-card\" open>"))
    }

    @Test
    fun `a Persian page is right to left and names a thread with no subject`() {
        val page = EmailReader.document("", trail, mailbox = null, language = Language.FA)
        assertTrue(page.startsWith("<!doctype html><html dir=\"rtl\">"))
        assertTrue(page.contains(EmailReader.escape(Str.emailNoSubject(Language.FA))))
    }

    @Test
    fun `what the mail brings is text, never markup of ours`() {
        val page = EmailReader.document("<script>alert(1)</script>", listOf(message("m", "<b>x</b>@y.z", text = "a < b & c", minutesAgo = 1)), null, Language.EN)
        assertFalse(page.contains("<script>alert"))
        assertTrue(page.contains("&lt;script&gt;alert(1)&lt;/script&gt;"))
        assertTrue(page.contains("a &lt; b &amp; c"))
    }

    @Test
    fun `nothing in a mail can run, submit or move the page`() {
        val html = """
            <html><head><meta http-equiv="refresh" content="0;url=https://evil.example"><base href="https://evil.example/"></head>
            <body onload="steal()"><style>p{color:red}</style>
            <script>steal()</script><iframe src="https://evil.example"></iframe>
            <form action="https://evil.example"><input name="password"><button>Go</button></form>
            <a href="javascript:steal()" onclick="steal()">click</a><p>Kept</p></body></html>
        """.trimIndent()
        val clean = EmailReader.sanitize(html, emptyList())

        listOf("<script", "steal()", "<iframe", "<form", "<input", "<meta", "<base", "onload", "onclick", "javascript:").forEach {
            assertFalse("left in: $it", clean.contains(it, ignoreCase = true))
        }
        // What makes a mail look like itself stays — its stylesheet held
        // inside its own box.
        assertTrue(clean.contains("<style>.m0 p{color:red}</style>"))
        assertTrue(clean.contains("<p>Kept</p>"))
        assertTrue(clean.contains(">click</a>"))
    }

    @Test
    fun `a picture drawn in the mail is fetched by the app and not listed again as a file`() {
        val logo = EmailAttachmentView(id = "a1b2c3d4e5f6-p1.2~18f3a9c2b1d0e4f5", filename = "logo.png", contentType = "image/png", contentId = "<logo@mail>")
        val pdf = EmailAttachmentView(id = "0f0f0f0f0f0f-p2~18f3a9c2b1d0e4f5", filename = "invoice.pdf", contentType = "application/pdf", sizeBytes = 2048)
        val m = message("m", "a@b.c", html = "<img src=\"cid:logo@mail\"> Hello", minutesAgo = 1, attachments = listOf(logo, pdf))

        val page = EmailReader.document("Hi", listOf(m), null, Language.EN)

        assertTrue(page.contains("src=\"${EmailReader.inlineUrl(logo.id)}\""))
        assertFalse(page.contains("cid:logo@mail\""))
        // The PDF is a chip that opens in the app; the logo is not a chip.
        assertTrue(page.contains("href=\"${EmailReader.escape(EmailReader.attachmentLink(pdf.id))}\""))
        assertFalse(page.contains("logo.png"))
        // Links come back to the ids they name.
        assertEquals(pdf.id, EmailReader.attachmentIdOf(EmailReader.attachmentLink(pdf.id)))
        assertEquals(logo.id, EmailReader.attachmentIdOf(EmailReader.inlineUrl(logo.id)))
        assertNull(EmailReader.attachmentIdOf("https://example.com/x"))
    }

    @Test
    fun `a plain-text mail folds the trail it quotes`() {
        val m = message("m", "a@b.c", text = "Thanks, received.\n\nOn Tue, 3 Sep 2026 at 10:04, Sara <sara@x.com> wrote:\n> Here it is.", minutesAgo = 1)
        val page = EmailReader.document("Re: file", listOf(m), null, Language.EN)
        assertTrue(page.contains("<pre class=\"w-t\">Thanks, received.</pre><details class=\"w-q\">"))
        assertTrue(page.contains("&gt; Here it is."))
    }

    @Test
    fun `a sender is their name and their address`() {
        assertEquals(MailName("Sara Karimi", "sara@example.com"), MailName.parse("\"Sara Karimi\" <sara@example.com>"))
        assertEquals(MailName("Ali", "ali@example.com"), MailName.parse("Ali <ali@example.com>"))
        assertEquals(MailName(null, "ali@example.com"), MailName.parse("ali@example.com"))
    }

    @Test
    fun `a mail's stylesheet reaches its own box and nothing else`() {
        val css = """
            <!--
            /* desktop first */
            html, body { margin:0 !important; min-width:600px }
            :root { --brand:#f00 }
            body.dark .x, table.main > td { width:600px }
            h1 { font-size:32px }
            * { box-sizing:border-box }
            @import url("https://evil.example/x.css");
            @media only screen and (max-width:600px) { .wrap { width:100% !important } body { padding:0 } }
            @font-face { font-family:Brand; src:url(https://fonts.example/b.woff2) }
            @keyframes spin { from { opacity:0 } to { opacity:1 } }
            @unknown { h1 { color:red } }
            a[title="{,}"] { color:blue }
            -->
        """.trimIndent()

        val scoped = MailCss.scope(css, "m3")

        assertTrue(scoped.contains(".m3,.m3{ margin:0 !important; min-width:600px }"))
        assertTrue(scoped.contains(".m3{ --brand:#f00 }"))
        assertTrue(scoped.contains(".m3 .x,.m3 table.main > td{"))
        assertTrue(scoped.contains(".m3 h1{"))
        assertTrue(scoped.contains(".m3 *{"))
        assertTrue(scoped.contains("@media only screen and (max-width:600px){.m3 .wrap{"))
        assertTrue(scoped.contains(".m3{ padding:0 }}"))
        assertTrue(scoped.contains("@font-face{ font-family:Brand;"))
        assertTrue(scoped.contains("@keyframes spin{ from { opacity:0 } to { opacity:1 } }"))
        assertTrue(scoped.contains(".m3 a[title=\"{,}\"]{"))
        listOf("@import", "evil.example", "@unknown", "desktop first", "<!--", "-->").forEach {
            assertFalse("left in: $it", scoped.contains(it))
        }
        // Every rule names the box, so no selector reaches the reader.
        val plain = MailCss.scope(css.lines().filterNot { it.startsWith("a[title") }.joinToString("\n"), "m3")
        Regex("(^|})\\s*([^@{}][^{}]*)\\{").findAll(plain).forEach { rule ->
            val selectors = rule.groupValues[2]
            if (!selectors.trim().let { it == "from" || it == "to" }) {
                selectors.split(',').forEach { assertTrue("unscoped: $it", it.trim().startsWith(".m3")) }
            }
        }
    }

    @Test
    fun `each mail of a thread has a box of its own, and the page is held to the phone`() {
        val styled = trail.mapIndexed { i, m -> m.copy(htmlBody = "<style>p{color:#${i}${i}${i}}</style><p>mail $i</p>", textBody = null) }
        val page = EmailReader.document("Invoice", styled, mailbox = null, language = Language.EN)

        assertTrue(page.contains("<div class=\"w-b m2\" dir=\"auto\"><style>.m2 p{color:#222}</style><p>mail 2</p>"))
        assertTrue(page.contains("<div class=\"w-b m1\" dir=\"auto\"><style>.m1 p{color:#111}</style>"))
        assertTrue(page.contains("<div class=\"w-b m0\" dir=\"auto\"><style>.m0 p{color:#000}</style>"))
        // Nothing may be wider than the phone, above whatever a mail says.
        assertTrue(page.contains(".w-b:not(#w):not(#w) *{max-width:100%!important;min-width:0!important"))
        // No fixed initial scale: a mail wider still opens zoomed out to fit.
        assertTrue(page.contains("<meta name=\"viewport\" content=\"width=device-width\">"))
        // The reader styles no bare element, so a mail's own markup keeps its look.
        val readerCss = page.substringAfter("<style>").substringBefore("</style>")
        assertFalse(Regex("(^|})\\s*(h1|pre|details|summary)\\b").containsMatchIn(readerCss))
    }

    @Test
    fun `an English subject and sender stand on the Persian reader's side`() {
        val page = EmailReader.document("Invoice", trail, mailbox = null, language = Language.FA)
        val side = Regex("([^}]*)\\{unicode-bidi:plaintext;text-align:right}").find(page)!!.groupValues[1]
        listOf(".w-s", ".w-hn", ".w-hr", ".w-who", ".w-sn").forEach { assertTrue("$it not on the right", side.contains(it)) }
        // Their own direction is not set per element, which would pull them left.
        assertFalse(page.contains("<span class=\"w-hn\" dir="))
    }

    @Test
    fun `a mail cut off mid-way does not swallow the rest of the page`() {
        val titled = EmailReader.sanitize("<html><head><title>Security alert</title></head><body><p>Hi</p></body></html>", emptyList())
        assertEquals("<p>Hi</p>", titled)

        val unclosedStyle = EmailReader.sanitize("<style>p{color:red}</style><p>Kept</p><style>td{", emptyList())
        assertEquals("<style>.m0 p{color:red}</style><p>Kept</p>", unclosedStyle)

        val unclosedComment = EmailReader.sanitize("<p>Kept</p><!-- a comment with no end", emptyList())
        assertTrue(unclosedComment.endsWith("-->"))
    }
}
