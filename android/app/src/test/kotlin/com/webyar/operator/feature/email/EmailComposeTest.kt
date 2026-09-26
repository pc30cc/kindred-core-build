package com.webyar.operator.feature.email

import com.webyar.operator.core.model.EmailAddress
import com.webyar.operator.core.model.EmailBody
import com.webyar.operator.core.model.EmailDraft
import com.webyar.operator.core.model.EmailFolder
import com.webyar.operator.core.model.EmailMessageView
import com.webyar.operator.core.model.EmailThreadSummary
import com.webyar.operator.core.model.EmailThreadsResponse
import com.webyar.operator.core.net.SampleApi
import com.webyar.operator.core.net.WebyarApi
import com.webyar.operator.i18n.Language
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * The mailbox's new half: the composer's addressing, and the list's folders,
 * pages and stars. Plain JUnit — nothing here draws.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class EmailComposeTest {

    private val dispatcher = StandardTestDispatcher()

    @Before fun setUp() = Dispatchers.setMain(dispatcher)
    @After fun tearDown() = Dispatchers.resetMain()

    private val mailbox = "support@webyar.app"

    private val thread = EmailThreadSummary(
        id = "t-9",
        subject = "Invoice 2026-0914",
        participants = listOf(EmailAddress("billing@example.com"), EmailAddress(mailbox), EmailAddress("cfo@example.com")),
    )

    private val messages = listOf(
        EmailMessageView(
            id = "m-1",
            direction = "inbound",
            fromAddress = "billing@example.com",
            toAddresses = listOf(EmailAddress(mailbox)),
            ccAddresses = listOf(EmailAddress("cfo@example.com")),
            textBody = "Please find the invoice attached.",
        ),
    )

    // MARK: - Addressing a reply

    @Test
    fun `reply goes to the sender, in the thread, as Re`() {
        val p = EmailComposeViewModel.prefill(EmailReplyMode.REPLY, thread, messages, mailbox, Language.EN)
        assertEquals("t-9", p.threadId)
        assertEquals(listOf("billing@example.com"), p.to)
        assertTrue(p.cc.isEmpty())
        assertEquals("Re: Invoice 2026-0914", p.subject)
    }

    @Test
    fun `reply all copies everyone else, never the mailbox itself`() {
        val p = EmailComposeViewModel.prefill(EmailReplyMode.REPLY_ALL, thread, messages, mailbox, Language.EN)
        assertEquals(listOf("billing@example.com"), p.to)
        assertEquals(listOf("cfo@example.com"), p.cc)
    }

    @Test
    fun `forward starts a new thread, addressed to nobody, with the mail underneath`() {
        val p = EmailComposeViewModel.prefill(EmailReplyMode.FORWARD, thread, messages, mailbox, Language.EN)
        assertNull(p.threadId)
        assertTrue(p.to.isEmpty())
        assertEquals("Fwd: Invoice 2026-0914", p.subject)
        assertTrue(p.body.contains("Please find the invoice attached."))
        assertTrue(p.body.contains("billing@example.com"))
    }

    @Test
    fun `a subject that already says Re is not said twice`() {
        val p = EmailComposeViewModel.prefill(
            EmailReplyMode.REPLY, thread.copy(subject = "RE: Invoice"), messages, mailbox, Language.EN,
        )
        assertEquals("RE: Invoice", p.subject)
    }

    @Test
    fun `addresses are split the way people type them`() {
        assertEquals(
            listOf("a@x.com", "b@y.org", "c@z.io"),
            EmailComposeViewModel.addresses(" a@x.com, b@y.org;c@z.io  A@X.com"),
        )
        assertTrue(EmailComposeViewModel.isAddress("sara.k+support@mail.example.com"))
        assertFalse(EmailComposeViewModel.isAddress("sara@"))
        assertFalse(EmailComposeViewModel.isAddress("not an address"))
    }

    // MARK: - Sending

    private class RecordingApi(private val real: SampleApi = SampleApi()) : WebyarApi by real {
        var sent: EmailDraft? = null
        override suspend fun sendEmailDraft(workspaceId: String, draft: EmailDraft) {
            sent = draft
        }
    }

    @Test
    fun `a mistyped address is refused before anything leaves`() = runTest(dispatcher) {
        val api = RecordingApi()
        val model = EmailComposeViewModel(api) { Language.EN }
        model.start("ws-1", null, null, mailbox)
        model.setTo("billing@example")
        model.setSubject("Hello")
        model.setBody("Hi")
        model.send()
        testScheduler.advanceUntilIdle()

        assertNull(api.sent)
        assertTrue(model.form.value.error!!.contains("billing@example"))
    }

    @Test
    fun `a new mail goes out with its copies and no thread`() = runTest(dispatcher) {
        val api = RecordingApi()
        val model = EmailComposeViewModel(api) { Language.EN }
        model.start("ws-1", null, null, mailbox)
        model.setTo("a@x.com, b@y.org")
        model.showCopies()
        model.setCc("c@z.io")
        model.setSubject("Welcome")
        model.setBody("Glad to have you.")
        model.send()
        testScheduler.advanceUntilIdle()

        val sent = api.sent!!
        assertNull(sent.threadId)
        assertEquals(listOf("a@x.com", "b@y.org"), sent.to)
        assertEquals(listOf("c@z.io"), sent.cc)
        assertTrue(model.form.value.sent)
    }

    // MARK: - The quoted trail

    @Test
    fun `the quoted trail folds away from the new text`() {
        val (fresh, quoted) = EmailBody.splitQuoted(
            "Thanks, received.\n\nOn Tue, 3 Sep 2026 at 10:04, Sara <sara@x.com> wrote:\n> Here it is.",
        )
        assertEquals("Thanks, received.", fresh)
        assertTrue(quoted!!.contains("Here it is."))

        // Nothing quoted, nothing folded.
        assertEquals("Hello" to null, EmailBody.splitQuoted("Hello"))
    }

    // MARK: - The list: folders, pages, stars

    private class PagedApi(private val real: SampleApi = SampleApi()) : WebyarApi by real {
        val asked = mutableListOf<Pair<EmailFolder, String?>>()
        var starred: Pair<String, Boolean>? = null
        override suspend fun emailThreadsPage(
            workspaceId: String,
            folder: EmailFolder,
            search: String?,
            before: String?,
        ): EmailThreadsResponse {
            asked += folder to before
            return if (before == null) {
                EmailThreadsResponse(listOf(EmailThreadSummary("a"), EmailThreadSummary("b")), nextBefore = "cursor-1")
            } else {
                EmailThreadsResponse(listOf(EmailThreadSummary("b"), EmailThreadSummary("c")), nextBefore = null)
            }
        }
        override suspend fun setEmailThreadStarred(workspaceId: String, threadId: String, starred: Boolean) {
            this.starred = threadId to starred
        }
    }

    @Test
    fun `a folder is the server's own filter, and the next page follows on`() = runTest(dispatcher) {
        val api = PagedApi()
        val email = EmailInboxViewModel(api) { Language.EN }
        email.bind("ws-1")
        testScheduler.advanceUntilIdle()
        assertTrue(email.hasMore)

        email.loadMore()
        testScheduler.advanceUntilIdle()
        // "b" came twice across the pages and is listed once.
        assertEquals(listOf("a", "b", "c"), (email.state.value as EmailInboxState.Loaded).threads.map { it.id })
        assertFalse(email.hasMore)

        email.selectFolder(EmailFolder.STARRED)
        testScheduler.advanceUntilIdle()
        assertEquals(EmailFolder.STARRED to null, api.asked.last())
    }

    @Test
    fun `a star flips on the row at once and the request follows`() = runTest(dispatcher) {
        val api = PagedApi()
        val email = EmailInboxViewModel(api) { Language.EN }
        email.bind("ws-1")
        testScheduler.advanceUntilIdle()

        email.toggleStar("a")
        assertEquals(true, email.thread("a")?.isStarred)
        testScheduler.advanceUntilIdle()
        assertEquals("a" to true, api.starred)
    }
}
